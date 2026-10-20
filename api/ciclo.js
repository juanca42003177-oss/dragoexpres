// DragoExpres — LIQUIDACIÓN DE CICLO (cada 72 horas).
// Reglas de Juan: los pilotos transfieren su neto (comisiones − compensaciones)
// a la cuenta Industrial 7171286805 cada 72h, para no molestarlos a diario
// y que el banco no cobre comisiones por transferencias.
// El piloto que no liquidó el ciclo anterior queda SUSPENDIDO automático.
// El pozo de pilotos sigue aparte, dominical (api/pozo.js).
const wrap = require('./_cors');
const { REPO, BRANCH, H, ensureBranch } = require('./_dx');

const TZ = 6 * 3600 * 1000;
const CICLO_MS = 72 * 3600 * 1000;
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
    await fetch('https://api.telegram.org/bot' + tok + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: texto }) });
  } catch (e) { }
}

module.exports = wrap(async (req, res) => {
  const q = req.query || {};
  const b = req.body || {};
  const action = b.action || q.action || '';
  const now = Date.now();

  // estado informativo: cuando es la próxima liquidación
  if (action === 'estado') {
    const fp = await ghGet('pozo.json');
    const pozo = fp ? fp.data : {};
    const desde = pozo.tsUltimoCiclo || (now - CICLO_MS);
    return res.status(200).json({ ok: true, proximoEn: Math.max(0, desde + CICLO_MS - now), ultimo: desde });
  }

  // GET del cron diario (21:00 GT) o ejecución manual
  if (action === 'ejecutar' || (!action && req.method === 'GET')) {
    const fpz = await ghGet('pozo.json');
    const pozo = fpz ? fpz.data : {};
    const ultimo = pozo.tsUltimoCiclo || 0;
    if (!action && now - ultimo < CICLO_MS) return res.status(200).json({ ok: true, skip: 'todavía no pasan 72h', proximoEn: ultimo + CICLO_MS - now });

    const desde = ultimo || (now - CICLO_MS);
    const gt = (ts) => new Date(ts - TZ).toISOString().replace('T', ' ').slice(0, 16);

    // pedidos entregados dentro del ciclo
    const fpd = await ghGet('pedidos.json');
    const peds = (fpd ? fpd.data : []).filter(o => o.estado === 'entregado' && (o.tsEntregado || 0) > desde && (o.tsEntregado || 0) <= now);
    const porPiloto = {};
    peds.forEach(o => {
      if (!o.piloto) return;
      const k = o.piloto.tel;
      if (!porPiloto[k]) porPiloto[k] = { tel: k, nombre: o.piloto.nombre, entregas: 0, comisiones: 0 };
      porPiloto[k].entregas++;
      porPiloto[k].comisiones = dinero(porPiloto[k].comisiones + (o.comision || 0) + (o.comisionLocal || 0));
    });
    const pilotos = Object.values(porPiloto).sort((a, b2) => b2.entregas - a.entregas);

    // pilots.json: suspensiones por ciclo anterior no pagado + compensaciones + nuevos pendientes
    const fpr = await ghGet('pilots.json');
    const parr = fpr ? fpr.data : [];
    const sancionados = [];
    parr.forEach(x => { if (x.pendiente && !x.pendiente.pagado) { x.retraso = true; sancionados.push(x.nombre || x.tel); } });
    pilotos.forEach(p => {
      let st = parr.find(x => x.tel === p.tel);
      if (!st) { st = { tel: p.tel }; parr.push(st); }
      const comp = Math.min((st.compensa || 0), p.comisiones);
      const neto = dinero(p.comisiones - comp);
      p.compAplicada = comp; p.neto = neto;
      if (comp > 0) st.compensa = dinero((st.compensa || 0) - comp);
      if (neto > 0) st.pendiente = { monto: dinero((st.pendiente && !st.pendiente.pagado ? st.pendiente.monto : 0) + neto), desde: new Date(now - TZ).toISOString().slice(0, 10), pagado: false };
    });
    await ghPut('pilots.json', fpr ? fpr.sha : null, parr, 'liquidacion de ciclo pendientes');

    pozo.tsUltimoCiclo = now;
    pozo.ciclos = (pozo.ciclos || 0) + 1;
    await ghPut('pozo.json', fpz ? fpz.sha : null, pozo, 'ciclo liquidado ' + gt(now));

    const LINEAS = pilotos.length ? pilotos.map(p => `• ${p.nombre} (${p.tel}): ${p.entregas} entregas · comisiones Q${p.comisiones}${p.compAplicada ? ' − ⛽ comp Q' + p.compAplicada : ''} → TE TRANSFIERE Q${p.neto}`).join('\n') : 'Sin entregas este ciclo.';
    const SANC = sancionados.length ? `\n\n⏳ PENDIENTES de liquidar el ciclo anterior (NO suspendidos: entran normal y ven un aviso amable para pagar; no les llegan pedidos nuevos hasta liquidar): ${sancionados.join(', ')}` : '';
    const prox = new Date(now + CICLO_MS - TZ).toISOString().replace('T', ' ').slice(0, 16);
    await aviso(`🐉 DRAGOEXPRES — LIQUIDACIÓN DE CICLO (cada 72h)\nCiclo del ${gt(desde)} al ${gt(now)}\n\n💰 Cada piloto te transfiere su neto a tu Industrial 7171286805:\n${LINEAS}\n\n⏰ Próxima liquidación: ${prox} GT${SANC}\nAl pagar tarde pierden la racha del pozo del domingo (salvo que vos les des el chance con 🐉 Restaurar racha). Las compensaciones ⛽ salen de las comisiones del propio piloto (vos no pones nada).`);

    return res.status(200).json({ ok: true, ciclo: { desde, hasta: now }, pilotos, sancionados, proxima: now + CICLO_MS });
  }

  return res.status(200).json({ ok: false, error: 'Acción no válida.' });
});
