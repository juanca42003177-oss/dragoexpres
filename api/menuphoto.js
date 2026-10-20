// DragoExpres — Fotos del menu de los locales.
// Se guardan en el repo PUBLICO de la app, rama menu-assets (no dispara deploys de Vercel),
// para que los consumidores las vean directo desde raw.githubusercontent.com
const wrap = require('./_cors');

const REPO_APP = 'juanca42003177-oss/dragoexpres';
const BRANCH = 'menu-assets';
const TOKEN = () => process.env.GITHUB_TOKEN || '';
const H = () => ({ Authorization: 'Bearer ' + TOKEN(), Accept: 'application/vnd.github+json' });

async function asegurarRama() {
  const chk = await fetch(`https://api.github.com/repos/${REPO_APP}/git/ref/heads/${BRANCH}`, { headers: H() });
  if (chk.ok) return;
  const base = await fetch(`https://api.github.com/repos/${REPO_APP}/git/ref/heads/main`, { headers: H() });
  if (!base.ok) throw new Error('rama main no accesible');
  const bj = await base.json();
  const cr = await fetch(`https://api.github.com/repos/${REPO_APP}/git/refs`, {
    method: 'POST',
    headers: { ...H(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: bj.object.sha }),
  });
  if (!cr.ok && cr.status !== 422) throw new Error('crear rama HTTP ' + cr.status);
}

module.exports = wrap(async (req, res) => {
  const d = req.body || {};
  const tel = String(d.tel || '').replace(/[^0-9]/g, '').slice(0, 15);
  const b64 = String(d.b64 || '').replace(/^data:image\/\w+;base64,/, '');
  if (!tel || !b64) return res.status(200).json({ ok: false, error: 'Faltan datos de la foto.' });
  if (b64.length > 400000) return res.status(200).json({ ok: false, error: 'Foto demasiado grande (comprimila desde el celular).' });
  try {
    await asegurarRama();
    const archivo = `menus/${tel}-${Date.now()}.jpg`;
    const r = await fetch(`https://api.github.com/repos/${REPO_APP}/contents/${archivo}`, {
      method: 'PUT',
      headers: { ...H(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'foto menu', branch: BRANCH, content: b64 }),
    });
    if (!r.ok) return res.status(200).json({ ok: false, error: 'No se pudo guardar la foto (HTTP ' + r.status + ')' });
    return res.status(200).json({ ok: true, foto: `https://raw.githubusercontent.com/${REPO_APP}/${BRANCH}/${archivo}` });
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'Error subiendo foto: ' + e.message });
  }
});
