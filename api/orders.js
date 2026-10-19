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
function comisionDe(tipo, envio) {
  const e = dinero(envio);
  if (tipo === 'comida') return dinero(e * 0.10);
  if (tipo === 'repuesto') return dinero(e * 0.08);
  if (e <= 25) return 2;
  if (e <= 50) return 3;
  return 5;
}
const ESTADOS = ['buscando', 'asignado', 'aceptado', 'en_camino', 'entregado', 'cancelado'];

module.exports = wrap(async (req, res) => {
  const b = req.body || {};
  const action = b.action || (req.query && req.query.action) || '';
  const now = Date.now();

  // zonas activas (con pilotos o locales aprobados) para el formulario de pedido
  if (action === 'zonas') {
    const f = await ghGet('registros.json');
    const reg = f ? f.data : [];
    const pil = new Set(), loc = new Set();
    reg.filter(r => r.estado === 'aprobado').forEach(r => (r.tipo === 'piloto' ? pil : r.tipo === 'local' ? loc : null) && 0);
    reg.filter(r => r.estado === 'aprobado' && r.tipo === 'piloto').forEach(r => pil.add(r.datos.zona));
    reg.filter(r => r.estado === 'aprobado' && r.tipo === 'local').forEach(r => loc.add(r.datos.zona));
    return res.status(200).json({ ok: true, zonas: [...pil].sort(), zonasLocales: [...loc].sort() });
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
    const fpd = await ghGet('pedidos.json');
    const peds = fpd ? fpd.data : [];
    const mio = peds.filter(o => o.piloto && o.piloto.tel === tel && !['entregado', 'cancelado'].includes(o.estado));
    const zona = peds.filter(o => o.estado === 'buscando' && o.zona === p.datos.zona);
    const califs = peds.filter(o => o.piloto && o.piloto.tel === tel && o.califCliente > 0);
    const calif = califs.length ? Math.round(califs.reduce((x, o) => x + o.califCliente, 0) / califs.length * 10) / 10 : null;
    return res.status(200).json({ ok: true, piloto: { nombre: p.datos.nombre, zona: p.datos.zona, vehiculo: p.datos.vehiculo, disponible: st.disponible, ganadoHoy: st.ganadoHoy || 0, ganadoSemana: st.ganadoSemana || 0, pedidosHoy: st.pedidosHoy || 0, calif: calif }, activo: mio[0] || null, zonaBuscando: zona });
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
    const id = 'DX' + String(now).slice(-6) + String(Math.floor(Math.random() * 90) + 10);
    const pedido = {
      id, tipo, zona,
      cliente: { nombre, tel, direccion: String(b.direccion).slice(0, 160), referencia: String(b.referencia || '').slice(0, 160) },
      detalle: String(b.detalle).slice(0, 400),
      compra: dinero(b.compra || 0), envio, comision: comisionDe(tipo, envio),
      estado: 'buscando', piloto: null, ts: now
    };
    // dispatch: primer piloto disponible de la zona
    const fp = await ghGet('pilots.json'); const pilots = fp ? fp.data : [];
    const fr = await ghGet('registros.json'); const reg = fr ? fr.data : [];
    const aprobados = new Set(reg.filter(r => r.tipo === 'piloto' && r.estado === 'aprobado').map(r => String(r.datos.tel).trim()));
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const ocupados = new Set(peds.filter(o => o.piloto && ['asignado', 'aceptado', 'en_camino'].includes(o.estado)).map(o => o.piloto.tel));
    const cand = pilots.filter(x => x.disponible && aprobados.has(x.tel) && !ocupados.has(x.tel))
      .filter(x => { const r = reg.find(y => y.tipo === 'piloto' && String(y.datos.tel).trim() === x.tel); return r && r.datos.zona === zona; })
      .sort((a, b2) => (a.desde || 0) - (b2.desde || 0));
    if (cand.length) {
      const r = reg.find(y => y.tipo === 'piloto' && String(y.datos.tel).trim() === cand[0].tel);
      pedido.estado = 'asignado';
      pedido.piloto = { tel: cand[0].tel, nombre: r.datos.nombre };
      const st = pilots.find(x => x.tel === cand[0].tel);
      // el piloto asignado queda "ocupado" hasta entregar/rechazar
    }
    peds.push(pedido);
    await ghPut('pedidos.json', fpd ? fpd.sha : null, peds, 'pedido nuevo ' + id);
    const ic = { comida: '🍔', viaje: '🛺', repuesto: '🔧' }[tipo];
    await aviso(`🚀 DRAGOEXPRES — PEDIDO NUEVO ${ic}\n${id} · ${tipo.toUpperCase()} · ${zona}\nCliente: ${nombre} (${tel})\nDetalle: ${String(b.detalle).slice(0, 120)}\nEnvío: Q${envio} · Comisión DragoExpres: Q${pedido.comision}\n${pedido.piloto ? '→ Asignado AUTOMÁTICAMENTE a: ' + pedido.piloto.nombre + ' (' + pedido.piloto.tel + ')' : '→ SIN piloto disponible ahora, queda BUSCANDO'}`);
    return res.status(200).json({ ok: true, pedido });
  }

  // ---- consultar estado (usuario o pantalla) ----
  if (action === 'estado') {
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
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

  // ---- acciones del piloto sobre el pedido ----
  if (['aceptar', 'rechazar', 'avanzar'].includes(action)) {
    const tel = String(b.tel || '').trim(), id = String(b.id || '').trim();
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const o = peds.find(x => x.id === id);
    if (!o) return res.status(200).json({ ok: false, error: 'Pedido no encontrado.' });
    if (action === 'aceptar') {
      // puede aceptar el suyo asignado o tomar uno 'buscando' de su zona
      const fr = await ghGet('registros.json'); const reg = fr ? fr.data : [];
      const p = reg.find(r => r.tipo === 'piloto' && r.estado === 'aprobado' && String(r.datos.tel).trim() === tel);
      if (!p) return res.status(200).json({ ok: false, error: 'No sos piloto aprobado.' });
      if (o.estado === 'asignado' && (!o.piloto || o.piloto.tel !== tel)) return res.status(200).json({ ok: false, error: 'Este pedido es de otro piloto.' });
      if (!['asignado', 'buscando'].includes(o.estado)) return res.status(200).json({ ok: false, error: 'Este pedido ya no está disponible.' });
      if (o.estado === 'buscando' && o.zona !== p.datos.zona) return res.status(200).json({ ok: false, error: 'Pedido de otra zona.' });
      o.estado = 'aceptado'; o.piloto = { tel, nombre: p.datos.nombre }; o.tsAceptado = now;
      await ghPut('pedidos.json', fpd.sha, peds, 'aceptado ' + id);
      await aviso(`🚀 DRAGOEXPRES — Pedido ${id}\n✅ ${p.datos.nombre} ACEPTÓ el pedido (${o.tipo})\nCliente: ${o.cliente.nombre}\n→ El piloto va en camino. Estado: ACEPTADO`);
      return res.status(200).json({ ok: true, pedido: o });
    }
    if (!o.piloto || o.piloto.tel !== tel) return res.status(200).json({ ok: false, error: 'Este pedido no es tuyo.' });
    if (action === 'rechazar') {
      if (!['asignado', 'aceptado'].includes(o.estado)) return res.status(200).json({ ok: false, error: 'Ya no se puede rechazar.' });
      o.estado = 'buscando'; o.piloto = null; o.rechazos = (o.rechazos || 0) + 1;
      await ghPut('pedidos.json', fpd.sha, peds, 'rechazado ' + id);
      await aviso(`🚀 DRAGOEXPRES — Pedido ${id}\n⚠️ ${tel} rechazó el pedido → volvió a BUSCANDO`);
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
        await aviso(`🚀 DRAGOEXPRES — Pedido ${id} ENTREGADO ✅\n${o.piloto.nombre} completó ${o.tipo}\nEnvío Q${o.envio} → piloto gana Q${gananciaPiloto} · Comisión DragoExpres: Q${o.comision}${flotaTxt}\nCliente: ${o.cliente.nombre}`);
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
