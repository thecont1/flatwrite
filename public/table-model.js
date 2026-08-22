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
 * table-model.js — parse, mutate, and serialize GitHub-Flavored
 * Markdown tables. Dependency-free so bun test can exercise the
 * editor without a DOM.
 *
 * A model is:
 *   { headers, alignments, rows, hidden }
 * Hidden columns stay in the model until serialize(), which omits
 * them so a print-prep hide actually shrinks the page.
 */
(function (root) {
  'use strict';

  var ALIGN_LEFT = 'left';
  var ALIGN_CENTER = 'center';
  var ALIGN_RIGHT = 'right';

  function isSepCell(cell) {
    return /^:?-+:?$/.test(String(cell || '').replace(/\s+/g, ''));
  }

  function parseAlignment(cell) {
    var s = String(cell || '').replace(/\s+/g, '');
    var left = s.charAt(0) === ':';
    var right = s.charAt(s.length - 1) === ':';
    if (left && right) return ALIGN_CENTER;
    if (right) return ALIGN_RIGHT;
    return ALIGN_LEFT;
  }

  function alignmentMarker(align) {
    if (align === ALIGN_CENTER) return ':---:';
    if (align === ALIGN_RIGHT) return '---:';
    return '---';
  }

  function splitRow(line) {
    var s = String(line || '').replace(/\s+$/, '');
    var start = 0;
    var end = s.length;
    while (start < end && (s.charAt(start) === ' ' || s.charAt(start) === '\t')) start++;
    if (s.charAt(start) === '|') start++;
    if (end > start && s.charAt(end - 1) === '|') {
      var slash = 0;
      var k = end - 2;
      while (k >= start && s.charAt(k) === '\\') { slash++; k--; }
      if (slash % 2 === 0) end--;
    }
    var cells = [];
    var buf = '';
    var escaped = false;
    for (var i = start; i < end; i++) {
      var ch = s.charAt(i);
      if (escaped) {
        buf += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '|') {
        cells.push(buf.trim());
        buf = '';
        continue;
      }
      buf += ch;
    }
    if (escaped) buf += '\\';
    cells.push(buf.trim());
    return cells;
  }

  function padCells(cells, width) {
    var out = cells.slice();
    while (out.length < width) out.push('');
    if (out.length > width) out.length = width;
    return out;
  }

  function emptyModel() {
    return {
      headers: ['Column 1', 'Column 2', 'Column 3'],
      alignments: [ALIGN_LEFT, ALIGN_LEFT, ALIGN_LEFT],
      rows: [['', '', '']],
      hidden: [false, false, false]
    };
  }

  function normalizeModel(raw) {
    var model = raw && typeof raw === 'object' ? raw : emptyModel();
    var headers = (model.headers || []).map(function (h) { return String(h == null ? '' : h); });
    if (!headers.length) headers = ['Column 1'];
    var width = headers.length;
    var alignments = (model.alignments || []).slice();
    var hidden = (model.hidden || []).slice();
    var i;
    for (i = 0; i < width; i++) {
      if (alignments[i] !== ALIGN_CENTER && alignments[i] !== ALIGN_RIGHT) alignments[i] = ALIGN_LEFT;
      hidden[i] = !!hidden[i];
    }
    alignments.length = width;
    hidden.length = width;
    var rows = (model.rows || []).map(function (row) {
      return padCells((row || []).map(function (c) { return String(c == null ? '' : c); }), width);
    });
    if (!rows.length) rows = [padCells([], width)];
    return { headers: headers, alignments: alignments, rows: rows, hidden: hidden };
  }

  function cloneModel(model) {
    var m = normalizeModel(model);
    return {
      headers: m.headers.slice(),
      alignments: m.alignments.slice(),
      rows: m.rows.map(function (r) { return r.slice(); }),
      hidden: m.hidden.slice()
    };
  }

  function parseTableLines(lines) {
    if (!lines || lines.length < 2) return null;
    var header = splitRow(lines[0]);
    var sep = splitRow(lines[1]);
    if (!header.length || !sep.length) return null;
    if (!sep.every(isSepCell)) return null;
    var width = Math.max(header.length, sep.length);
    header = padCells(header, width);
    sep = padCells(sep, width);
    var alignments = sep.map(parseAlignment);
    var rows = [];
    for (var i = 2; i < lines.length; i++) {
      if (!/^\s*\|/.test(lines[i]) && lines[i].indexOf('|') === -1) break;
      rows.push(padCells(splitRow(lines[i]), width));
    }
    if (!rows.length) rows = [padCells([], width)];
    return {
      headers: header,
      alignments: alignments,
      rows: rows,
      hidden: header.map(function () { return false; })
    };
  }

  function findTables(md) {
    var text = String(md || '');
    var lines = text.split('\n');
    var tables = [];
    var i = 0;
    var offset = 0;
    while (i < lines.length) {
      var line = lines[i];
      var lineLen = line.length + (i < lines.length - 1 ? 1 : 0);
      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[-:| ]+\|/.test(lines[i + 1])) {
        var block = [lines[i], lines[i + 1]];
        var j = i + 2;
        var blockLen = lines[i].length + 1 + lines[i + 1].length + (i + 1 < lines.length - 1 ? 1 : 0);
        while (j < lines.length && /^\s*\|/.test(lines[j])) {
          block.push(lines[j]);
          blockLen += lines[j].length + (j < lines.length - 1 ? 1 : 0);
          j++;
        }
        var table = parseTableLines(block);
        if (table) {
          tables.push({
            start: offset,
            end: offset + block.join('\n').length,
            table: table
          });
        }
        for (var k = i; k < j; k++) offset += lines[k].length + (k < lines.length - 1 ? 1 : 0);
        i = j;
        continue;
      }
      offset += lineLen;
      i++;
    }
    return tables;
  }

  function parseFirstTable(md) {
    var found = findTables(md);
    return found.length ? found[0].table : null;
  }

  function tableAtOffset(md, offset) {
    var found = findTables(md);
    var pos = Number(offset) || 0;
    for (var i = 0; i < found.length; i++) {
      if (pos >= found[i].start && pos <= found[i].end) return found[i];
    }
    return found[0] || null;
  }

  function escapeCell(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ');
  }

  function visibleIndices(model) {
    var m = normalizeModel(model);
    var idx = [];
    for (var i = 0; i < m.headers.length; i++) {
      if (!m.hidden[i]) idx.push(i);
    }
    if (!idx.length) idx.push(0);
    return idx;
  }

  function serializeTable(model, opts) {
    opts = opts || {};
    var m = normalizeModel(model);
    var cols = opts.includeHidden ? m.headers.map(function (_, i) { return i; }) : visibleIndices(m);
    var rows = m.rows;
    if (opts.rowMask && opts.rowMask.length === rows.length) {
      rows = rows.filter(function (_, i) { return !!opts.rowMask[i]; });
    }
    var grid = [cols.map(function (i) { return escapeCell(m.headers[i]); })];
    grid.push(cols.map(function (i) { return alignmentMarker(m.alignments[i]); }));
    for (var r = 0; r < rows.length; r++) {
      grid.push(cols.map(function (i) { return escapeCell(rows[r][i]); }));
    }
    var widths = cols.map(function (_, c) {
      var w = 3;
      for (var r = 0; r < grid.length; r++) {
        if (grid[r][c].length > w) w = grid[r][c].length;
      }
      return w;
    });
    function pad(cell, c, align) {
      var extra = widths[c] - cell.length;
      if (extra <= 0) return cell;
      if (align === ALIGN_RIGHT) return new Array(extra + 1).join(' ') + cell;
      if (align === ALIGN_CENTER) {
        var left = Math.floor(extra / 2);
        return new Array(left + 1).join(' ') + cell + new Array(extra - left + 1).join(' ');
      }
      return cell + new Array(extra + 1).join(' ');
    }
    var out = [];
    for (var g = 0; g < grid.length; g++) {
      var alignRow = g === 1;
      var line = '|';
      for (var c = 0; c < cols.length; c++) {
        var cell = grid[g][c];
        if (!alignRow) cell = pad(cell, c, m.alignments[cols[c]]);
        else {
          var w = Math.max(widths[c], 3);
          if (m.alignments[cols[c]] === ALIGN_CENTER) cell = ':' + new Array(Math.max(w - 1, 2)).join('-') + ':';
          else if (m.alignments[cols[c]] === ALIGN_RIGHT) cell = new Array(Math.max(w, 3)).join('-') + ':';
          else cell = new Array(Math.max(w, 3) + 1).join('-');
        }
        line += ' ' + cell + ' |';
      }
      out.push(line);
    }
    return out.join('\n');
  }

  function replaceTable(md, block, model, serializeOpts) {
    var text = String(md || '');
    if (!block) return serializeTable(model, serializeOpts);
    return text.slice(0, block.start) + serializeTable(model, serializeOpts) + text.slice(block.end);
  }

  function parseNumber(value) {
    var s = String(value == null ? '' : value).trim();
    if (!s) return null;
    if (/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(s)) {
      var n = Number(s.replace(/,/g, ''));
      return isFinite(n) ? n : null;
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s)) {
      var n2 = Number(s);
      return isFinite(n2) ? n2 : null;
    }
    return null;
  }

  function compareValues(a, b) {
    var na = parseNumber(a);
    var nb = parseNumber(b);
    var aEmpty = String(a == null ? '' : a).trim() === '';
    var bEmpty = String(b == null ? '' : b).trim() === '';
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    if (na !== null && nb !== null) return na === nb ? 0 : (na < nb ? -1 : 1);
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  function sortBy(model, col, dir) {
    var m = cloneModel(model);
    var c = clampIndex(col, 0, m.headers.length - 1);
    var sign = dir === 'desc' ? -1 : 1;
    var indexed = m.rows.map(function (row, i) { return { row: row, i: i }; });
    indexed.sort(function (x, y) {
      var cmp = compareValues(x.row[c], y.row[c]);
      if (cmp !== 0) return cmp * sign;
      return x.i - y.i;
    });
    m.rows = indexed.map(function (x) { return x.row; });
    return m;
  }

  function clampIndex(n, min, max) {
    n = Number(n);
    if (!isFinite(n)) return min;
    n = Math.trunc(n);
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function setCell(model, row, col, value) {
    var m = cloneModel(model);
    var r = clampIndex(row, 0, m.rows.length - 1);
    var c = clampIndex(col, 0, m.headers.length - 1);
    m.rows[r][c] = String(value == null ? '' : value);
    return m;
  }

  function setHeader(model, col, value) {
    var m = cloneModel(model);
    var c = clampIndex(col, 0, m.headers.length - 1);
    var name = String(value == null ? '' : value).trim();
    m.headers[c] = name || ('Column ' + (c + 1));
    return m;
  }

  function setHidden(model, col, hidden) {
    var m = cloneModel(model);
    var c = clampIndex(col, 0, m.headers.length - 1);
    m.hidden[c] = !!hidden;
    return m;
  }

  function moveColumn(model, from, to) {
    var m = cloneModel(model);
    var a = clampIndex(from, 0, m.headers.length - 1);
    var b = clampIndex(to, 0, m.headers.length - 1);
    if (a === b) return m;
    function move(arr) {
      var item = arr.splice(a, 1)[0];
      arr.splice(b, 0, item);
    }
    move(m.headers);
    move(m.alignments);
    move(m.hidden);
    for (var i = 0; i < m.rows.length; i++) move(m.rows[i]);
    return m;
  }

  function insertColumn(model, index, name) {
    var m = cloneModel(model);
    var at = clampIndex(index, 0, m.headers.length);
    var label = String(name || '').trim() || ('Column ' + (m.headers.length + 1));
    m.headers.splice(at, 0, label);
    m.alignments.splice(at, 0, ALIGN_LEFT);
    m.hidden.splice(at, 0, false);
    for (var i = 0; i < m.rows.length; i++) m.rows[i].splice(at, 0, '');
    return m;
  }

  function deleteColumn(model, index) {
    var m = cloneModel(model);
    if (m.headers.length <= 1) return m;
    var at = clampIndex(index, 0, m.headers.length - 1);
    m.headers.splice(at, 1);
    m.alignments.splice(at, 1);
    m.hidden.splice(at, 1);
    for (var i = 0; i < m.rows.length; i++) m.rows[i].splice(at, 1);
    return m;
  }

  function insertRow(model, index) {
    var m = cloneModel(model);
    var at = clampIndex(index, 0, m.rows.length);
    m.rows.splice(at, 0, m.headers.map(function () { return ''; }));
    return m;
  }

  function deleteRow(model, index) {
    var m = cloneModel(model);
    if (m.rows.length <= 1) {
      m.rows[0] = m.headers.map(function () { return ''; });
      return m;
    }
    m.rows.splice(clampIndex(index, 0, m.rows.length - 1), 1);
    return m;
  }

  function rowMatches(row, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    for (var i = 0; i < row.length; i++) {
      if (String(row[i] || '').toLowerCase().indexOf(q) !== -1) return true;
    }
    return false;
  }

  function rowMask(model, query) {
    var m = normalizeModel(model);
    return m.rows.map(function (row) { return rowMatches(row, query); });
  }

  function visibleColumnCount(model) {
    return visibleIndices(model).length;
  }

  function detectCsvDelimiter(text) {
    var sample = String(text || '').split(/\r?\n/, 8).join('\n');
    var counts = { ',': 0, '\t': 0, ';': 0 };
    var inQuotes = false;
    for (var i = 0; i < sample.length; i++) {
      var ch = sample.charAt(i);
      if (ch === '"') {
        if (inQuotes && sample.charAt(i + 1) === '"') { i++; continue; }
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && Object.prototype.hasOwnProperty.call(counts, ch)) counts[ch]++;
    }
    if (counts['\t'] >= counts[','] && counts['\t'] >= counts[';'] && counts['\t'] > 0) return '\t';
    if (counts[';'] > counts[','] && counts[';'] > 0) return ';';
    return ',';
  }

  function parseCsvLine(line, delimiter) {
    var cells = [];
    var buf = '';
    var inQuotes = false;
    var delim = delimiter || ',';
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          if (line.charAt(i + 1) === '"') { buf += '"'; i++; }
          else inQuotes = false;
        } else {
          buf += ch;
        }
        continue;
      }
      if (ch === '"') { inQuotes = true; continue; }
      if (ch === delim) { cells.push(buf.trim()); buf = ''; continue; }
      buf += ch;
    }
    cells.push(buf.trim());
    return cells;
  }

  function parseCsv(text) {
    var raw = String(text || '').replace(/^\uFEFF/, '');
    if (!raw.trim()) return null;
    var delimiter = detectCsvDelimiter(raw);
    var lines = raw.split(/\r?\n/);
    var rows = [];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      rows.push(parseCsvLine(lines[i], delimiter));
    }
    if (!rows.length) return null;
    var width = 0;
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].length > width) width = rows[r].length;
    }
    if (!width) return null;
    var headers = padCells(rows[0], width);
    if (!headers.some(function (h) { return String(h).trim(); })) {
      headers = headers.map(function (_, i) { return 'Column ' + (i + 1); });
    }
    var body = rows.slice(1).map(function (row) { return padCells(row, width); });
    if (!body.length) body = [padCells([], width)];
    return {
      headers: headers,
      alignments: headers.map(function () { return ALIGN_LEFT; }),
      rows: body,
      hidden: headers.map(function () { return false; })
    };
  }

  function csvToMarkdown(text) {
    var model = parseCsv(text);
    return model ? serializeTable(model) : '';
  }

  root.FlatwriteTableModel = {
    ALIGN_LEFT: ALIGN_LEFT,
    ALIGN_CENTER: ALIGN_CENTER,
    ALIGN_RIGHT: ALIGN_RIGHT,
    emptyModel: emptyModel,
    normalizeModel: normalizeModel,
    cloneModel: cloneModel,
    splitRow: splitRow,
    parseTableLines: parseTableLines,
    findTables: findTables,
    parseFirstTable: parseFirstTable,
    tableAtOffset: tableAtOffset,
    serializeTable: serializeTable,
    replaceTable: replaceTable,
    parseNumber: parseNumber,
    compareValues: compareValues,
    sortBy: sortBy,
    setCell: setCell,
    setHeader: setHeader,
    setHidden: setHidden,
    moveColumn: moveColumn,
    insertColumn: insertColumn,
    deleteColumn: deleteColumn,
    insertRow: insertRow,
    deleteRow: deleteRow,
    rowMatches: rowMatches,
    rowMask: rowMask,
    visibleColumnCount: visibleColumnCount,
    detectCsvDelimiter: detectCsvDelimiter,
    parseCsvLine: parseCsvLine,
    parseCsv: parseCsv,
    csvToMarkdown: csvToMarkdown
  };
})(typeof window !== 'undefined' ? window : globalThis);
