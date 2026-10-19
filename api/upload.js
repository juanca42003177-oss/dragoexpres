// Subida de documentos de pilotos (DPI, licencia, foto) al repo PRIVADO de datos.
// El cliente comprime la imagen a ~200KB antes de enviarla (canvas + jpeg 0.7).
const wrap = require('./_cors');
const { ensureBranch } = require('./_dx');
const REPO = process.env.GITHUB_DATA_REPO || 'juanca42003177-oss/dragon-labs-data';
const BRANCH = 'dragoexpres-data';
module.exports = wrap(async (req, res) => {
  const d = req.body || {};
  const tipo = String(d.docTipo || '').replace(/[^a-z]/g, '');
  const nombre = String(d.nombre || '').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 40) || 'piloto';
  const tel = String(d.tel || '').replace(/[^0-9]/g, '').slice(0, 15) || '0';
  const b64 = String(d.b64 || '').replace(/^data:image\/\w+;base64,/, '');
  if (!tipo || !b64) return res.status(200).json({ ok: false, error: 'Faltan datos del documento.' });
  if (b64.length > 900000) return res.status(200).json({ ok: false, error: 'Imagen demasiado grande.' });
  await ensureBranch();
  const path = `docs/${tipo}/${tel}-${nombre}-${Date.now()}.jpg`;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/dragoexpres/${path}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + (process.env.GITHUB_TOKEN || ''), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'doc ' + tipo, branch: BRANCH, content: b64 }),
  });
  if (!r.ok) return res.status(200).json({ ok: false, error: 'No se pudo guardar el documento (HTTP ' + r.status + ')' });
  return res.status(200).json({ ok: true, archivo: path });
});
