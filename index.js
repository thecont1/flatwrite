/* Vercel Node.js root handler — raw http.ServerResponse (no Express) */
module.exports = function handler(req, res) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain");
  res.end("Not found");
};
