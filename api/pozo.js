// DragoExpres — Pozo semanal de pilotos (Fase 2).
// Reglas: meta 20 entregas por piloto (lunes→domingo GT).
// Pozo = 25% de las comisiones de la semana + acumulado de semanas sin ganador.
// Reparto: domingo 20:00 GT, entre pilotos con meta cumplida, proporcional
// a sus entregas de la semana. Si nadie cumple, el pozo se acumula.
// El pago lo hace Juan a mano (como los premios por volumen), con aviso Telegram.
const wrap = require('./_cors');
const { REPO, BRANCH, H, ensureBranch } = require('./_dx');

const TZ = 6 * 3600 * 1000;
const dinero = (q) => Math.max(0, Math.round(+q * 100) / 100);
const META = 20, PCT_POZO = 0.25;

function lunesGT() {
  const g = new Date(Date.now() - TZ);
  const diasDesdeLunes = (g.getUTCDay() + 6) % 7;
  return Date.UTC(g.getUTCFullYear(), g.getUTCMonth(), g.getUTCDate() - diasDesdeLunes) + TZ;
}
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

function lineas(s, reparto) {
  const gana = {};
  (reparto||[]).forEach(p => gana[p.tel] = p.monto);
  return s.pilotos.map(p => {
    const pozoG = gana[p.tel] || 0;
    const neto = dinero(p.comisiones - pozoG);
    if (neto >= 0) return `• ${p.nombre} (${p.tel}): ${p.entregas} entregas · comisiones Q${p.comisiones}${pozoG ? ' − pozo Q' + pozoG : ''} → TE TRANSFIERE Q${neto}`;
    return `• ${p.nombre} (${p.tel}): ${p.entregas} entregas · comisiones Q${p.comisiones} − pozo Q${pozoG} → LE PAGÁS VOS Q${-neto}`;
  }).join('\n');
}
async function estado() {
  const L = lunesGT();
  const fpd = await ghGet('pedidos.json');
  const peds = (fpd ? fpd.data : []).filter(o => o.estado === 'entregado' && (o.tsEntregado || o.ts) >= L);
  const comisiones = dinero(peds.reduce((s, o) => s + (o.comision || 0) + (o.comisionLocal || 0), 0));
  const pz = await ghGet('pozo.json');
  const pozo = pz ? pz.data : {};
  pozo.acumulado = pozo.acumulado || 0;
  pozo.historial = pozo.historial || [];
  const porPiloto = {};
  peds.forEach(o => {
    if (!o.piloto) return;
    const k = o.piloto.tel;
    if (!porPiloto[k]) porPiloto[k] = { tel: k, nombre: o.piloto.nombre, entregas: 0, comisiones: 0 };
    porPiloto[k].entregas++;
    porPiloto[k].comisiones = dinero(porPiloto[k].comisiones + (o.comision || 0) + (o.comisionLocal || 0));
  });
  const pilotos = Object.values(porPiloto).sort((a, b) => b.entregas - a.entregas);
  const califican = pilotos.filter(p => p.entregas >= META);
  const pozoSemana = dinero(comisiones * PCT_POZO);
  const total = dinero(pozoSemana + (pozo.acumulado || 0));
  return { meta: META, comisiones, pozoSemana, acumulado: pozo.acumulado || 0, total, pilotos, califican, faltanDias: 7 - Math.floor((Date.now() - L) / 864e5) };
}

module.exports = wrap(async (req, res) => {
  const q = req.query || {};
  const b = req.body || {};
  const action = b.action || q.action || '';

  if (action === 'estado') {
    const s = await estado();
    return res.status(200).json({ ok: true, ...s });
  }

  if (action === 'ejecutar' || (!action && req.method === 'GET')) {
    // cron de Vercel (GET dominical) o ejecucion manual
    const g = new Date(Date.now() - TZ);
    if (!action && g.getUTCDay() !== 0) return res.status(200).json({ ok: true, skip: 'hoy no es domingo' });
    const s = await estado();
    const pz = await ghGet('pozo.json');
    const pozo = pz ? pz.data : {};
    pozo.acumulado = pozo.acumulado || 0;
    pozo.historial = pozo.historial || [];
    const totalEntregas = s.califican.reduce((s2, p) => s2 + p.entregas, 0);
    const reparto = s.califican.map(p => ({ tel: p.tel, nombre: p.nombre, entregas: p.entregas, monto: dinero(s.total * p.entregas / totalEntregas) }));
    const gana = {};
    reparto.forEach(p => gana[p.tel] = p.monto);
    // pendientes de la semana pasada sin pagar → SUSPENSION automatica
    const fp = await ghGet('pilots.json');
    const parr = fp ? fp.data : [];
    const sancionados = [];
    parr.forEach(x => { if (x.pendiente && !x.pendiente.pagado) { x.susp = true; sancionados.push(x.nombre || x.tel); } });
    // nuevos pendientes de esta semana (comisiones − pozo ganado)
    s.pilotos.forEach(p => {
      let st = parr.find(x => x.tel === p.tel);
      if (!st) { st = { tel: p.tel }; parr.push(st); }
      const neto = dinero(p.comisiones - (gana[p.tel] || 0));
      if (neto > 0) st.pendiente = { monto: dinero((st.pendiente && !st.pendiente.pagado ? st.pendiente.monto : 0) + neto), desde: g.toISOString().slice(0, 10) };
    });
    await ghPut('pilots.json', fp ? fp.sha : null, parr, 'liquidacion semanal pendientes');
    const SANC = sancionados.length ? `\n\n⛔ SUSPENDIDOS por no liquidar (no reciben pedidos hasta pagar): ${sancionados.join(', ')}` : '';
    if (!s.califican.length) {
      pozo.acumulado = dinero((pozo.acumulado || 0) + s.pozoSemana);
      pozo.historial.push({ domingo: g.toISOString().slice(0, 10), monto: s.pozoSemana, reparto: [], nota: 'sin pilotos con meta, se acumula' });
      await ghPut('pozo.json', pz ? pz.sha : null, pozo, 'pozo: sin ganadores, acumula');
      await aviso(`🏆 DRAGOEXPRES — RESUMEN SEMANAL\nNadie cumplió la meta de ${META} entregas 😢 el pozo de Q${s.pozoSemana} se ACUMULA.\n\n💰 LIQUIDACIÓN (cada piloto te transfiere su neto a tu Industrial 7171286805):\n${lineas(s, []) || 'Sin entregas esta semana'}${SANC}`);
      return res.status(200).json({ ok: true, acumulado: pozo.acumulado, liquidacion: lineas(s, []), sancionados });
    }
    pozo.historial.push({ domingo: g.toISOString().slice(0, 10), monto: s.total, reparto });
    pozo.acumulado = 0;
    await ghPut('pozo.json', pz ? pz.sha : null, pozo, 'pozo repartido');
    const LINEAS = lineas(s, reparto);
    await aviso(`🏆 DRAGOEXPRES — RESUMEN SEMANAL 🐉\nPozo de la semana: Q${s.total} (25% de comisiones + acumulado)\n\n💰 LIQUIDACIÓN (cada piloto te transfiere su neto a tu Industrial 7171286805):\n${LINEAS}${SANC}\n\nSi el pozo ganado supera las comisiones de un piloto, ese poquito sí lo pagás vos. El resto llega solo.\nEl piloto que no liquida queda SUSPENDIDO el próximo domingo: no recibe pedidos hasta pagar.`);
    return res.status(200).json({ ok: true, total: s.total, reparto, liquidacion: LINEAS, sancionados });
  }

  return res.status(200).json({ ok: false, error: 'Acción desconocida' });
});
