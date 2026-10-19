const wrap = require('./_cors');
module.exports = wrap(async (req, res) => {
  res.status(200).json({ ok: true, app: 'dragoexpres', ts: Date.now() });
});
