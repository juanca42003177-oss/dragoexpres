// DragoExpres — health + diagnóstico de la doble vía (sin exponer secretos).
const wrap = require('./_cors');
module.exports = wrap(async (req, res) => {
  const q = req.query || {};
  // ?diag=1 → muestra si Vercel entregó las variables de Supabase y si la base responde.
  if (q.diag === '1') {
    const { usaDb, dbGet } = require('./_db');
    const URL_ENV = process.env.SUPABASE_URL ? 'SI' : 'NO';
    const KEY_ENV = process.env.SUPABASE_SERVICE_ROLE_KEY ? 'SI (' + process.env.SUPABASE_SERVICE_ROLE_KEY.length + ' caracteres)' : 'NO';
    let dbPrueba = 'no aplica (modo GitHub)';
    if (usaDb) {
      try { const r = await dbGet('salud.json'); dbPrueba = 'OK, responde (' + (r ? r.data && Object.keys(r.data).length + ' claves en salud.json' : 'archivo no existe pero autenticó') + ')'; }
      catch (e) { dbPrueba = 'FALLA: ' + String(e.message || e).slice(0, 80); }
    }
    return res.status(200).json({ ok: true, app: 'dragoexpres', ts: Date.now(), env: { SUPABASE_URL: URL_ENV, SUPABASE_SERVICE_ROLE_KEY: KEY_ENV }, modo: usaDb ? 'SUPABASE' : 'GITHUB', dbPrueba });
  }
  res.status(200).json({ ok: true, app: 'dragoexpres', ts: Date.now() });
});
