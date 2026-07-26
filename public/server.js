/**
 * flatwrite.md - Minimalist Markdown Editor
 *
 * Copyright (C) 2026 Mahesh Shantaram
 * Sole Proprietary Owner. All Rights Reserved.
 *
 * This file is part of flatwrite.md.
 * flatwrite.md is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * For commercial, closed-source embedding, and SaaS deployment exemptions,
 * a valid Commercial License Agreement is required. Contact: sales@flatwrite.md
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/markdown",
  ".woff2": "font/woff2",
};

const CACHE_HEADERS = {
  ".css": "public, max-age=31536000, immutable",
  ".js": "public, max-age=31536000, immutable",
  ".woff2": "public, max-age=31536000, immutable",
  ".png": "public, max-age=31536000, immutable",
  ".jpg": "public, max-age=31536000, immutable",
  ".svg": "public, max-age=31536000, immutable",
  ".ico": "public, max-age=31536000, immutable",
  ".html": "no-cache",
};

/* When 1 (default), GET /api/s?key=<name> serves a fixture from
   public/test/fixtures/shares/<key>. This lets local development and
   Playwright tests reproduce `?s=<key>` shared-doc flow without the
   upstream Dustebin paste backend. Set FW_STUB_SHARES=0 in production. */
const STUB_SHARES = process.env.FW_STUB_SHARES !== "0";

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (STUB_SHARES && req.url.startsWith("/api/s")) {
    const reqUrl = new URL(req.url, "http://localhost");
    const key = reqUrl.searchParams.get("key");
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!key) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing_key" }));
      return;
    }
    const fixturePath = path.join(__dirname, "test", "fixtures", "shares", key);
    try {
      const data = await fs.promises.readFile(fixturePath, "utf8");
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      });
      res.end(JSON.stringify({ content: data }));
    } catch (err) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    }
    return;
  }

  let url = req.url.split("?")[0];
  let filePath = path.join(__dirname, url === "/" ? "index.html" : url);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": CACHE_HEADERS[ext] || "no-cache",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log("Server running at http://localhost:" + PORT + (STUB_SHARES ? " (share stubs ENABLED, FW_STUB_SHARES=0 to disable)" : ""));
});
