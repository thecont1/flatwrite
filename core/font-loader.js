// core/font-loader.js
// Build a self-contained @font-face block for the selected font using the
// vendored .woff2 files in public/fonts/. The font file is base64-encoded
// and embedded as a data URI so the document has no external dependencies.
//
// The font inventory lives in core/font-inventory.js (single source of truth).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadAsset } = require('./inline-assets');
const { sanitizeFontName } = require('./document-css');
const { FONT_INVENTORY } = require('./font-inventory');

const FONT_DIR = path.resolve(__dirname, '..', 'public', 'fonts');

async function buildFontFaces(fontName) {
  const safeName = sanitizeFontName(fontName);
  const faces = FONT_INVENTORY[safeName];
  if (!faces) {
    // Unknown font: return a generic system font declaration so the document
    // still renders, but fail if the caller explicitly requires it.
    return { css: '', fontName: safeName };
  }

  const blocks = [];
  for (const face of faces) {
    const filePath = path.join(FONT_DIR, face.file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Font file missing: ${filePath}`);
    }
    const { dataUri } = await loadAsset(filePath);
    blocks.push(`
      @font-face {
        font-family: '${safeName}';
        font-style: ${face.style};
        font-weight: ${face.weight};
        font-display: swap;
        src: url('${dataUri}') format('woff2');
        unicode-range: ${face.unicodeRange ?? 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'};
      }
    `);
  }

  return {
    css: blocks.join('\n'),
    fontName: safeName,
  };
}

module.exports = {
  buildFontFaces,
  FONT_INVENTORY,
};