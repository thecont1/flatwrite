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
 * extract-drop.js — pure routing helpers for the drag-and-drop
 * file-import flow. Kept dependency-free so it can be unit-tested
 * with `bun test` without spinning up a DOM.
 *
 * The two functions exported here answer two questions:
 *
 *   1. `routeDroppedFile(filename)` — should this dropped file go to
 *      the existing `handleFileUpload` (plain-text path) or to
 *      `handleExtractDrop` (browser-local conversion)?
 *
 *   2. `buildExtractFormData(file, filename)` — legacy multipart helper
 *      retained for tests and compatibility with the old server contract.
 *      The interactive browser flow no longer performs a network upload.
 *
 * `app.js` imports these via a script tag (it's not a module) and
 * wires them into the drop event listener. Local conversion is
 * orchestrated in `app.js` because it depends on the `setEditorContent`
 * and `showToast` functions defined there.
 */

(function (root) {
  'use strict';

  // Plain-text extensions that the existing `handleFileUpload` can
  // read directly via FileReader.readAsText. Anything else goes
  // through browser-local conversion.
  const PLAIN_TEXT_EXTS = new Set(['.md', '.markdown', '.txt']);
  const LOCAL_TABLE_EXTS = new Set(['.csv', '.tsv']);

  /**
   * @param {string} filename
   * @returns {'plain' | 'csv' | 'extract'}
   */
  function routeDroppedFile(filename) {
    if (!filename || typeof filename !== 'string') return 'extract';
    var base = filename.split(/[\\/]/).pop();
    var dot = base.lastIndexOf('.');
    if (dot < 0) return 'extract';
    var ext = base.slice(dot).toLowerCase();
    if (PLAIN_TEXT_EXTS.has(ext)) return 'plain';
    if (LOCAL_TABLE_EXTS.has(ext)) return 'csv';
    return 'extract';
  }

  /**
   * Wrap a browser File in FormData with the field name the legacy server
   * contract expected. Kept as a separate helper so the test can exercise
   * the exact historical wire shape without a live File.
   *
   * @param {Blob} blob
   * @param {string} filename
   * @returns {FormData}
   */
  function buildExtractFormData(blob, filename) {
    var fd = new FormData();
    fd.append('file', blob, filename);
    return fd;
  }

  // Expose for both browser (window) and CommonJS (bun test) consumers.
  root.FlatwriteExtractDrop = {
    routeDroppedFile: routeDroppedFile,
    buildExtractFormData: buildExtractFormData,
    PLAIN_TEXT_EXTS: PLAIN_TEXT_EXTS,
    LOCAL_TABLE_EXTS: LOCAL_TABLE_EXTS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
