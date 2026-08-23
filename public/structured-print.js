/**
 * flatwrite.md - Minimalist Markdown Editor
 *
 * Copyright (C) 2026 Mahesh Shantaram
 * Sole Proprietary Owner. All Rights Reserved.
 *
 * This file is part of flatwrite.md.
 * flatwrite.md is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * For commercial, closed-source embedding, and SaaS deployment exemptions,
 * a valid Commercial License Agreement is required. Contact: sales@flatwrite.md
 */

/**
 * structured-print.js — pure helpers for the CSV / spreadsheet
 * drop-to-print pipeline. Kept dependency-free so bun test can
 * exercise detection, column counting, and page-size selection
 * without a DOM.
 *
 * After AnyDoc turns structured data into a Markdown table, FlatWrite
 * applies a print-ready layout: Paged.js, landscape, narrow margins,
 * JetBrains Mono, a smaller type size, and the smallest ISO page that
 * can hold the columns.
 */
(function (root) {
  'use strict';

  var STRUCTURED_FILE_TYPES = { csv: 1, excel: 1 };
  var LANDSCAPE_PAGE_ORDER = ['A4', 'A3', 'A2', 'A1', 'A0'];
  var TABLE_FONT = 'JetBrains Mono';
  var TABLE_MARGIN = 'narrow';
  var TABLE_FONT_STEP = -2;
  /* Vivliostyle, not Paged.js: full CSS table support so `thead`
     repeats on every page and rows are less likely to split. */
  var TABLE_ENGINE = 'vivliostyle';
  var MAX_FIT_ITERS = 8;

  function isStructuredFileType(fileType) {
    return !!(fileType && STRUCTURED_FILE_TYPES[String(fileType).toLowerCase()]);
  }

  function looksLikeMarkdownTable(md) {
    if (!md || typeof md !== 'string') return false;
    return /^\s*\|.+\|\s*\n\s*\|[-:| ]+\|/m.test(md);
  }

  function shouldAutoPrint(markdown, metadata) {
    var fileType = metadata && metadata.fileType;
    if (isStructuredFileType(fileType)) return true;
    return looksLikeMarkdownTable(markdown);
  }

  function countMarkdownTableColumns(md) {
    if (!md || typeof md !== 'string') return 0;
    var max = 0;
    var lines = md.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!/^\s*\|/.test(line)) continue;
      if (/^\s*\|[-:| ]+\|/.test(line)) continue;
      var cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
      if (cells.length > max) max = cells.length;
    }
    return max;
  }

  function chooseLandscapePageSize(columnCount) {
    var n = Number(columnCount) || 0;
    if (n <= 5) return 'A4';
    if (n <= 8) return 'A3';
    if (n <= 12) return 'A2';
    if (n <= 16) return 'A1';
    return 'A0';
  }

  function nextLargerPageSize(current) {
    var i = LANDSCAPE_PAGE_ORDER.indexOf(current);
    if (i < 0) return 'A3';
    if (i >= LANDSCAPE_PAGE_ORDER.length - 1) return current;
    return LANDSCAPE_PAGE_ORDER[i + 1];
  }

  function buildStructuredPrintSettings(columnCount) {
    return {
      engine: TABLE_ENGINE,
      orientation: 'landscape',
      pageSize: chooseLandscapePageSize(columnCount),
      marginsLR: TABLE_MARGIN,
      marginsTB: TABLE_MARGIN,
      font: TABLE_FONT,
      sizeStep: TABLE_FONT_STEP,
      columns: 1
    };
  }

  /**
   * Measure whether any paginated table still needs more width than
   * the current page content area, ignoring `table-layout: fixed`
   * wrapping so we detect crushed columns rather than wrapped cells.
   */
  function tableOverflowsPage(doc) {
    if (!doc || !doc.querySelector || !doc.body) return false;
    var area = doc.querySelector('[data-vivliostyle-page-area]')
      || doc.querySelector('[data-vivliostyle-page-container]')
      || doc.querySelector('.pagedjs_area')
      || doc.querySelector('main');
    if (!area) return false;
    var avail = area.clientWidth;
    if (!avail) return false;
    var tables = area.querySelectorAll('table');
    for (var i = 0; i < tables.length; i++) {
      var clone = tables[i].cloneNode(true);
      clone.style.tableLayout = 'auto';
      clone.style.width = 'max-content';
      clone.style.maxWidth = 'none';
      clone.style.position = 'absolute';
      clone.style.visibility = 'hidden';
      clone.style.whiteSpace = 'nowrap';
      var cells = clone.querySelectorAll('th, td');
      for (var c = 0; c < cells.length; c++) {
        cells[c].style.maxWidth = 'none';
        cells[c].style.wordWrap = 'normal';
        cells[c].style.overflowWrap = 'normal';
        cells[c].style.whiteSpace = 'nowrap';
      }
      doc.body.appendChild(clone);
      var needed = clone.scrollWidth;
      clone.parentNode.removeChild(clone);
      if (needed > avail + 4) return true;
    }
    return false;
  }

  root.FlatwriteStructuredPrint = {
    STRUCTURED_FILE_TYPES: STRUCTURED_FILE_TYPES,
    LANDSCAPE_PAGE_ORDER: LANDSCAPE_PAGE_ORDER,
    TABLE_FONT: TABLE_FONT,
    TABLE_MARGIN: TABLE_MARGIN,
    TABLE_FONT_STEP: TABLE_FONT_STEP,
    TABLE_ENGINE: TABLE_ENGINE,
    MAX_FIT_ITERS: MAX_FIT_ITERS,
    isStructuredFileType: isStructuredFileType,
    looksLikeMarkdownTable: looksLikeMarkdownTable,
    shouldAutoPrint: shouldAutoPrint,
    countMarkdownTableColumns: countMarkdownTableColumns,
    chooseLandscapePageSize: chooseLandscapePageSize,
    nextLargerPageSize: nextLargerPageSize,
    buildStructuredPrintSettings: buildStructuredPrintSettings,
    tableOverflowsPage: tableOverflowsPage
  };
})(typeof window !== 'undefined' ? window : globalThis);
