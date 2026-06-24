// core/render.js
'use strict';
const { marked } = require('marked');
const sanitize = require('sanitize-html');

const FRAMEWORK_CSS = {
  spectre:  'https://unpkg.com/spectre.css/dist/spectre.min.css',
  posh:     'https://unpkg.com/poshui/dist/posh.min.css',
  oat:      'https://unpkg.com/oatcss/oat.css',
  pico:     'https://unpkg.com/@picocss/pico/css/pico.min.css',
  milligram:'https://unpkg.com/milligram/dist/milligram.min.css',
  chota:    'https://unpkg.com/chota/dist/chota.min.css',
  simple:   'https://unpkg.com/simpledotcss/simple.min.css',
};

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

/* Sanitize a font name to safe characters only (prevents CSS injection) */
function sanitizeFontName(name) {
  return String(name).replace(/[^a-zA-Z0-9\s\-]/g, '').trim() || 'Inter';
}

/* Coerce a value to a safe number within bounds */
function safeNumber(val, fallback, min, max) {
  var n = parseFloat(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Sanitize HTML produced by marked.parse().
 * Strips dangerous tags/attrs (script, iframe, event handlers, etc.)
 */
function sanitizeHTML(raw) {
  return sanitize(raw, SANITIZE_OPTS);
}

/**
 * Returns a full HTML document string. No DOM access. Safe to call in Node or CF Workers.
 */
function renderToDocument(markdown, frontmatter = {}) {
  var title      = escapeHTML(frontmatter.title || '');
  var framework  = String(frontmatter.framework || 'spectre');
  var font       = sanitizeFontName(frontmatter.font || 'Inter');
  var fontSize   = safeNumber(frontmatter.fontSize, 16, 8, 72);
  var fontWeight = safeNumber(frontmatter.fontWeight, 400, 100, 900);
  var lineHeight = safeNumber(frontmatter.lineHeight, 1.6, 0.8, 4.0);

  var cssUrl = FRAMEWORK_CSS[framework] || FRAMEWORK_CSS.spectre;
  var body   = sanitizeHTML(marked.parse(markdown));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="${cssUrl}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}:wght@${fontWeight}&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: '${font}', sans-serif;
      font-size: ${fontSize}px;
      font-weight: ${fontWeight};
      line-height: ${lineHeight};
    }
  </style>
</head>
<body class="container">
${body}
</body>
</html>`;
}

/**
 * Returns only the inner HTML fragment (no document shell).
 * Used by the browser preview — caller applies DOMPurify after injection.
 */
function renderToFragment(markdown) {
  return marked.parse(markdown);
}

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

module.exports = { renderToDocument, renderToFragment, sanitizeHTML, FRAMEWORK_CSS };
