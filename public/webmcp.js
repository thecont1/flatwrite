// public/webmcp.js
//
// Registers the FlatWrite render tools via document.modelContext
// (WebMCP, Chrome 146+ DevTrial) so an AI agent driving the browser
// can call the same render pipeline that the editor uses internally.
//
// IMPORTANT: the WebMCP spec puts the entry point on `document`, not
// `navigator`. A previous version of this file used
// `navigator.modelContext`, which is always undefined and caused the
// script to silently no-op on every Chrome build. The spec repo
// (webmachinelearning/webmcp) confirms the namespace is
// `document.modelContext`.
//
// This script runs client-side in the tab when flatwrite.md is loaded.
// On browsers without WebMCP it does nothing. The execute function
// calls the public render.flatwrite.md/render Worker — same endpoint
// the MCP server uses — so the page output is byte-identical to what
// an MCP/HTTP client gets from outside the browser.
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
  RENDER_OUTPUT_SCHEMA,
  RENDER_OPTIONS_OUTPUT_SCHEMA,
  ALLOWED_FONT_FAMILIES,
  ALLOWED_APP_FRAMEWORKS,
  ALLOWED_DOC_ENGINES,
  ALLOWED_SURFACE_MODES,
  ALLOWED_PAGE_SIZES,
  ALLOWED_ORIENTATIONS,
  ALLOWED_MARGINS,
} from './webmcp-shared.js?v=2';

// WebMCP spec: the spec entry point is `document.modelContext`. The
// current webmachinelearning/webmcp README documents that shape, and
// Chrome 150+ implements it.
//
// Chrome 149 (the DevTrial release you may still be on) exposed the
// API as `navigator.modelContext` instead — a now-deprecated shape
// that the spec repo and Chrome 150+ both abandoned. We resolve
// whichever is present, preferring the spec name first.
//
// Reference: webmachinelearning/webmcp README, "Imperative Tool
// Registration" section. nekuda.ai/scripts/webmcp.js (Chrome 149–156
// origin trial, dogfooded by nekuda themselves) probes both in the
// same order — that's the working pattern.
//
// Regression history (FlatWrite, 2026-06-30):
//   - `handler:` → `execute:` rename fixed a registerTool() throw
//     on the Chrome 150+ spec shape.
//   - single-namespace guard was a silent no-op on the OTHER Chrome
//     build (whichever one we hadn't probed). Whichever we picked,
//     the opposite version broke. The dual-probe below is robust to
//     Chrome 149 (`navigator.modelContext`) AND Chrome 150+
//     (`document.modelContext`) AND future renames.
var mc = null;
if (typeof document !== 'undefined' && document && document.modelContext
    && typeof document.modelContext.registerTool === 'function') {
  mc = document.modelContext;  // spec / Chrome 150+
} else if (typeof navigator !== 'undefined' && navigator && navigator.modelContext
    && typeof navigator.modelContext.registerTool === 'function') {
  mc = navigator.modelContext;  // Chrome 149 legacy
}
if (mc === null) {
  // Graceful no-op on browsers without WebMCP / with the flag off.
}
else {
  var RENDER_URL = 'https://render.flatwrite.md/render';
  var TOKEN_URL = 'https://render.flatwrite.md/mcp-token';

  // ---- Shared schema definitions ----
  //
  // The render tool returns a { head, body } envelope and accepts the same
  // style options regardless of whether the markdown is inline or fetched
  // from a URL. Define the shape once so the page-side schema stays in sync
  // with the .well-known/model-context.docs.json manifest.
  var OUTPUT_SCHEMA = RENDER_OUTPUT_SCHEMA;
  var STYLE_SCHEMA = {
    framework: {
      type: 'string',
      enum: [...ALLOWED_APP_FRAMEWORKS],
      description: 'Optional UI framework applied when surfaceMode="app". Must be one of the bundled frameworks.',
    },
    fontFamily: {
      type: 'string',
      enum: [...ALLOWED_FONT_FAMILIES],
      description: 'Optional font family — must be one of the bundled families. Defaults to Inter.',
    },
    fontSize: {
      oneOf: [
        { type: 'string', description: 'Scale token (e.g. "-1", "0", "1")' },
        { type: 'number', description: 'Absolute pixel value (8..72)' },
      ],
      description: 'Optional font size',
      minimum: 8,
      maximum: 72,
    },
    fontWeight: {
      oneOf: [
        { type: 'string', description: 'Scale token (e.g. "-1", "0")' },
        { type: 'number', description: 'Absolute weight (100..900, multiples of 100)' },
      ],
      description: 'Optional font weight',
      minimum: 100,
      maximum: 900,
    },
    lineHeight: {
      oneOf: [
        { type: 'string', description: 'Scale token (e.g. "-1", "0", "1")' },
        { type: 'number', description: 'Absolute multiplier (0.8..4.0)' },
      ],
      description: 'Optional line height',
      minimum: 0.8,
      maximum: 4.0,
    },
    uiZoom: {
      type: 'number',
      description: 'Optional UI zoom level (1.0 = default; >1 zooms in, <1 zooms out)',
      minimum: 0.25,
      maximum: 4.0,
    },
    pageSize: {
      type: 'string',
      enum: [...ALLOWED_PAGE_SIZES],
      description: 'Optional page size for paged output.',
    },
    orientation: {
      type: 'string',
      enum: [...ALLOWED_ORIENTATIONS],
      description: 'Optional page orientation',
    },
    marginsLR: {
      type: 'string',
      enum: [...ALLOWED_MARGINS],
      description: 'Optional left/right page margin preset.',
    },
    marginsTB: {
      type: 'string',
      enum: [...ALLOWED_MARGINS],
      description: 'Optional top/bottom page margin preset.',
    },
    footer: {
      type: 'boolean',
      description: 'Optional: include a page-number footer in paged output',
    },
    width: {
      type: 'number',
      description: 'Optional content width in pixels (400..1400)',
      minimum: 400,
      maximum: 1400,
    },
    docEngine: {
      type: 'string',
      enum: [...ALLOWED_DOC_ENGINES],
      description: 'Optional document engine — "none" emits plain CSS; "pagedjs"/"vivliostyle" wrap the output in @page rules.',
    },
    surfaceMode: {
      type: 'string',
      enum: [...ALLOWED_SURFACE_MODES],
      description: 'Optional surface mode — "doc" or "app". "app" unlocks the framework picker.',
    },
    theme: {
      type: 'string',
      description: 'Optional theme identifier (e.g. "light" or "dark") rendered as body[data-theme="..."].',
    },
  };

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
    // Return in the WebMCP structured-content format so the declared
    // outputSchema is actually honored. Agents see the JSON in the text
    // content block and the validated object in structuredContent.
    return {
      content: [{ type: 'text', text: 'Rendered markdown as HTML head/body fragments' }],
      structuredContent: parsed,
    };
  }

  // Pre-warm the token at page load so the first tool call is fast.
  // Fire-and-forget — failure here is recoverable on the first tool call.
  getToken().catch(() => {});  // fire-and-forget; failure recovered on first tool call

  // === render_markdown ===
  mc.registerTool({
    name: 'render_markdown',
    description:
      'Render markdown into FlatWrite-styled HTML <head> and <body> fragments, with optional ' +
      'typography and page-layout controls. Provide either the raw markdown inline (`markdown`) ' +
      'or an allowlisted URL (`markdownUrl`) pointing to raw markdown content. The Worker ' +
      'validates URLs against raw.githubusercontent.com / raw.gitlab.com / bitbucket.org and ' +
      'enforces a size cap. Returns { head, body } — head is CSS to inject, body is the document fragment.',
    inputSchema: {
      type: 'object',
      properties: {
        markdown: { type: 'string', description: 'Raw markdown content to render' },
        markdownUrl: {
          type: 'string',
          format: 'uri',
          description: 'URL pointing to raw markdown content. Must be on an allowlisted host (raw.githubusercontent.com, raw.gitlab.com, bitbucket.org). The deprecated alias `url` is still accepted.',
        },
        ...STYLE_SCHEMA,
      },
      required: [],
      oneOf: [
        { required: ['markdown'] },
        { required: ['markdownUrl'] },
      ],
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: true,
    },
    execute: function (args) {
      // Accept either inline markdown or a markdown URL. Canonical
      // markdownUrl wins if both are sent; the deprecated `url` alias
      // is still accepted for backward compatibility with older agents.
      var hasMarkdown = args && typeof args.markdown === 'string' && args.markdown.length > 0;
      var rawUrl = (args && typeof args.markdownUrl === 'string' && args.markdownUrl.length > 0)
        ? args.markdownUrl
        : (args && typeof args.url === 'string' ? args.url : '');
      var hasUrl = rawUrl.length > 0;

      if (hasMarkdown && hasUrl) {
        return Promise.reject(new Error('provide only one of markdown or markdownUrl, not both [INVALID_INPUT]'));
      }
      if (!hasMarkdown && !hasUrl) {
        return Promise.reject(new Error('markdown or markdownUrl is required [INVALID_INPUT]'));
      }

      var fontCheck = validateFontFamily(args.fontFamily);
      if (!fontCheck.ok) {
        return Promise.reject(new Error(fontCheck.message + ' [' + fontCheck.code + ']'));
      }

      var body;
      if (hasUrl) {
        var urlCheck = validateMarkdownUrl(rawUrl);
        if (!urlCheck.ok) {
          return Promise.reject(new Error(urlCheck.message + ' [' + urlCheck.code + ']'));
        }
        body = buildRemoteMarkdownBody(urlCheck.url, args);
      } else {
        body = buildRawMarkdownBody(args.markdown, args);
      }
      return callRender(body);
    },
  });

  // === list_render_options ===
  mc.registerTool({
    name: 'list_render_options',
    description:
      'Return the supported fonts, UI frameworks, document engines, page sizes, orientations, ' +
      'margins, and surface modes for the render_markdown tool. Call this before rendering if ' +
      'you need to know which enum values are valid.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    outputSchema: RENDER_OPTIONS_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: true,
    },
    execute: function () {
      return {
        content: [{ type: 'text', text: 'Supported render options' }],
        structuredContent: {
          fonts: ALLOWED_FONT_FAMILIES,
          frameworks: ALLOWED_APP_FRAMEWORKS,
          docEngines: ALLOWED_DOC_ENGINES,
          pageSizes: ALLOWED_PAGE_SIZES,
          orientations: ALLOWED_ORIENTATIONS,
          margins: ALLOWED_MARGINS,
          surfaceModes: ALLOWED_SURFACE_MODES,
        },
      };
    },
  });
}
