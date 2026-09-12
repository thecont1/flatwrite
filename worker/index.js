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

// worker/index.js — Cloudflare Worker entry point for flatwrite.md (apex + www)
//
// This is the Worker that replaces the Vercel deployment. It serves:
//
//   POST /api/render       → api/render.js      (canonical render handler)
//   POST /api/import-url   → api/import-url.js  (AnyDoc import-from-URL)
//   POST /api/share        → Dustebin paste create (index.js handleShare logic)
//   GET  /api/s?key=       → Dustebin paste fetch   (index.js handleFetch logic)
//   everything else        → static assets via env.ASSETS (public/)
//
// The canonical API handlers (api/render.js, api/import-url.js) are reused
// verbatim via createRequire — they are written against plain Node.js
// http.ServerRequest/ServerResponse APIs, so this entry provides a thin
// adaptation layer:
//
//   Request  → { method, url, headers, socket: { remoteAddress }, on(...) }
//   Response → { statusCode, setHeader(), end() }  (collected into a Worker Response)
//
// process.env is auto-populated with Worker env vars/secrets by
// nodejs_compat for compatibility dates >= 2025-04-01, so the handlers'
// process.env.INTERNAL_RENDER_KEY / EXTRACT_SERVICE_URL / TRUST_PROXY reads
// work unchanged.
//
// Static assets: assets.run_worker_first is limited to /api/* in
// wrangler.jsonc, so every non-API request is served directly by the
// assets layer (including _redirects/_headers processing) without invoking
// this Worker at all. env.ASSETS.fetch() here is only the fallback for
// requests that somehow reach the Worker on a non-API path.

// The canonical handlers are CommonJS modules. Importing them as ESM lets
// the bundler (Wrangler/esbuild) statically resolve their whole require()
// graph — api/render.js, core/render.js, core/math.js, core/font-loader.js,
// sanitize-html, marked — and wrap them with CJS interop. This works in
// workerd (import.meta.url is unavailable there, so createRequire is not).
import handleRender from '../api/render.js';
import handleImportUrl from '../api/import-url.js';
import { setAssetReader } from '../core/inline-assets.js';
import { setFontFileExists } from '../core/font-loader.js';

/* ── Static-asset bridge for core/font-loader.js ──────────────────────────
 * renderToDocument() embeds the vendored .woff2 fonts from public/fonts/
 * as data URIs. On Node that goes through node:fs; on Workers there is no
 * filesystem, so we route those reads through the ASSETS binding.
 *
 * FONT_DIR is <repo>/public/fonts; asset URLs are /fonts/<file>. The ASSETS
 * binding only serves paths *within* public/, so we map the absolute path
 * to its public URL by stripping up to '/public/'.
 */
const FONT_PATH_RE = /\/public\/(.+)$/;

function toAssetUrl(absPath) {
  const m = FONT_PATH_RE.exec(absPath);
  return m ? '/' + m[1] : null;
}

function configureAssetBridge(env) {
  if (!env || !env.ASSETS) return;
  setAssetReader((absPath) => {
    const assetUrl = toAssetUrl(absPath);
    if (!assetUrl) return null;
    // Synchronous existence check + async body fetch cannot be mixed in the
    // loadAsset contract, so the reader itself stays async-capable: loadAsset
    // awaits the result. We return a promise-wrapped entry; loadAsset treats
    // a thenable like any other value via Buffer.from(buffer).
    // (core/inline-assets.js readLocal is called inside async loadAsset.)
    return fetchViaAssets(env, assetUrl);
  });
  setFontFileExists((absPath) => {
    const assetUrl = toAssetUrl(absPath);
    if (!assetUrl) return false;
    // Fonts are small (<100KB); the existence probe caches the response so
    // the subsequent read in loadAsset reuses the entry.
    return assetCache.has(assetUrl) ? assetCache.get(assetUrl) !== null : true;
  });
}

/* Small cache of ASSETS responses so the exists-probe + read pair costs one
 * fetch instead of two. Map<url, Promise<{buffer, contentType}|null>>. */
const assetCache = new Map();

async function fetchViaAssets(env, assetUrl) {
  if (!assetCache.has(assetUrl)) {
    const promise = (async () => {
      const resp = await env.ASSETS.fetch(new Request('https://flatwrite.md' + assetUrl));
      if (!resp.ok) return null;
      const buffer = await resp.arrayBuffer();
      const contentType = resp.headers.get('content-type') || 'application/octet-stream';
      return { buffer, contentType };
    })();
    promise.catch(() => {}); // avoid unhandled rejection if the probe never awaits
    assetCache.set(assetUrl, promise);
  }
  return assetCache.get(assetUrl);
}

/* ── Node-style response shim ────────────────────────────────────────────
 * Collects statusCode/headers/body written by the canonical handlers and
 * materialises a Worker Response. Only the http.ServerResponse surface the
 * handlers actually use: statusCode (get/set), setHeader, end.
 */
function makeResponseShim() {
  const state = { statusCode: 200, headers: {}, body: null };
  const res = {
    setHeader(name, value) {
      state.headers[name] = value;
    },
    end(data) {
      if (data !== undefined && data !== null) state.body = data;
    },
  };
  Object.defineProperty(res, 'statusCode', {
    get: () => state.statusCode,
    set: (v) => { state.statusCode = v; },
  });
  return { res, state };
}

function toWorkerResponse(state) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(state.headers)) {
    headers.set(name, value);
  }
  const body = state.body === null || state.body === undefined ? null : String(state.body);
  const resp = new Response(body, { status: state.statusCode, headers });

  // Workerd does not sniff Content-Type for opaque string bodies — preserve
  // whatever the handler set, defaulting to JSON (every end() call in the
  // canonical handlers writes JSON).
  if (!resp.headers.has('Content-Type')) {
    resp.headers.set('Content-Type', 'application/json');
  }
  return resp;
}

/* ── Node-style request shim ─────────────────────────────────────────────
 * Builds the { method, url, headers, socket, on() } object the handlers
 * expect from a Worker Request. core/io.js readBody() listens for 'data'
 * and 'end' events and counts chunk.length as bytes; TextDecoder chunks
 * guarantee string.length === byte count for UTF-8 input.
 */
function makeRequestShim(request) {
  const url = new URL(request.url);
  const headers = {};
  for (const [name, value] of request.headers.entries()) {
    const key = name.toLowerCase();
    // Node gives first-wins for duplicated headers; Headers.get() matches that.
    if (key in headers) continue;
    headers[key] = value;
  }

  const ip =
    headers['cf-connecting-ip'] ||
    (headers['x-forwarded-for'] ? String(headers['x-forwarded-for']).split(',')[0].trim() : undefined) ||
    '0.0.0.0';

  /* The Worker Request body can only be consumed once, but readBody()
     registers BOTH 'data' and 'end' listeners — read the body lazily once,
     cache it, and replay to whichever listeners attach. */
  let bodyPromise = null;
  function readBodyText() {
    if (!bodyPromise) bodyPromise = request.text().catch(() => '');
    return bodyPromise;
  }

  let bodyDelivered = false;
  return {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    socket: { remoteAddress: ip },

    on(event, cb) {
      if (event === 'data') {
        if (bodyDelivered) return;
        bodyDelivered = true;
        readBodyText().then((text) => { if (text) cb(text); });
      } else if (event === 'end') {
        readBodyText().then(() => cb());
      }
      // 'error' and others: never fired for these handlers.
    },
  };
}

/* ── API: POST /api/share ─────────────────────────────────────────────────
 * Mirrors index.js handleShare: 512 KB cap, markdown paste, 7-day expiry.
 * Written directly against the Worker Request/Response because the legacy
 * api/share.js uses Vercel's res.status().json() convenience API.
 */
const MAX_SHARE_BYTES = 512 * 1024;

async function handleShare(request) {
  const BASE = process.env.DUSTEBIN_BASE_URL;
  if (!BASE) {
    return Response.json({ error: 'Server configuration error' }, { status: 500 });
  }

  let body;
  try {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_SHARE_BYTES) {
      return Response.json({ error: 'Payload too large' }, { status: 413 });
    }
    body = new TextDecoder('utf-8', { fatal: false }).decode(raw);
  } catch {
    return Response.json({ error: 'Bad body' }, { status: 400 });
  }
  if (!body) {
    return Response.json({ error: 'Empty content' }, { status: 400 });
  }

  try {
    const up = await fetch(BASE + '/api/pastes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: body, language: 'markdown', expiration: '7d' }),
    });
    if (!up.ok) {
      return Response.json({ error: 'upstream_error' }, { status: 502 });
    }
    const data = await up.json();
    if (!data || !data.id) {
      return Response.json({ error: 'upstream_error' }, { status: 502 });
    }
    return Response.json({ key: data.id });
  } catch {
    return Response.json({ error: 'upstream_error' }, { status: 502 });
  }
}

/* ── API: GET /api/s?key=<key> ────────────────────────────────────────────
 * Mirrors index.js handleFetch (the canonical live behaviour): 404 on
 * 404/410, null-byte rejection, JSON { content } response.
 */
async function handleFetchShared(request) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key) {
    return Response.json({ error: 'missing_key' }, { status: 400 });
  }

  const BASE = process.env.DUSTEBIN_BASE_URL;
  if (!BASE) {
    return Response.json({ error: 'Server configuration error' }, { status: 500 });
  }

  try {
    const up = await fetch(BASE + '/api/pastes/' + encodeURIComponent(key) + '/raw');
    if (up.status === 404 || up.status === 410) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    if (!up.ok) {
      return Response.json({ error: 'upstream_error' }, { status: 502 });
    }
    const content = await up.text();
    if (content.indexOf('\0') !== -1) {
      return Response.json({ error: 'invalid_content' }, { status: 422 });
    }
    return Response.json({ content });
  } catch {
    return Response.json({ error: 'upstream_error' }, { status: 502 });
  }
}

/* ── Fetch handler ────────────────────────────────────────────────────────
 * run_worker_first is scoped to /api/*, so this handler only sees API
 * requests in production; env.ASSETS.fetch() covers the rest defensively.
 */
export default {
  async fetch(request, env, ctx) {
    configureAssetBridge(env);
    const url = new URL(request.url);
    const pathname = url.pathname;

    /* Static file: let the assets binding serve (it applies _redirects and
       _headers). Only reached in production via direct ASSETS binding use
       or misconfiguration; a plain pass-through keeps behaviour identical
       to the asset-first routing. */
    if (!pathname.startsWith('/api/')) {
      if (env && env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return new Response('Not found', { status: 404 });
    }

    if (pathname === '/api/share' && request.method === 'POST') {
      return handleShare(request);
    }
    if (pathname === '/api/share' && request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    if (pathname === '/api/s' && request.method === 'GET') {
      return handleFetchShared(request);
    }
    if (pathname === '/api/s' && request.method !== 'GET') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    if (pathname === '/api/render') {
      if (request.method === 'POST') {
        const { res, state } = makeResponseShim();
        await handleRender(makeRequestShim(request), res);
        return toWorkerResponse(state);
      }
      return Response.json({ error: 'POST only' }, { status: 405 });
    }
    if (pathname === '/api/import-url') {
      if (request.method === 'POST') {
        const { res, state } = makeResponseShim();
        await handleImportUrl(makeRequestShim(request), res);
        return toWorkerResponse(state);
      }
      return Response.json({ error: 'POST only' }, { status: 405 });
    }

    /* Unknown /api/* path. _redirects has a `/* → /index.html 200` proxy
       rule, but redirects never apply to Worker-served responses, so
       match the previous Vercel behaviour for unknown API paths: 404 JSON
       (api/*.js 404'd on Vercel; index.js had no /api/* catch-all). */
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
};
