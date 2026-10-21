// DragoExpres — Pedidos reales + pantalla de piloto + dispatch automático.
// Datos en la bodega privada, rama dragoexpres-data:
//   pedidos.json  (pedidos) · pilots.json (disponibilidad y ganancias de pilotos)
// Dispatch: al crear un pedido se asigna SOLO al primer piloto disponible
// de la zona (FIFO por disponibilidad). Si no hay, queda 'buscando' y los
// pilotos de la zona pueden tomarlo desde su pantalla. Efectivo directo
// usuario↔piloto↔local: DragoExpres no toca el dinero; las comisiones
// Comisiones: 5% del envío comida/repuestos + Q2-Q5 viajes; al local 10% de la compra en comida y repuestos tras 90 días de zona.
const wrap = require('./_cors');
// horario de atencion: null/undefined = abierto siempre; soporta cruce de medianoche
const abiertoAhora = (h, abre, cierra) => {
  if (abre === undefined || abre === null || cierra === undefined || cierra === null) return true;
  if (abre === cierra) return true;
  if (abre < cierra) return h >= abre && h < cierra;
  return h >= abre || h < cierra;
};
const { REPO, BRANCH, H, ensureBranch } = require('./_dx');
const { pushA } = require('./_push');

const TZ = 6 * 3600 * 1000; // GT = UTC-6
const hoy = () => new Date(Date.now() - TZ).toISOString().slice(0, 10);
const COMP_GAS = 5; // Q de gasolina por viaje cancelado con piloto en camino
async function compensarPiloto(tel, id) {
  try {
    const fp = await ghGet('pilots.json'); const arr = fp ? fp.data : [];
    const st = arr.find(x => x.tel === tel);
    if (!st) return 0;
    st.compensa = dinero((st.compensa || 0) + COMP_GAS);
    st.compensaN = (st.compensaN || 0) + 1;
    st.compensaPedidos = st.compensaPedidos || []; st.compensaPedidos.push(id);
    await ghPut('pilots.json', fp.sha, arr, 'compensacion gasolina ' + tel + ' ' + id);
    return st.compensa;
  } catch (e) { return 0; }
}
const semana = () => 'S' + Math.floor((Date.now() - TZ) / (7 * 864e5));
const dinero = (q) => { const n = Number(q); return (isNaN(n) || !isFinite(n) || n < 0) ? 0 : Math.round(n * 100) / 100; };
const dig = (t) => { const d = String(t || '').replace(/\D/g, ''); return d.length > 8 ? d.slice(-8) : d; };

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
async function pushATel(telD, obj) {
  try {
    const f = await ghGet('pushsubs.json'); const all = (f ? f.data : []).filter(s => s && s.endpoint && s.keys);
    const subs = all.filter(s => dig(s.tel) === dig(telD));
    if (!subs.length) return;
    const r = await pushA(subs, obj);
    if (r.vivas.length !== subs.length) {
      const muertas = new Set(subs.filter(s => !r.vivas.some(v => v.endpoint === s.endpoint)).map(s => s.endpoint));
      await ghPut('pushsubs.json', f.sha, all.filter(s => !muertas.has(s.endpoint)), 'push: limpia suscripciones muertas');
    }
  } catch (e) { }
}
async function aviso(texto) {
  try {
    const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID || '8022768138';
    if (!tok) return;
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: texto }) });
  } catch (e) { }
}
const PCT_LOCAL = 0.10, GRACIA_LOCAL_MS = 90 * 864e5; // 10% al local tras 90 dias de operar la zona (intermedio vs las grandes)
const CUENTA_LIQ = 'Banco Industrial, cuenta monetaria No. 7171286805, a nombre de Andrea Ester Perez Acosta';
// Turno nocturno (23:00-06:00 GT): recargo Q5 que paga el cliente, 100% para el piloto (como la propina)
const RECARGO_NOCHE = 5;
function horaGT(ts) { return (new Date(ts).getUTCHours() + 18) % 24; } // GT = UTC-6
function esNoche(ts) { const h = horaGT(ts); return h >= 23 || h < 6; }
function comisionDe(tipo, envio) {
  const e = dinero(envio);
  if (tipo === 'comida') return dinero(e * 0.05);   // 5% del envío: al piloto le queda CASI TODO (las grandes se quedan con 20-30%)
  if (tipo === 'repuesto') return dinero(e * 0.05);
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
      if (o.promoFiel) { o.expiros = (o.expiros || 0) + 1; if (o.expiros % 2 === 0 && (o.promoBonus || 0) < 15) o.promoBonus = dinero((o.promoBonus || 0) + 5); }
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
// cada piloto trabaja SOLO en lo que eligió al registrarse (sin servicios definidos = todos, compatibilidad)
const svOk = (r, tipo) => { const sv = { comida: 'comida', repuesto: 'repuestos', viaje: 'viajes' }[tipo] || 'comida'; const s = r && r.datos && r.datos.servicios; return !Array.isArray(s) || !s.length || s.indexOf(sv) >= 0; };

// ---- CONTRAOFERTA DE VIAJES (estilo InDrive): el piloto pide mas, el cliente decide en 30s (60s si hay pocos pilotos) ----
async function candidatosViaje(zona, excluir) {
  const fp = await ghGet('pilots.json'); const pilots = fp ? fp.data : [];
  const fr = await ghGet('registros.json'); const reg = fr ? fr.data : [];
  const aprobados = new Set(reg.filter(r => r.tipo === 'piloto' && r.estado === 'aprobado').map(r => dig(r.datos.tel)));
  const fpd = await ghGet('pedidos.json');
  const ocupados = new Set((fpd ? fpd.data : []).filter(o => o.piloto && ['asignado', 'aceptado', 'en_camino', 'contraoferta'].includes(o.estado)).map(o => dig(o.piloto.tel)));
  return pilots.filter(x => x.disponible && !(x.pendiente && !x.pendiente.pagado) && aprobados.has(dig(x.tel)) && !ocupados.has(dig(x.tel)) && !excluir.includes(x.tel))
    .filter(x => { const r = reg.find(y => y.tipo === 'piloto' && dig(y.datos.tel) === dig(x.tel)); return r && r.datos.zona === zona && svOk(r, 'viaje') && r.datos.vehiculo !== 'bicicleta'; });
}

async function redispatchViaje(o, peds, sha) {
  const ex = (o.rechazadoPor || []).concat(o.contraRechazos || []);
  const cand = await candidatosViaje(o.zona, ex);
  if (cand.length) {
    const fr = await ghGet('registros.json'); const reg = fr ? fr.data : [];
    const r = reg.find(y => y.tipo === 'piloto' && dig(y.datos.tel) === dig(cand[0].tel));
    o.estado = 'asignado'; o.tsAsignado = Date.now(); o.piloto = Object.assign({ tel: cand[0].tel, nombre: r.datos.nombre }, vehInfo(r.datos));
  } else { o.estado = 'buscando'; o.piloto = null; }
  o.contra = null;
  await ghPut('pedidos.json', sha, peds, 'viaje vuelve a busqueda ' + o.id);
}

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
  if (['promoAdd','promoDel','servAdd','servDel'].includes(action)) {
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
      m.promos.push({ id: String(now) + String(Math.floor(Math.random() * 90) + 10), titulo, detalle, foto: String(b.foto || '').slice(0, 300), ts: now });
    } else if (action === 'servAdd') {
      const nombre = String(b.nombre || '').trim().slice(0, 90);
      const precio = dinero(b.precio || 0);
      const mecanico = String(b.mecanico || '').trim().slice(0, 60);
      const veh = b.veh === 'moto' ? 'moto' : 'carro';
      const marca = String(b.marca || '').trim().slice(0, 40);
      const color = String(b.color || '').trim().slice(0, 40);
      const placa = String(b.placa || '').trim().slice(0, 20);
      if (!nombre || !precio) return res.status(200).json({ ok: false, error: 'Poné el nombre del servicio y su precio.' });
      m.servicios = m.servicios || [];
      if (m.servicios.length >= 6) return res.status(200).json({ ok: false, error: 'Máximo 6 servicios activos.' });
      m.servicios.push({ id: String(now) + String(Math.floor(Math.random() * 90) + 10), nombre, precio, mecanico, veh, marca, color, placa, ts: now });
    } else if (action === 'servDel') {
      const sid = String(b.servId || '');
      m.servicios = (m.servicios || []).filter(x => x.id !== sid);
    } else {
      const pid = String(b.promoId || '');
      m.promos = (m.promos || []).filter(x => x.id !== pid);
    }
    await ghPut('menus.json', fm ? fm.sha : null, arr, action + ' ' + tel);
    if (action.startsWith('serv')) return res.status(200).json({ ok: true, servicios: m.servicios || [] });
    return res.status(200).json({ ok: true, promos: m.promos || [] });
  }

  // ---- PILOTO: login (tel + placa) ----
  if (action === 'pushSub') {
    const tel = String(b.tel || '').replace(/\D/g, '').slice(0, 15), zona = String(b.zona || '').slice(0, 60);
    const s = b.sub || {};
    if (!s.endpoint || !(s.keys || {}).p256dh || !(s.keys || {}).auth) return res.status(200).json({ ok: false, error: 'Suscripción inválida.' });
    const f = await ghGet('pushsubs.json');
    const arr = (f ? f.data : []).filter(x => x.endpoint !== s.endpoint && x.endpoint);
    arr.push({ endpoint: String(s.endpoint).slice(0, 400), keys: { p256dh: String(s.keys.p256dh).slice(0, 200), auth: String(s.keys.auth).slice(0, 120) }, tel, zona, ts: now });
    await ghPut('pushsubs.json', f ? f.sha : null, arr, 'pushsub ' + tel);
    return res.status(200).json({ ok: true });
  }
  if (action === 'pushUnsub') {
    const f = await ghGet('pushsubs.json');
    if (f) {
      const quedan = f.data.filter(x => x.endpoint !== String(b.endpoint || ''));
      await ghPut('pushsubs.json', f.sha, quedan, 'pushunsub');
    }
    return res.status(200).json({ ok: true });
  }
  if (action === 'loginPiloto') {
    const tel = String(b.tel || '').trim(), placa = String(b.placa || '').trim().toUpperCase();
    const f = await ghGet('registros.json');
    const reg = f ? f.data : [];
    const p = reg.find(r => r.tipo === 'piloto' && r.estado === 'aprobado' && dig(r.datos.tel) === dig(tel));
    if (!p) return res.status(200).json({ ok: false, error: 'No encontramos un piloto aprobado con ese WhatsApp.' });
    if (p.datos.placa && String(p.datos.placa).trim().toUpperCase() !== placa) return res.status(200).json({ ok: false, error: 'La placa no coincide.' });
    const fp = await ghGet('pilots.json');
    const st = (fp ? fp.data : []).find(x => x.tel === tel) || { tel, disponible: false };
    const debePend = !!(st.pendiente && !st.pendiente.pagado);
    const fpd = await ghGet('pedidos.json');
    const peds = fpd ? fpd.data : [];
    await expirarAsignados(peds, fpd ? fpd.sha : null);
    const mio = peds.filter(o => o.piloto && o.piloto.tel === tel && !['entregado', 'cancelado'].includes(o.estado));
    const zona = peds.filter(o => o.estado === 'buscando' && o.zona === p.datos.zona);
    const califs = peds.filter(o => o.piloto && o.piloto.tel === tel && o.califCliente > 0);
    const calif = califs.length ? Math.round(califs.reduce((x, o) => x + o.califCliente, 0) / califs.length * 10) / 10 : null;
    const zonaF = zona.filter(o => !(o.rechazadoPor || []).includes(tel));
    return res.status(200).json({ ok: true, piloto: { nombre: p.datos.nombre, zona: p.datos.zona, servicios: (p.datos && Array.isArray(p.datos.servicios)) ? p.datos.servicios : null, vehiculo: p.datos.vehiculo, marca: p.datos.marca || '', color: p.datos.color || '', placa: p.datos.placa || '', propio: !!p.datos.propio, disponible: st.disponible, ganadoHoy: st.ganadoHoy || 0, ganadoSemana: st.ganadoSemana || 0, pedidosHoy: st.pedidosHoy || 0, racha: st.racha || 0, boletosExtra: st.boletosExtra || 0, compensa: st.compensa || 0, compensaN: st.compensaN || 0, calif: calif, pendiente: st.pendiente || null, saldoChico: st.saldoChico || 0, pendienteActivo: debePend, avisoPendiente: debePend ? ('Tenés Q' + st.pendiente.monto + ' de comisiones por liquidar. Depositá o transferí a: ' + CUENTA_LIQ + '. Después avisale al admin por WhatsApp con tu nombre. En cuanto confirme volvés a recibir pedidos como si nada. Si tuviste un motivo del retraso, contáselo: puede devolverte la racha del pozo.') : null, retraso: !!st.retraso }, activo: mio[0] || null, zonaBuscando: zonaF });
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
    const TARIFA_FIJA = { comida: 15, repuesto: 20, viaje: 25 }; // tarifa fija DragoExpres: MAS BARATA que las apps grandes (InDrive ~Q27 a Oakland, PedidosYa Q15-25 + cargos)
    const nocturno = esNoche(now);
    const recargo = nocturno ? RECARGO_NOCHE : 0;
    const envioTarifa = TARIFA_FIJA[tipo] + recargo; // de noche +Q5 (100% para el piloto, sin comisión)
    // 🎁 PROMO CLIENTE FIEL (regla de Juan): cada 30 pedidos ENTREGADOS, el SIGUIENTE va con ENVÍO GRATIS.
    // El piloto cobra su envío completo como cashback (bonosPend) y se netea en la liquidación de 72h:
    // lo pagan las comisiones que ese mismo cliente ya generó. Nadie pone de su bolsa.
    let promoFiel = false, entFiel = 0;
    {
      const ff = await ghGet('pedidos.json');
      const miosF = (ff ? ff.data : []).filter(x => dig(String((x.cliente || {}).tel || '')) === dig(tel));
      entFiel = miosF.filter(x => x.estado === 'entregado').length;
      const yaUso = miosF.some(x => x.promoFiel && x.estado === 'entregado'); // UNA SOLA VEZ por usuario (regla de Juan): si su envío gratis llegó, jamás se repite
      if (entFiel > 0 && entFiel % 30 === 0 && !yaUso) promoFiel = true;
    }
    const envio = promoFiel ? 0 : envioTarifa;
    const propina = Math.max(0, dinero(b.propina || 0)); // voluntaria, 100% para el piloto
    const pago = b.pago === 'transferencia' ? 'transferencia' : 'efectivo';
    const referencia = pago === 'transferencia' ? String(b.refbanco || '').trim().slice(0, 40) : '';
    const id = 'DX' + String(now).slice(-6) + String(Math.floor(Math.random() * 90) + 10);
    const localObj = b.local && b.local.tel ? { nombre: String(b.local.nombre || '').slice(0, 60), tel: String(b.local.tel).replace(/\D/g, '').slice(0, 25) } : null;
    if (localObj) {
      const fl = await ghGet('locales.json');
      const rowL = (fl ? fl.data : []).find(x => x.tel === localObj.tel) || {};
      const pausa = rowL.hasta > now;
      if (pausa) {
        const mins = Math.max(1, Math.ceil((rowL.hasta - now) / 60000));
        return res.status(200).json({ ok: false, error: localObj.nombre + ' está saturado ahora. Probá de nuevo en ' + mins + ' minuto(s) o pedí de otro local.' });
      }
      if (rowL.horarioAbre !== undefined && rowL.horarioCierra !== undefined) {
        const horaGT = new Date(now - TZ).getUTCHours();
        if (!abiertoAhora(horaGT, rowL.horarioAbre, rowL.horarioCierra)) {
          const hh = (x) => String(x).padStart(2, '0') + ':00';
          return res.status(200).json({ ok: false, error: localObj.nombre + ' está CERRADO ahora. Abre a las ' + hh(rowL.horarioAbre) + ' (atiende de ' + hh(rowL.horarioAbre) + ' a ' + hh(rowL.horarioCierra) + ').' });
        }
      }
    }
    const compra = dinero(b.compra || 0);
    // servicio mecanico del taller (extra, como el postre): lo elige el cliente, el taller puso su precio
    let servicio = null;
    if (localObj && b.servicio) {
      const fms = await ghGet('menus.json');
      const mm = fms ? fms.data.find(x => x.tel === localObj.tel) : null;
      servicio = (mm && (mm.servicios || []).find(s => s.id === String(b.servicio))) || null;
    }
    let comisionLocal = 0;
    const baseLocal = compra + (servicio ? servicio.precio : 0);
    if ((tipo === 'comida' || tipo === 'repuesto') && baseLocal > 0) { // 10% al local en comida Y repuestos (mercado virgen), con 90 dias de gracia por zona
      const fprev = await ghGet('pedidos.json');
      const prev = (fprev ? fprev.data : []).filter(x => x.zona === zona && x.ts);
      const primera = prev.length ? Math.min(...prev.map(x => x.ts)) : now;
      if (now - primera >= GRACIA_LOCAL_MS) comisionLocal = dinero(baseLocal * PCT_LOCAL);
    }
    const pedido = {
      id, tipo, zona,
      cliente: { nombre, tel, direccion: String(b.direccion).slice(0, 500), referencia: String(b.referencia || '').slice(0, 500) },
      detalle: String(b.detalle).slice(0, 800),
      items: Array.isArray(b.items) ? b.items.slice(0, 30).map(x => ({ nombre: String(x.nombre || '').slice(0, 60), qty: Math.max(1, Math.min(50, +x.qty || 1)), precio: dinero(x.precio || 0), nota: String(x.nota || '').slice(0, 120) })) : undefined,
      compra: dinero(b.compra || 0), servicio: servicio || undefined, envio, promoFiel: promoFiel || undefined, promoTarifa: promoFiel ? envioTarifa : undefined, propina, comision: promoFiel ? 0 : comisionDe(tipo, envioTarifa - recargo), comisionLocal, nocturno, recargo,
      estado: 'buscando', piloto: null, ts: now, pago, referencia, local: localObj || undefined, avisoWa: b.avisoWa !== false
    };
    // dispatch: primer piloto disponible de la zona
    const fp = await ghGet('pilots.json'); const pilots = fp ? fp.data : [];
    const fr = await ghGet('registros.json'); const reg = fr ? fr.data : [];
    const aprobados = new Set(reg.filter(r => r.tipo === 'piloto' && r.estado === 'aprobado').map(r => dig(r.datos.tel)));
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const ocupados = new Set(peds.filter(o => o.piloto && ['asignado', 'aceptado', 'en_camino'].includes(o.estado)).map(o => dig(o.piloto.tel)));
    const cand = pilots.filter(x => x.disponible && !(x.pendiente && !x.pendiente.pagado) && aprobados.has(dig(x.tel)) && !ocupados.has(dig(x.tel)))
      .filter(x => { const r = reg.find(y => y.tipo === 'piloto' && dig(y.datos.tel) === dig(x.tel)); return r && r.datos.zona === zona && svOk(r, tipo) && (tipo !== 'viaje' || r.datos.vehiculo !== 'bicicleta'); })
      .sort((a, b2) => {
        if (nocturno) { // de noche: primero los turnos 24hrs, después los demás (FIFO)
          const ra = reg.find(y => y.tipo === 'piloto' && dig(y.datos.tel) === dig(a.tel));
          const rb = reg.find(y => y.tipo === 'piloto' && dig(y.datos.tel) === dig(b2.tel));
          const ha = ra && ra.datos.h24 ? 1 : 0, hb = rb && rb.datos.h24 ? 1 : 0;
          if (ha !== hb) return hb - ha;
        }
        return (a.desde || 0) - (b2.desde || 0);
      });
    if (cand.length) {
      const r = reg.find(y => y.tipo === 'piloto' && dig(y.datos.tel) === dig(cand[0].tel));
      pedido.estado = 'asignado';
      pedido.tsAsignado = now;
      pedido.piloto = Object.assign({ tel: cand[0].tel, nombre: r.datos.nombre }, vehInfo(r.datos));
      const st = pilots.find(x => x.tel === cand[0].tel);
      // el piloto asignado queda "ocupado" hasta entregar/rechazar
    }
    pedido.etaMin = { comida: 35, repuesto: 50, viaje: 25 }[tipo] || 40; // tiempo estimado (lo ve el cliente en el tracker)
    peds.push(pedido);
    await ghPut('pedidos.json', fpd ? fpd.sha : null, peds, 'pedido nuevo ' + id);
    const ic = { comida: '🍔', viaje: '🛺', repuesto: '🔧' }[tipo];
    await aviso(`🚀 DRAGOEXPRES — PEDIDO NUEVO ${ic}\n${id} · ${tipo.toUpperCase()} · ${zona}\nCliente: ${nombre} (${tel})\n${pedido.local ? 'Local: ' + pedido.local.nombre + ' · ' : ''}Detalle: ${String(b.detalle).slice(0, 120)}${servicio ? '\n🔧 Servicio mecánico: ' + servicio.nombre + ' Q' + servicio.precio + ' (mecánico: ' + servicio.mecanico + ', llega en ' + servicio.veh + ' ' + servicio.color + ' ' + servicio.marca + ', placa ' + servicio.placa + ')' : ''}\nEnvío: Q${envio} (tarifa fija)${recargo ? ' · 🌙 Incluye recargo nocturno Q' + recargo + ' (100% piloto, sin comisión)' : ''}${propina ? ' · Propina voluntaria: Q' + propina + ' (100% piloto)' : ''} · Comisión DragoExpres: Q${pedido.comision}${pedido.comisionLocal ? ' · 10% al local (zona operativa >90 días): Q' + pedido.comisionLocal : ''}\n${pago === 'transferencia' ? '💳 Pago: TRANSFERENCIA al Banco Industrial' + (referencia ? ' · Ref: ' + referencia : ' · (sin referencia, verificar)') : '💵 Pago: EFECTIVO al piloto'}${promoFiel ? '\n🎁 ENVÍO GRATIS — PROMO CLIENTE FIEL: pedido n.º ' + (entFiel + 1) + ' del cliente (promo cliente fiel LIMITADA: 30 pedidos entregados = su envío gratis, UNA SOLA VEZ por usuario). El piloto cobra su envío COMPLETO (Q' + envioTarifa + ') como cashback en la liquidación de 72h. Lo pagan las comisiones que este cliente ya generó: NO sale de tu bolsa.' : ''}\n${pedido.piloto ? '→ Asignado AUTOMÁTICAMENTE a: ' + pedido.piloto.nombre + ' (' + pedido.piloto.tel + ')' : '→ SIN piloto disponible ahora, queda BUSCANDO'}`);
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
    const hoyStr = new Date(now - TZ).toISOString().slice(0, 10);
    const cancelHoy = mios.filter(x => x.estado === 'cancelado' && new Date((x.canceladoTs || 0) - TZ).toISOString().slice(0, 10) === hoyStr).slice(-3);
    const gL = new Date(now - 21600000); const lunesL = new Date(gL); lunesL.setUTCDate(gL.getUTCDate() - ((gL.getUTCDay() + 6) % 7)); lunesL.setUTCHours(0, 0, 0, 0); const iniSemL = lunesL.getTime() + 21600000;
    const entSem = mios.filter(x => x.estado === 'entregado' && (x.tsEntregado || x.ts) >= iniSemL);
    const ventasSemana = dinero(entSem.reduce((s2, x) => s2 + (+x.compra || 0), 0));
    const rowH = (fl ? fl.data : []).find(x => x.tel === tel) || {};
    return res.status(200).json({ ok: true, local: { nombre: r.datos.nombre, zona: r.datos.zona, tel, rubro: String((r.datos && (r.datos.rubro || r.datos.tipo)) || 'comida'), fotoLocal: r.datos.fotoLocal || '', abre: rowH.horarioAbre !== undefined ? rowH.horarioAbre : null, cierra: rowH.horarioCierra !== undefined ? rowH.horarioCierra : null }, activos: activos.slice(-10).reverse(), totalEntregados: mios.filter(x => x.estado === 'entregado').length, ventasSemana, entregasSemana: entSem.length, pausa: pausa ? pausa.hasta : null, cancelHoy });
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

  // ---- LOCAL: horario de atencion (regla: fuera de horario no entran pedidos) ----
  if (action === 'horario') {
    const tel = String(b.tel || '').replace(/\D/g, '');
    const abre = parseInt(b.abre), cierra = parseInt(b.cierra);
    const freg = await ghGet('registros.json');
    const rl = (freg ? freg.data : []).find(x => x.tipo === 'local' && x.estado === 'aprobado' && String(x.datos.whatsapp || x.datos.tel || '').replace(/\D/g, '') === tel);
    if (!rl) return res.status(200).json({ ok: false, error: 'No encontramos un local aprobado con ese WhatsApp.' });
    const fl = await ghGet('locales.json'); const arr = fl ? fl.data : [];
    let row = arr.find(x => x.tel === tel);
    if (isNaN(abre) || isNaN(cierra)) { if (row) { delete row.horarioAbre; delete row.horarioCierra; } }
    else { if (!row) { row = { tel }; arr.push(row); } row.horarioAbre = abre; row.horarioCierra = cierra; }
    await ghPut('locales.json', fl ? fl.sha : null, arr, 'horario local ' + tel);
    return res.status(200).json({ ok: true, abre: isNaN(abre) ? null : abre, cierra: isNaN(cierra) ? null : cierra });
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
    return res.status(200).json({ ok: true, items: (m && m.items) || [], promos: (m && m.promos) || [], servicios: (m && m.servicios) || [] });
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
      const CATS = ['Platos fuertes', 'Combos', 'Entradas', 'Bebidas', 'Postres', 'Repuestos de moto', 'Repuestos de carro', 'Aceites y líquidos', 'Llantas y ruedas', 'Baterías', 'Accesorios', 'Herramientas', 'Productos', 'Abarrotería', 'Snacks', 'Higiene y limpieza', 'Repuestos', 'Otros'];
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
      if (b.categoria !== undefined && ['Platos fuertes', 'Combos', 'Entradas', 'Bebidas', 'Postres', 'Repuestos de moto', 'Repuestos de carro', 'Aceites y líquidos', 'Llantas y ruedas', 'Baterías', 'Accesorios', 'Herramientas', 'Productos', 'Abarrotería', 'Snacks', 'Higiene y limpieza', 'Repuestos', 'Otros'].includes(b.categoria)) it.categoria = b.categoria;
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
    const texto = String(b.texto || '').trim().slice(0, 800);
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
    const ganado = dinero(mios.reduce((s, x) => s + (x.envio - x.comision + (x.propina || 0)), 0));
    const comisiones = dinero(mios.reduce((s, x) => s + (x.comision || 0) + (x.comisionLocal || 0), 0));
    const califs = mios.filter(x => x.califCliente > 0);
    const calif = califs.length ? Math.round(califs.reduce((s, x) => s + x.califCliente, 0) / califs.length * 10) / 10 : null;
    // comisiones NETAS: lo que muestra el piloto siempre coincide con lo que deposita (premios ya aplicados, nunca se nota la diferencia)
    const g = new Date(now - 21600000);
    const lunes = new Date(g);
    lunes.setUTCDate(g.getUTCDate() - ((g.getUTCDay() + 6) % 7));
    lunes.setUTCHours(0, 0, 0, 0);
    const iniSem = lunes.getTime() + 21600000;
    const semana = mios.filter(x => (x.tsEntregado || x.ts) >= iniSem).length;
    const fp = await ghGet('pilots.json');
    const st = (fp ? fp.data : []).find(x => String(x.tel).replace(/\D/g, '') === tel) || {};
    let metaEfe = st.metaP || 20;
    try { const pz2 = await ghGet('pozo.json'); const pg = pz2 ? pz2.data : {}; metaEfe = Math.min(st.metaP || 20, pg.metaGlobal || 20); } catch (e) { }
    const historial = mios.slice(-15).reverse().map(x => ({ id: x.id, tipo: x.tipo, ganado: dinero((x.promoFiel ? (x.promoTarifa || 0) + (x.promoBonus || 0) : x.envio) - x.comision + (x.propina || 0)), envio: x.promoFiel ? 0 : x.envio, propina: x.propina || 0, ts: x.tsEntregado || x.ts }));
    const resenas = califs.slice(-10).reverse().map(x => ({ id: x.id, estrellas: x.califCliente, texto: String(x.califClienteTxt || ''), ts: x.tsEntregado || x.ts }));
    return res.status(200).json({ ok: true, entregas: mios.length, resenas, ganado, comisiones: dinero(comisiones - (st.bonosAplicados || 0)), calif, bonosPend: dinero(st.bonosPend || 0), bonoBienvenida: st.bonoBienvenida || null, pendiente: st.pendiente || null, saldoChico: st.saldoChico || 0, pendienteActivo: !!(st.pendiente && !st.pendiente.pagado), retraso: !!st.retraso, meta: { hechas: semana, faltan: Math.max(0, metaEfe - semana), meta: metaEfe }, historial });
  }

  // ---- consultar estado (usuario o pantalla) ----
  if (action === 'estado') {
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    await expirarAsignados(peds, fpd ? fpd.sha : null);
    if (b.id) {
      let o = peds.find(x => x.id === String(b.id).trim());
      if (!o) return res.status(200).json({ ok: false, error: 'Pedido no encontrado.' });
      if (o.estado === 'contraoferta' && o.contra && Date.now() > o.contra.expira) {
        o.contraRechazos = (o.contraRechazos || []).concat([o.piloto.tel]); o.contraExpiro = Date.now();
        await redispatchViaje(o, peds, fpd.sha);
        o = peds.find(x => x.id === String(b.id).trim());
      }
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
    const fl = await ghGet('locales.json'); const lrows = fl ? fl.data : [];
    const horaGT = new Date(Date.now() - TZ).getUTCHours();
    const loc = regs.filter(r => r.tipo === 'local' && r.estado === 'aprobado').map(r => {
      const tel = String((r.datos && (r.datos.whatsapp || r.datos.tel)) || '').replace(/\D/g, '');
      const row = lrows.find(x => x.tel === tel) || {};
      const tieneHor = row.horarioAbre !== undefined && row.horarioCierra !== undefined;
      return {
        nombre: (r.datos && r.datos.nombre) || r.nombre || 'Local',
        zona: (r.datos && r.datos.zona) || r.zona || '',
        tel, rubro: (r.datos && (r.datos.rubro || r.datos.tipo)) || 'Comida',
        fotoLocal: (r.datos && r.datos.fotoLocal) || '',
        abre: tieneHor ? row.horarioAbre : null, cierra: tieneHor ? row.horarioCierra : null,
        abierto: tieneHor ? abiertoAhora(horaGT, row.horarioAbre, row.horarioCierra) : true,
        pausado: !!(row.hasta && row.hasta > Date.now()),
      };
    });
    return res.status(200).json({ ok: true, locales: loc });
  }

  // historial de pedidos del cliente (hasta 30, mas recientes primero)
  if (action === 'misp') {
    const tel = String(b.tel || '').replace(/\D/g, '');
    if (!tel) return res.status(200).json({ ok: false, error: 'Decinos tu numero.' });
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const mios = peds.filter(x => String(x.cliente && x.cliente.tel || '').replace(/\D/g, '') === tel).slice(-30).reverse();
    const entF = peds.filter(x => String(x.cliente && x.cliente.tel || '').replace(/\D/g, '') === tel && x.estado === 'entregado').length;
    const usado = peds.some(x => String(x.cliente && x.cliente.tel || '').replace(/\D/g, '') === tel && x.promoFiel && x.estado === 'entregado');
    return res.status(200).json({ ok: true, pedidos: mios, fiel: { entregas: entF, promoAhora: !usado && entF > 0 && entF % 30 === 0, faltan: entF % 30 === 0 ? 0 : 30 - (entF % 30), usado } });
  }


  // ---- CANCELACIONES ----
  if (action === 'localFoto') {
    const tel = String(b.tel || '').replace(/\D/g, '');
    const foto = String(b.foto || '').slice(0, 300);
    if (!tel || !foto) return res.status(200).json({ ok: false, error: 'Faltan datos de la foto.' });
    const fr = await ghGet('registros.json'); const reg = fr ? fr.data : [];
    const r = reg.find(x => x.tipo === 'local' && x.estado === 'aprobado' && String(x.datos.whatsapp || x.datos.tel || '').replace(/\D/g, '') === tel);
    if (!r) return res.status(200).json({ ok: false, error: 'Solo locales aprobados pueden subir su foto.' });
    r.datos.fotoLocal = foto;
    await ghPut('registros.json', fr ? fr.sha : null, reg, 'foto del local ' + tel);
    await aviso(`🏪 DRAGOEXPRES — Foto del local\n${r.datos.nombre} actualizó la foto de su local (la ven los clientes en la lista).`);
    return res.status(200).json({ ok: true, fotoLocal: foto });
  }
  if (action === 'localCancela') {
    const tel = String(b.tel || '').replace(/\D/g, '');
    const id = String(b.id || '');
    const razon = String(b.razon || '').trim().slice(0, 80);
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const o = peds.find(x => x.id === id);
    if (!o || ['entregado', 'cancelado'].includes(o.estado)) return res.status(200).json({ ok: false, error: 'Este pedido ya cerró.' });
    if (!o.local || String(o.local.tel).replace(/\D/g, '') !== tel) return res.status(200).json({ ok: false, error: 'No es un pedido de tu local.' });
    const teniaPiloto = !!(o.piloto && ['asignado', 'aceptado', 'en_camino'].includes(o.estado));
    const salioConPiloto2 = !!(o.piloto && o.estado === 'en_camino');
    const telPiloto2 = o.piloto ? o.piloto.tel : null;
    o.estado = 'cancelado'; o.canceladoPor = 'local'; o.canceladoRazon = razon; o.canceladoTs = now;
    if (salioConPiloto2) o.compensa = COMP_GAS;
    await ghPut('pedidos.json', fpd.sha, peds, 'local cancela ' + id);
    if (salioConPiloto2 && telPiloto2) await compensarPiloto(telPiloto2, id);
    await aviso('🚀 DRAGOEXPRES — ' + id + '\n🏪 El local canceló el pedido' + (razon ? ' (' + razon + ')' : '') + (teniaPiloto ? '. El piloto queda LIBRE y su racha NO se rompe.' : '') + '. El cliente no fue cobrado.' + (salioConPiloto2 ? '\n⛽ Q' + COMP_GAS + ' de gasolina acreditados al piloto (salen de SUS comisiones en la próxima liquidación de 72h).' : ''));
    return res.status(200).json({ ok: true, pedido: o });
  }
  if (action === 'clienteCancela') {
    const tel = String(b.tel || '').replace(/\D/g, '');
    const id = String(b.id || '');
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const o = peds.find(x => x.id === id);
    if (!o || ['entregado', 'cancelado'].includes(o.estado)) return res.status(200).json({ ok: false, error: 'Este pedido ya cerró.' });
    if (String(o.cliente.tel).replace(/\D/g, '') !== tel) return res.status(200).json({ ok: false, error: 'No es tu pedido.' });
    const conViaje = !!(o.piloto && ['asignado', 'aceptado', 'en_camino'].includes(o.estado));
    const cancelos = peds.filter(x => x.canceladoPor === 'cliente' && x.canceloConViaje && String(x.cliente.tel).replace(/\D/g, '') === tel).length;
    if (conViaje && cancelos >= 2) return res.status(200).json({ ok: false, error: 'Cancelaste varios viajes con el piloto ya en camino. Escribí al chat de soporte para poder volver a pedir.' });
    const salioConPiloto = !!(o.piloto && o.estado === 'en_camino');
    o.estado = 'cancelado'; o.canceladoPor = 'cliente'; o.canceladoTs = now; o.canceloConViaje = conViaje;
    if (conViaje) { o.pilotoAlCancelar = o.piloto ? { nombre: o.piloto.nombre, tel: o.piloto.tel } : null; o.piloto = null; }
    if (salioConPiloto) o.compensa = COMP_GAS;
    await ghPut('pedidos.json', fpd.sha, peds, 'cliente cancela ' + id);
    if (salioConPiloto && o.pilotoAlCancelar) await compensarPiloto(o.pilotoAlCancelar.tel, id);
    await aviso(conViaje
      ? '🚀 DRAGOEXPRES — ' + id + '\n🧑⚠️ El cliente canceló CON EL PILOTO EN CAMINO. El piloto quedó libre, su racha sigue viva. Cancelaciones de este cliente con viaje: ' + (cancelos + 1) + '.' + (salioConPiloto ? '\n⛽ Compensación de gasolina Q' + COMP_GAS + ' acreditada al piloto (se descuenta de SUS comisiones en la próxima liquidación de 72h, vos no pones nada).' : '')
      : '🚀 DRAGOEXPRES — ' + id + '\n🧑 El cliente canceló mientras buscábamos piloto. Nadie pierde nada.');
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
    const brutoNR = o.promoFiel ? dinero((o.promoTarifa || 0) + (o.promoBonus || 0)) : o.envio;
    const neto = dinero(brutoNR - o.comision);
    if (o.promoFiel) st.bonosPend = dinero((st.bonosPend || 0) + brutoNR);
    st.ganadoHoy = dinero((st.ganadoHoy || 0) + neto); st.ganadoSemana = dinero((st.ganadoSemana || 0) + neto);
    st.pedidosHoy = (st.pedidosHoy || 0) + 1;
    st.racha = (st.racha || 0) + 1;
    if (st.racha % 3 === 0) st.boletosExtra = (st.boletosExtra || 0) + 1;
    if (o.nocturno) st.boletosExtra = (st.boletosExtra || 0) + 1; // 🌙 boleto extra por entrega nocturna
    await ghPut('pilots.json', fp ? fp.sha : null, arr, 'cobrado no-responde ' + id);
    await aviso('🚀 DRAGOEXPRES — ' + id + '\n⏱️ Cerrado tras 10 minutos sin respuesta del cliente. El piloto cobra COMPLETO su envío (Q' + neto + ').');
    return res.status(200).json({ ok: true, pedido: o });
  }
  }
  // ---- piloto pide mas por un VIAJE (contraoferta estilo InDrive) ----
  if (action === 'pedirMas') {
    const tel = String(b.tel || '').trim(), id = String(b.id || '').trim();
    const monto = dinero(b.monto || 0);
    if (!tel || !id) return res.status(200).json({ ok: false, error: 'Faltan datos.' });
    if (monto <= 0 || monto > 150) return res.status(200).json({ ok: false, error: 'Pedí un monto entre Q1 y Q150.' });
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const o = peds.find(x => x.id === id);
    if (!o) return res.status(200).json({ ok: false, error: 'Pedido no encontrado.' });
    if (o.tipo !== 'viaje') return res.status(200).json({ ok: false, error: 'El regateo solo es para viajes. Comida y repuestos van con tarifa fija.' });
    if (o.estado === 'contraoferta') return res.status(200).json({ ok: false, error: 'Ya pediste más. Esperá la respuesta del cliente.' });
    if (!['asignado', 'buscando'].includes(o.estado)) return res.status(200).json({ ok: false, error: 'Este pedido ya no está disponible.' });
    if (o.estado === 'asignado' && (!o.piloto || o.piloto.tel !== tel)) return res.status(200).json({ ok: false, error: 'Este pedido es de otro piloto.' });
    if ((o.contraRechazos || []).includes(tel)) return res.status(200).json({ ok: false, error: 'El cliente ya rechazó tu precio para este viaje.' });
    const fr = await ghGet('registros.json'); const reg = fr ? fr.data : [];
    const p = reg.find(r => r.tipo === 'piloto' && r.estado === 'aprobado' && dig(r.datos.tel) === dig(tel));
    if (!p) return res.status(200).json({ ok: false, error: 'No sos piloto aprobado.' });
    const fps = await ghGet('pilots.json'); const stP = (fps ? fps.data : []).find(x => x.tel === tel) || {};
    if (stP.pendiente && !stP.pendiente.pagado) return res.status(200).json({ ok: false, error: 'Ponete al día con tus comisiones primero 😊' });
    if (monto <= o.envio) return res.status(200).json({ ok: false, error: 'Tu precio tiene que ser MAYOR que la tarifa fija (Q' + o.envio + ').' });
    // pocos pilotos en la zona => el cliente obtiene 60s en vez de 30s
    const otros = await candidatosViaje(o.zona, [tel]);
    const pocos = otros.length < 1;
    const segundos = pocos ? 60 : 30;
    if (o.estado === 'buscando') { o.piloto = Object.assign({ tel, nombre: p.datos.nombre }, vehInfo(p.datos)); o.tsAsignado = now; }
    o.estado = 'contraoferta';
    o.contra = { monto, ts: now, expira: now + segundos * 1000, pocos, segundos };
    await ghPut('pedidos.json', fpd.sha, peds, 'contraoferta ' + id);
    await aviso(`🚀 DRAGOEXPRES — VIAJE ${id}\n🛺 ${p.datos.nombre} PIDE MÁS: Q${monto} (tarifa fija Q${o.envio})\n⏱️ El cliente tiene ${segundos}s para aceptar${pocos ? ' (60s porque hay POCOS PILOTOS en ' + o.zona + ')' : ''}\nCliente: ${o.cliente.nombre} (${o.cliente.tel})`);
    return res.status(200).json({ ok: true, pedido: o });
  }

  // ---- cliente acepta o rechaza la contraoferta del piloto ----
  if (action === 'contraOk' || action === 'contraNo') {
    const tel = String(b.tel || '').replace(/\D/g, ''), id = String(b.id || '').trim();
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const o = peds.find(x => x.id === id);
    if (!o || o.estado !== 'contraoferta') return res.status(200).json({ ok: false, error: 'Esta oferta ya no está activa.' });
    if (String(o.cliente.tel).replace(/\D/g, '') !== tel) return res.status(200).json({ ok: false, error: 'No es tu pedido.' });
    if (action === 'contraOk') {
      if (o.contra && Date.now() > o.contra.expira) {
        o.contraRechazos = (o.contraRechazos || []).concat([o.piloto.tel]); o.contraExpiro = Date.now();
        await redispatchViaje(o, peds, fpd.sha);
        return res.status(200).json({ ok: false, error: 'Se te pasó el tiempo. El viaje volvió a búsqueda con la tarifa fija.' });
      }
      o.envio = o.contra.monto; o.comision = comisionDe('viaje', o.envio); o.contra = null;
      o.estado = 'aceptado'; o.tsAceptado = now; o.contraAceptado = now;
      await ghPut('pedidos.json', fpd.sha, peds, 'cliente acepto aumento ' + id);
      await aviso(`🚀 DRAGOEXPRES — VIAJE ${id}\n✅ ${o.cliente.nombre} ACEPTÓ el aumento del piloto: ahora el envío es Q${o.envio}\n🛺 Piloto: ${o.piloto.nombre} · Tu comisión: Q${o.comision}`);
      return res.status(200).json({ ok: true, pedido: o });
    }
    o.contraRechazos = (o.contraRechazos || []).concat([o.piloto.tel]);
    await redispatchViaje(o, peds, fpd.sha);
    await aviso(`🚀 DRAGOEXPRES — VIAJE ${id}\n❌ ${o.cliente.nombre} RECHAZÓ el aumento de ${o.piloto.nombre}. El viaje volvió a búsqueda con tarifa fija Q${o.envio}.`);
    return res.status(200).json({ ok: true, pedido: o });
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
      const p = reg.find(r => r.tipo === 'piloto' && r.estado === 'aprobado' && dig(r.datos.tel) === dig(tel));
      if (!p) return res.status(200).json({ ok: false, error: 'No sos piloto aprobado.' });
      if (peds.some(x => x.id !== id && x.piloto && dig(x.piloto.tel) === dig(tel) && ['asignado', 'aceptado', 'en_camino', 'contraoferta'].includes(x.estado) && !(x.estado === 'asignado' && x.tsAsignado && now - x.tsAsignado > OFERTA_MS))) return res.status(200).json({ ok: false, error: 'Ya tenés un pedido activo. Terminá ese primero y volvés a recibir otros.' });
      const fps = await ghGet('pilots.json'); const stP = (fps ? fps.data : []).find(x => x.tel === tel) || {};
      if (stP.pendiente && !stP.pendiente.pagado) return res.status(200).json({ ok: false, error: 'Primero ponete al día con tus comisiones (Q' + stP.pendiente.monto + '): transferilas a la cuenta del banco y avisale al admin por WhatsApp. En cuanto confirme, volvés a recibir pedidos como si nada 😊' });
      if (o.estado === 'contraoferta') return res.status(200).json({ ok: false, error: 'Esperá: le ofreciste un aumento al cliente. Si acepta, el viaje es tuyo.' });
      if (o.estado === 'asignado' && (!o.piloto || o.piloto.tel !== tel)) return res.status(200).json({ ok: false, error: 'Este pedido es de otro piloto.' });
      if ((o.rechazadoPor || []).includes(tel)) return res.status(200).json({ ok: false, error: 'Rechazaste este pedido, se lo dejamos a otro piloto.' });
      if (!['asignado', 'buscando'].includes(o.estado)) return res.status(200).json({ ok: false, error: 'Este pedido ya no está disponible.' });
      if (o.estado === 'buscando' && o.zona !== p.datos.zona) return res.status(200).json({ ok: false, error: 'Pedido de otra zona.' });
      o.estado = 'aceptado'; o.piloto = Object.assign({ tel, nombre: p.datos.nombre }, vehInfo(p.datos)); o.tsAceptado = now;
      await ghPut('pedidos.json', fpd.sha, peds, 'aceptado ' + id);
      await aviso(`🚀 DRAGOEXPRES — Pedido ${id}\n✅ ${p.datos.nombre} ACEPTÓ el pedido (${o.tipo})\nCliente: ${o.cliente.nombre}\n→ El piloto va en camino. Estado: ACEPTADO`);
      try { await pushATel(o.cliente.tel, { title: '🛺 ¡Tu pedido ' + id + ' ya tiene piloto!', body: String(p.datos.nombre) + ' lo va a buscar ahora. Abrí la app para seguirlo en vivo.', tag: 'dx-' + id, url: 'https://dragoexpres.vercel.app/pedir.html' }); } catch (e) { }
      return res.status(200).json({ ok: true, pedido: o });
    }
    if (!o.piloto || o.piloto.tel !== tel) return res.status(200).json({ ok: false, error: 'Este pedido no es tuyo.' });
    if (action === 'rechazar') {
      if (!['asignado', 'aceptado'].includes(o.estado)) return res.status(200).json({ ok: false, error: 'Ya no se puede rechazar.' });
      o.rechazadoPor = o.rechazadoPor || []; o.rechazadoPor.push(tel);
      o.rechazos = (o.rechazos || 0) + 1;
      try { const fp2 = await ghGet('pilots.json'); const a2 = fp2 ? fp2.data : []; const sr = a2.find(x => x.tel === tel); if (sr && sr.racha) { sr.racha = 0; await ghPut('pilots.json', fp2 ? fp2.sha : null, a2, 'racha rota ' + tel); } } catch (e) {}
      if (o.rechazos >= 3) {
        o.estado = 'cancelado'; o.piloto = null; o.canceladoPor = 'sin_piloto'; o.canceladoTs = now;
        await ghPut('pedidos.json', fpd.sha, peds, 'cancelado por rechazos ' + id);
        await aviso(`🚀 DRAGOEXPRES — Pedido ${id}
⛔ 3 pilotos lo rechazaron → CANCELADO. Avisale al cliente que nadie le cobró nada.`);
        return res.status(200).json({ ok: true, pedido: o });
      }
      o.estado = 'buscando'; o.piloto = null;
      try { const fp2 = await ghGet('pilots.json'); const a2 = fp2 ? fp2.data : []; const sr = a2.find(x => x.tel === tel); if (sr && sr.racha) { sr.racha = 0; await ghPut('pilots.json', fp2 ? fp2.sha : null, a2, 'racha rota ' + tel); } } catch (e) {}
      await ghPut('pedidos.json', fpd.sha, peds, 'rechazado ' + id);
      await aviso(`🚀 DRAGOEXPRES — Pedido ${id}\n⚠️ Un piloto rechazó → volvió a BUSCANDO, se lo ofrecemos a otro piloto de la zona.`);
      return res.status(200).json({ ok: true, pedido: o });
    }
    if (action === 'avanzar') {
      if (o.estado === 'aceptado') o.estado = 'en_camino';
      else if (o.estado === 'en_camino') {
        o.estado = 'entregado'; o.tsEntregado = now;
        await ghPut('pedidos.json', fpd.sha, peds, 'entregado ' + id); // guardar el estado ANTES de pagar al piloto
        // PAGO CON REINTENTO: si otra entrega concurrente movió pilots.json (HTTP 409), se relee fresco y se reaplica. La racha/boletos NO se duplican porque cada intento parte de datos recién leídos.
        let st = null, gananciaPiloto = 0, flotaTxt = '', bonoTxt = '', promoTxt = '', flotasAcreditada = false;
        for (let intento = 0; intento < 3 && !st; intento++) {
          if (intento) await new Promise(r2 => setTimeout(r2, 900));
          const fp = await ghGet('pilots.json'); const arr = fp ? fp.data : [];
          let st2 = arr.find(x => x.tel === tel);
          if (!st2) { st2 = { tel }; arr.push(st2); }
          if (st2.dia !== hoy()) { st2.dia = hoy(); st2.ganadoHoy = 0; st2.pedidosHoy = 0; }
          if (st2.semana !== semana()) { st2.semana = semana(); st2.ganadoSemana = 0; }
          st2.racha = (st2.racha || 0) + 1;
          if (st2.racha % 3 === 0) st2.boletosExtra = (st2.boletosExtra || 0) + 1;
          if (o.nocturno) st2.boletosExtra = (st2.boletosExtra || 0) + 1; // 🌙 boleto extra por entrega nocturna
          const bruto = o.promoFiel ? dinero((o.promoTarifa || 0) + (o.promoBonus || 0)) : o.envio;
          const neto = dinero(bruto - o.comision + (o.propina || 0));
          let gp = neto;
          if (!flotasAcreditada) {
            const ff = await ghGet('flotas.json');
            const flotas = ff ? ff.data : [];
            const asig = flotas.find(x => x.activa !== false && x.conductor && x.conductor.tel === tel);
            if (asig) {
              gp = dinero(neto * 0.75);
              if (asig.semana !== semana()) { asig.semana = semana(); asig.ganadoSemana = 0; asig.pedidosSemana = 0; }
              asig.ganadoSemana = dinero((asig.ganadoSemana || 0) + dinero(neto * 0.25));
              asig.pedidosSemana = (asig.pedidosSemana || 0) + 1;
              try { await ghPut('flotas.json', ff ? ff.sha : null, flotas, 'flota ' + id); flotasAcreditada = true; } catch (e) { }
              flotaTxt = `\n🚚 Flota ${asig.placa}: 75% conductor (Q${gp}) / 25% flotista ${asig.flotista.nombre} (Q${dinero(neto * 0.25)})`;
            }
          } else { gp = dinero(neto * 0.75); }
          st2.ganadoHoy = dinero((st2.ganadoHoy || 0) + gp);
          st2.ganadoSemana = dinero((st2.ganadoSemana || 0) + gp);
          st2.pedidosHoy = (st2.pedidosHoy || 0) + 1;
          if (o.promoFiel) { st2.bonosPend = dinero((st2.bonosPend || 0) + bruto); promoTxt = '\n🎁 CASHBACK PROMO CLIENTE FIEL: se le acredita Q' + bruto + ((o.promoBonus || 0) ? ' (envío Q' + o.promoTarifa + ' + extra Q' + o.promoBonus + ' por aceptar cuando nadie más quiso — ¡el afortunado!)' : '') + ' en su liquidación de 72h, como la devolución del domingo. El cliente NO pagó envío (promo de fidelidad): lo pagan las comisiones que ese cliente ya generó.'; }
          st2.disponible = true; st2.desde = now;
          // 🎁 BONO DE BIENVENIDA: a la 10ma entrega vuelven Q100 de SUS PROPIAS comisiones (Juan comparte su parte, nunca pierde)
          const entregasTotales = peds.filter(x => x.piloto && x.piloto.tel === tel && x.estado === 'entregado').length;
          if (entregasTotales === 10 && !st2.bonoBienvenida) {
            st2.bonoBienvenida = { total: 100, ts: now };
            st2.bonosPend = dinero((st2.bonosPend || 0) + 100);
            bonoTxt = '\n🎁 BONO DE BIENVENIDA: cumplió 10 entregas → Q100 de SUS PROPIAS comisiones vuelven a él en la próxima liquidación (no lo pagás vos, no perdés nada).';
          }
          try {
            await ghPut('pilots.json', fp ? fp.sha : null, arr, 'entregado ' + id);
            st = st2; gananciaPiloto = gp;
          } catch (e) { /* 409: reintenta con datos frescos */ }
        }
        await aviso(`🚀 DRAGOEXPRES — Pedido ${id} ENTREGADO ✅\n${o.piloto.nombre} completó ${o.tipo}\nEnvío Q${o.envio}${o.propina ? ' + propina Q' + o.propina : ''} → piloto gana Q${gananciaPiloto} · Comisión DragoExpres: Q${dinero(o.comision + (o.comisionLocal || 0))}${o.comisionLocal ? ' (envío Q' + o.comision + ' + local Q' + o.comisionLocal + ')' : ''}${flotaTxt}\nCliente: ${o.cliente.nombre}${bonoTxt}${promoTxt}`);
        try { await pushATel(o.cliente.tel, { title: '✅ ¡Tu pedido ' + id + ' fue entregado!', body: 'Gracias por pedir con el dragón 🐉 Calificá a tu piloto en la app.', tag: 'dx-' + id, url: 'https://dragoexpres.vercel.app/pedir.html' }); } catch (e) { }
        if (!st) return res.status(200).json({ ok: false, error: 'Tu entrega quedó registrada pero no pudimos acreditar tu pago justo ahora. Avisale al administrador por WhatsApp para acreditarlo a mano.' });
        return res.status(200).json({ ok: true, pedido: o, ganadoHoy: st.ganadoHoy, ganadoSemana: st.ganadoSemana });
      } else return res.status(200).json({ ok: false, error: 'Estado inválido.' });
      await ghPut('pedidos.json', fpd.sha, peds, o.estado + ' ' + id);
      if (o.estado === 'en_camino') { try { await pushATel(o.cliente.tel, { title: '🛺 ¡Tu pedido ' + id + ' va EN CAMINO!', body: (o.piloto && o.piloto.nombre ? o.piloto.nombre : 'Tu piloto') + ' ya viene a tu dirección. Tené el pago listo 💰', tag: 'dx-' + id, url: 'https://dragoexpres.vercel.app/pedir.html' }); } catch (e) { } }
      return res.status(200).json({ ok: true, pedido: o });
    }
  }

  // ---- BUZÓN DE SUGERENCIAS (usuario / piloto / local) ----
  // ---- ELIMINAR MI CUENTA (requisito Google Play): borra el registro del usuario
  // y anonimiza sus pedidos y chats. Irreversible.
  if (action === 'eliminarCuenta') {
    const tel = String(b.tel || '').replace(/\D/g, '').slice(0, 25);
    const rol = ['usuario', 'piloto', 'local', 'flotista'].includes(b.rol) ? b.rol : 'usuario';
    const rolReg = rol === 'flotista' ? 'flota' : rol; // en registros.json el flotista se guarda como tipo 'flota'
    const rolTxt = { usuario: 'cliente', piloto: 'piloto', local: 'local', flotista: 'flotista' }[rol];
    if (!tel) return res.status(200).json({ ok: false, error: 'Decinos tu WhatsApp para eliminar la cuenta correcta.' });
    // proteccion: no borrar cuentas con pedidos en curso
    const fpd0 = await ghGet('pedidos.json');
    const activos = ['buscando', 'asignado', 'aceptado', 'en_camino'];
    if (fpd0 && fpd0.data.some(o => activos.includes(o.estado) && (
      (rol === 'usuario' && o.cliente && dig(o.cliente.tel) === dig(tel)) ||
      (rol === 'piloto' && o.piloto && dig(o.piloto.tel) === dig(tel)) ||
      (rol === 'local' && o.local && dig(o.local.tel) === dig(tel))))) {
      return res.status(200).json({ ok: false, error: 'Tenés un pedido en curso: esperá a que se entregue y volvé a intentar.' });
    }
    const fr = await ghGet('registros.json');
    const regs = fr ? fr.data : [];
    const antes = regs.length;
    const quedan = regs.filter(r => !(r.tipo === rolReg && dig((r.datos || {}).tel) === dig(tel)));
    if (quedan.length === antes) return res.status(200).json({ ok: false, error: 'No encontramos una cuenta de ' + rolTxt + ' con ese WhatsApp.' });
    await ghPut('registros.json', fr ? fr.sha : null, quedan, 'cuenta eliminada ' + rol + ' ' + tel);
    // estado y datos por rol: al borrarlos, el WhatsApp queda LIBRE para registrarse de nuevo
    if (rol === 'piloto') { const fp = await ghGet('pilots.json'); if (fp) await ghPut('pilots.json', fp.sha, fp.data.filter(x => dig(x.tel) !== dig(tel)), 'estado piloto eliminado ' + tel); }
    if (rol === 'local') {
      const fl = await ghGet('locales.json'); if (fl) await ghPut('locales.json', fl.sha, fl.data.filter(x => dig(x.tel) !== dig(tel)), 'estado local eliminado ' + tel);
      const fm = await ghGet('menus.json'); if (fm) await ghPut('menus.json', fm.sha, fm.data.filter(x => dig(x.tel) !== dig(tel)), 'menu/promos/servicios local eliminado ' + tel);
    }
    if (rol === 'flotista') { const ff = await ghGet('flotas.json'); if (ff) await ghPut('flotas.json', ff.sha, ff.data.filter(x => !(x.flotista && dig(x.flotista.tel) === dig(tel))), 'flota eliminada ' + tel); }
    // suscripciones de avisos push del numero
    const fps = await ghGet('pushsubs.json');
    if (fps) { const q2 = fps.data.filter(x2 => dig(x2.tel) !== dig(tel)); if (q2.length !== fps.data.length) await ghPut('pushsubs.json', fps.sha, q2, 'push subs eliminadas ' + tel); }
    // pedidos: anonimizados (quedan para contabilidad, sin datos personales)
    const fpd = await ghGet('pedidos.json');
    let toc = 0;
    if (fpd) {
      fpd.data.forEach(o => {
        if (rol === 'usuario' && o.cliente && dig(o.cliente.tel) === dig(tel)) { o.cliente = { nombre: 'Cliente eliminado', tel: '', direccion: '' }; if (Array.isArray(o.chat)) o.chat = o.chat.filter(m => m.de !== 'cliente'); toc++; }
        if (rol === 'piloto' && o.piloto && dig(o.piloto.tel) === dig(tel)) { o.piloto = { nombre: 'Piloto eliminado', tel: '' }; if (Array.isArray(o.chat)) o.chat = o.chat.filter(m => m.de !== 'piloto'); toc++; }
        if (rol === 'local' && o.local && dig(o.local.tel) === dig(tel)) { o.local = { nombre: 'Local eliminado', tel: '' }; if (Array.isArray(o.chat)) o.chat = o.chat.filter(m => m.de !== 'local'); toc++; }
      });
      if (toc) await ghPut('pedidos.json', fpd.sha, fpd.data, 'anonimizados pedidos de cuenta eliminada ' + rol);
    }
    await aviso(`🗑️ DRAGOEXPRES — CUENTA ELIMINADA\n${rolTxt} ${tel} borró su cuenta y todos sus datos.${toc ? ' Sus pedidos quedaron anonimizados.' : ''} Su WhatsApp queda libre para registrarse de nuevo.`);
    return res.status(200).json({ ok: true, mensaje: 'Tu cuenta y tus datos fueron eliminados.' });
  }

  if (action === 'sugerencia') {
    const rol = ['usuario', 'piloto', 'local', 'flotista'].includes(b.rol) ? b.rol : 'usuario';
    const nombre = String(b.nombre || '').slice(0, 60);
    const tel = String(b.tel || '').replace(/\D/g, '').slice(0, 12);
    const texto = String(b.texto || '').trim().slice(0, 500);
    if (texto.length < 5) return res.status(200).json({ ok: false, error: 'Escribí tu sugerencia (mínimo 5 letras).' });
    const fs = await ghGet('sugerencias.json');
    const arr = fs ? fs.data : [];
    const id = 'SG' + Date.now().toString(36).toUpperCase();
    arr.push({ id, rol, nombre, tel, texto, ts: now, leida: false });
    while (arr.length > 200) arr.shift();
    await ghPut('sugerencias.json', fs ? fs.sha : null, arr, 'sugerencia ' + id);
    await aviso(`✉️ DRAGOEXPRES — SUGERENCIA NUEVA 📩\nDe: ${nombre || 'Anónimo'}${tel ? ' (' + tel + ')' : ''} · rol: ${rol}\n"${texto}"\nLa ves en tu panel, pestaña Pedidos, buzón de sugerencias.`);
    return res.status(200).json({ ok: true, id, mensaje: '¡Gracias! El dragón leyó tu sugerencia 🐉' });
  }

  // ---- PILOTO: BOTÓN SOS (emergencia: manda su ubicación exacta al admin por Telegram) ----
  if (action === 'sos') {
    const tel = String(b.tel || '').trim();
    const lat = +b.lat, lng = +b.lng;
    if (!tel || !isFinite(lat) || !isFinite(lng)) return res.status(200).json({ ok: false, error: 'No pudimos leer tu ubicación. Activá el GPS e intentá de nuevo.' });
    const fp = await ghGet('pilots.json'); const arr = fp ? fp.data : [];
    let st = arr.find(x => x.tel === tel);
    if (!st) { st = { tel, disponible: false }; arr.push(st); }
    st.sos = { ts: now, lat, lng };
    await ghPut('pilots.json', fp ? fp.sha : null, arr, 'sos ' + tel);
    let nombre = tel, zona = '?', placa = '';
    try {
      const fr = await ghGet('registros.json'); const reg = fr ? fr.data : [];
      const p = reg.find(r => r.tipo === 'piloto' && dig(r.datos.tel) === dig(tel));
      if (p) { nombre = p.datos.nombre; zona = p.datos.zona; placa = p.datos.placa || ''; }
    } catch (e) { }
    const maps = 'https://maps.google.com/?q=' + lat + ',' + lng;
    await aviso(`🚨🚨🚨 DRAGOEXPRES — SOS DE PILOTO 🚨🚨🚨\n${nombre} (${tel}) marcó EMERGENCIA\nZona: ${zona}${placa ? ' · Placa: ' + placa : ''}\n📍 UBICACIÓN EXACTA: ${maps}\nEscribile y verificá que esté bien. La ubicación es del momento en que tocó el botón.`);
    return res.status(200).json({ ok: true, maps });
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
    const texto = String(b.texto || '').trim().slice(0, 160);
    if (quien === 'cliente') { o.califCliente = estrellas; if (texto) o.califClienteTxt = texto; } else { o.califPiloto = estrellas; if (texto) o.califPilotoTxt = texto; }
    await ghPut('pedidos.json', fpd.sha, peds, 'calificacion ' + id);
    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: false, error: 'Acción desconocida: ' + action });
});
