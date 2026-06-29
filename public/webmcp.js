// public/webmcp.js
//
// Registers the FlatWrite render tools via navigator.modelContext (WebMCP,
// Chrome 146+ DevTrial) so an AI agent driving the browser can call the
// same render pipeline that the editor uses internally.
//
// This script runs client-side in the tab when flatwrite.md is loaded. On
// browsers without WebMCP it does nothing. The handler calls the public
// render.flatwrite.md/render Worker — same endpoint the MCP server uses
// — so the page output is byte-identical to what an MCP/HTTP client gets
// from outside the browser.
//
// Auth model: we do NOT embed a long-lived API key in this script.
// Instead, the script mints short-lived HMAC tokens from
// render.flatwrite.md/mcp-token at page load (and on demand when the
// cached token is about to expire) and sends them as X-Mcp-Token. The
// Worker mints these tokens only for trusted origins (flatwrite.md and
// its subdomains), validates the X-Mcp-Token HMAC signature, and
// rejects any browser request that tries to send X-Api-Key directly.

import {
  buildRawMarkdownBody,
  buildRemoteMarkdownBody,
  validateFontFamily,
  validateMarkdownUrl,
} from './webmcp-shared.js';

// navigator.modelContext is the WebMCP entry point. If absent (older
// browsers, or the DevTrial flag is off), gracefully bail.
if (typeof navigator === 'undefined' || !navigator.modelContext) {
  // Module top-level; no further work.
}
else {
  var RENDER_URL = 'https://render.flatwrite.md/render';
  var TOKEN_URL = 'https://render.flatwrite.md/mcp-token';

  // ---- Token management ----
  //
  // We mint short-lived tokens via the Worker's /mcp-token endpoint
  // and cache them in memory. A token is good for ~60s; we refresh
  // ~10s before expiry to keep tool calls fast. The Worker is the
  // source of truth for the TTL — we just refresh defensively.
  var cachedToken = null;
  var inflightToken = null;

  async function getToken() {
    if (cachedToken && cachedToken.expiresAt > Math.floor(Date.now() / 1000) + 10) {
      return cachedToken;
    }
    // Coalesce concurrent calls so we don't mint N tokens in parallel
    // when a tool fires several render_markdown calls at once.
    if (inflightToken) return inflightToken;
    inflightToken = (async () => {
      try {
        var r = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!r.ok) {
          var detail = '';
          try { detail = (await r.text()).slice(0, 200); } catch (_) { /* ignore */ }
          throw new Error('token mint failed: HTTP ' + r.status + ' ' + detail);
        }
        var body = await r.json();
        if (!body || !body.token || !body.expiresAt) {
          throw new Error('token mint returned malformed body');
        }
        cachedToken = body;
        return body;
      } finally {
        inflightToken = null;
      }
    })();
    return inflightToken;
  }

  /**
   * POST to the render Worker. Resolves with the JSON response body
   * on 2xx, rejects with a structured Error (carrying .code and .detail)
   * otherwise. Mirrors the MCP server's renderClient.ts error contract.
   */
  async function callRender(body) {
    var t = await getToken();
    var resp = await fetch(RENDER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mcp-Token': t.token,
      },
      body: JSON.stringify(body),
    });
    var text = await resp.text();
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (_) { parsed = null; }
    if (!resp.ok) {
      // If the token expired between mint and use (clock skew / 60s
      // boundary), clear the cache and surface a clean error.
      if (resp.status === 401) cachedToken = null;
      var err = parsed || { error: 'HTTP ' + resp.status, code: 'RENDER_FAILED' };
      var e = new Error(err.error + ' [' + err.code + ']');
      e.code = err.code;
      e.detail = err.detail;
      e.status = resp.status;
      throw e;
    }
    if (!parsed || typeof parsed.head !== 'string' || typeof parsed.body !== 'string') {
      var e2 = new Error('Malformed render response [RENDER_FAILED]');
      e2.code = 'RENDER_FAILED';
      throw e2;
    }
    return parsed;
  }

  // Pre-warm the token at page load so the first tool call is fast.
  // Fire-and-forget — failure here is recoverable on the first tool call.
  getToken().catch(() => {});  // fire-and-forget; failure recovered on first tool call

  // === render_markdown ===
  navigator.modelContext.registerTool({
    name: 'render_markdown',
    description:
      'Render raw markdown into FlatWrite-styled HTML head and body fragments. ' +
      'Same render pipeline as the editor (flatwrite.md) and the flatwrite-render MCP server. ' +
      'Returns { head, body }: head is CSS to inject, body is the document fragment.',
    inputSchema: {
      type: 'object',
      properties: {
        markdown: { type: 'string', description: 'Raw markdown content to render' },
        framework: { type: 'string', description: 'Optional UI framework (spectre, pico, oat, poshui, simple)' },
        fontFamily: { type: 'string', description: 'Optional font family — must be a bundled family: Inter, JetBrains Mono, Lato, Lora, Merriweather, Playfair Display, Comfortaa, Unbounded. Defaults to Inter.' },
        fontSize: {
          oneOf: [
            { type: 'string', description: 'Scale token (e.g. "-1", "0", "1")' },
            { type: 'number', description: 'Absolute pixel value (8..72)' },
          ],
          description: 'Optional font size',
        },
        fontWeight: {
          oneOf: [
            { type: 'string', description: 'Scale token (e.g. "-1", "0")' },
            { type: 'number', description: 'Absolute weight (100..900)' },
          ],
          description: 'Optional font weight',
        },
        lineHeight: {
          oneOf: [
            { type: 'string', description: 'Scale token (e.g. "-1", "0", "1")' },
            { type: 'number', description: 'Absolute multiplier (0.8..4.0)' },
          ],
          description: 'Optional line height',
        },
        uiZoom: { type: 'number', description: 'Optional UI zoom level (1.0 = default)' },
        pageSize: { type: 'string', description: 'Optional page size — A4, A3, Letter, Legal' },
        orientation: { type: 'string', enum: ['portrait', 'landscape'], description: 'Optional orientation' },
        marginsLR: { type: 'string', description: 'Optional left/right margins — narrow, normal, wide' },
        marginsTB: { type: 'string', description: 'Optional top/bottom margins — narrow, normal, wide' },
        footer: { type: 'boolean', description: 'Optional: include a page-number footer in paged output' },
        width: { type: 'number', description: 'Optional content width in pixels (400..1400)' },
        docEngine: { type: 'string', description: 'Optional document engine — "none" or "paged"' },
        surfaceMode: { type: 'string', description: 'Optional surface mode — "doc" or "app"' },
        theme: { type: 'string', description: 'Optional theme identifier' },
      },
      required: ['markdown'],
    },
    annotations: {
      readOnlyHint: true,
    },
    handler: function (args) {
      if (!args || typeof args.markdown !== 'string' || args.markdown.length === 0) {
        return Promise.reject(new Error('markdown is required and must be a non-empty string [INVALID_INPUT]'));
      }
      var fontCheck = validateFontFamily(args.fontFamily);
      if (!fontCheck.ok) {
        return Promise.reject(new Error(fontCheck.message + ' [' + fontCheck.code + ']'));
      }
      var body = buildRawMarkdownBody(args.markdown, args);
      return callRender(body);
    },
  });

  // === render_markdown_from_url ===
  navigator.modelContext.registerTool({
    name: 'render_markdown_from_url',
    description:
      'Fetch markdown from an allowlisted URL (raw.githubusercontent.com, raw.gitlab.com, bitbucket.org) ' +
      'and render it into FlatWrite-styled HTML head and body fragments. ' +
      'Same render pipeline as the editor and the flatwrite-render MCP server.',
    inputSchema: {
      type: 'object',
      properties: {
        // Canonical name: matches the MCP server contract and the
        // manifest. The deprecated `url` alias is still accepted by
        // the handler for backward compatibility with older agents.
        markdownUrl: {
          type: 'string',
          format: 'uri',
          description: 'URL pointing to raw markdown content. Must be on an allowlisted host (raw.githubusercontent.com, raw.gitlab.com, bitbucket.org). The deprecated alias `url` is still accepted.',
        },
        framework: { type: 'string', description: 'Optional UI framework' },
        fontFamily: { type: 'string', description: 'Optional font family (must be a bundled family)' },
        fontSize: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Optional font size' },
        fontWeight: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Optional font weight' },
        lineHeight: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Optional line height' },
        uiZoom: { type: 'number', description: 'Optional UI zoom level' },
        pageSize: { type: 'string', description: 'Optional page size' },
        orientation: { type: 'string', enum: ['portrait', 'landscape'], description: 'Optional orientation' },
        marginsLR: { type: 'string', description: 'Optional left/right margins' },
        marginsTB: { type: 'string', description: 'Optional top/bottom margins' },
        footer: { type: 'boolean', description: 'Optional: page-number footer' },
        width: { type: 'number', description: 'Optional content width in pixels' },
        docEngine: { type: 'string', description: 'Optional document engine' },
        surfaceMode: { type: 'string', description: 'Optional surface mode' },
        theme: { type: 'string', description: 'Optional theme identifier' },
      },
      required: ['markdownUrl'],
    },
    annotations: {
      readOnlyHint: true,
    },
    handler: function (args) {
      // Accept either the canonical `markdownUrl` or the deprecated
      // `url` alias. Canonical wins if both are sent.
      var rawUrl = (args && typeof args.markdownUrl === 'string' && args.markdownUrl.length > 0)
        ? args.markdownUrl
        : (args && typeof args.url === 'string' ? args.url : '');
      if (!rawUrl) {
        return Promise.reject(new Error('markdownUrl is required [INVALID_INPUT]'));
      }
      var urlCheck = validateMarkdownUrl(rawUrl);
      if (!urlCheck.ok) {
        return Promise.reject(new Error(urlCheck.message + ' [' + urlCheck.code + ']'));
      }
      var fontCheck = validateFontFamily(args.fontFamily);
      if (!fontCheck.ok) {
        return Promise.reject(new Error(fontCheck.message + ' [' + fontCheck.code + ']'));
      }
      var body = buildRemoteMarkdownBody(urlCheck.url, args);
      return callRender(body);
    },
  });
}
