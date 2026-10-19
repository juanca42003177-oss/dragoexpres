module.exports = function wrap(handler) {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    try { return await handler(req, res); }
    catch (e) { return res.status(200).json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
  };
};
