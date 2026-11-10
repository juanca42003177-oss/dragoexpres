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

async function githubGet(path, branch) {
  const B = branch || BRANCH;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${B}`, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('GitHub leer ' + path + ' HTTP ' + r.status);
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8') || '[]') };
}
async function githubPut(path, sha, data, msg, branch) {
  const B = branch || BRANCH;
  const current = sha ? { sha } : await githubGet(path, B);
  const body = { message: msg || 'DragoExpres: actualizar bodega', branch: B, content: Buffer.from(JSON.stringify(data, null, 1)).toString('base64') };
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
/* RESPALDO (2026-11-10): copia la bodega viva a una rama APARTE (respaldo), nunca a
   la rama de respaldo-en-caliente (dragoexpres-data). Asi un respaldo viejo jamas
   puede pisar los datos buenos si Supabase se cae y la app usa GitHub. */
const BRANCH_RESPALDO = process.env.GITHUB_BRANCH_RESPALDO || 'respaldo';
async function asegurarRamaRespaldo() {
  const rb = await fetch(`https://api.github.com/repos/${REPO}/branches/${BRANCH_RESPALDO}`, { headers: ghHeaders() });
  if (rb.ok) return true;
  const rs = await fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/${BRANCH}`, { headers: ghHeaders() });
  if (!rs.ok) return false;
  const j = await rs.json();
  const rc = await fetch(`https://api.github.com/repos/${REPO}/git/refs`, {
    method: 'POST', headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'refs/heads/' + BRANCH_RESPALDO, sha: j.object.sha }),
  });
  return rc.ok || rc.status === 422;
}
async function respaldoGithub(path, data, msg) {
  try { await asegurarRamaRespaldo(); } catch (e) { }
  return githubPut(path, null, data, msg || 'respaldo bodega', BRANCH_RESPALDO);
}
module.exports = { usaDb, dbGet, dbPut, respaldoGithub, BRANCH_RESPALDO };
