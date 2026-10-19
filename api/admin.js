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
    const comisiones = pedidos.reduce((s, o) => s + (o.estado === 'entregado' ? (o.comision || 0) : 0), 0);
    const porEstado = {};
    pedidos.forEach(o => porEstado[o.estado] = (porEstado[o.estado] || 0) + 1);
    return res.status(200).json({ ok: true, pedidos: pedidos.slice(-60).reverse(), total: pedidos.length, comisiones, porEstado });
  }
  return res.status(200).json({ ok: false, error: 'Acción desconocida' });
});
