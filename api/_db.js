// DragoExpres storage adapter. Prefer Supabase when configured and healthy.
// If its credentials/API fail, fall back to the existing GitHub JSON bodega so
// the live app remains readable and writable while configuration is repaired.
// trim(): Vercel a veces guarda la llave con un espacio o salto de línea pegado
// (regla aprendida 2026-10-26: la llave buena tiene 219 caracteres, una dañada tenía 220).
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const usaDb = !!(SUPABASE_URL && SUPABASE_KEY);
const REPO = process.env.GITHUB_DATA_REPO || 'juanca42003177-oss/dragon-labs-data';
const BRANCH = 'dragoexpres-data';
const GH_TOKEN = () => process.env.GITHUB_TOKEN || '';
const ghHeaders = () => ({ Authorization: 'Bearer ' + GH_TOKEN(), Accept: 'application/vnd.github+json' });
const RH = () => ({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' });

async function githubGet(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${BRANCH}`, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('GitHub leer ' + path + ' HTTP ' + r.status);
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8') || '[]') };
}
async function githubPut(path, sha, data, msg) {
  const current = sha ? { sha } : await githubGet(path);
  const body = { message: msg || 'DragoExpres: actualizar bodega', branch: BRANCH, content: Buffer.from(JSON.stringify(data, null, 1)).toString('base64') };
  if (current && current.sha) body.sha = current.sha;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PUT', headers: { ...ghHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('GitHub guardar ' + path + ' HTTP ' + r.status);
  return true;
}
async function dbGet(path) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/bodega?path=eq.${encodeURIComponent(path)}&select=data`, { headers: RH() });
    if (r.ok) {
      const rows = await r.json();
      if (rows && rows.length) return { sha: null, data: rows[0].data };
      // Missing Supabase row: use GitHub's existing value if present.
    }
  } catch (_) { /* fail over below */ }
  return githubGet(path);
}
async function dbPut(path, sha, data, msg) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/bodega`, {
      method: 'POST', headers: { ...RH(), Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ path, data, updated_at: new Date().toISOString() }),
    });
    if (r.ok) return true;
  } catch (_) { /* fail over below */ }
  return githubPut(path, sha, data, msg);
}
module.exports = { usaDb, dbGet, dbPut };
