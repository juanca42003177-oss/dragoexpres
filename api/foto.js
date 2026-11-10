// Sirve las fotos de fachada que sube el cliente (viven en el repo PRIVADO de datos).
// El piloto ve la foto real de la casa/taller y no se pierde buscando el portón.
const wrap = require('./_cors');
const REPO = process.env.GITHUB_DATA_REPO || 'juanca42003177-oss/dragon-labs-data';
const BRANCH = 'dragoexpres-data';
module.exports = wrap(async (req, res) => {
  const q = req.query || {};
  const p = String(q.p || '').replace(/\.\./g, '').replace(/^\/+/, '');
  // solo fotos de fachada: nada de documentos privados (DPI, licencia) por esta vía
  if (!/^docs\/fachada\/[A-Za-z0-9._-]{3,140}\.jpg$/.test(p)) return res.status(200).json({ ok: false, error: 'foto no válida' });
  const url = `https://api.github.com/repos/${REPO}/contents/dragoexpres/${p.split('/').map(encodeURIComponent).join('/')}?ref=${BRANCH}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + (process.env.GITHUB_TOKEN || ''), Accept: 'application/vnd.github+json' } });
  if (!r.ok) return res.status(200).json({ ok: false, error: 'foto no encontrada' });
  const j = await r.json();
  const buf = Buffer.from(String(j.content || ''), 'base64');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.status(200).send(buf);
});
