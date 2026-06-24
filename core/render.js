// core/render.js
'use strict';
const { marked } = require('marked');

const FRAMEWORK_CSS = {
  spectre:  'https://unpkg.com/spectre.css/dist/spectre.min.css',
  posh:     'https://unpkg.com/poshui/dist/posh.min.css',
  oat:      'https://unpkg.com/oatcss/oat.css',
  pico:     'https://unpkg.com/@picocss/pico/css/pico.min.css',
  milligram:'https://unpkg.com/milligram/dist/milligram.min.css',
  chota:    'https://unpkg.com/chota/dist/chota.min.css',
  simple:   'https://unpkg.com/simpledotcss/simple.min.css',
};

/**
 * Returns a full HTML document string. No DOM access. Safe to call in Node or CF Workers.
 */
function renderToDocument(markdown, frontmatter = {}) {
  const {
    title      = '',
    framework  = 'spectre',
    font       = 'Inter',
    fontSize   = '16',
    fontWeight = '400',
    lineHeight = '1.6',
  } = frontmatter;

  const cssUrl = FRAMEWORK_CSS[framework] || FRAMEWORK_CSS.spectre;
  const body   = marked.parse(markdown);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHTML(title)}</title>
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

module.exports = { renderToDocument, renderToFragment, FRAMEWORK_CSS };
