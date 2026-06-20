/* Minimal test endpoint */

module.exports = function handler(req, res) {
  res.status(200).json({ ok: true, method: req.method });
};
