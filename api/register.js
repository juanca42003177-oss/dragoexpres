// Registro de pilotos, locales, flotistas y usuarios de DragoExpres.
// Los registros (datos personales) se guardan en el repo PRIVADO de datos,
// rama 'dragoexpres-data', archivo registros.json — nunca en repos publicos.
const wrap = require('./_cors');
const { REPO, BRANCH, TOKEN, H, ensureBranch, normalizar } = require('./_dx');
const PATH = 'registros.json';
let cache = null;

async function ghGet() {
  await ensureBranch();
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}?ref=${BRANCH}`, { headers: H() });
  if (!r.ok) return null;
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8') || '[]') };
}
async function ghPut(sha, data) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}`, {
    method: 'PUT',
    headers: { ...H(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'registro nuevo', branch: BRANCH, content: Buffer.from(JSON.stringify(data, null, 1)).toString('base64'), sha: sha || undefined }),
  });
  if (!r.ok) throw new Error('guardar HTTP ' + r.status);
}

module.exports = wrap(async (req, res) => {
  const now = Date.now();
  if (req.query && req.query.stats) {
    let stats = { pilotos: 0, locales: 0, flota: 0 };
    if (cache && now - cache.ts < 60000) stats = cache.stats;
    else {
      const f = await ghGet();
      if (f) {
        stats = { pilotos: f.data.filter(r => r.tipo === 'piloto').length, locales: f.data.filter(r => r.tipo === 'local').length, flota: f.data.filter(r => r.tipo === 'flota').length };
        cache = { ts: now, stats };
      }
    }
    return res.status(200).json({ ok: true, stats: stats, pilotos: stats.pilotos, locales: stats.locales, flota: stats.flota });
  }
  const d = normalizar(req.body);
  if (!d.tipo || !d.nombre || !d.tel || !d.zona) {
    return res.status(200).json({ ok: false, error: 'Faltan datos: nombre, WhatsApp y área son obligatorios.' });
  }
  const f = await ghGet();
  const data = f ? f.data : [];
  data.push({ tipo: d.tipo, datos: d, estado: 'pendiente_verificacion', ts: now });
  await ghPut(f ? f.sha : null, data);
  return res.status(200).json({ ok: true, mensaje: 'Registro recibido' });
});
