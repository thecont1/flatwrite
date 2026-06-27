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

(function () {
  'use strict';

  // navigator.modelContext is the WebMCP entry point. If absent (older
  // browsers, or the DevTrial flag is off), gracefully bail.
  if (typeof navigator === 'undefined' || !navigator.modelContext) {
    return;
  }

  // The render endpoint and its public API key. The key is the same one
  // documented in the README for direct curl access and is the public
  // MCP server key. Per-IP rate limiting on the Worker caps abuse; this
  // is the same trust model as any read-only public API.
  var RENDER_URL = 'https://render.flatwrite.md/render';
  var API_KEY = '936ccdfcce785a164261f125de3f09460cfa0eb9f9bb49eac9f34e58f37210f6';

  /**
   * Translate the public RenderStyle (fontFamily / framework / fontSize /
   * ...) to the canonical FlatWrite render frontmatter (font /
   * appFramework / size / ...) before forwarding to the Worker.
   * Mirrors the translator in
   * mcp/flatwrite-render-server/src/renderClient.ts so the page-side
   * tool produces identical output to the MCP server. Strings are
   * scale tokens; numbers are absolute pixel values.
   */
  function toCanonicalStyle(publicStyle) {
    var out = {};
    if (publicStyle == null) return out;
    if (publicStyle.fontFamily != null) out.font = String(publicStyle.fontFamily);
    if (publicStyle.framework != null) out.appFramework = String(publicStyle.framework);
    if (publicStyle.fontSize != null) {
      if (typeof publicStyle.fontSize === 'string') out.size = publicStyle.fontSize;
      else out.fontSize = publicStyle.fontSize;
    }
    if (publicStyle.fontWeight != null) {
      if (typeof publicStyle.fontWeight === 'string') out.weight = publicStyle.fontWeight;
      else out.fontWeight = publicStyle.fontWeight;
    }
    if (publicStyle.lineHeight != null) {
      if (typeof publicStyle.lineHeight === 'string') out.line = publicStyle.lineHeight;
      else out.lineHeight = publicStyle.lineHeight;
    }
    var passthrough = [
      'docEngine', 'surfaceMode', 'pageSize', 'orientation',
      'marginsLR', 'marginsTB', 'footer', 'width',
    ];
    for (var i = 0; i < passthrough.length; i++) {
      var k = passthrough[i];
      if (publicStyle[k] != null) out[k] = publicStyle[k];
    }
    // uiZoom is editor-only for now; not forwarded.
    return out;
  }

  /**
   * Bundled font inventory — must match core/font-inventory.js and
   * core/document-css.js's COMFORT_FONTS exactly. Used to validate
   * fontFamily at the page boundary so the agent gets a structured
   * error before any HTTP roundtrip.
   */
  var ALLOWED_FONTS = {
    'Inter': true,
    'JetBrains Mono': true,
    'Lato': true,
    'Lora': true,
    'Merriweather': true,
    'Playfair Display': true,
    'Comfortaa': true,
    'Unbounded': true,
  };

  var ALLOWED_MARKDOWN_HOSTS = {
    'raw.githubusercontent.com': true,
    'raw.gitlab.com': true,
    'bitbucket.org': true,
  };

  /**
   * Pre-flight validate fontFamily. Mirrors the MCP server's
   * [INVALID_FONT_FAMILY] rejection so the agent sees the same error
   * shape regardless of which surface (page, MCP, HTTP) it called.
   */
  function validateFontFamily(fontFamily) {
    if (fontFamily == null) return { ok: true };
    if (ALLOWED_FONTS[fontFamily]) return { ok: true };
    return {
      ok: false,
      code: 'INVALID_FONT_FAMILY',
      message: "fontFamily '" + fontFamily + "' is not one of the bundled fonts (Inter, JetBrains Mono, Lato, Lora, Merriweather, Playfair Display, Comfortaa, Unbounded)",
    };
  }

  /**
   * Pre-flight validate the markdown URL. Mirrors the MCP server's
   * [DISALLOWED_HOST] / [UNSUPPORTED_SCHEME] / [INVALID_URL] codes.
   */
  function validateMarkdownUrl(rawUrl) {
    var parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (_) {
      return { ok: false, code: 'INVALID_URL', message: 'url is not a valid URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        code: 'UNSUPPORTED_SCHEME',
        message: 'url must use http or https (got ' + parsed.protocol + ')',
      };
    }
    var host = parsed.hostname.toLowerCase();
    if (!ALLOWED_MARKDOWN_HOSTS[host]) {
      return {
        ok: false,
        code: 'DISALLOWED_HOST',
        message: "host '" + host + "' is not on the markdown URL allowlist",
      };
    }
    return { ok: true, url: parsed.toString() };
  }

  /**
   * POST to the render Worker. Resolves with the JSON response body
   * on 2xx, rejects with a structured Error (carrying .code and .detail)
   * otherwise. Mirrors the MCP server's renderClient.ts error contract.
   */
  function callRender(body) {
    return fetch(RENDER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': API_KEY,
      },
      body: JSON.stringify(body),
    }).then(function (resp) {
      return resp.text().then(function (text) {
        var parsed;
        try { parsed = JSON.parse(text); }
        catch (_) { parsed = null; }
        if (!resp.ok) {
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
      });
    });
  }

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
        orientation: { type: 'enum', enum: ['portrait', 'landscape'], description: 'Optional orientation' },
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
      var body = Object.assign({ markdown: args.markdown }, toCanonicalStyle(args));
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
        url: { type: 'string', format: 'uri', description: 'URL pointing to raw markdown content' },
        framework: { type: 'string', description: 'Optional UI framework' },
        fontFamily: { type: 'string', description: 'Optional font family (must be a bundled family)' },
        fontSize: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Optional font size' },
        fontWeight: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Optional font weight' },
        lineHeight: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Optional line height' },
        uiZoom: { type: 'number', description: 'Optional UI zoom level' },
        pageSize: { type: 'string', description: 'Optional page size' },
        orientation: { type: 'enum', enum: ['portrait', 'landscape'], description: 'Optional orientation' },
        marginsLR: { type: 'string', description: 'Optional left/right margins' },
        marginsTB: { type: 'string', description: 'Optional top/bottom margins' },
        footer: { type: 'boolean', description: 'Optional: page-number footer' },
        width: { type: 'number', description: 'Optional content width in pixels' },
        docEngine: { type: 'string', description: 'Optional document engine' },
        surfaceMode: { type: 'string', description: 'Optional surface mode' },
        theme: { type: 'string', description: 'Optional theme identifier' },
      },
      required: ['url'],
    },
    annotations: {
      readOnlyHint: true,
    },
    handler: function (args) {
      if (!args || typeof args.url !== 'string' || args.url.length === 0) {
        return Promise.reject(new Error('url is required [INVALID_INPUT]'));
      }
      var urlCheck = validateMarkdownUrl(args.url);
      if (!urlCheck.ok) {
        return Promise.reject(new Error(urlCheck.message + ' [' + urlCheck.code + ']'));
      }
      var fontCheck = validateFontFamily(args.fontFamily);
      if (!fontCheck.ok) {
        return Promise.reject(new Error(fontCheck.message + ' [' + fontCheck.code + ']'));
      }
      var body = Object.assign({ markdownUrl: urlCheck.url }, toCanonicalStyle(args));
      return callRender(body);
    },
  });
})();