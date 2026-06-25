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
    "sub","sup","small","mark","abbr","cite","q","kbd",
  ],
  allowedAttributes: {
    "*": ["class","id","role","aria-label","aria-hidden","tabindex","style"],
    "a": ["href","target","rel","title"],
    "img": ["src","alt","width","height","title"],
    "td": ["colspan","rowspan","align","valign"],
    "th": ["colspan","rowspan","align","valign","scope"],
    "table": ["border","cellpadding","cellspacing"],
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
  const font = sanitizeFontName(f.font || 'Inter');
  const fontSize = f.size !== undefined
    ? absoluteFontSize(f.size)
    : Math.round(safeNumber(f.fontSize, 16, 8, 72));
  const fontWeight = f.weight !== undefined
    ? absoluteFontWeight(f.weight)
    : Math.round(safeNumber(f.fontWeight, 400, 100, 900));
  const lineHeight = f.line !== undefined
    ? absoluteLineHeight(f.line)
    : Math.round(safeNumber(f.lineHeight, 1.75, 0.8, 4.0) * 10) / 10;

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
 * Returns a structured document fragment with separate head and body strings.
 * The head contains inlined style/font declarations (and an optional engine script).
 * The body has the rendered markdown wrapped in <main> and class="fw-render".
 *
 * No external <link> tags, <meta>, <title>, or <base> are emitted.
 */
async function renderToDocument(markdown, frontmatter) {
  const opts = resolveRenderOptions(frontmatter);
  const body = sanitizeHTML(marked.parse(markdown));
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
function renderToFragment(markdown) {
  return marked.parse(markdown);
}

module.exports = {
  renderToDocument,
  renderToFragment,
  sanitizeHTML,
  resolveRenderOptions,
  escapeHTML,
};
