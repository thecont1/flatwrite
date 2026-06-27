// core/render.js
'use strict';
const { marked } = require('marked');
const sanitize = require('sanitize-html');
const {
  absoluteFontSize,
  absoluteFontWeight,
  absoluteLineHeight,
} = require('./scale-map');
const { DOC_ENGINES } = require('./doc-engines');
const { buildDocumentCss, sanitizeFontName } = require('./document-css');
const { buildFontFaces } = require('./font-loader');

/* Allowed tags/attrs match the browser-side DOMPurify config in public/app.js */
const SANITIZE_OPTS = {
  allowedTags: [
    "h1","h2","h3","h4","h5","h6","p","a","img","ul","ol","li",
    "blockquote","pre","code","strong","em","del","s","table",
    "thead","tbody","tr","th","td","br","hr","div","span",
    "details","summary","main","section","article","aside",
    "header","footer","nav","figure","figcaption","dl","dt","dd",
    "sub","sup","small","mark","abbr","cite","q","kbd","input",
  ],
  allowedAttributes: {
    "*": ["class","id","role","aria-label","aria-hidden","tabindex","style","start","type"],
    "a": ["href","target","rel","title"],
    "img": ["src","alt","width","height","title"],
    "td": ["colspan","rowspan","align","valign"],
    "th": ["colspan","rowspan","align","valign","scope"],
    "table": ["border","cellpadding","cellspacing"],
    "input": ["type","checked","disabled"],
  },
  allowedSchemes: ["http","https","mailto"],
  allowProtocolRelative: true,
  disallowedTagsMode: "discard",
};

/** Escape HTML entities in a string */
function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function sanitizeHTML(raw) {
  return sanitize(raw, SANITIZE_OPTS);
}

/**
 * Resolve relative URLs in rendered HTML against a base URL.
 * Only rewrites src (img/video/source) and href (a) attributes that are not
 * already absolute, protocol-relative, data URIs, fragments, or mailto links.
 */
function resolveRelativeUrls(html, baseUrl) {
  if (!baseUrl) return html;

  let base;
  try {
    base = new URL('.', baseUrl).href;
  } catch (e) {
    return html;
  }

  function resolveUrl(url) {
    if (!url) return url;
    if (/^(?:https?:|data:|mailto:|#)/i.test(url)) return url;
    if (/^\/\//i.test(url)) return url;
    try {
      return new URL(url, base).href;
    } catch (e) {
      return url;
    }
  }

  html = html.replace(
    /(<(?:img|video|source)\s[^>]*?)src=(["'])([^"']+)\2/gi,
    (m, pre, q, src) => {
      const r = resolveUrl(src);
      return r !== src ? `${pre}src=${q}${r}${q}` : m;
    }
  );

  html = html.replace(
    /(<a\s[^>]*?)href=(["'])([^"']+)\2/gi,
    (m, pre, q, href) => {
      const r = resolveUrl(href);
      return r !== href ? `${pre}href=${q}${r}${q}` : m;
    }
  );

  return html;
}

/**
 * Coerce a frontmatter field to a finite number.
 */
function safeNumber(val, fallback, min, max) {
  const n = parseFloat(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Build the final rendering options from raw frontmatter.
 * Scale indices (size/weight/line) are preferred over absolute values.
 */
function resolveRenderOptions(fm) {
  const f = fm || {};
  // Accept both canonical YAML-codename fields (font, appFramework, size,
  // weight, line, width, zoom) and friendly aliases (fontFamily, framework,
  // fontSize, fontWeight, lineHeight, uiZoom). The MCP server and the
  // public HTTP API expose the friendly names; the editor's
  // buildShareYaml() writes the codenames. Both should reach the same
  // place — this is the single source of truth for what the renderer
  // accepts.
  const rawFont = f.fontFamily ?? f.font;
  const font = sanitizeFontName(rawFont || 'Inter');
  const fontSize = f.size !== undefined
    ? absoluteFontSize(f.size)
    : (f.fontSize !== undefined
        ? Math.round(safeNumber(f.fontSize, 16, 8, 72))
        : 16);
  const fontWeight = f.weight !== undefined
    ? absoluteFontWeight(f.weight)
    : (f.fontWeight !== undefined
        ? Math.round(safeNumber(f.fontWeight, 400, 100, 900))
        : 400);
  const lineHeight = f.line !== undefined
    ? absoluteLineHeight(f.line)
    : (f.lineHeight !== undefined
        ? Math.round(safeNumber(f.lineHeight, 1.75, 0.8, 4.0) * 10) / 10
        : 1.75);

  return {
    title: escapeHTML(String(f.title || '').slice(0, 500)),
    font,
    fontSize,
    fontWeight,
    lineHeight,
    docEngine: String(f.docEngine || 'none'),
    surfaceMode: String(f.surfaceMode || 'doc'),
    pageSize: String(f.pageSize || 'A4'),
    orientation: String(f.orientation || 'portrait'),
    marginsLR: String(f.marginsLR || 'normal'),
    marginsTB: String(f.marginsTB || 'normal'),
    footer: f.footer === true || f.footer === 'true' || f.footer === 'on',
    contentWidth: safeNumber(f.width, 1100, 400, 1400),
  };
}

/* ── Public API ───────────────────────────────────────────────────────── */

/**
 * marked treats text like "- [ ] 6. Add docs" as a task-list item followed
 * by a nested ordered list. That produces a checkbox plus a separate "6."
 * marker. If the generated <ol> immediately follows the checkbox and has a
 * single item, unwrap it so the text reads as "6. Add docs" inline.
 */
function fixTaskListNumberedItems(html) {
  return html.replace(
    /<li([^>]*)>\s*(?:<p>\s*)?(<input[^>]*type="checkbox"[^>]*>)\s*(?:<\/p>\s*)?<ol(?:\s+start="(\d+)")?>\s*<li>(.*?)<\/li>\s*<\/ol>/gi,
    (m, attrs, inputHtml, num, text) => '<li' + attrs + '>' + inputHtml + ' ' + (num || '1') + '. ' + text
  );
}

/**
 * Add a stable class to task-list <li> items so we can hide the default bullet
 * without relying solely on the :has() selector. This is more robust on older
 * browsers and in some iframe/CSS edge cases. It also copes with marked
 * wrapping an empty checkbox in a <p>.
 */
function classifyTaskListItems(html) {
  return html.replace(
    /<li([^>]*)>\s*(?:<p>\s*)?(<input[^>]*type="checkbox"[^>]*>)/gi,
    (m, attrs, input) => {
      const classMatch = attrs.match(/class="([^"]*)"/);
      if (classMatch) {
        return '<li' + attrs.replace(/class="([^"]*)"/, 'class="$1 task-list-item"') + '>' + input;
      }
      return '<li class="task-list-item"' + attrs + '>' + input;
    }
  );
}

/**
 * Returns a structured document fragment with separate head and body strings.
 * The head contains inlined style/font declarations (and an optional engine script).
 * The body has the rendered markdown wrapped in <main> and class="fw-render".
 *
 * No external <link> tags, <meta>, <title>, or <base> are emitted.
 */
async function renderToDocument(markdown, frontmatter, options) {
  const { baseUrl } = options || {};
  const opts = resolveRenderOptions(frontmatter);
  const rawHTML = classifyTaskListItems(fixTaskListNumberedItems(marked.parse(markdown)));
  const body = sanitizeHTML(resolveRelativeUrls(rawHTML, baseUrl));
  const { css: fontCss, fontName } = await buildFontFaces(opts.font);
  const docCss = buildDocumentCss({
    font: fontName,
    fontSize: opts.fontSize,
    fontWeight: opts.fontWeight,
    lineHeight: opts.lineHeight,
    docEngine: opts.docEngine,
    pageSize: opts.pageSize,
    orientation: opts.orientation,
    marginsLR: opts.marginsLR,
    marginsTB: opts.marginsTB,
    contentWidth: opts.contentWidth,
  });

  const engine = DOC_ENGINES[opts.docEngine] || DOC_ENGINES.none;
  const engineScript = engine.script && !engine.module
    ? `<script src="${engine.script}" defer></script>`
    : '';

  const head = `<head>
  <style>
${fontCss}
${docCss}
  </style>
${engineScript}
</head>`;

  const bodyTag = `<body class="fw-render">
  <main>
${body}
  </main>
</body>`;

  return { head, body: bodyTag };
}

/**
 * Returns only the inner HTML fragment (no document shell).
 * Used by the browser preview — caller applies DOMPurify after injection.
 */
function renderToFragment(markdown, options) {
  const { baseUrl } = options || {};
  return resolveRelativeUrls(classifyTaskListItems(fixTaskListNumberedItems(marked.parse(markdown))), baseUrl);
}

module.exports = {
  renderToDocument,
  renderToFragment,
  sanitizeHTML,
  resolveRenderOptions,
  escapeHTML,
  resolveRelativeUrls,
};
