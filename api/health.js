// DragoExpres — health + diagnóstico de la doble vía (sin exponer secretos).
const wrap = require('./_cors');
module.exports = wrap(async (req, res) => {
  const q = req.query || {};
  // ?diag=1 → muestra si Vercel entregó las variables de Supabase y si la base responde.
  if (q.diag === '1') {
    const URL_RAW = (process.env.SUPABASE_URL || '').trim();
    const KEY_RAW = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    // sonda DIRECTA a Supabase (sin pasar por el respaldo, para ver la verdad)
    let sonda = 'no aplica (faltan variables)';
    if (URL_RAW && KEY_RAW) {
      try {
        const r = await fetch(`${URL_RAW.replace(/\/+$/, '')}/rest/v1/bodega?select=path&limit=1`, { headers: { apikey: KEY_RAW, Authorization: 'Bearer ' + KEY_RAW } });
        sonda = 'HTTP ' + r.status + (r.ok ? ' — Supabase AUTENTICA bien' : ' — Supabase RECHAZA (llave o URL mal pegada)');
      } catch (e) { sonda = 'sin conexión: ' + String(e.message || e).slice(0, 60); }
    }
    return res.status(200).json({ ok: true, app: 'dragoexpres', ts: Date.now(), env: { SUPABASE_URL: URL_RAW ? 'SI' : 'NO', SUPABASE_SERVICE_ROLE_KEY: KEY_RAW ? 'SI (' + KEY_RAW.length + ' caracteres, la buena son 219)' : 'NO' }, modo: 'SUPABASE', sonda });
  }
  res.status(200).json({ ok: true, app: 'dragoexpres', ts: Date.now() });
});
