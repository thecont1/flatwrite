/* Vercel Node.js entrypoint — static files served from public/, API routes from api/ */
module.exports = function (req, res) {
  res.status(404).send("Not found");
};
