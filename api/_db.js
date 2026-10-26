// DragoExpres — DOBLE VÍA DE DATOS (Supabase o GitHub), misma interfaz para toda la app.
// Regla de Juan: si SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY están en las variables de entorno,
// TODA la bodega JSON vive en la base de datos real (miles de usuarios a la vez).
// Si no están, la app sigue con GitHub exactamente como siempre. Cero riesgo.
// Las fotos (DPI, menús) siguen en GitHub: son archivos estáticos que no van ni vienen seguido.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const usaDb = !!(SUPABASE_URL && SUPABASE_KEY);

const RH = () => ({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' });

// Lee un "archivo" de la bodega (misma firma y contrato que ghGet de GitHub):
// devuelve { sha, data } o null si no existe.
async function dbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/bodega?path=eq.${encodeURIComponent(path)}&select=data`, { headers: RH() });
  if (!r.ok) throw new Error('db leer ' + path + ' HTTP ' + r.status);
  const rows = await r.json();
  if (!rows || !rows.length) return null;
  return { sha: null, data: rows[0].data };
}

// Guarda un "archivo" completo de la bodega (misma firma que ghPut: sha se ignora en la base).
async function dbPut(path, sha, data, msg) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/bodega`, {
    method: 'POST',
    headers: { ...RH(), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ path: path, data: data, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error('db guardar ' + path + ' HTTP ' + r.status);
  return true;
}

module.exports = { usaDb, dbGet, dbPut };
