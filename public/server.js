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

/* When enabled, GET /api/s?key=<name> serves a fixture from
   public/test/fixtures/shares/<key>. This lets local development and
   Playwright tests reproduce the `?s=<key>` shared-doc flow without
   the upstream Dustebin paste backend.

   Security defaults:
     - Production (NODE_ENV=production): stubs OFF unless explicitly
       forced on with FW_STUB_SHARES=1. This file is server-runnable
       and binds to non-localhost interfaces in some deployments —
       the previous "enabled by default" default was an unauthenticated
       local file read when bound to a public interface.
     - Dev / unbranded: stubs ON by default so `npm start` continues
       to hydrate `?s=<fixture>` URLs without extra setup. Explicit
       FW_STUB_SHARES=0 always disables, FW_STUB_SHARES=1 always enables. */
const isProd = process.env.NODE_ENV === "production";
const stubEnv = process.env.FW_STUB_SHARES;
const STUB_SHARES = stubEnv === "1" || (!isProd && stubEnv !== "0");

/* Strict allowlist for share keys. Public HTTP callers can pass any
   string, so we treat the key as untrusted input and refuse anything
   outside [A-Za-z0-9._-] before it touches the filesystem. The
   explicit `..` reject is belt-and-braces in case the regex ever
   loosens; the regex alone already blocks slashes, null bytes,
   and other path metacharacters. */
const VALID_SHARE_KEY = /^[A-Za-z0-9._-]+$/;
function isValidShareKey(key) {
  return typeof key === "string" && key.length > 0 &&
    VALID_SHARE_KEY.test(key) && !key.includes("..");
}

const SHARE_FIXTURES_DIR = path.resolve(__dirname, "test", "fixtures", "shares");

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  /* Exact-path match: split off the query string first, then require
     the path component to be exactly "/api/s". The previous
     startsWith("/api/s") check accidentally matched /api/sx,
     /api/secrets, /api/s/anything, etc. */
  const pathOnly = req.url.split("?")[0];
  if (STUB_SHARES && pathOnly === "/api/s") {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const reqUrl = new URL(req.url, "http://localhost");
    const key = reqUrl.searchParams.get("key");
    if (!key) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing_key" }));
      return;
    }
    if (!isValidShareKey(key)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_key" }));
      return;
    }
    /* Defense-in-depth path containment: even with the allowlist above,
       resolve the candidate and confirm it stays inside the fixtures
       directory. If any future caller or code path forgets to
       validate, this still catches classical ../ traversal. */
    const candidate = path.resolve(SHARE_FIXTURES_DIR, key);
    if (!candidate.startsWith(SHARE_FIXTURES_DIR + path.sep)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_key" }));
      return;
    }
    try {
      const data = await fs.promises.readFile(candidate, "utf8");
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
