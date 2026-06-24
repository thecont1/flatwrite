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

/* ── Validation helpers ───────────────────────────────────────────────── */

/** Strip to safe CSS font-name characters: letters, digits, spaces, hyphens */
function sanitizeFontName(name) {
  return String(name).replace(/[^a-zA-Z0-9\s\-]/g, '').trim() || 'Inter';
}

/** Coerce to a finite number clamped between min and max */
function safeNumber(val, fallback, min, max) {
  var n = parseFloat(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Validate framework key — must exist in FRAMEWORK_CSS, case-insensitive */
function validateFramework(val) {
  var key = String(val || '').trim().toLowerCase();
  return FRAMEWORK_CSS[key] ? key : 'spectre';
}

/** Escape HTML entities in a string */
function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/**
 * Validate and coerce all frontmatter fields before HTML/CSS interpolation.
 * Returns a frozen object with only known, safe values.
 *
 * CSS injection surface: fm.font goes inside '...' in a style block,
 * fm.fontSize/fontWeight/lineHeight go directly into CSS property values.
 * All values are type-checked, bounded, and rounded before interpolation.
 */
function validateFrontmatter(fm) {
  var f = fm || {};
  var validated = {
    title:      escapeHTML(String(f.title || '').slice(0, 500)),
    framework:  validateFramework(f.framework),
    font:       sanitizeFontName(f.font || 'Inter'),
    fontSize:   Math.round(safeNumber(f.fontSize, 16, 8, 72)),
    fontWeight: Math.round(safeNumber(f.fontWeight, 400, 100, 900)),
    lineHeight: Math.round(safeNumber(f.lineHeight, 1.6, 0.8, 4.0) * 10) / 10,
  };
  return Object.freeze(validated);
}

/* ── Sanitize HTML produced by marked.parse() ─────────────────────────── */

function sanitizeHTML(raw) {
  return sanitize(raw, SANITIZE_OPTS);
}

/* ── Public API ───────────────────────────────────────────────────────── */

/**
 * Returns a full HTML document string. No DOM access. Safe to call in Node or CF Workers.
 */
function renderToDocument(markdown, frontmatter) {
  var fm = validateFrontmatter(frontmatter);

  var cssUrl = FRAMEWORK_CSS[fm.framework];
  var body   = sanitizeHTML(marked.parse(markdown));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${fm.title}</title>
  <link rel="stylesheet" href="${cssUrl}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(fm.font)}:wght@${fm.fontWeight}&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: '${fm.font}', sans-serif;
      font-size: ${fm.fontSize}px;
      font-weight: ${fm.fontWeight};
      line-height: ${fm.lineHeight};
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

module.exports = {
  renderToDocument, renderToFragment, sanitizeHTML,
  validateFrontmatter, escapeHTML,
  FRAMEWORK_CSS,
};
