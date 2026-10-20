// DragoExpres — Pedidos reales + pantalla de piloto + dispatch automático.
// Datos en la bodega privada, rama dragoexpres-data:
//   pedidos.json  (pedidos) · pilots.json (disponibilidad y ganancias de pilotos)
// Dispatch: al crear un pedido se asigna SOLO al primer piloto disponible
// de la zona (FIFO por disponibilidad). Si no hay, queda 'buscando' y los
// pilotos de la zona pueden tomarlo desde su pantalla. Efectivo directo
// usuario↔piloto↔local: DragoExpres no toca el dinero; las comisiones
// (10% comida, 8% repuestos, Q2-Q5 viajes) se registran para liquidación.
const wrap = require('./_cors');
const { REPO, BRANCH, H, ensureBranch } = require('./_dx');

const TZ = 6 * 3600 * 1000; // GT = UTC-6
const hoy = () => new Date(Date.now() - TZ).toISOString().slice(0, 10);
const semana = () => 'S' + Math.floor((Date.now() - TZ) / (7 * 864e5));
const dinero = (q) => Math.max(0, Math.round(+q * 100) / 100);

async function ghGet(path) {
  await ensureBranch();
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`, { headers: H() });
  if (!r.ok) return null;
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8') || '[]') };
}
async function ghPut(path, sha, data, msg) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...H(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg, branch: BRANCH, content: Buffer.from(JSON.stringify(data, null, 1)).toString('base64'), sha: sha || undefined }),
  });
  if (!r.ok) throw new Error('guardar ' + path + ' HTTP ' + r.status);
}
async function aviso(texto) {
  try {
    const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID || '8022768138';
    if (!tok) return;
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: texto }) });
  } catch (e) { }
}
const PCT_LOCAL = 0.05, GRACIA_LOCAL_MS = 90 * 864e5; // 5% al local tras 3 meses de operar la zona
function comisionDe(tipo, envio) {
  const e = dinero(envio);
  if (tipo === 'comida') return dinero(e * 0.10);
  if (tipo === 'repuesto') return dinero(e * 0.08);
  if (e <= 25) return 2;
  if (e <= 50) return 3;
  return 5;
}


// Expira pedidos asignados que el piloto no acepto en 35s -> vuelven a BUSCANDO
const OFERTA_MS = 35000;
async function expirarAsignados(peds, sha) {
  let cambio = false;
  peds.forEach(o => {
    if (o.estado === 'asignado' && o.tsAsignado && Date.now() - o.tsAsignado > OFERTA_MS) {
      o.estado = 'buscando'; o.piloto = null; o.expiro = Date.now(); cambio = true;
    }
  });
  if (cambio) await ghPut('pedidos.json', sha, peds, 'expiracion de ofertas 30s');
  return cambio;
}

// Datos publicos del vehiculo del piloto (marca, color, placa) para que el cliente lo reconozca
function vehInfo(d) {
  d = d || {};
  return { vehiculo: d.vehiculo || '', marca: d.marca || '', color: d.color || '', placa: d.placa || '' };
}
const ESTADOS = ['buscando', 'asignado', 'aceptado', 'en_camino', 'entregado', 'cancelado'];

module.exports = wrap(async (req, res) => {
  const b = req.body || {};
  const action = b.action || (req.query && req.query.action) || '';
  const now = Date.now();

  // zonas conocidas (de cualquier registro, aprobado o pendiente) — el pedido funciona desde el día 1 en cualquier zona
  if (action === 'zonas') {
    const f = await ghGet('registros.json');
    const reg = f ? f.data : [];
    const zonas = new Set();
    reg.forEach(r => { const z = r.datos && r.datos.zona; if (z) zonas.add(z); });
    return res.status(200).json({ ok: true, zonas: [...zonas].sort() });
  }


  // ---- PROMOS auto-gestionadas del local ----
  if (action === 'promoAdd' || action === 'promoDel') {
    const tel = String(b.tel || '').replace(/\D/g, '');
    const fr = await ghGet('registros.json');
    const reg = fr ? fr.data : [];
    const esLocal = reg.some(r => r.tipo === 'local' && r.estado === 'aprobado' && String(r.datos.tel).replace(/\D/g, '') === tel);
    if (!esLocal) return res.status(200).json({ ok: false, error: 'No encontramos un local aprobado con ese WhatsApp.' });
    const fm = await ghGet('menus.json'); let arr = fm ? fm.data : [];
    let m = arr.find(x => x.tel === tel);
    if (!m) { m = { tel, items: [] }; arr.push(m); }
    if (action === 'promoAdd') {
      const titulo = String(b.titulo || '').trim().slice(0, 60);
      const detalle = String(b.detalle || '').trim().slice(0, 140);
      if (!titulo) return res.status(200).json({ ok: false, error: 'Poné un título a la promo.' });
      m.promos = m.promos || [];
      if (m.promos.length >= 5) return res.status(200).json({ ok: false, error: 'Máximo 5 promos activas.' });
      m.promos.push({ id: String(now) + String(Math.floor(Math.random() * 90) + 10), titulo, detalle, ts: now });
    } else {
      const pid = String(b.promoId || '');
      m.promos = (m.promos || []).filter(x => x.id !== pid);
    }
    await ghPut('menus.json', fm ? fm.sha : null, arr, 'promo ' + action + ' ' + tel);
    return res.status(200).json({ ok: true, promos: m.promos || [] });
  }

  // ---- PILOTO: login (tel + placa) ----
  if (action === 'loginPiloto') {
    const tel = String(b.tel || '').trim(), placa = String(b.placa || '').trim().toUpperCase();
    const f = await ghGet('registros.json');
    const reg = f ? f.data : [];
    const p = reg.find(r => r.tipo === 'piloto' && r.estado === 'aprobado' && String(r.datos.tel).trim() === tel);
    if (!p) return res.status(200).json({ ok: false, error: 'No encontramos un piloto aprobado con ese WhatsApp.' });
    if (p.datos.placa && String(p.datos.placa).trim().toUpperCase() !== placa) return res.status(200).json({ ok: false, error: 'La placa no coincide.' });
    const fp = await ghGet('pilots.json');
    const st = (fp ? fp.data : []).find(x => x.tel === tel) || { tel, disponible: false };
    if (st.susp) return res.status(200).json({ ok: false, suspendido: true, error: 'Suspendido por liquidación pendiente: Q' + (st.pendiente ? st.pendiente.monto : '?') + '. Pagá tus comisiones a la cuenta del banco y avisános por WhatsApp para reactivarte.' });
    const fpd = await ghGet('pedidos.json');
    const peds = fpd ? fpd.data : [];
    await expirarAsignados(peds, fpd ? fpd.sha : null);
    const mio = peds.filter(o => o.piloto && o.piloto.tel === tel && !['entregado', 'cancelado'].includes(o.estado));
    const zona = peds.filter(o => o.estado === 'buscando' && o.zona === p.datos.zona);
    const califs = peds.filter(o => o.piloto && o.piloto.tel === tel && o.califCliente > 0);
    const calif = califs.length ? Math.round(califs.reduce((x, o) => x + o.califCliente, 0) / califs.length * 10) / 10 : null;
    const zonaF = zona.filter(o => !(o.rechazadoPor || []).includes(tel));
    return res.status(200).json({ ok: true, piloto: { nombre: p.datos.nombre, zona: p.datos.zona, vehiculo: p.datos.vehiculo, marca: p.datos.marca || '', color: p.datos.color || '', placa: p.datos.placa || '', disponible: st.disponible, ganadoHoy: st.ganadoHoy || 0, ganadoSemana: st.ganadoSemana || 0, pedidosHoy: st.pedidosHoy || 0, racha: st.racha || 0, boletosExtra: st.boletosExtra || 0, calif: calif, pendiente: st.pendiente || null }, activo: mio[0] || null, zonaBuscando: zonaF });
  }

  // ---- PILOTO: ponerse disponible / no disponible ----
  if (action === 'disponible') {
    const tel = String(b.tel || '').trim(), val = b.val === true || b.val === 'true';
    const fp = await ghGet('pilots.json');
    const arr = fp ? fp.data : [];
    let st = arr.find(x => x.tel === tel);
    if (!st) { st = { tel, disponible: false }; arr.push(st); }
    const fpd = await ghGet('pedidos.json');
    const peds = fpd ? fpd.data : [];
    const ocupado = peds.some(o => o.piloto && o.piloto.tel === tel && ['asignado', 'aceptado', 'en_camino'].includes(o.estado));
    if (val && ocupado) return res.status(200).json({ ok: false, error: 'Terminá tu pedido activo primero.' });
    st.disponible = val; st.desde = val ? now : 0;
    await ghPut('pilots.json', fp ? fp.sha : null, arr, 'piloto disponibilidad ' + tel);
    return res.status(200).json({ ok: true, disponible: val });
  }

  // ---- crear pedido (usuario) con DISPATCH AUTOMATICO ----
  if (action === 'crear') {
    const tipo = ['comida', 'viaje', 'repuesto'].includes(b.tipo) ? b.tipo : 'comida';
    const zona = String(b.zona || '').trim().slice(0, 80);
    const nombre = String(b.nombre || '').trim().slice(0, 80);
    const tel = String(b.tel || '').trim().slice(0, 25);
    if (!zona || !nombre || !tel || !b.direccion) return res.status(200).json({ ok: false, error: 'Faltan datos: nombre, WhatsApp, zona y dirección.' });
    if (!b.detalle) return res.status(200).json({ ok: false, error: 'Contanos qué querés pedir.' });
    const envio = dinero(tipo === 'comida' ? (b.envio || 15) : tipo === 'repuesto' ? (b.envio || 20) : (b.envio || 25));
    const pago = b.pago === 'transferencia' ? 'transferencia' : 'efectivo';
    const referencia = pago === 'transferencia' ? String(b.refbanco || '').trim().slice(0, 40) : '';
    const id = 'DX' + String(now).slice(-6) + String(Math.floor(Math.random() * 90) + 10);
    const localObj = b.local && b.local.tel ? { nombre: String(b.local.nombre || '').slice(0, 60), tel: String(b.local.tel).replace(/\D/g, '').slice(0, 25) } : null;
    if (localObj) {
      const fl = await ghGet('locales.json'); const pausa = (fl ? fl.data : []).find(x => x.tel === localObj.tel && x.hasta > now);
      if (pausa) {
        const mins = Math.max(1, Math.ceil((pausa.hasta - now) / 60000));
        return res.status(200).json({ ok: false, error: localObj.nombre + ' está saturado ahora. Probá de nuevo en ' + mins + ' minuto(s) o pedí de otro local.' });
      }
    }
    const compra = dinero(b.compra || 0);
    let comisionLocal = 0;
    if (tipo === 'comida' && compra > 0) {
      const fprev = await ghGet('pedidos.json');
      const prev = (fprev ? fprev.data : []).filter(x => x.zona === zona && x.ts);
      const primera = prev.length ? Math.min(...prev.map(x => x.ts)) : now;
      if (now - primera >= GRACIA_LOCAL_MS) comisionLocal = dinero(compra * PCT_LOCAL);
    }
    const pedido = {
      id, tipo, zona,
      cliente: { nombre, tel, direccion: String(b.direccion).slice(0, 160), referencia: String(b.referencia || '').slice(0, 160) },
      detalle: String(b.detalle).slice(0, 400),
      compra: dinero(b.compra || 0), envio, comision: comisionDe(tipo, envio), comisionLocal,
      estado: 'buscando', piloto: null, ts: now, pago, referencia, local: localObj || undefined
    };
    // dispatch: primer piloto disponible de la zona
    const fp = await ghGet('pilots.json'); const pilots = fp ? fp.data : [];
    const fr = await ghGet('registros.json'); const reg = fr ? fr.data : [];
    const aprobados = new Set(reg.filter(r => r.tipo === 'piloto' && r.estado === 'aprobado').map(r => String(r.datos.tel).trim()));
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const ocupados = new Set(peds.filter(o => o.piloto && ['asignado', 'aceptado', 'en_camino'].includes(o.estado)).map(o => o.piloto.tel));
    const cand = pilots.filter(x => x.disponible && !x.susp && aprobados.has(x.tel) && !ocupados.has(x.tel))
      .filter(x => { const r = reg.find(y => y.tipo === 'piloto' && String(y.datos.tel).trim() === x.tel); return r && r.datos.zona === zona; })
      .sort((a, b2) => (a.desde || 0) - (b2.desde || 0));
    if (cand.length) {
      const r = reg.find(y => y.tipo === 'piloto' && String(y.datos.tel).trim() === cand[0].tel);
      pedido.estado = 'asignado';
      pedido.tsAsignado = now;
      pedido.piloto = Object.assign({ tel: cand[0].tel, nombre: r.datos.nombre }, vehInfo(r.datos));
      const st = pilots.find(x => x.tel === cand[0].tel);
      // el piloto asignado queda "ocupado" hasta entregar/rechazar
    }
    peds.push(pedido);
    await ghPut('pedidos.json', fpd ? fpd.sha : null, peds, 'pedido nuevo ' + id);
    const ic = { comida: '🍔', viaje: '🛺', repuesto: '🔧' }[tipo];
    await aviso(`🚀 DRAGOEXPRES — PEDIDO NUEVO ${ic}\n${id} · ${tipo.toUpperCase()} · ${zona}\nCliente: ${nombre} (${tel})\n${pedido.local ? 'Local: ' + pedido.local.nombre + ' · ' : ''}Detalle: ${String(b.detalle).slice(0, 120)}\nEnvío: Q${envio} · Comisión DragoExpres: Q${pedido.comision}${pedido.comisionLocal ? ' · 🍽️ 5% al local (zona operativa >3 meses): Q' + pedido.comisionLocal : ''}\n${pago === 'transferencia' ? '💳 Pago: TRANSFERENCIA al Banco Industrial' + (referencia ? ' · Ref: ' + referencia : ' · (sin referencia, verificar)') : '💵 Pago: EFECTIVO al piloto'}\n${pedido.piloto ? '→ Asignado AUTOMÁTICAMENTE a: ' + pedido.piloto.nombre + ' (' + pedido.piloto.tel + ')' : '→ SIN piloto disponible ahora, queda BUSCANDO'}`);
    return res.status(200).json({ ok: true, pedido });
  }


  // ---- LOCAL: login (solo WhatsApp, debe estar aprobado) ----
  if (action === 'loginLocal') {
    const tel = String(b.tel || '').replace(/\D/g, '');
    if (!tel) return res.status(200).json({ ok: false, error: 'Decinos tu WhatsApp.' });
    const fr = await ghGet('registros.json'); const reg = fr ? fr.data : [];
    const r = reg.find(x => x.tipo === 'local' && x.estado === 'aprobado' && String(x.datos.whatsapp || x.datos.tel || '').replace(/\D/g, '') === tel);
    if (!r) return res.status(200).json({ ok: false, error: 'No encontramos un local aprobado con ese WhatsApp.' });
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    await expirarAsignados(peds, fpd ? fpd.sha : null);
    const mios = peds.filter(x => x.local && x.local.tel === tel);
    const activos = mios.filter(x => !['entregado', 'cancelado'].includes(x.estado));
    const fl = await ghGet('locales.json');
    const pausa = (fl ? fl.data : []).find(x => x.tel === tel && x.hasta > now);
    return res.status(200).json({ ok: true, local: { nombre: r.datos.nombre, zona: r.datos.zona, tel }, activos: activos.slice(-10).reverse(), totalEntregados: mios.filter(x => x.estado === 'entregado').length, pausa: pausa ? pausa.hasta : null });
  }

  // ---- LOCAL: confirmar pedido con tiempo de preparacion ----
  if (action === 'prep') {
    const tel = String(b.tel || '').replace(/\D/g, ''), id = String(b.id || ''), min = Math.max(5, Math.min(120, parseInt(b.min) || 25));
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const o = peds.find(x => x.id === id);
    if (!o || !o.local || o.local.tel !== tel) return res.status(200).json({ ok: false, error: 'Pedido no encontrado para tu local.' });
    if (['entregado', 'cancelado'].includes(o.estado)) return res.status(200).json({ ok: false, error: 'Este pedido ya cerró.' });
    o.prep = { min, ts: now };
    await ghPut('pedidos.json', fpd.sha, peds, 'local confirmo ' + id + ' (' + min + ' min)');
    await aviso('🏪 DRAGOEXPRES — ' + o.local.nombre + ' confirmó el pedido ' + id + '\nListo en ~' + min + ' minutos.');
    return res.status(200).json({ ok: true, pedido: o });
  }

  // ---- LOCAL: pausar / reanudar pedidos ----
  if (action === 'pausaLocal') {
    const tel = String(b.tel || '').replace(/\D/g, ''), min = parseInt(b.min) || 0;
    const freg = await ghGet('registros.json');
    const rl = (freg ? freg.data : []).find(x => x.tipo === 'local' && x.estado === 'aprobado' && String(x.datos.whatsapp || x.datos.tel || '').replace(/\D/g, '') === tel);
    if (!rl) return res.status(200).json({ ok: false, error: 'No encontramos un local aprobado con ese WhatsApp.' });
    const fl = await ghGet('locales.json'); const arr = fl ? fl.data : [];
    let row = arr.find(x => x.tel === tel);
    if (min > 0) {
      if (!row) { row = { tel }; arr.push(row); }
      row.hasta = now + min * 60000; row.ts = now;
      await aviso('⏸️ DRAGOEXPRES — local pausó pedidos por ' + min + ' min');
    } else if (row) { row.hasta = 0; }
    await ghPut('locales.json', fl ? fl.sha : null, arr, 'pausa local ' + (min || 'off'));
    return res.status(200).json({ ok: true, pausa: min > 0 ? row.hasta : null });
  }


  // ---- MENU del local: productos con foto, precio y agotado ----
  if (action === 'menu') {
    const tel = String(b.tel || '').replace(/\D/g, '');
    if (!tel) return res.status(200).json({ ok: false, error: 'Decinos de qué local el menú.' });
    const fm = await ghGet('menus.json');
    const m = (fm ? fm.data : []).find(x => x.tel === tel);
    return res.status(200).json({ ok: true, items: (m && m.items) || [], promos: (m && m.promos) || [] });
  }
  if (['menuAdd', 'menuEdit', 'menuDel'].includes(action)) {
    const tel = String(b.tel || '').replace(/\D/g, '');
    const freg = await ghGet('registros.json');
    const rl = (freg ? freg.data : []).find(x => x.tipo === 'local' && x.estado === 'aprobado' && String(x.datos.whatsapp || x.datos.tel || '').replace(/\D/g, '') === tel);
    if (!rl) return res.status(200).json({ ok: false, error: 'No encontramos un local aprobado con ese WhatsApp.' });
    const fm = await ghGet('menus.json');
    const arr = fm ? fm.data : [];
    let m = arr.find(x => x.tel === tel);
    if (!m) { m = { tel, items: [] }; arr.push(m); }
    if (action === 'menuAdd') {
      if (m.items.length >= 40) return res.status(200).json({ ok: false, error: 'Máximo 40 productos. Borrale alguno primero.' });
      const CATS = ['Platos fuertes', 'Entradas', 'Bebidas', 'Postres', 'Combos', 'Repuestos', 'Otros'];
      const categoria = CATS.includes(b.categoria) ? b.categoria : 'Otros';
      m.items.push({ id: String(now) + String(Math.floor(Math.random() * 90) + 10), nombre: String(b.nombre || '').trim().slice(0, 60), desc: String(b.desc || '').trim().slice(0, 120), categoria, precio: dinero(b.precio || 0), foto: String(b.foto || '').slice(0, 300), agotado: false });
    }
    if (action === 'menuEdit') {
      const it = m.items.find(x => x.id === String(b.id || ''));
      if (!it) return res.status(200).json({ ok: false, error: 'Producto no encontrado.' });
      if (b.agotado !== undefined) it.agotado = b.agotado === true || b.agotado === 'true';
      if (b.precio !== undefined) it.precio = dinero(b.precio);
      if (b.nombre !== undefined) it.nombre = String(b.nombre).trim().slice(0, 60);
      if (b.desc !== undefined) it.desc = String(b.desc).trim().slice(0, 120);
      if (b.categoria !== undefined && ['Platos fuertes', 'Entradas', 'Bebidas', 'Postres', 'Combos', 'Repuestos', 'Otros'].includes(b.categoria)) it.categoria = b.categoria;
    }
    if (action === 'menuDel') {
      m.items = m.items.filter(x => x.id !== String(b.id || ''));
    }
    await ghPut('menus.json', fm ? fm.sha : null, arr, 'menu ' + action + ' ' + tel);
    return res.status(200).json({ ok: true, items: m.items });
  }

  // ---- CHAT cliente <-> piloto (estilo PedidosYa) ----
  if (action === 'msg') {
    const id = String(b.id || '');
    const de = ['piloto', 'cliente', 'local'].includes(b.de) ? b.de : 'cliente';
    const texto = String(b.texto || '').trim().slice(0, 300);
    const tel = String(b.tel || '').replace(/\D/g, '');
    if (!id || !texto || !tel) return res.status(200).json({ ok: false, error: 'Faltan datos del mensaje.' });
    const fpd = await ghGet('pedidos.json');
    const peds = fpd ? fpd.data : [];
    const ped = peds.find(x => x.id === id);
    if (!ped || ['entregado', 'cancelado'].includes(ped.estado)) return res.status(200).json({ ok: false, error: 'Este chat ya cerró.' });
    if (de === 'cliente' && String(ped.cliente.tel).replace(/\D/g, '') !== tel) return res.status(200).json({ ok: false, error: 'Chat no disponible.' });
    if (de === 'piloto' && (!ped.piloto || String(ped.piloto.tel).replace(/\D/g, '') !== tel)) return res.status(200).json({ ok: false, error: 'Chat no disponible.' });
    if (de === 'local' && (!ped.local || String(ped.local.tel).replace(/\D/g, '') !== tel)) return res.status(200).json({ ok: false, error: 'Chat no disponible.' });
    if (de === 'cliente' && ped.noResponde) { delete ped.noResponde; }
    ped.chat = ped.chat || [];
    ped.chat.push({ de, texto, ts: now });
    await ghPut('pedidos.json', fpd.sha, peds, 'chat ' + id);
    return res.status(200).json({ ok: true, chat: ped.chat });
  }

  // ---- BILLETERA del piloto: todo su historial ----
  if (action === 'billetera') {
    const tel = String(b.tel || '').replace(/\D/g, '');
    const fpd = await ghGet('pedidos.json');
    const peds = fpd ? fpd.data : [];
    const mios = peds.filter(x => x.piloto && String(x.piloto.tel).replace(/\D/g, '') === tel && x.estado === 'entregado');
    const ganado = dinero(mios.reduce((s, x) => s + (x.envio - x.comision), 0));
    const comisiones = dinero(mios.reduce((s, x) => s + (x.comision || 0) + (x.comisionLocal || 0), 0));
    const califs = mios.filter(x => x.califCliente > 0);
    const calif = califs.length ? Math.round(califs.reduce((s, x) => s + x.califCliente, 0) / califs.length * 10) / 10 : null;
    const g = new Date(now - 21600000);
    const lunes = new Date(g);
    lunes.setUTCDate(g.getUTCDate() - ((g.getUTCDay() + 6) % 7));
    lunes.setUTCHours(0, 0, 0, 0);
    const iniSem = lunes.getTime() + 21600000;
    const semana = mios.filter(x => (x.tsEntregado || x.ts) >= iniSem).length;
    const fp = await ghGet('pilots.json');
    const st = (fp ? fp.data : []).find(x => String(x.tel).replace(/\D/g, '') === tel) || {};
    const historial = mios.slice(-15).reverse().map(x => ({ id: x.id, tipo: x.tipo, ganado: dinero(x.envio - x.comision), envio: x.envio, ts: x.tsEntregado || x.ts }));
    return res.status(200).json({ ok: true, entregas: mios.length, ganado, comisiones, calif, pendiente: st.pendiente || null, meta: { hechas: semana, faltan: Math.max(0, 20 - semana) }, historial });
  }

  // ---- consultar estado (usuario o pantalla) ----
  if (action === 'estado') {
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    await expirarAsignados(peds, fpd ? fpd.sha : null);
    if (b.id) {
      const o = peds.find(x => x.id === String(b.id).trim());
      if (!o) return res.status(200).json({ ok: false, error: 'Pedido no encontrado.' });
      let gps = null;
      if (o.piloto) {
        const fp = await ghGet('pilots.json');
        const st = (fp ? fp.data : []).find(x => x.tel === o.piloto.tel);
        if (st && st.lat && st.tsGPS && st.tsGPS > now - 300000) gps = { lat: st.lat, lng: st.lng, ts: st.tsGPS };
      }
      return res.status(200).json({ ok: true, pedido: o, gps });
    }
    if (b.tel) {
      const mios = peds.filter(x => x.cliente.tel === String(b.tel).trim()).slice(-5).reverse();
      return res.status(200).json({ ok: true, pedidos: mios });
    }
    return res.status(200).json({ ok: false, error: 'Dinos el id o tu WhatsApp.' });
  }

  // locales aprobados para el listado del consumidor (pantalla Inicio)
  if (action === 'locales') {
    const fr = await ghGet('registros.json'); const regs = fr ? fr.data : [];
    const loc = regs.filter(r => r.tipo === 'local' && r.estado === 'aprobado').map(r => ({
      nombre: (r.datos && r.datos.nombre) || r.nombre || 'Local',
      zona: (r.datos && r.datos.zona) || r.zona || '',
      tel: String((r.datos && (r.datos.whatsapp || r.datos.tel)) || '').replace(/\D/g, ''),
      rubro: (r.datos && (r.datos.rubro || r.datos.tipo)) || 'Comida',
    }));
    return res.status(200).json({ ok: true, locales: loc });
  }

  // historial de pedidos del cliente (hasta 30, mas recientes primero)
  if (action === 'misp') {
    const tel = String(b.tel || '').replace(/\D/g, '');
    if (!tel) return res.status(200).json({ ok: false, error: 'Decinos tu numero.' });
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const mios = peds.filter(x => String(x.cliente && x.cliente.tel || '').replace(/\D/g, '') === tel).slice(-30).reverse();
    return res.status(200).json({ ok: true, pedidos: mios });
  }


  // ---- CANCELACIONES ----
  if (action === 'localCancela') {
    const tel = String(b.tel || '').replace(/\D/g, '');
    const id = String(b.id || '');
    const razon = String(b.razon || '').trim().slice(0, 80);
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const o = peds.find(x => x.id === id);
    if (!o || ['entregado', 'cancelado'].includes(o.estado)) return res.status(200).json({ ok: false, error: 'Este pedido ya cerró.' });
    if (!o.local || String(o.local.tel).replace(/\D/g, '') !== tel) return res.status(200).json({ ok: false, error: 'No es un pedido de tu local.' });
    const teniaPiloto = !!(o.piloto && ['asignado', 'aceptado', 'en_camino'].includes(o.estado));
    o.estado = 'cancelado'; o.canceladoPor = 'local'; o.canceladoRazon = razon; o.canceladoTs = now;
    await ghPut('pedidos.json', fpd.sha, peds, 'local cancela ' + id);
    await aviso('🚀 DRAGOEXPRES — ' + id + '\n🏪 El local canceló el pedido' + (razon ? ' (' + razon + ')' : '') + (teniaPiloto ? '. El piloto ' + o.piloto.nombre + ' queda LIBRE y su racha NO se rompe.' : '') + '. El cliente no fue cobrado.');
    return res.status(200).json({ ok: true, pedido: o });
  }
  if (action === 'clienteCancela') {
    const tel = String(b.tel || '').replace(/\D/g, '');
    const id = String(b.id || '');
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const o = peds.find(x => x.id === id);
    if (!o || ['entregado', 'cancelado'].includes(o.estado)) return res.status(200).json({ ok: false, error: 'Este pedido ya cerró.' });
    if (String(o.cliente.tel).replace(/\D/g, '') !== tel) return res.status(200).json({ ok: false, error: 'No es tu pedido.' });
    if (o.estado !== 'buscando') return res.status(200).json({ ok: false, error: 'Ya hay un piloto en camino. Escribile por el chat para coordinar.' });
    o.estado = 'cancelado'; o.canceladoPor = 'cliente'; o.canceladoTs = now;
    await ghPut('pedidos.json', fpd.sha, peds, 'cliente cancela ' + id);
    await aviso('🚀 DRAGOEXPRES — ' + id + '\n🧑 El cliente canceló mientras buscábamos piloto. Nadie pierde nada.');
    return res.status(200).json({ ok: true, pedido: o });
  }

  // ---- acciones del piloto sobre el pedido ----

  // ---- CLIENTE NO RESPONDE (piloto en la puerta) ----
  if (action === 'noResponde' || action === 'cerrarNoResponde') {
    const telNR = String(b.tel || '').replace(/\D/g, '');
    const idNR = String(b.id || '');
    if (!telNR || !idNR) return res.status(200).json({ ok: false, error: 'Faltan datos.' });
    const fpdNR = await ghGet('pedidos.json'); const pedsNR = fpdNR ? fpdNR.data : [];
    const o = pedsNR.find(x => x.id === idNR);
    if (!o || ['entregado', 'cancelado'].includes(o.estado)) return res.status(200).json({ ok: false, error: 'Este pedido ya cerró.' });
    const tel = telNR, id = idNR, fpd = fpdNR, peds = pedsNR;
  if (action === 'noResponde') {
    if (o.estado !== 'en_camino') return res.status(200).json({ ok: false, error: 'Solo cuando ya estás en camino.' });
    if (!o.piloto || String(o.piloto.tel).replace(/\D/g, '') !== tel) return res.status(200).json({ ok: false, error: 'No es tu pedido.' });
    o.noResponde = { ts: now, tel };
    await ghPut('pedidos.json', fpd.sha, peds, 'no responde ' + id);
    await aviso('🚀 DRAGOEXPRES — ' + id + '\n🚫 El piloto reporta: CLIENTE NO RESPONDE. Tiene 10 minutos de tolerancia; si el cliente responde el chat, se cancela.');
    return res.status(200).json({ ok: true, pedido: o });
  }
  if (action === 'cerrarNoResponde') {
    if (o.estado !== 'en_camino' || !o.noResponde) return res.status(200).json({ ok: false, error: 'Primero marcá que el cliente no responde.' });
    if (String(o.piloto.tel).replace(/\D/g, '') !== tel) return res.status(200).json({ ok: false, error: 'No es tu pedido.' });
    if (now - o.noResponde.ts < 10 * 60000) return res.status(200).json({ ok: false, error: 'Todavía no pasan los 10 minutos de tolerancia. Escribile al cliente.' });
    o.estado = 'entregado'; o.tsEntregado = now; o.cerradoNoResponde = true;
    await ghPut('pedidos.json', fpd.sha, peds, 'cerrado por no respuesta ' + id);
    const fp = await ghGet('pilots.json'); const arr = fp ? fp.data : [];
    let st = arr.find(x => x.tel === tel);
    if (!st) { st = { tel }; arr.push(st); }
    if (st.dia !== hoy()) { st.dia = hoy(); st.ganadoHoy = 0; st.pedidosHoy = 0; }
    if (st.semana !== semana()) { st.semana = semana(); st.ganadoSemana = 0; }
    const neto = dinero(o.envio - o.comision);
    st.ganadoHoy = dinero((st.ganadoHoy || 0) + neto); st.ganadoSemana = dinero((st.ganadoSemana || 0) + neto);
    st.pedidosHoy = (st.pedidosHoy || 0) + 1;
    st.racha = (st.racha || 0) + 1;
    if (st.racha % 3 === 0) st.boletosExtra = (st.boletosExtra || 0) + 1;
    await ghPut('pilots.json', fp ? fp.sha : null, arr, 'cobrado no-responde ' + id);
    await aviso('🚀 DRAGOEXPRES — ' + id + '\n⏱️ Cerrado tras 10 minutos sin respuesta del cliente. El piloto cobra COMPLETO su envío (Q' + neto + ').');
    return res.status(200).json({ ok: true, pedido: o });
  }
  }
  if (['aceptar', 'rechazar', 'avanzar'].includes(action)) {
    const tel = String(b.tel || '').trim(), id = String(b.id || '').trim();
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const o = peds.find(x => x.id === id);
    if (!o) return res.status(200).json({ ok: false, error: 'Pedido no encontrado.' });
    if (action === 'aceptar') {
      if (o.estado === 'asignado' && o.tsAsignado && now - o.tsAsignado > OFERTA_MS) { o.estado = 'buscando'; o.piloto = null; o.expiro = now; await ghPut('pedidos.json', fpd.sha, peds, 'expirado ' + id); return res.status(200).json({ ok: false, error: 'La oferta expiró (30 segundos). El pedido volvió a buscando.' }); }
      // puede aceptar el suyo asignado o tomar uno 'buscando' de su zona
      const fr = await ghGet('registros.json'); const reg = fr ? fr.data : [];
      const p = reg.find(r => r.tipo === 'piloto' && r.estado === 'aprobado' && String(r.datos.tel).trim() === tel);
      if (!p) return res.status(200).json({ ok: false, error: 'No sos piloto aprobado.' });
      if (o.estado === 'asignado' && (!o.piloto || o.piloto.tel !== tel)) return res.status(200).json({ ok: false, error: 'Este pedido es de otro piloto.' });
      if ((o.rechazadoPor || []).includes(tel)) return res.status(200).json({ ok: false, error: 'Rechazaste este pedido, se lo dejamos a otro piloto.' });
      if (!['asignado', 'buscando'].includes(o.estado)) return res.status(200).json({ ok: false, error: 'Este pedido ya no está disponible.' });
      if (o.estado === 'buscando' && o.zona !== p.datos.zona) return res.status(200).json({ ok: false, error: 'Pedido de otra zona.' });
      o.estado = 'aceptado'; o.piloto = Object.assign({ tel, nombre: p.datos.nombre }, vehInfo(p.datos)); o.tsAceptado = now;
      await ghPut('pedidos.json', fpd.sha, peds, 'aceptado ' + id);
      await aviso(`🚀 DRAGOEXPRES — Pedido ${id}\n✅ ${p.datos.nombre} ACEPTÓ el pedido (${o.tipo})\nCliente: ${o.cliente.nombre}\n→ El piloto va en camino. Estado: ACEPTADO`);
      return res.status(200).json({ ok: true, pedido: o });
    }
    if (!o.piloto || o.piloto.tel !== tel) return res.status(200).json({ ok: false, error: 'Este pedido no es tuyo.' });
    if (action === 'rechazar') {
      if (!['asignado', 'aceptado'].includes(o.estado)) return res.status(200).json({ ok: false, error: 'Ya no se puede rechazar.' });
      o.rechazadoPor = o.rechazadoPor || []; o.rechazadoPor.push(tel);
      o.rechazos = (o.rechazos || 0) + 1;
      try { const fp2 = await ghGet('pilots.json'); const a2 = fp2 ? fp2.data : []; const sr = a2.find(x => x.tel === tel); if (sr && sr.racha) { sr.racha = 0; await ghPut('pilots.json', fp2.sha, a2, 'racha rota ' + tel); } } catch (e) {}
      if (o.rechazos >= 3) {
        o.estado = 'cancelado'; o.piloto = null; o.canceladoPor = 'sin_piloto'; o.canceladoTs = now;
        await ghPut('pedidos.json', fpd.sha, peds, 'cancelado por rechazos ' + id);
        await aviso(`🚀 DRAGOEXPRES — Pedido ${id}
⛔ 3 pilotos lo rechazaron → CANCELADO. Avisale al cliente que nadie le cobró nada.`);
        return res.status(200).json({ ok: true, pedido: o });
      }
      o.estado = 'buscando'; o.piloto = null;
      try { const fp2 = await ghGet('pilots.json'); const a2 = fp2 ? fp2.data : []; const sr = a2.find(x => x.tel === tel); if (sr && sr.racha) { sr.racha = 0; await ghPut('pilots.json', fp2.sha, a2, 'racha rota ' + tel); } } catch (e) {}
      await ghPut('pedidos.json', fpd.sha, peds, 'rechazado ' + id);
      await aviso(`🚀 DRAGOEXPRES — Pedido ${id}\n⚠️ Un piloto rechazó → volvió a BUSCANDO, se lo ofrecemos a otro piloto de la zona.`);
      return res.status(200).json({ ok: true, pedido: o });
    }
    if (action === 'avanzar') {
      if (o.estado === 'aceptado') o.estado = 'en_camino';
      else if (o.estado === 'en_camino') {
        o.estado = 'entregado'; o.tsEntregado = now;
        await ghPut('pedidos.json', fpd.sha, peds, 'entregado ' + id); // guardar el estado ANTES de pagar al piloto
        const fp = await ghGet('pilots.json'); const arr = fp ? fp.data : [];
        let st = arr.find(x => x.tel === tel);
        if (!st) { st = { tel }; arr.push(st); }
        if (st.dia !== hoy()) { st.dia = hoy(); st.ganadoHoy = 0; st.pedidosHoy = 0; }
        if (st.semana !== semana()) { st.semana = semana(); st.ganadoSemana = 0; }
        st.racha = (st.racha || 0) + 1;
        if (st.racha % 3 === 0) st.boletosExtra = (st.boletosExtra || 0) + 1;
        const neto = dinero(o.envio - o.comision);
        let gananciaPiloto = neto, flotaTxt = '';
        const ff = await ghGet('flotas.json');
        const flotas = ff ? ff.data : [];
        const asig = flotas.find(x => x.activa !== false && x.conductor && x.conductor.tel === tel);
        if (asig) {
          gananciaPiloto = dinero(neto * 0.75);
          if (asig.semana !== semana()) { asig.semana = semana(); asig.ganadoSemana = 0; asig.pedidosSemana = 0; }
          asig.ganadoSemana = dinero((asig.ganadoSemana || 0) + dinero(neto * 0.25));
          asig.pedidosSemana = (asig.pedidosSemana || 0) + 1;
          await ghPut('flotas.json', ff ? ff.sha : null, flotas, 'flota ' + id);
          flotaTxt = `\n🚚 Flota ${asig.placa}: 75% conductor (Q${gananciaPiloto}) / 25% flotista ${asig.flotista.nombre} (Q${dinero(neto * 0.25)})`;
        }
        st.ganadoHoy = dinero((st.ganadoHoy || 0) + gananciaPiloto);
        st.ganadoSemana = dinero((st.ganadoSemana || 0) + gananciaPiloto);
        st.pedidosHoy = (st.pedidosHoy || 0) + 1;
        st.disponible = true; st.desde = now;
        await ghPut('pilots.json', fp ? fp.sha : null, arr, 'entregado ' + id);
        await aviso(`🚀 DRAGOEXPRES — Pedido ${id} ENTREGADO ✅\n${o.piloto.nombre} completó ${o.tipo}\nEnvío Q${o.envio} → piloto gana Q${gananciaPiloto} · Comisión DragoExpres: Q${dinero(o.comision + (o.comisionLocal || 0))}${o.comisionLocal ? ' (envío Q' + o.comision + ' + local Q' + o.comisionLocal + ')' : ''}${flotaTxt}\nCliente: ${o.cliente.nombre}`);
        return res.status(200).json({ ok: true, pedido: o, ganadoHoy: st.ganadoHoy, ganadoSemana: st.ganadoSemana });
      } else return res.status(200).json({ ok: false, error: 'Estado inválido.' });
      await ghPut('pedidos.json', fpd.sha, peds, o.estado + ' ' + id);
      return res.status(200).json({ ok: true, pedido: o });
    }
  }

  // ---- PILOTO: publica su GPS (para el mapa vivo del cliente) ----
  if (action === 'gps') {
    const tel = String(b.tel || '').trim();
    const lat = +b.lat, lng = +b.lng;
    if (!tel || !isFinite(lat) || !isFinite(lng)) return res.status(200).json({ ok: false, error: 'datos gps invalidos' });
    const fp = await ghGet('pilots.json'); const arr = fp ? fp.data : [];
    let st = arr.find(x => x.tel === tel);
    if (!st) { st = { tel, disponible: false }; arr.push(st); }
    st.lat = lat; st.lng = lng; st.tsGPS = now;
    await ghPut('pilots.json', fp ? fp.sha : null, arr, 'gps ' + tel);
    return res.status(200).json({ ok: true });
  }

  // ---- CALIFICACIONES: cliente ⇄ piloto, 1 a 5 estrellas ----
  if (action === 'calificar') {
    const id = String(b.id || '').trim(), quien = b.quien === 'piloto' ? 'piloto' : 'cliente';
    const estrellas = Math.min(5, Math.max(1, Math.round(+b.estrellas || 0)));
    const tel = String(b.tel || '').trim();
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const o = peds.find(x => x.id === id);
    if (!o) return res.status(200).json({ ok: false, error: 'Pedido no encontrado.' });
    if (quien === 'cliente' && o.cliente.tel !== tel) return res.status(200).json({ ok: false, error: 'No es tu pedido.' });
    if (quien === 'piloto' && (!o.piloto || o.piloto.tel !== tel)) return res.status(200).json({ ok: false, error: 'No es tu pedido.' });
    if (o.estado !== 'entregado') return res.status(200).json({ ok: false, error: 'Se califica al entregar.' });
    if (quien === 'cliente' && o.califCliente) return res.status(200).json({ ok: false, error: 'Ya calificaste.' });
    if (quien === 'piloto' && o.califPiloto) return res.status(200).json({ ok: false, error: 'Ya calificaste.' });
    if (quien === 'cliente') o.califCliente = estrellas; else o.califPiloto = estrellas;
    await ghPut('pedidos.json', fpd.sha, peds, 'calificacion ' + id);
    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: false, error: 'Acción desconocida: ' + action });
});
