// Panel de administracion DragoExpres (solo Juan). Requiere ADMIN_PASS en Vercel.
const wrap = require('./_cors');
const { ensureBranch } = require('./_dx');
const REPO = process.env.GITHUB_DATA_REPO || 'juanca42003177-oss/dragon-labs-data';
const BRANCH = 'dragoexpres-data';
const TOKEN = () => process.env.GITHUB_TOKEN || '';
const PATH = 'registros.json';
const okPass = (p) => process.env.ADMIN_PASS && p === process.env.ADMIN_PASS;

async function ghGet() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}?ref=${BRANCH}`, {
    headers: { Authorization: 'Bearer ' + TOKEN(), Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8') || '[]') };
}
async function ghPut(sha, data) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + TOKEN(), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'admin: actualizar registro', branch: BRANCH, content: Buffer.from(JSON.stringify(data, null, 1)).toString('base64'), sha: sha || undefined }),
  });
  if (!r.ok) throw new Error('guardar HTTP ' + r.status);
}
module.exports = wrap(async (req, res) => {
  const d = req.body || {};
  const action = d.action || (req.query && req.query.action) || '';
  if (!okPass(d.pass)) return res.status(200).json({ ok: false, error: 'Acceso denegado' });
  if (action === 'check') return res.status(200).json({ ok: true });
  await ensureBranch();
  const f = await ghGet();
  const data = f ? f.data : [];
  if (action === 'list') {
    try { await ensureBranch(); } catch (e) {}

    return res.status(200).json({ ok: true, registros: data });
  }
  if (action === 'aprobar' || action === 'rechazar') {
    const i = data.findIndex(r => String(r.ts) === String(d.ts));
    if (i < 0) return res.status(200).json({ ok: false, error: 'Registro no encontrado' });
    data[i].estado = action === 'aprobar' ? 'aprobado' : 'rechazado';
    await ghPut(f ? f.sha : null, data);
    return res.status(200).json({ ok: true, estado: data[i].estado });
  }
  if (action === 'pedidos') {
    // pedidos.json vive en la misma rama; se lee aparte para no romper si aún no existe
    const rp = await fetch(`https://api.github.com/repos/${REPO}/contents/pedidos.json?ref=${BRANCH}`, { headers: H() });
    const pedidos = rp.ok ? JSON.parse(Buffer.from((await rp.json()).content, 'base64').toString('utf8') || '[]') : [];
    const comisiones = pedidos.reduce((s, o) => s + (o.estado === 'entregado' ? (o.comision || 0) + (o.comisionLocal || 0) : 0), 0);
    const porEstado = {};
    pedidos.forEach(o => porEstado[o.estado] = (porEstado[o.estado] || 0) + 1);
    return res.status(200).json({ ok: true, pedidos: pedidos.slice(-60).reverse(), total: pedidos.length, comisiones, porEstado });
  }
  if (action === 'liquidaciones') {
    const fp = await ghGet('pilots.json');
    const arr = fp ? fp.data : [];
    return res.status(200).json({ ok: true, pendientes: arr.filter(x => x.pendiente).map(x => ({ tel: x.tel, nombre: x.nombre || x.tel, monto: x.pendiente.monto, desde: x.pendiente.desde, susp: !!x.susp })) });
  }
  if (action === 'liqOk') {
    const tel = String(b.tel || '').trim();
    const fp = await ghGet('pilots.json');
    const arr = fp ? fp.data : [];
    const st = arr.find(x => x.tel === tel);
    if (!st) return res.status(200).json({ ok: false, error: 'Piloto no encontrado.' });
    delete st.pendiente;
    delete st.susp;
    await ghPut('pilots.json', fp ? fp.sha : null, arr, 'liquidado ' + tel);
    return res.status(200).json({ ok: true });
  }
  if (action === 'detalle') {
    const tel = String(d.tel || '').replace(/\D/g, '');
    const reg = f.data.find(r => String((r.datos || {}).tel || '').replace(/\D/g, '') === tel) || null;
    if (!reg) return res.status(200).json({ ok: false, error: 'No encontrado.' });
    const H2 = () => ({ Authorization: 'Bearer ' + TOKEN(), Accept: 'application/vnd.github+json' });
    const r2 = await fetch(`https://api.github.com/repos/${REPO}/contents/pedidos.json?ref=${BRANCH}`, { headers: H2() });
    const peds = r2.ok ? JSON.parse(Buffer.from((await r2.json()).content, 'base64').toString('utf8') || '[]') : [];
    const mios = peds.filter(x => x.piloto && String(x.piloto.tel).replace(/\D/g, '') === tel && x.estado === 'entregado');
    const r3 = await fetch(`https://api.github.com/repos/${REPO}/contents/pilots.json?ref=${BRANCH}`, { headers: H2() });
    const pilots = r3.ok ? JSON.parse(Buffer.from((await r3.json()).content, 'base64').toString('utf8') || '[]') : [];
    const st = pilots.find(x => String(x.tel).replace(/\D/g, '') === tel) || {};
    const califs = mios.filter(x => x.califCliente > 0);
    const g = new Date(Date.now() - 21600000);
    const lunes = new Date(g);
    lunes.setUTCDate(g.getUTCDate() - ((g.getUTCDay() + 6) % 7));
    lunes.setUTCHours(0, 0, 0, 0);
    const semana = mios.filter(x => (x.tsEntregado || x.ts) >= lunes.getTime() + 21600000).length;
    const dinero2 = (q) => Math.round(+q * 100) / 100;
    return res.status(200).json({ ok: true, registro: reg.datos, estado: reg.estado, checks: reg.checks || [], docs: (reg.datos && reg.datos.docs) || [], stats: {
      entregas: mios.length,
      semana,
      ganado: dinero2(mios.reduce((s, x) => s + (x.envio - x.comision), 0)),
      comisiones: dinero2(mios.reduce((s, x) => s + (x.comision || 0) + (x.comisionLocal || 0), 0)),
      calif: califs.length ? Math.round(califs.reduce((s, x) => s + x.califCliente, 0) / califs.length * 10) / 10 : null,
      pendiente: st.pendiente ? st.pendiente.monto : 0
    }});
  }
  if (action === 'doc') {
    const archivo = String(d.archivo || '').replace(/[^a-z0-9_/.,-]/gi, '');
    if (!archivo) return res.status(200).json({ ok: false, error: 'Documento inválido.' });
    const archivoEnc = archivo.split('/').map(encodeURIComponent).join('/');
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/dragopres/${archivoEnc}?ref=${BRANCH}`, {
      headers: { Authorization: 'Bearer ' + TOKEN(), Accept: 'application/vnd.github+json' }
    });
    if (!r.ok) return res.status(200).json({ ok: false, error: 'Documento no encontrado (HTTP ' + r.status + ')' });
    const j = await r.json();
    return res.status(200).json({ ok: true, img: 'data:image/jpeg;base64,' + j.content });
  }
  if (action === 'pozo') {
    const TZ = 6 * 3600 * 1000;
    const g = new Date(Date.now() - TZ);
    const lunes = Date.UTC(g.getUTCFullYear(), g.getUTCMonth(), g.getUTCDate() - (g.getUTCDay() + 6) % 7) + TZ;
    const entregados = pedidos.filter(o => o.estado === 'entregado' && (o.tsEntregado || o.ts) >= lunes);
    const comisiones = entregados.reduce((s, o) => s + (o.comision || 0) + (o.comisionLocal || 0), 0);
    const por = {};
    entregados.forEach(o => { if (o.piloto) { const k = o.piloto.nombre; por[k] = (por[k] || 0) + 1; } });
    return res.status(200).json({ ok: true, meta: 20, comisiones, pozo: Math.round(comisiones * 25) / 100, pilotos: Object.entries(por).map(([nombre, entregas]) => ({ nombre, entregas })).sort((x, y) => y.entregas - x.entregas) });
  }
  return res.status(200).json({ ok: false, error: 'Acción desconocida' });
});
