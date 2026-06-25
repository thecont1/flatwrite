// core/doc-engines.js
// Document engines and page layout helpers for the doc preview.

'use strict';

const DOC_ENGINES = {
  pagedjs: {
    label: 'Paged.js',
    script: 'https://unpkg.com/pagedjs/dist/paged.polyfill.js',
    category: 'paged-media',
  },
  vivliostyle: {
    label: 'Vivliostyle',
    script: 'https://esm.unpkg.com/@vivliostyle/core@2.43.3',
    category: 'css-books',
    module: true,
  },
  none: {
    label: 'Plain CSS',
    script: null,
    category: 'unstyled',
  },
};

const PAGE_SIZES = {
  A4: { width: 210, height: 297 },
  Letter: { width: 215.9, height: 279.4 },
  Legal: { width: 215.9, height: 355.6 },
  A5: { width: 148, height: 210 },
};

const MARGIN_MAP = {
  narrow: 12,
  normal: 25,
  wide: 40,
};

function getPageSizeMm(pageSize, orientation) {
  const s = PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
  if (orientation === 'landscape') {
    return { width: s.height, height: s.width };
  }
  return { width: s.width, height: s.height };
}

function getPageWidthPx(pageSize, orientation) {
  const mm = getPageSizeMm(pageSize, orientation);
  return Math.round(mm.width * 3.78);
}

function getPageHeightPx(pageSize, orientation) {
  const mm = getPageSizeMm(pageSize, orientation);
  return Math.round(mm.height * 3.78);
}

function buildPageCSS(pageSize, orientation, marginsLR, marginsTB) {
  const size = getPageSizeMm(pageSize, orientation);
  const lrMm = MARGIN_MAP[marginsLR] || MARGIN_MAP.normal;
  const tbMm = MARGIN_MAP[marginsTB] || MARGIN_MAP.normal;
  return `
    @page {
      size: ${size.width}mm ${size.height}mm;
      margin: ${tbMm}mm ${lrMm}mm;
    }
  `;
}

module.exports = {
  DOC_ENGINES,
  PAGE_SIZES,
  MARGIN_MAP,
  getPageSizeMm,
  getPageWidthPx,
  getPageHeightPx,
  buildPageCSS,
};
