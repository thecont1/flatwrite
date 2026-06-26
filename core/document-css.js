// core/document-css.js
// Build the self-contained CSS for a FlatWrite doc preview.

'use strict';

const { buildPageCSS } = require('./doc-engines');

const COMFORT_FONTS = {
  Inter: true,
  'JetBrains Mono': true,
  Lora: true,
  Merriweather: true,
  'Playfair Display': true,
  Comfortaa: true,
  Unbounded: true,
  Lato: true,
};

function sanitizeFontName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9\s\-]/g, '').trim() || 'Inter';
}

function isComfortFont(name) {
  return !!COMFORT_FONTS[sanitizeFontName(name)];
}

function buildDocumentCss(opts) {
  const {
    font,
    fontSize,
    fontWeight,
    lineHeight,
    docEngine,
    pageSize,
    orientation,
    marginsLR,
    marginsTB,
    contentWidth,
  } = opts;

  const safeFont = sanitizeFontName(font);
  const fontStack = `'${safeFont}', system-ui, sans-serif`;
  const headWeight = Math.min(fontWeight + 200, 900);
  const engineKey = docEngine || 'none';
  const isPlain = engineKey === 'none';

  const pageCss = isPlain ? '' : buildPageCSS(pageSize, orientation, marginsLR, marginsTB);

  const resetCss = `
    .fw-render, .fw-render * {
      font-family: ${fontStack} !important;
      box-sizing: border-box;
    }
    .fw-render {
      font-size: ${fontSize}px !important;
      font-weight: ${fontWeight} !important;
      line-height: ${lineHeight} !important;
      color: #2d2a3e;
      margin: 0;
      overflow-x: hidden;
      background: #fff;
    }
    .fw-render main {
      width: 100%;
      max-width: 100%;
    }
    .fw-render h1, .fw-render h2, .fw-render h3, .fw-render h4, .fw-render h5, .fw-render h6 {
      font-weight: ${headWeight} !important;
      overflow-wrap: break-word;
      word-break: break-word;
    }
    .fw-render h1 { font-size: ${Math.round(fontSize * 2)}px !important; }
    .fw-render h2 { font-size: ${Math.round(fontSize * 1.5)}px !important; margin-top: 1.8em !important; }
    .fw-render h3 { font-size: ${Math.round(fontSize * 1.25)}px !important; margin-top: 1.4em !important; }
    .fw-render h4 { font-size: ${Math.round(fontSize * 1.1)}px !important; }
    .fw-render img { max-width: 100%; height: auto; display: block; }
    .fw-render pre, .fw-render code { font-family: 'JetBrains Mono', monospace !important; }
    .fw-render pre { overflow-x: auto; word-wrap: break-word; white-space: pre-wrap; }
    .fw-render table { border-collapse: collapse; width: 100%; table-layout: fixed; }
    .fw-render th, .fw-render td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; word-wrap: break-word; overflow-wrap: break-word; max-width: 100%; }
    .fw-render thead th { background: #333333; color: #fff; }
    .fw-render tbody tr:nth-child(even) { background: #f2f2f2; }
    .fw-render tbody tr:nth-child(odd) { background: #ffffff; }
    .fw-render blockquote { margin: 0; padding: 0 1em; border-left: 3px solid #ccc; }
    .fw-render ul, .fw-render ol { padding-left: 1.8em; margin: 0.2em 0; list-style-position: outside; }
    .fw-render li { margin: 0.15em 0; display: list-item; }
    .fw-render li > ul, .fw-render li > ol { margin: 0.15em 0; padding-left: 2em; }
    .fw-render li::marker { display: inline; }
    .fw-render li:has(> input[type="checkbox"]) { list-style: none; }
    .fw-render li:has(> input[type="checkbox"])::marker { display: none; }
    .fw-render .task-list-item { list-style: none; }
    .fw-render .task-list-item::marker { display: none; }
    .fw-render input[type="checkbox"] { margin: 0 0.4em 0 0; vertical-align: middle; }
    .fw-render ul { list-style-type: disc; }
    .fw-render ul ul { list-style-type: circle; }
    .fw-render ul ul ul { list-style-type: disc; }
    .fw-render ul ul ul ul { list-style-type: circle; }
    .fw-render p { margin: 0.4em 0; }
    .fw-render br { margin: 0.3em 0; }
    .fw-render a { color: #4569d4; text-decoration: underline; }
    .fw-render a:hover { color: #2a438c; }
  `;

  const engineCss = isPlain
    ? `
      .fw-render { max-width: ${contentWidth || 1100}px; margin: 0 auto; background: #fff !important; }
      .fw-render main { padding: 2rem 1rem; }
    `
    : `
      .pagedjs_page { margin: 8px 0; }
      html::-webkit-scrollbar { display: none; }
      html { scrollbar-width: none; -ms-overflow-style: none; }
      .fw-render { max-width: none; margin: 0; background: transparent !important; }
    `;

  return `${pageCss}\n${resetCss}\n${engineCss}`.trim();
}

module.exports = {
  COMFORT_FONTS,
  sanitizeFontName,
  isComfortFont,
  buildDocumentCss,
};
