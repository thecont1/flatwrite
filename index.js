/* Vercel Node.js root handler — serves public/ + API routes */
const fs = require("fs");
const path = require("path");
const handleRender = require("./api/render");
const { readBody } = require("./core/io");

const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/* ── JSON response helper ───────────────────────────────────────────────── */
function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

/* ── API: POST /api/share ───────────────────────────────────────────────── */
async function handleShare(req, res) {
  const BASE = process.env.DUSTEBIN_BASE_URL;
  if (!BASE) return json(res, 500, { error: "Server configuration error" });

  let body;
  try { body = await readBody(req, 512 * 1024); } catch (e) {
    if (e.message === "Payload too large") return json(res, 413, { error: "Payload too large" });
    return json(res, 400, { error: "Bad body" });
  }
  if (!body) return json(res, 400, { error: "Empty content" });

  try {
    const up = await fetch(BASE + "/api/pastes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: body, language: "markdown", expiration: "7d" }),
    });
    if (!up.ok) return json(res, 502, { error: "upstream_error" });
    const data = await up.json();
    if (!data || !data.id) return json(res, 502, { error: "upstream_error" });
    return json(res, 200, { key: data.id });
  } catch { return json(res, 502, { error: "upstream_error" }); }
}

/* ── API: GET /api/s?key=<key> ──────────────────────────────────────────── */
async function handleFetch(req, res) {
  const url = new URL(req.url, "http://localhost");
  const key = url.searchParams.get("key");
  if (!key) return json(res, 400, { error: "missing_key" });

  const BASE = process.env.DUSTEBIN_BASE_URL;
  if (!BASE) return json(res, 500, { error: "Server configuration error" });

  try {
    const up = await fetch(BASE + "/api/pastes/" + encodeURIComponent(key) + "/raw");
    if (up.status === 404 || up.status === 410) return json(res, 404, { error: "not_found" });
    if (!up.ok) return json(res, 502, { error: "upstream_error" });
    const content = await up.text();
    if (content.indexOf("\0") !== -1) return json(res, 422, { error: "invalid_content" });
    return json(res, 200, { content });
  } catch { return json(res, 502, { error: "upstream_error" }); }
}

/* ── Static file server ─────────────────────────────────────────────────── */
function serveStatic(req, res) {
  const url = req.url.split("?")[0];
  const filePath = path.join(__dirname, "public", url === "/" ? "index.html" : url);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  /* SPA fallback */
  const indexPath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(indexPath)) {
    res.setHeader("Content-Type", "text/html");
    fs.createReadStream(indexPath).pipe(res);
    return;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain");
  res.end("Not found");
}

/* ── Router ─────────────────────────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  const url = req.url.split("?")[0];

  /* API routes */
  if (url === "/api/share"  && req.method === "POST") return handleShare(req, res);
  if (url === "/api/s"      && req.method === "GET")  return handleFetch(req, res);
  if (url === "/api/render") {
    if (req.method === "POST") return handleRender(req, res);
    return json(res, 405, { error: "POST only" });
  }

  /* Static files */
  serveStatic(req, res);
};
