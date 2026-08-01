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

(function () {
  "use strict";

  /* ==========================================================================
     IndexedDB persistence
     Database: flatwrite | Stores: activeDocument, preferences
     ========================================================================== */

  var DB_NAME    = "flatwrite";
  var DB_VERSION = 3;

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        var tx = e.target.transaction;
        if (!db.objectStoreNames.contains("activeDocument")) db.createObjectStore("activeDocument");
        if (!db.objectStoreNames.contains("preferences"))   db.createObjectStore("preferences");
        /* Migration: rename "framework" key to "docEngine" in preferences */
        try {
          var getReq = tx.objectStore("preferences").get("current");
          getReq.onsuccess = function() {
            var rec = getReq.result;
            if (!rec) return;
            if (rec.framework && !rec.docEngine) {
              rec.docEngine = rec.framework;
              delete rec.framework;
            }
            /* Reset columns to 1 after layout control refactor */
            if (rec.docLayout && rec.docLayout.columns) {
              rec.docLayout.columns = 1;
            }
            tx.objectStore("preferences").put(rec, "current");
          };
        } catch (ex) { /* migration is best-effort */ }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function (e) { reject(e.target.error); };
    });
  }

  function idbGet(store, key) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(store, "readonly");
        var req = tx.objectStore(store).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror   = function () { reject(req.error); };
      });
    });
  }

  function idbPut(store, key, val) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(val, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror    = function () { reject(tx.error); };
      });
    });
  }

  var autosaveTimer    = null;
  var suppressAutosave = false;

  function scheduleAutosave() {
    if (suppressAutosave) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveToIDB, 1500);
  }

  function saveToIDB() {
    var record = {
      markdown:   editor.value,
      mode:       mode,
      docEngine:  currentDocEngine,
      surfaceMode: surfaceMode,
      appFramework: currentAppFramework,
      docLayout:  { pageSize: pageSize, orientation: orientation, marginsLR: pageMarginsLR, marginsTB: pageMarginsTB, columns: pageColumns,
                    footer: showFooter, math: mathMode },
      typography: { family: comfortFont, sizeStep: sizeStep, weightStep: weightStep, lineStep: lineStep },
      layout:     { contentWidth: contentWidth, zoomStep: zoomStep },
      updated:    new Date().toISOString()
    };
    idbPut("activeDocument", "current", record).catch(function (err) {
      console.error("IDB autosave failed:", err);
    });
  }

  /* ==========================================================================
     YAML front-matter stripping (render-only)
     Detection: doc starts with "---" on its own line (after trimming whitespace).
     Block ends at the next "---" line. Content after is passed to the renderer.
     The full source (with front-matter) is preserved in IDB and on .md export.
     ========================================================================== */

  function stripYamlFrontMatter(md) {
    if (!md) return md;
    var match = md.match(/^\s*---\n[\s\S]*?\n---\n?/);
    if (!match) return md;
    return md.substring(match[0].length);
  }

  /* ── Build YAML front-matter from current preferences (for sharing) ──── */
  function buildShareYaml() {
    var lines = [
      "---",
      "docEngine: " + currentDocEngine,
      "surfaceMode: " + surfaceMode,
      "appFramework: " + currentAppFramework,
      "pageSize: " + pageSize,
      "orientation: " + orientation,
      "marginsLR: " + pageMarginsLR,
      "marginsTB: " + pageMarginsTB,
      "columns: " + pageColumns,
      "footer: " + showFooter,
      "math: " + mathMode,
      "font: " + comfortFont,
      "size: " + sizeStep,
      "weight: " + weightStep,
      "line: " + lineStep,
      "width: " + contentWidth,
      "zoom: " + zoomStep,
      "---"
    ];
    if (currentMarkdownUrl) {
      lines.splice(lines.length - 1, 0, "url: " + currentMarkdownUrl);
    }
    return lines.join("\n") + "\n";
  }

  /* ── Parse YAML front-matter from shared document ──────────────────── */
  function parseShareYaml(md) {
    if (!md) return { frontmatter: null, body: md };
    var match = md.match(/^\s*---\n([\s\S]*?)\n---\n?/);
    if (!match) return { frontmatter: null, body: md };
    return {
      frontmatter: parseShareYamlMap(match[1]),
      body: md.substring(match[0].length)
    };
  }

  /* Split each `key: value` line of a frontmatter block into a flat map.
     Strings are trimmed; whitespace-only values are kept as "" so callers
     can distinguish "absent" from "present but empty". */
  function parseShareYamlMap(block) {
    var fm = {};
    block.split("\n").forEach(function (line) {
      var idx = line.indexOf(":");
      if (idx === -1) return;
      var key = line.substring(0, idx).trim();
      var val = line.substring(idx + 1).trim();
      fm[key] = val;
    });
    return fm;
  }

  /* ── Apply parsed frontmatter to live state ──────────────────────────────
   *
   * One source of truth for hydrating globals from a frontmatter map. Used
   * by both `loadSharedDocument` (shared-doc flow, line ~1180) and the
   * markdown-import path (line ~4226). Every registry key is validated
   * against its own lookup map so a typo like `pageSze: A3` is rejected
   * and silently falls back to the prior value rather than corrupting the
   * pagination. String values are trimmed before lookup so trailing
   * whitespace from hand-edited shares doesn't fail the registry check.
   *
   * After mutation, syncs the form controls via `syncDocControlsUI()` so
   * the dropdowns always reflect the live state — this is the entire
   * reason every YAML hydration path now routes through here. Before this
   * helper, `loadSharedDocument` set globals but never refreshed the UI,
   * leaving `document.getElementById("page-size").value === "A4"` while
   * the underlying `pageSize` global was "A3"; the cached srcdoc path in
   * `buildPrintSnapshot` then read the stale form value and exported A4
   * portrait regardless of the YAML.
   *
   * The returned object is reserved for future test introspection; the
   * current tests pin the side-effects (syncDocControlsUI ran, every key
   * was validated) rather than the return value.
   */
  function applyFrontmatter(fm) {
    if (!fm || typeof fm !== "object") return {};
    var v;
    /* docEngine is the engine registry, not a free text. A bad value must
       NEVER downgrade a working engine to "none" — silently keep the
       current engine. */
    if (typeof (v = fm.docEngine) === "string" && DOC_ENGINES[v.trim()]) {
      currentDocEngine = v.trim();
    }
    if (typeof (v = fm.surfaceMode) === "string" && (v = v.trim()) &&
        (v === "doc" || v === "app")) {
      surfaceMode = v;
    }
    if (typeof (v = fm.appFramework) === "string" && (v = v.trim()) &&
        APP_FRAMEWORKS[v]) {
      currentAppFramework = v;
    }
    if (typeof (v = fm.pageSize) === "string" && (v = v.trim()) &&
        PAGE_SIZES[v]) {
      pageSize = v;
    }
    if (typeof (v = fm.orientation) === "string" && (v = v.trim()) &&
        (v === "portrait" || v === "landscape")) {
      orientation = v;
    }
    if (typeof (v = fm.marginsLR) === "string" && (v = v.trim()) &&
        MARGIN_MAP[v]) {
      pageMarginsLR = v;
    }
    if (typeof (v = fm.marginsTB) === "string" && (v = v.trim()) &&
        MARGIN_MAP[v]) {
      pageMarginsTB = v;
    }
    if (typeof (v = fm.columns) === "string" || typeof v === "number") {
      pageColumns = clampInt(String(v).trim(), 1, 3, pageColumns);
    }
    /* Footer accepts boolean (programmatic callers — IDB autosave,
       restoreFromIDB) OR string ("true"/"on"/"false"/"off" from YAML
       frontmatter). Both an explicit `false` and an explicit `"false"`
       restore as off so a user who deliberately disabled the footer
       gets the same state after reload. Anything else (undefined,
       other strings, null) leaves the current setting alone so existing
       callers that omit footer don't accidentally toggle the toggle. */
    if (fm.footer !== undefined) {
      v = fm.footer;
      if (typeof v === "boolean") {
        showFooter = v;
      } else if (typeof v === "string") {
        var fv = v.trim().toLowerCase();
        if (fv === "true" || fv === "on") showFooter = true;
        else if (fv === "false" || fv === "off") showFooter = false;
      }
    }
    /* Math Mode: same boolean/string contract as footer. Default remains
       OFF when the key is absent so pre-math documents stay zero-cost. */
    if (fm.math !== undefined) {
      v = fm.math;
      if (typeof v === "boolean") {
        mathMode = v;
      } else if (typeof v === "string") {
        var mv = v.trim().toLowerCase();
        if (mv === "true" || mv === "on") mathMode = true;
        else if (mv === "false" || mv === "off") mathMode = false;
      }
    }
    if (typeof (v = fm.font) === "string" && (v = v.trim()) &&
        COMFORT_FONTS.some(function (f) { return f.value === v; })) {
      comfortFont = v;
      if (fontPickerLabel) {
        fontPickerLabel.textContent = v;
        fontPickerLabel.style.fontFamily = '"' + v + '", system-ui, sans-serif';
      }
    }
    if (typeof (v = fm.size) === "string" || typeof v === "number") {
      sizeStep = clampInt(String(v).trim(), SIZE_MIN, SIZE_MAX, sizeStep);
    }
    if (typeof (v = fm.weight) === "string" || typeof v === "number") {
      weightStep = clampInt(String(v).trim(), WEIGHT_MIN, WEIGHT_MAX, weightStep);
    }
    if (typeof (v = fm.line) === "string" || typeof v === "number") {
      lineStep = clampInt(String(v).trim(), LINE_MIN, LINE_MAX, lineStep);
    }
    if (typeof (v = fm.width) === "string" || typeof v === "number") {
      contentWidth = clampInt(String(v).trim(), 400, 1400, contentWidth);
    }
    if (typeof (v = fm.zoom) === "string" || typeof v === "number") {
      zoomStep = clampInt(String(v).trim(), 50, 150, zoomStep);
    }
    /* URL inside frontmatter (`url: ...`) is also a knob — mirror the
       global setMarkdownUrl side-effect the inline branch did. */
    if (typeof (v = fm.url) === "string" && (v = v.trim())) {
      setMarkdownUrl(v);
    }
    /* Once every knob is hydrated, push the new values into the form so
       the user immediately sees what the frontmatter asked for. Critically,
       this must happen BEFORE renderPreview is invoked downstream so the
       doc CSS that depends on these globals matches what the form shows. */
    if (typeof syncDocControlsUI === "function") syncDocControlsUI();
  }

  /* ==========================================================================
     Document Engine registry
     Each engine: label, script URL (optional), category.
     ========================================================================== */

  var DOC_ENGINES = {
    pagedjs: { label: "Paged.js", script: "https://unpkg.com/pagedjs/dist/paged.polyfill.js", category: "paged-media", description: "Fast pagination. Best for text-heavy documents. Basic table support (may break mid-row). Running headers unreliable across page breaks. ~70KB." },
    vivliostyle: { label: "Vivliostyle", script: "https://esm.unpkg.com/@vivliostyle/core@2.43.3", category: "css-books", module: true, description: "Professional publishing. Full CSS Table support, reliable running headers via string-set/string(), accurate page counters. Best for books and complex layouts. ~1.2MB." },
    none: { label: "Plain CSS", script: null, category: "unstyled", description: "No pagination. WYSIWYG preview for quick edits. PDF export disabled." }
  };

  /* ==========================================================================
     App Frameworks registry (for App surface mode)
     Each framework: label, css URLs (array), js URL (optional), category, style function.
     ========================================================================== */

  var APP_FRAMEWORKS = {
    spectre: {
      label: "Spectre",
      css: ["https://unpkg.com/spectre.css/dist/spectre.min.css", "https://unpkg.com/spectre.css/dist/spectre-icons.min.css"],
      js: null,
      category: "grid",
      style: function (css) { return css + "body { max-width: 1100px; margin: 0 auto; padding: 20px; }"; }
    },
    poshui: {
      label: "Poshui",
      css: ["https://unpkg.com/poshui/dist/poshui.min.css"],
      js: null,
      category: "minimal",
      style: function (css) { return css + "body { max-width: 960px; margin: 0 auto; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }"; }
    },
    pico: {
      label: "Pico",
      css: ["https://unpkg.com/@picocss/pico@latest/css/pico.min.css"],
      js: null,
      category: "semantic",
      style: function (css) { return css + "body { max-width: 900px; margin: 0 auto; padding: 20px; }"; }
    },
    milligram: {
      label: "Milligram",
      css: ["https://unpkg.com/milligram@1.4.1/dist/milligram.min.css"],
      js: null,
      category: "minimal",
      style: function (css) { return css + "body { max-width: 800px; margin: 0 auto; padding: 20px; }"; }
    },
    chota: {
      label: "Chota",
      css: ["https://unpkg.com/chota@1.0.4/dist/chota.min.css"],
      js: null,
      category: "grid",
      style: function (css) { return css + "body { max-width: 1000px; margin: 0 auto; padding: 20px; }"; }
    }
  };

  /* ==========================================================================
     App Components registry (for App surface mode)
     Each component: id, label, support map, snippets per framework.
     ========================================================================== */

  var APP_COMPONENTS = [
    {
      id: "card", label: "Card",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<div class="card"><div class="card-body">Card content</div></div>',
        poshui: '<div class="card">Card content</div>',
        pico: '<article class="card"><div class="card-body">Card content</div></article>',
        milligram: '<div class="card"><p>Card content</p></div>',
        chota: '<div class="card"><p>Card content</p></div>'
      }
    },
    {
      id: "button", label: "Button",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<button class="btn btn-primary">Primary</button>',
        poshui: '<button class="button primary">Primary</button>',
        pico: '<button class="secondary">Secondary</button>',
        milligram: '<button class="button button-primary">Primary</button>',
        chota: '<button class="button primary">Primary</button>'
      }
    },
    {
      id: "table", label: "Table",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<table class="table"><thead><tr><th>#</th><th>Name</th></tr></thead><tbody><tr><td>1</td><td>Item</td></tr></tbody></table>',
        poshui: '<table class="table"><tr><th>#</th><th>Name</th></tr><tr><td>1</td><td>Item</td></tr></table>',
        pico: '<table><thead><tr><th>#</th><th>Name</th></tr></thead><tbody><tr><td>1</td><td>Item</td></tr></tbody></table>',
        milligram: '<table><tr><th>#</th><th>Name</th></tr><tr><td>1</td><td>Item</td></tr></table>',
        chota: '<table><tr><th>#</th><th>Name</th></tr><tr><td>1</td><td>Item</td></tr></table>'
      }
    },
    {
      id: "list", label: "List",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<ul class="breadcrumb"><li><a href="#">Home</a></li><li><a href="#">Library</a></li></ul>',
        poshui: '<ul class="list"><li>Item 1</li><li>Item 2</li></ul>',
        pico: '<ul><li>Item 1</li><li>Item 2</li></ul>',
        milligram: '<ul><li>Item 1</li><li>Item 2</li></ul>',
        chota: '<ul><li>Item 1</li><li>Item 2</li></ul>'
      }
    },
    {
      id: "image", label: "Image",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<img src="https://via.placeholder.com/600x400" alt="Placeholder" class="img-responsive">',
        poshui: '<img src="https://via.placeholder.com/600x400" alt="Placeholder" class="image">',
        pico: '<img src="https://via.placeholder.com/600x400" alt="Placeholder">',
        milligram: '<img src="https://via.placeholder.com/600x400" alt="Placeholder">',
        chota: '<img src="https://via.placeholder.com/600x400" alt="Placeholder">'
      }
    },
    {
      id: "alert", label: "Alert",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<div class="alert alert-primary">Alert message</div>',
        poshui: '<div class="alert">Alert message</div>',
        pico: '<div class="alert alert-primary" role="alert">Alert message</div>',
        milligram: '<p class="alert alert-warning">Alert message</p>',
        chota: '<div class="notification"><p>Alert message</p></div>'
      }
    },
    {
      id: "button-group", label: "Button Group",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<div class="btn-group"><button class="btn">Left</button><button class="btn">Right</button></div>',
        poshui: '<div class="button-group"><button class="button">Left</button><button class="button">Right</button></div>',
        pico: '<div class="button-group"><button>Left</button><button>Right</button></div>',
        milligram: '<div class="button-group"><button class="button">Left</button><button class="button">Right</button></div>',
        chota: '<div class="button-group"><button class="button">Left</button><button class="button">Right</button></div>'
      }
    },
    {
      id: "nav", label: "Nav",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<ul class="nav"><li class="nav-item"><a class="nav-link" href="#">Home</a></li></ul>',
        poshui: '<nav class="navbar"><a href="#" class="navbar-item">Home</a></nav>',
        pico: '<nav><ul><li><a href="#">Home</a></li></ul></nav>',
        milligram: '<nav><ul><li><a href="#">Home</a></li></ul></nav>',
        chota: '<nav><a href="#" class="nav-link">Home</a></nav>'
      }
    },
    {
      id: "badge", label: "Badge",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<span class="badge badge-primary">New</span>',
        poshui: '<span class="badge primary">New</span>',
        pico: '<span class="badge primary">New</span>',
        milligram: '<span class="badge badge-pill badge-primary">New</span>',
        chota: '<span class="badge primary">New</span>'
      }
    },
    {
      id: "input", label: "Input",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<input type="text" class="form-input" placeholder="Enter text...">',
        poshui: '<input type="text" class="input" placeholder="Enter text...">',
        pico: '<input type="text" placeholder="Enter text...">',
        milligram: '<input type="text" class="input" placeholder="Enter text...">',
        chota: '<input type="text" class="input" placeholder="Enter text...">'
      }
    },
    {
      id: "modal", label: "Modal",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<a href="#" class="btn btn-link" role="button">Launch</a><div class="modal"><div class="modal-content"><a href="#" class="btn btn-close">&times;</a><div class="modal-body">Content</div></div></div>',
        poshui: '<button class="button" onclick="document.getElementById(\'modal\').classList.toggle(\'active\')">Launch</button><div id="modal" class="modal">Content</div>',
        pico: '<dialog role="dialog" aria-modal="true" class="modal"><form method="dialog"><button>Close</button></form><p>Content</p></dialog>',
        milligram: '<p><button class="button" onclick="document.getElementById(\'modal\').style.display=\'block\'">Launch</button></p><div id="modal" class="modal" style="display:none"><div class="modal-content">Content</div></div>',
        chota: '<div class="modal"><div class="modal-content">Content</div></div>'
      }
    },
    {
      id: "accordion", label: "Accordion",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<details class="accordion"><summary class="accordion-header">Title</summary><div class="accordion-body">Content</div></details>',
        poshui: '<details class="details"><summary class="details-summary">Title</summary><div class="details-content">Content</div></details>',
        pico: '<details><summary>Title</summary><p>Content</p></details>',
        milligram: '<details><summary>Title</summary><p>Content</p></details>',
        chota: '<details class="details"><summary>Title</summary><div class="details-content">Content</div></details>'
      }
    },
    {
      id: "toast", label: "Toast",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<div class="alert alert-success">Toast message</div>',
        poshui: '<div class="alert success">Toast message</div>',
        pico: '<div class="alert alert-success" role="alert">Toast message</div>',
        milligram: '<p class="toast">Toast message</p>',
        chota: '<div class="notification success">Toast message</div>'
      }
    },
    {
      id: "progress", label: "Progress",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<div class="progress"><div class="progress-value" style="width: 50%"></div></div>',
        poshui: '<div class="progress"><div class="progress-inner" style="width: 50%"></div></div>',
        pico: '<progress value="50" max="100"></progress>',
        milligram: '<progress value="50" max="100"></progress>',
        chota: '<div class="progress"><div class="progress-inner" style="width: 50%"></div></div>'
      }
    },
    {
      id: "tab", label: "Tab",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<div class="tabs"><ul class="tab-item active"><li class="tab-active"><a href="#">Home</a></li></ul></div>',
        poshui: '<div class="tabs"><div class="tab-item active">Home</div></div>',
        pico: '<div class="tabs" role="tablist"><button role="tab" aria-selected="true">Home</button></div>',
        milligram: '<div class="tabs"><ul><li class="tab-active"><a href="#">Home</a></li></ul></div>',
        chota: '<div class="tabs"><div class="tab-item active">Home</div></div>'
      }
    },
    {
      id: "tooltip", label: "Tooltip",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<span class="tooltipped" data-tooltip="Help text">Hover me</span>',
        poshui: '<span class="tooltip" data-tooltip="Help text">Hover me</span>',
        pico: '<span data-tooltip="Help text">Hover me</span>',
        milligram: '<span class="tooltip" data-tooltip="Help text">Hover me</span>',
        chota: '<span class="tooltip" data-tooltip="Help text">Hover me</span>'
      }
    },
    {
      id: "navbar", label: "Navbar",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<nav class="navbar"><a class="navbar-brand" href="#">Brand</a><ul class="nav"><li class="nav-item"><a class="nav-link" href="#">Home</a></li></ul></nav>',
        poshui: '<nav class="navbar"><a href="#" class="navbar-brand">Brand</a><div class="navbar-item"><a href="#" class="navbar-link">Home</a></div></nav>',
        pico: '<nav><a href="#">Brand</a><ul><li><a href="#">Home</a></li></ul></nav>',
        milligram: '<nav class="navbar"><div class="container"><a class="navbar-title">Brand</a><ul><li><a href="#">Home</a></li></ul></div></nav>',
        chota: '<nav class="navbar"><a href="#" class="nav-brand">Brand</a><div class="nav-links"><a href="#" class="nav-link">Home</a></div></nav>'
      }
    },
    {
      id: "footer", label: "Footer",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<footer class="footer"><p>&copy; 2026 My Site</p></footer>',
        poshui: '<footer class="footer"><p>&copy; 2026 My Site</p></footer>',
        pico: '<footer><p>&copy; 2026 My Site</p></footer>',
        milligram: '<footer class="footer"><p>&copy; 2026 My Site</p></footer>',
        chota: '<footer class="footer"><p>&copy; 2026 My Site</p></footer>'
      }
    },
    {
      id: "hero-wide", label: "Hero",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<div class="hero"><div class="hero-body"><h1 class="hero-title">Welcome</h1><p class="hero-subtitle">Subtitle here</p></div></div>',
        poshui: '<div class="hero"><h1>Welcome</h1><p>Subtitle here</p></div>',
        pico: '<section aria-label="Hero section"><h1>Welcome</h1><p>Subtitle here</p></section>',
        milligram: '<section class="hero"><h1>Welcome</h1><p class="hero-subtitle">Subtitle here</p></section>',
        chota: '<div class="hero"><h1>Welcome</h1><p>Subtitle here</p></div>'
      }
    },
    {
      id: "two-col", label: "2-Col Layout",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<div class="columns"><div class="column col-6">Left</div><div class="column col-6">Right</div></div>',
        poshui: '<div class="row"><div class="col"><p>Left</p></div><div class="col"><p>Right</p></div></div>',
        pico: '<div class="grid"><div class="grid-item">Left</div><div class="grid-item">Right</div></div>',
        milligram: '<div class="row"><div class="column">Left</div><div class="column">Right</div></div>',
        chota: '<div class="grid"><div class="grid-col">Left</div><div class="grid-col">Right</div></div>'
      }
    },
    {
      id: "three-col", label: "3-Col Layout",
      support: { spectre: true, poshui: true, pico: true, milligram: true, chota: true },
      snippets: {
        spectre: '<div class="columns"><div class="column col-4">Left</div><div class="column col-4">Center</div><div class="column col-4">Right</div></div>',
        poshui: '<div class="row"><div class="col"><p>Left</p></div><div class="col"><p>Center</p></div><div class="col"><p>Right</p></div></div>',
        pico: '<div class="grid"><div class="grid-item">Left</div><div class="grid-item">Center</div><div class="grid-item">Right</div></div>',
        milligram: '<div class="row"><div class="column">Left</div><div class="column">Center</div><div class="column">Right</div></div>',
        chota: '<div class="grid"><div class="grid-col">Left</div><div class="grid-col">Center</div><div class="grid-col">Right</div></div>'
      }
    }
  ];

  /* ==========================================================================
     Typography presets
     ========================================================================== */

  var COMFORT_FONTS = [
    { value: "Inter",            label: "Inter" },
    { value: "JetBrains Mono",   label: "JetBrains Mono" },
    { value: "Lora",             label: "Lora" },
    { value: "Merriweather",     label: "Merriweather" },
    { value: "Playfair Display", label: "Playfair Display" },
    { value: "Comfortaa",        label: "Comfortaa" },
    { value: "Unbounded",        label: "Unbounded" }
  ];

  var SIZE_SCALE = { "-5": 0.62, "-4": 0.68, "-3": 0.76, "-2": 0.84, "-1": 0.92, "0": 1, "1": 1.1, "2": 1.2, "3": 1.32, "4": 1.46, "5": 1.62, "6": 1.8 };
  var SIZE_MIN = -5;
  var SIZE_MAX = 6;

  var WEIGHT_MAP = { "-3": 100, "-2": 200, "-1": 300, "0": 400, "1": 600, "2": 700 };
  var WEIGHT_MIN = -3;
  var WEIGHT_MAX = 2;

  var LINE_SCALE = { "-2": 1.3, "-1": 1.5, "0": 1.75, "1": 2.0, "2": 2.3, "3": 2.6 };
  var LINE_MIN = -2;
  var LINE_MAX = 3;

  var FONTS_URL = "https://fonts.googleapis.com/css2?family=Unbounded:wght@200;300;400;500;600;700;800;900"
    + "&family=Lato:wght@100;300;400;700;900"
    + "&family=Inter:wght@100;200;300;400;500;600;700"
    + "&family=Merriweather:wght@300;400;700;900"
    + "&family=Lora:wght@400;500;600;700"
    + "&family=Playfair+Display:wght@400;500;600;700;900"
    + "&family=JetBrains+Mono:wght@300;400;600;700"
    + "&family=Comfortaa:wght@300;400;500;600;700"
    + "&display=swap";
  /* Generated previews and exports use the same vendored font inventory as
     the editor shell. Keeping this URL absolute also makes it resolve from
     blob: export documents. */
  var FONT_STYLESHEET_URL = new URL("fonts.css?v=2", window.location.href).href;

  /* Lazy-load the Comfort Font stylesheet only when the user opens the dropdown. */
  function loadComfortFonts() {
    if (loadComfortFonts.loaded) return;
    loadComfortFonts.loaded = true;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = FONTS_URL;
    document.head.appendChild(link);
  }

  /* ==========================================================================
     State
     ========================================================================== */

  var mode = "edit";
  var surfaceMode = "doc";  /* "doc" | "app" */
  var currentDocEngine = "none";
  var currentAppFramework = "spectre";
  var sizeStep = 0;
  var weightStep = 0;
  var lineStep = 0;
  var comfortFont = "Inter";
  var zoomStep = 100;
  var readZoomRestore = null;
  var lastScrollRatio = 0;
  var lastEditorScrollTop = 0;
  var previewLoaderTimer = null;
  var currentRenderId = 0;

  function showPreviewLoader() {
    if (!previewLoader) return;
    previewLoader.classList.remove("hidden");
    if (previewLoaderTimer) clearTimeout(previewLoaderTimer);
    previewLoaderTimer = setTimeout(hidePreviewLoader, 8000);
  }

  function hidePreviewLoader() {
    if (!previewLoader) return;
    previewLoader.classList.add("hidden");
    if (previewLoaderTimer) {
      clearTimeout(previewLoaderTimer);
      previewLoaderTimer = null;
    }
  }

  function swapPreviewFrames() {
    if (!previewFrame || !previewFrameNext) return;
    var oldFrame = previewFrame;
    var newFrame = previewFrameNext;

    newFrame.classList.add("active");
    oldFrame.classList.remove("active");

    /* Swap ids so global references stay on the active iframe */
    oldFrame.id = "preview-frame-next";
    newFrame.id = "preview-frame";
    previewFrame = newFrame;
    previewFrameNext = oldFrame;

    positionWidthHandles();
    applyZoom();
    hidePreviewLoader();
  }

  function onPreviewFrameReady(e) {
    if (!e || !e.source) return;
    if (e.source !== previewFrameNext.contentWindow) return;
    if (e.data && e.data.renderId !== currentRenderId) return;
    swapPreviewFrames();
  }

  function onPreviewFrameError(e) {
    /* An engine (Paged.js / Vivliostyle) failed to paginate — usually its CDN
       script did not load. Ignore stale frames so a late failure from an
       superseded render cannot clobber a good current preview. Keep the last
       committed frame on screen, drop the loader, and tell the user instead
       of leaving the spinner to time out silently. */
    if (!e || !e.source) return;
    if (e.source !== previewFrameNext.contentWindow) return;
    if (e.data && e.data.renderId !== currentRenderId) return;
    hidePreviewLoader();
    showToast("Preview engine failed to load — check your connection and try again");
  }

  function isCurrentPreviewCommitted() {
    if (!previewFrame || !previewFrame.contentWindow) return false;
    try {
      return previewFrame.contentWindow.__flatwriteRenderId === currentRenderId;
    } catch (e) {
      return false;
    }
  }

  /* Document layout state */
  var pageSize     = "A4";
  var orientation  = "portrait";
  var pageMarginsLR = "normal";
  var pageMarginsTB = "normal";
  var pageColumns  = 1;
  var showFooter   = false;
  /* Math Mode: OFF by default per document. When OFF, dollar signs and
     backslash-parens are plain text and KaTeX is never loaded. Persist via
     frontmatter `math:` and IDB docLayout.math (same path as footer). */
  var mathMode = false;
  /* One-shot load dialog: once dismissed (or accepted) for the current
     document session, do not re-prompt until a new document is loaded. */
  var mathPromptDismissed = false;
  /* ==========================================================================
     DOM references
     ========================================================================== */

  /* Engine selector DOM refs */
  var engineToggle      = document.getElementById("engine-toggle");
  var engineSlider      = document.getElementById("engine-slider");

  /* Document controls DOM refs */
  var pageSizeSel       = document.getElementById("page-size");
  var pageMarginsLRSel  = document.getElementById("page-margins-lr");
  var pageMarginsTBSel  = document.getElementById("page-margins-tb");
  var pageColumnsSel    = document.getElementById("page-columns");
  var toggleFooterBtn   = document.getElementById("toggle-footer");

  var editor            = document.getElementById("editor");
  var editorWrap        = document.getElementById("editor-wrap");
  var previewWrap       = document.getElementById("preview-wrap");
  var previewFrame      = document.getElementById("preview-frame");
  var previewFrameNext  = document.getElementById("preview-frame-next");
  var previewLoader     = document.getElementById("preview-loader");
  var btnEdit           = document.getElementById("btn-edit");
  var btnPreview        = document.getElementById("btn-preview");
  var btnExportMd       = document.getElementById("btn-export-md");
  var btnExportHtml     = document.getElementById("btn-export-html");
  var btnExportPdf      = document.getElementById("btn-export-pdf");
  var mdToolbar         = document.getElementById("md-toolbar");
  var fontPicker        = document.getElementById("font-dropdown-btn");
  var fontPickerList    = null;
  var fontPickerLabel   = document.getElementById("font-dropdown-label");
  var fontPickerWrap    = document.getElementById("font-dropdown");
  var sizeDownBtn       = document.getElementById("size-down");
  var sizeUpBtn         = document.getElementById("size-up");
  var weightDownBtn     = document.getElementById("weight-down");
  var weightUpBtn       = document.getElementById("weight-up");
  var lineDownBtn       = document.getElementById("line-down");
  var lineUpBtn         = document.getElementById("line-up");
  var zoomSlider        = document.getElementById("zoom-slider");
  var zoomValue         = document.getElementById("zoom-value");
  var btnShare          = document.getElementById("btn-share");
  var exportActions     = document.getElementById("export-actions");
  var mainPanelWrapper  = document.querySelector(".main-panel-wrapper");

  /* Load sidebar DOM refs */
  var btnLoadUrl        = document.getElementById("btn-load-url");
  var btnLoadLocal      = document.getElementById("btn-load-local");

  /* Hidden file input for disk load */
  var loadFileInput     = document.getElementById("load-file-input");

  /* Width handle DOM refs */
  var widthHandleLeft   = document.getElementById("width-handle-left");
  var widthHandleRight  = document.getElementById("width-handle-right");
  var widthDragOverlay  = document.getElementById("width-drag-overlay");

  /* ==========================================================================
     Tab bubble alignment — sync export-actions top with textarea
     ========================================================================== */

  function syncExportActionsTop() {
    if (!exportActions || !mainPanelWrapper) return;
    /* On mobile (<760px) the export actions are inline — clear any desktop alignment */
    if (window.innerWidth < 760) {
      exportActions.style.top = "";
      return;
    }
    /* The visible content area (editor in Edit, preview in View/Read) sits
       directly below the toolbar inside .main-inner. The toolbar isn't
       animated, so measuring it avoids the preview-enter transform while
       still aligning the tab with the textarea box. */
    var toolbar   = document.querySelector(".toolbar");
    var mainInner = document.querySelector(".main-inner");
    if (!toolbar || !mainInner) return;
    var toolbarRect   = toolbar.getBoundingClientRect();
    var wrapperRect   = mainPanelWrapper.getBoundingClientRect();
    var mainInnerStyle = getComputedStyle(mainInner);
    var gap = parseFloat(mainInnerStyle.rowGap) || parseFloat(mainInnerStyle.gap) || 0;
    exportActions.style.top = (toolbarRect.bottom - wrapperRect.top + gap) + "px";
  }

  /* ==========================================================================
     Markdown Loader
     ========================================================================== */

  var initialEditorContent = "";
  var contentWidth = 780;
  var githubBaseUrl = "";
  var currentMarkdownUrl = "";

  function setMarkdownUrl(url) {
    currentMarkdownUrl = url || "";
    if (!currentMarkdownUrl) {
      githubBaseUrl = "";
      return;
    }
    var m = currentMarkdownUrl.match(/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)\/(.+)$/);
    if (m) {
      var raw = "https://raw.githubusercontent.com/" + m[1] + "/" + m[2] + "/" + m[3] + "/" + m[4];
      githubBaseUrl = raw.replace(/\/[^/]*$/, '/');
      currentMarkdownUrl = raw;
      return;
    }
    if (/^https?:\/\//.test(currentMarkdownUrl)) {
      try {
        githubBaseUrl = new URL('.', currentMarkdownUrl).href;
      } catch (e) {
        githubBaseUrl = "";
      }
    } else {
      githubBaseUrl = "";
    }
  }

  function rewriteGitHubUrl(url) {
    setMarkdownUrl(url);
    return currentMarkdownUrl || url;
  }

  /**
   * Extract a sensible filename from a URL for routing purposes.
   * The router uses the extension to decide whether to send a file
   * to the extract endpoint (.pdf, .pptx, etc.) or read it as
   * plain text (.md, .markdown, .txt). If the URL has no
   * recognizable filename (e.g. an API endpoint or a bare host),
   * we return a generic name — the dispatcher will then route to
   * extract, which is the right default for unknown formats.
   */
  function deriveFilenameFromUrl(url) {
    try {
      var u = new URL(url);
      var path = u.pathname || "";
      var base = path.split("/").filter(Boolean).pop() || "";
      if (base && base.indexOf(".") >= 0) {
        // Strip query string / fragment if they slipped into the base.
        return base.split("?")[0].split("#")[0] || "remote";
      }
    } catch (_) {
      // URL parsing failed — fall through to the default.
    }
    return "remote";
  }

  function resolveRelativeUrls(html) {
    if (!githubBaseUrl) return html;

    var ghHostOk;
    try {
      var host = new URL(githubBaseUrl).hostname;
      ghHostOk = /^(?:raw\.)?githubusercontent\.com$|^github\.com$/.test(host);
    } catch (_) {
      ghHostOk = false;
    }

    function stampRaw(u) {
      if (!ghHostOk) return u;
      try {
        var parsed = new URL(u);
        if (!parsed.searchParams.has("raw")) parsed.searchParams.set("raw", "true");
        return parsed.toString();
      } catch (_) {
        return u;
      }
    }

    // Image-like src — apply ?raw=true on GitHub. The capture group for
    // everything up to and including "src=" lets us splice in the resolved
    // value without any manual index arithmetic (a previous version of
    // this code hand-computed slice offsets and silently mangled the
    // rewritten attribute — e.g. "/library/foo.jpg" style root-relative
    // paths came out as a duplicated/broken src attribute).
    html = html.replace(
      /(<(?:img|video|source)\s[^>]*?src=)(["'])([^"']+)\2/gi,
      function (match, prefix, q, src) {
        var resolved = resolveUrlTarget(src, githubBaseUrl);
        if (resolved === src) return match;
        return prefix + q + stampRaw(resolved) + q;
      }
    );

    // Anchor href — never stamp ?raw=true (would break link navigation)
    html = html.replace(
      /(<a\s[^>]*?href=)(["'])([^"']+)\2/gi,
      function (match, prefix, q, href) {
        var resolved = resolveUrlTarget(href, githubBaseUrl);
        if (resolved === href) return match;
        return prefix + q + resolved + q;
      }
    );

    return html;
  }

  function resolveUrlTarget(url, baseUrl) {
    if (window.FlatwriteUrlRouting) {
      return window.FlatwriteUrlRouting.resolveUrlTarget(url, baseUrl);
    }
    return url;
  }

  function rewriteMarkdownUrls(markdown, baseUrl) {
    if (window.FlatwriteUrlRouting) {
      return window.FlatwriteUrlRouting.rewriteMarkdownUrls(markdown, baseUrl);
    }
    return markdown;
  }

  function decideUrlRoute(url, contentType) {
    if (window.FlatwriteUrlRouting) {
      return window.FlatwriteUrlRouting.decideUrlRoute(url, contentType);
    }
    return "direct";
  }

  function isEditorDirty() {
    return editor.value !== initialEditorContent;
  }

  function setEditorContent(text) {
    editor.value = text;
    editor.dispatchEvent(new Event("input"));
    /* autosave is handled by the input event listener */
  }

  function handleFileUpload(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onerror = function () {
      showToast("Could not read " + (file.name || "the selected file"));
    };
    reader.onload = function () {
      if (typeof reader.result !== "string" || reader.result.length === 0) {
        showToast("The selected file is empty");
        return;
      }
      if (isEditorDirty()) {
        var ok = confirm("Replace current content with loaded file?");
        if (!ok) return;
      }
      setEditorContent(reader.result);
      currentMarkdownUrl = "";
      githubBaseUrl = "";
      // Re-render the preview if we're not in Edit mode — without
      // this, dropping a .md in View or Read mode leaves a blank
      // preview pane (the textarea is hidden, so the new content
      // isn't visible until something else triggers a render).
      mathPromptDismissed = false;
      maybePromptMathMode(reader.result);
      if (mode !== "edit") renderPreview();
    };
    reader.readAsText(file);
  }

  /* ==========================================================================
     Inline drop-routing helper.

     Mirrors the public/extract-drop.js helper but is bundled directly
     into app.js so the routing decision is always available — even if
     extract-drop.js failed to load (script tag typo, cache miss,
     deploy lag). Without this fallback, .md/.markdown/.txt drops
     would be misrouted to the extract endpoint on production and
     415-rejected by the Fly service (markdown isn't in the Fly
     extension allowlist — see services/extract/validators.py).

     The standalone public/extract-drop.js is kept for bun-test
     coverage of the routing logic and as a small public API for
     future integrations.
     ========================================================================== */
  var PLAIN_TEXT_EXTS_INLINE = { ".md": 1, ".markdown": 1, ".txt": 1 };
  function routeDroppedFileInline(filename) {
    if (!filename || typeof filename !== "string") return "extract";
    var base = filename.split(/[\\/]/).pop();
    var dot = base.lastIndexOf(".");
    if (dot < 0) return "extract";
    var ext = base.slice(dot).toLowerCase();
    if (PLAIN_TEXT_EXTS_INLINE[ext]) return "plain";
    return "extract";
  }

  /* ==========================================================================
     File import — drag-and-drop extract flow
     ==========================================================================
     Routes any dropped file that isn't a plain-text file (`.md`, `.txt`,
     `.markdown`) through the new /extract endpoint, which converts it to
     Markdown via the MarkItDown service behind extract.flatwrite.md.

     Plain-text files still go through handleFileUpload() — no need to
     round-trip to the server for a raw text read.
     ========================================================================== */

  // Local dev override: when the editor itself is served from localhost,
  // point at a locally-running `wrangler dev` instance of the extract
  // Worker (see workers/flatwrite-extract/README.md § Local dev) instead
  // of the production endpoint. Production hosts are unaffected.
  var IS_LOCAL_DEV = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var EXTRACT_BASE = IS_LOCAL_DEV ? "http://127.0.0.1:8787" : "https://extract.flatwrite.md";
  var EXTRACT_URL = EXTRACT_BASE + "/extract";
  var EXTRACT_TOKEN_URL = EXTRACT_BASE + "/mcp-token";
  var EXTRACT_MAX_BYTES = 25 * 1024 * 1024;
  var _extractCachedToken = null;
  var _extractInflightToken = null;

  async function getExtractToken() {
    if (_extractCachedToken && _extractCachedToken.expiresAt > Math.floor(Date.now() / 1000) + 10) {
      return _extractCachedToken;
    }
    if (_extractInflightToken) return _extractInflightToken;
    _extractInflightToken = (async () => {
      try {
        var r = await fetch(EXTRACT_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!r.ok) {
          throw new Error("token mint failed: HTTP " + r.status);
        }
        var body = await r.json();
        if (!body || !body.token || !body.expiresAt) {
          throw new Error("token mint returned malformed body");
        }
        _extractCachedToken = body;
        return body;
      } finally {
        _extractInflightToken = null;
      }
    })();
    return _extractInflightToken;
  }

  /**
   * POST a dropped file to /extract and load the returned markdown into
   * the editor. Re-uses the Worker's mcp-token flow for browser-safe auth,
   * mirroring webmcp.js's render-worker call site.
   */
  async function handleExtractDrop(file) {
    if (!file) return;
    if (file.size > EXTRACT_MAX_BYTES) {
      showToast("File too large (25 MB max)");
      return;
    }
    if (isEditorDirty()) {
      var ok = confirm("Replace current content with extracted file?");
      if (!ok) return;
    }
    var routing = window.FlatwriteExtractDrop
      ? window.FlatwriteExtractDrop.routeDroppedFile(file.name)
      : routeDroppedFileInline(file.name);
    if (routing === "plain") {
      // Defensive: this should already have been routed to handleFileUpload
      // by the drop listener, but if handleExtractDrop is called directly
      // we honor the same path.
      handleFileUpload(file);
      return;
    }
    showToast("Extracting " + file.name + "…");
    try {
      var token = await getExtractToken();
      var fd = new FormData();
      fd.append("file", file, file.name);
      var resp = await fetch(EXTRACT_URL, {
        method: "POST",
        headers: { "X-Mcp-Token": token.token },
        body: fd,
      });
      var text = await resp.text();
      var data;
      try { data = JSON.parse(text); } catch (_) { data = null; }
      if (!resp.ok) {
        if (resp.status === 401) _extractCachedToken = null;
        var errCode = (data && data.detail && data.detail.code) || (data && data.code) || "EXTRACT_FAILED";
        var errMsg = (data && data.detail && data.detail.error) || (data && data.error) || ("HTTP " + resp.status);
        showToast("Extract failed: " + errMsg);
        console.error("[extract]", errCode, errMsg);
        return;
      }
      if (!data || typeof data.markdown !== "string") {
        showToast("Extract failed: malformed response");
        return;
      }
      if (data.markdown.length === 0) {
        showToast("No text could be extracted from " + file.name);
        return;
      }
      setEditorContent(data.markdown);
      currentMarkdownUrl = "";
      githubBaseUrl = "";
      mathPromptDismissed = false;
      maybePromptMathMode(data.markdown);
      if (mode !== "edit") renderPreview();
      var meta = data.metadata || {};
      showToast("Loaded " + (meta.fileType || "file") + " from " + file.name);
    } catch (e) {
      // Translate the opaque "Failed to fetch" message (thrown by the
      // browser when the network request was blocked — usually CORS,
      // offline, or DNS) into an actionable hint. Without this, the
      // user sees "Failed to fetch" with no way to debug.
      var rawMsg = (e && e.message) ? e.message : String(e);
      var friendly;
      if (/Failed to fetch|NetworkError|Load failed/i.test(rawMsg)) {
        friendly = "network error (check your connection or the file size)";
      } else if (/timeout|aborted/i.test(rawMsg)) {
        friendly = "request timed out";
      } else if (/413/i.test(rawMsg)) {
        friendly = "file is too large (25 MB max)";
      } else if (/415/i.test(rawMsg)) {
        friendly = "this file type isn't supported";
      } else if (/401/i.test(rawMsg)) {
        friendly = "authentication failed — refresh the page";
      } else {
        friendly = rawMsg;
      }
      showToast("Extract failed: " + friendly);
      console.error("[extract]", e);
    }
  }

  /**
   * Shared routing decision for any dropped/picked file, regardless of
   * where the drop landed (the outer document in Edit mode, or a
   * sandboxed preview iframe in View/Read mode — see
   * `iframeDropForwardScript()`). Routes .md/.txt/.markdown to
   * handleFileUpload, everything else to handleExtractDrop.
   */
  function processDroppedFile(file) {
    if (!file || !file.name) return;
    // Use the bundled inline router by default so this works even if
    // extract-drop.js failed to load (deploy lag, cache miss). Fall
    // back to the helper when present so test edits there propagate.
    var route = window.FlatwriteExtractDrop
      ? window.FlatwriteExtractDrop.routeDroppedFile(file.name)
      : routeDroppedFileInline(file.name);
    if (route === "plain") {
      handleFileUpload(file);
    } else {
      handleExtractDrop(file);
    }
  }

  /**
   * Global drag/drop dispatcher. Called from the listeners attached in
   * bindEvents(). Toggles the `drop-target` class on .app-shell so the
   * CSS overlay appears.
   */
  function onDroppedFiles(e) {
    if (!e.dataTransfer || !e.dataTransfer.files) return;
    var files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    // v1 — single file only.
    processDroppedFile(files[0]);
  }

  /**
   * The preview pane is a sandboxed same-origin-opaque iframe with its own
   * Document. Native file drag-and-drop events landing on the iframe are
   * delivered to *that* document, not the outer one — so the top-level
   * `document.addEventListener("drop", ...)` in bindDropZone() never fires
   * for drops over the preview in View/Read mode, and the browser's
   * default action (navigate the frame to the dropped file) takes over
   * instead: .md files render as a raw-text navigation (which the
   * `allow-popups-to-escape-sandbox` flag turns into a new tab), and
   * binary files like .pptx just fail silently.
   *
   * Every generated preview document embeds this snippet so it forwards
   * dropped File objects to the parent via postMessage instead (File is
   * structured-cloneable, so this works regardless of the iframe's
   * sandboxed origin). The parent's "message" listener in bindEvents()
   * then runs the exact same processDroppedFile() routing as a native
   * drop on the outer document.
   */
  function iframeDropForwardScript() {
    return 'document.addEventListener("dragover", function(e){ e.preventDefault(); });'
      + 'document.addEventListener("drop", function(e){'
      + '  e.preventDefault();'
      + '  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {'
      + '    parent.postMessage({type:"dropped-files", files: Array.prototype.slice.call(e.dataTransfer.files)}, "*");'
      + '  }'
      + '});';
  }

  function bindDropZone() {
    var appShell = document.getElementById("app-shell");
    if (!appShell) return;
    var dragDepth = 0;
    // We only show the overlay for drags that actually carry files. Plain
    // text/HTML drags are common in editors and shouldn't trigger the
    // overlay (they'd just create dead UI flicker).
    function hasFile(e) {
      if (!e.dataTransfer || !e.dataTransfer.types) return false;
      for (var i = 0; i < e.dataTransfer.types.length; i++) {
        if (e.dataTransfer.types[i] === "Files") return true;
      }
      return false;
    }
    document.addEventListener("dragenter", function (e) {
      if (!hasFile(e)) return;
      e.preventDefault();
      dragDepth++;
      appShell.classList.add("drop-target");
    });
    document.addEventListener("dragover", function (e) {
      if (!hasFile(e)) return;
      // Required so the `drop` event fires.
      e.preventDefault();
    });
    document.addEventListener("dragleave", function (e) {
      if (!hasFile(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) appShell.classList.remove("drop-target");
    });
    document.addEventListener("drop", function (e) {
      if (!hasFile(e)) return;
      e.preventDefault();
      dragDepth = 0;
      appShell.classList.remove("drop-target");
      onDroppedFiles(e);
    });
  }

  /* ==========================================================================
     Init
     ========================================================================== */

  function init() {
    marked.use({ html: true, gfm: true, breaks: true, async: false });
    document.querySelector(".app-shell").classList.add("mode-" + mode);

    /* Mode B: shared link load (?s=<key>) */
    var params = new URLSearchParams(window.location.search);
    var shareKey = params.get("s");

    function finishInit() {
      initialEditorContent = editor.value;
      buildFontDropdown();
      buildAppFrameworkDropdown();
      renderComponentGrid();
      initButtonTooltips();
      setDocEngine(currentDocEngine);
      setSurfaceMode(surfaceMode);
      syncDocControlsUI();
      updateDocControlStates();
      bindEvents();
      requestAnimationFrame(syncExportActionsTop);
      updateCharCount();
      /* Apply restored mode (may differ from initial "edit") */
      if (mode !== "edit") setMode(mode);
    }

    if (shareKey) {
      /* Mode B — fetch shared document, suppress autosave until user edits */
      suppressAutosave = true;
      finishInit();
      loadSharedDocument(shareKey);
    } else {
      /* Mode A — restore from IndexedDB */
      restoreFromIDB().then(finishInit).catch(finishInit);
    }

    /* Align tab bubble after first layout */
    requestAnimationFrame(syncExportActionsTop);
  }

  /* ==========================================================================
     Mode B — Load shared document from API
     ========================================================================== */

  function loadSharedDocument(key) {
    fetch("/api/s?key=" + encodeURIComponent(key))
      .then(function (res) {
        if (res.status === 404) {
          showError("This shared document no longer exists or has expired.");
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.error === "not_found") {
          showError("This shared document no longer exists or has expired.");
          return;
        }
        if (data.error === "invalid_content") {
          showError("This shared document is not valid text or markdown.");
          return;
        }
        if (!data.content || typeof data.content !== "string") {
          showError("This shared document is not valid text or markdown.");
          return;
        }
        var parsed = parseShareYaml(data.content);
        /* Metadata belongs to the share envelope, not the user's Markdown. */
        editor.value = parsed.body;

        /* Apply preferences from YAML front-matter if present. The helper
           validates each key against its own registry, mutates globals,
           and pushes the new values into the form via syncDocControlsUI()
           (called inside the helper, since every hydration path must
           share it). Without that sync the #page-size dropdown would
           still read "A4" while pageSize is "A3", so the cached-srcdoc
           fast-path in buildPrintSnapshot would silently re-export A4. */
        if (parsed.frontmatter) {
          var fm = parsed.frontmatter;
          applyFrontmatter(fm);
          zoomSlider.value = zoomStep;
          zoomValue.textContent = zoomStep + "%";
          applyZoom();
          applyContentWidth();
          setDocEngine(currentDocEngine);
        }

        editor.setSelectionRange(0, 0);
        initialEditorContent = parsed.body;
        lastScrollRatio = 0;
        /* paginated engines (pagedjs/vivliostyle) need preview mode;
           read mode forces engine to "none" at render time */
        setMode(currentDocEngine === "none" ? "read" : "preview");
        /* Fresh document load — allow one Math Mode prompt for this body. */
        mathPromptDismissed = false;
        maybePromptMathMode(parsed.body);
        /* Strip ?s= from URL so refresh doesn't re-fetch the shared doc */
        history.replaceState(null, "", window.location.pathname);
      })
      .catch(function (e) {
        console.error("[loadSharedDocument] failed:", e && e.stack || e);
        showError("Could not load shared document. Please try again.");
      });
  }

  function showError(message) {
    editor.value = "";
    editorWrap.classList.add("hidden");
    previewWrap.classList.add("hidden");
    var errorEl = document.createElement("div");
    errorEl.className = "shared-error";
    errorEl.textContent = message;
    var mainInner = document.querySelector(".main-inner");
    if (mainInner) mainInner.appendChild(errorEl);
  }

  /* ==========================================================================
     HTML sanitization — defense-in-depth against XSS via markdown content
     ========================================================================== */

  function sanitizeHTML(raw) {
    if (typeof DOMPurify !== "undefined") {
      return DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: [
          "h1","h2","h3","h4","h5","h6","p","a","img","ul","ol","li",
          "blockquote","pre","code","strong","em","del","s","table",
          "thead","tbody","tr","th","td","br","hr","div","span","input",
          "label","select","option","textarea","button","form","details",
          "summary","main","section","article","aside","header","footer",
          "nav","figure","figcaption","dl","dt","dd","sub","sup","small",
          "mark","abbr","cite","q","pre","kbd","sup",
          /* KaTeX / MathML (only present after Math Mode pre-render) */
          "math","semantics","mrow","mi","mo","mn","msup","msub","msubsup",
          "mfrac","msqrt","mroot","mtable","mtr","mtd","mstyle","mspace",
          "mtext","annotation","mover","munder","munderover","menclose",
          "mpadded","mphantom"
        ],
        ALLOWED_ATTR: [
          "href","src","alt","width","height","class","id","type","name",
          "value","placeholder","checked","disabled","for","role",
          "aria-label","aria-hidden","aria-live","tabindex","colspan","rowspan","style",
          "data-md","data-component","data-tooltip","data-latex","data-latex-fallback",
          "target","rel","title",
          "open","align","valign","border","cellpadding","cellspacing",
          "start","xmlns","encoding","displaystyle","scriptlevel"
        ],
        ALLOW_DATA_ATTR: false
      });
    }
    return raw;
  }

  // SOURCE: core/render.js — keep in sync
  function fixTaskListNumberedItems(html) {
    return html.replace(
      /<li([^>]*)>\s*(?:<p>\s*)?(<input[^>]*type="checkbox"[^>]*>)\s*(?:<\/p>\s*)?<ol(?:\s+start="(\d+)")?>\s*<li>(.*?)<\/li>\s*<\/ol>/gi,
      function (m, attrs, inputHtml, num, text) { return '<li' + attrs + '>' + inputHtml + ' ' + (num || '1') + '. ' + text; }
    );
  }

  function classifyTaskListItems(html) {
    return html.replace(
      /<li([^>]*)>\s*(?:<p>\s*)?(<input[^>]*type="checkbox"[^>]*>)/gi,
      function (m, attrs, input) {
        var classMatch = attrs.match(/class="([^"]*)"/);
        if (classMatch) {
          return '<li' + attrs.replace(/class="([^"]*)"/, 'class="$1 task-list-item"') + '>' + input;
        }
        return '<li class="task-list-item"' + attrs + '>' + input;
      }
    );
  }

  function renderToFragment(markdown) {
    var raw;
    /* Math Mode ON: isolated Marked instance via FlatWriteMath (zero cost
       when OFF — falls through to the global marked singleton). */
    if (mathMode && window.FlatWriteMath && typeof FlatWriteMath.parseMarkdown === "function") {
      raw = FlatWriteMath.parseMarkdown(markdown, true);
    } else {
      raw = marked.parse(markdown);
    }
    return classifyTaskListItems(fixTaskListNumberedItems(raw));
  }

  /**
   * When Math Mode is ON and placeholders are present, lazy-load KaTeX and
   * replace .fw-math-* nodes with static KaTeX HTML/MathML. Must finish
   * BEFORE Paged.js/Vivliostyle pagination (especially Vivliostyle blob docs
   * which run with allowScripts:false). Returns a Promise<string>.
   */
  function finalizeMathHtml(html) {
    if (!mathMode) return Promise.resolve(html);
    if (!html || html.indexOf("fw-math-") === -1) return Promise.resolve(html);
    if (!window.FlatWriteMath || typeof FlatWriteMath.renderMathInHtml !== "function") {
      return Promise.resolve(html);
    }
    return FlatWriteMath.renderMathInHtml(html).catch(function (err) {
      console.error("[math] pre-render failed:", err);
      return html;
    });
  }

  /** KaTeX stylesheet link for iframe/export heads when Math Mode is ON. */
  function mathHeadAssets() {
    if (!mathMode) return "";
    if (window.FlatWriteMath && typeof FlatWriteMath.katexCssLink === "function") {
      return FlatWriteMath.katexCssLink();
    }
    return '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/katex.min.css">';
  }

  /** Lightweight display-math spacing (only meaningful when math HTML present). */
  function mathBodyCss() {
    if (!mathMode) return "";
    return ".fw-math-display{margin:0.85em 0;overflow-x:auto;text-align:center;}"
      + ".fw-math-inline{white-space:normal;}"
      + ".katex-display{margin:0.5em 0;}"
      + ".katex{font-size:1.05em;}";
  }

  /* FlatWrite PDF-only vertical spacing.
     Syntax: <fw-break lines="3"> or <fw-break lines="3" />.
     The count is an integer line multiple, clamped to keep accidental values
     from creating unbounded blank space. Plain, Read, and App surfaces strip
     the tag before Markdown is parsed. */
  var FW_PDF_BREAK_MAX = 24;

  function applyFlatWritePdfBreaks(markdown, renderEngineKey) {
    var isPaged = renderEngineKey === "pagedjs" || renderEngineKey === "vivliostyle";
    var source = String(markdown || "")
      /* Remove malformed/unclosed FlatWrite break tags as well. They should
         never leak into Plain/Read output or become visible prose. */
      .replace(/<fw-break\b(?![^>]*>)[^\r\n]*/gi, "");
    return source.replace(
      /<fw-break\b([^>]*)\/?\s*>(?:\s*<\/fw-break\s*>)?/gi,
      function (_match, attrs) {
        var countMatch = String(attrs || "").match(/\blines\s*=\s*["']?([^\s"'>]+)/i);
        var numeric = countMatch ? Number(countMatch[1]) : 1;
        var lines = Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
        lines = Math.max(0, Math.min(FW_PDF_BREAK_MAX, lines));
        var replacement = lines > 0
          ? '<span class="fw-pdf-break" style="--fw-break-lines:' + lines + '" aria-hidden="true"></span>'
          : "";
        return isPaged ? replacement : "";
      }
    );
  }

  /* ==========================================================================
     IDB persistence — restore from IndexedDB (Mode A default)
     ========================================================================== */

  function clampInt(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function restoreFromIDB() {
    return idbGet("activeDocument", "current").then(function (record) {
      if (!record) return;

      if (record.markdown !== undefined) editor.value = record.markdown;

      if (record.mode === "edit" || record.mode === "preview" || record.mode === "read") {
        mode = record.mode;
      }

      if (record.surfaceMode === "doc" || record.surfaceMode === "app") {
        surfaceMode = record.surfaceMode;
      }
      if (record.appFramework && APP_FRAMEWORKS[record.appFramework]) {
        currentAppFramework = record.appFramework;
      }
      if (record.docEngine && DOC_ENGINES[record.docEngine]) {
        currentDocEngine = record.docEngine;
      }
            
      var t = record.typography || {};
      if (t.family && COMFORT_FONTS.some(function (f) { return f.value === t.family; })) {
        comfortFont = t.family;
      }
      fontPickerLabel.textContent = comfortFont;
      fontPickerLabel.style.fontFamily = '"' + comfortFont + '", system-ui, sans-serif';
      if (t.sizeStep !== undefined)   sizeStep   = clampInt(t.sizeStep,   SIZE_MIN,   SIZE_MAX,   sizeStep);
      if (t.weightStep !== undefined) weightStep = clampInt(t.weightStep, WEIGHT_MIN, WEIGHT_MAX, weightStep);
      if (t.lineStep !== undefined)   lineStep   = clampInt(t.lineStep,   LINE_MIN,   LINE_MAX,   lineStep);

      var l = record.layout || {};
      if (l.zoomStep !== undefined)     zoomStep     = clampInt(l.zoomStep, 50, 150, zoomStep);
      if (l.contentWidth !== undefined) contentWidth = clampInt(l.contentWidth, 400, 1400, contentWidth);

      zoomSlider.value = zoomStep;
      zoomValue.textContent = zoomStep + "%";
      applyZoom();
      applyContentWidth();
      setDocEngine(currentDocEngine);

      var dl = record.docLayout || {};
      /* Reconstruct a share-shaped frontmatter map from the IDB docLayout
         record so the same validation pipeline that hydrates `?s=…` URLs
         also hydrates the IDB restore. Then push the new values into the
         form via syncDocControlsUI inside applyFrontmatter. The legacy
         `margins` field (single string for both LR/TB) is folded into both
         marginsLR and marginsTB so old IDB records from before the split
         still restore. */
      var legacy = Object.assign({}, dl);
      if (dl.margins && MARGIN_MAP[dl.margins]) {
        legacy.marginsLR = dl.margins;
        legacy.marginsTB = dl.margins;
      }
      applyFrontmatter(legacy);
      /* IDB restore is a document load — prompt once if math looks present. */
      mathPromptDismissed = false;
      maybePromptMathMode(editor && editor.value);
    }).catch(function (err) {
      console.error("IDB restore failed:", err);
    });
  }

  /* ==========================================================================
     Accessible button tooltips
     ========================================================================== */

  var BUTTON_TOOLTIP_COPY = {
    "mobile-hamburger": "Open or close the controls sidebar",
    "btn-load-url": "Load a document from a public URL",
    "btn-load-local": "Load a document from this device",
    "toggle-orient": "Switch between portrait and landscape pages",
    "toggle-footer": "Show or hide page numbers and the document title",
    "fw-dropdown-btn": "Choose the component CSS framework",
    "sidebar-export-md": "Open the source as Markdown",
    "sidebar-export-html": "Open the rendered document as HTML",
    "sidebar-export-pdf": "Open the paginated document for PDF printing",
    "sidebar-share-url": "Create a shareable URL",
    "font-dropdown-btn": "Choose the document typeface",
    "size-down": "Decrease document text size",
    "size-up": "Increase document text size",
    "weight-down": "Use a lighter document weight",
    "weight-up": "Use a bolder document weight",
    "line-down": "Tighten document line spacing",
    "line-up": "Loosen document line spacing",
    "btn-edit": "Edit the Markdown source",
    "btn-preview": "Preview the rendered document",
    "btn-read": "Read without editing controls",
    "btn-page-break": "Insert PDF-only line spacing; edit lines=1 for more (ignored in Plain and Read)",
    "btn-math": "Toggle Math Mode — render $…$, $$…$$, \\(…\\), \\[…\\], and ```math with KaTeX",
    "btn-assist": "AI Assist — Coming Soon!",
    "assist-close": "Close AI Assist",
    "assist-run": "Run the selected AI Assist operation",
    "assist-accept": "Apply the proposed AI edit",
    "assist-discard": "Discard the proposed AI edit",
    "btn-export-md": "Open the source as Markdown",
    "btn-export-html": "Open the rendered document as HTML",
    "btn-export-pdf": "Open the paginated document for PDF printing",
    "btn-share": "Create a shareable URL",
    "load-modal-close": "Close the URL loader",
    "load-modal-cancel": "Cancel loading from a URL",
    "load-modal-insert": "Fetch the document from this URL",
    "comp-modal-close": "Close the component dialog",
    "comp-modal-cancel": "Cancel inserting this component",
    "comp-modal-insert": "Insert this component into the document"
  };

  function getButtonTooltip(button) {
    if (!button) return "";
    if (BUTTON_TOOLTIP_COPY[button.id]) return BUTTON_TOOLTIP_COPY[button.id];
    if (button.dataset.tooltip) return button.dataset.tooltip;
    var dataTip = button.getAttribute("data-tip");
    if (dataTip) return dataTip;
    var title = button.getAttribute("title");
    if (title) return title;
    var aria = button.getAttribute("aria-label");
    if (aria) return aria;
    var text = (button.textContent || "").replace(/\s+/g, " ").trim();
    if (button.classList.contains("engine-btn")) return "Render with " + (text || aria || title);
    if (button.classList.contains("surface-btn")) return "Use the " + text + " surface";
    if (button.classList.contains("font-dropdown-item")) return "Use " + text + " as the document typeface";
    if (button.classList.contains("fw-dropdown-item")) return "Use the " + text + " component framework";
    if (button.classList.contains("comp-btn")) return "Insert the " + text + " component";
    if (button.classList.contains("assist-mode")) return "Use the " + text + " assist mode";
    return text ? "Activate " + text : "Activate this control";
  }

  function initButtonTooltips() {
    var tooltip = document.getElementById("fw-button-tooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = "fw-button-tooltip";
      tooltip.className = "fw-tooltip";
      tooltip.setAttribute("role", "tooltip");
      tooltip.setAttribute("aria-hidden", "true");
      document.body.appendChild(tooltip);
    }
    var activeButton = null;

    function prepare(button) {
      if (!button || button.dataset.fwTooltipReady) return;
      var copy = getButtonTooltip(button);
      button.dataset.fwTooltipReady = "1";
      button.dataset.tooltip = copy;
      button.removeAttribute("title");
      if (!button.getAttribute("aria-label") && !(button.textContent || "").trim()) {
        button.setAttribute("aria-label", copy);
      }
      var host = button.closest(".fw-tooltip-host");
      if (host) {
        host.tabIndex = button.disabled ? 0 : -1;
        host.dataset.tooltip = copy;
        host.setAttribute("aria-label", copy);
      }
    }

    function prepareAll(root) {
      if (root && root.matches && root.matches("button")) prepare(root);
      if (root && root.querySelectorAll) root.querySelectorAll("button").forEach(prepare);
    }

    function show(button) {
      if (!button) return;
      var liveButton = button.matches && button.matches(".fw-tooltip-host")
        ? button.querySelector("button")
        : button;
      var copy = (liveButton && liveButton.dataset.tooltip)
        || button.dataset.tooltip
        || getButtonTooltip(liveButton);
      if (!copy) return;
      activeButton = button;
      tooltip.textContent = copy;
      tooltip.classList.add("visible");
      tooltip.setAttribute("aria-hidden", "false");
      button.setAttribute("aria-describedby", tooltip.id);
      var rect = button.getBoundingClientRect();
      var gap = 9;
      var pad = 8;
      tooltip.style.left = "0px";
      tooltip.style.top = "0px";
      var tw = tooltip.offsetWidth;
      var th = tooltip.offsetHeight;
      var left = Math.max(pad, Math.min(window.innerWidth - tw - pad, rect.left + rect.width / 2 - tw / 2));
      var top = rect.top - th - gap;
      var placeBelow = top < pad;
      if (placeBelow) top = Math.min(window.innerHeight - th - pad, rect.bottom + gap);
      tooltip.classList.toggle("below", placeBelow);
      tooltip.style.left = Math.round(left) + "px";
      tooltip.style.top = Math.round(top) + "px";
    }

    function hide() {
      if (activeButton) activeButton.removeAttribute("aria-describedby");
      activeButton = null;
      tooltip.classList.remove("visible", "below");
      tooltip.setAttribute("aria-hidden", "true");
    }

    function resolveTarget(target) {
      if (!(target instanceof Element)) return null;
      if (target.matches("button")) return target;
      return target.closest("button") || target.closest(".fw-tooltip-host");
    }

    prepareAll(document);
    document.addEventListener("pointerover", function (e) { show(resolveTarget(e.target)); });
    document.addEventListener("pointerout", function (e) {
      var button = resolveTarget(e.target);
      if (button && !button.contains(e.relatedTarget)) hide();
    });
    document.addEventListener("focusin", function (e) { show(resolveTarget(e.target)); });
    document.addEventListener("focusout", function (e) { if (resolveTarget(e.target)) hide(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); });
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);

    var observer = new MutationObserver(function (records) {
      records.forEach(function (record) {
        record.addedNodes.forEach(function (node) { prepareAll(node); });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ==========================================================================
     Character count warning
     ========================================================================== */

  var SHARE_CHAR_LIMIT   = 400000;
  var SHARE_WARN_LIMIT   = 390000;
  var charCountEl        = document.getElementById("char-count");

  function updateCharCount() {
    if (!charCountEl) return;
    var len = editor.value.length;
    if (len >= SHARE_WARN_LIMIT) {
      charCountEl.textContent = len.toLocaleString() + " / " + SHARE_CHAR_LIMIT.toLocaleString() + " chars";
      charCountEl.classList.add("warning");
    } else {
      charCountEl.textContent = "";
      charCountEl.classList.remove("warning");
    }
    /* Disable share button at hard limit */
    if (btnShare) {
      btnShare.disabled = len >= SHARE_CHAR_LIMIT;
      btnShare.dataset.tooltip = len >= SHARE_CHAR_LIMIT
        ? "Document too large to share"
        : "Create a shareable URL";
    }
    var sbUrl = document.getElementById("sidebar-share-url");
    if (sbUrl) sbUrl.disabled = len >= SHARE_CHAR_LIMIT;
  }

  /* ==========================================================================
     Share via serverless API (Hastebin proxy)
     ========================================================================== */

  async function shareDocument() {
    var content = buildShareYaml() + editor.value;
    if (content.length > SHARE_CHAR_LIMIT) {
      showToast("Document too large to share. Try downloading instead.");
      return;
    }

    btnShare.disabled = true;
    showToast("Creating share link…");
    try {
      var res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: content
      });
      if (!res.ok) {
        var errData = await res.json().catch(function () { return {}; });
        if (errData.error === "too_large" || res.status === 413) {
          showToast("Document too large to share. Try downloading instead.");
          return;
        }
        throw new Error("HTTP " + res.status);
      }
      var data = await res.json();
      if (data.error) throw new Error(data.error);

      var shareUrl = window.location.origin + window.location.pathname + "?s=" + data.key;
      await navigator.clipboard.writeText(shareUrl);
      showToast("Link copied — available for up to 7 days");
    } catch (e) {
      showToast("Could not create a share link. Please try again.");
    } finally {
      updateCharCount(); /* re-evaluate disabled state */
    }
  }

  /* ==========================================================================
     Event binding
     ========================================================================== */

  function bindEvents() {
    /* --- Mobile drawer toggle --- */
    var drawerToggle = document.getElementById("mobile-hamburger");
    var drawerBackdrop = document.getElementById("drawer-backdrop");
    var appShell = document.getElementById("app-shell");

    function openDrawer() {
      appShell.classList.add("drawer-open");
      if (drawerToggle) drawerToggle.setAttribute("aria-expanded", "true");
    }
    function closeDrawer() {
      appShell.classList.remove("drawer-open");
      if (drawerToggle) {
        drawerToggle.setAttribute("aria-expanded", "false");
        drawerToggle.focus();
      }
    }

    if (drawerToggle) {
      drawerToggle.addEventListener("click", function () {
        if (appShell.classList.contains("drawer-open")) {
          closeDrawer();
        } else {
          openDrawer();
        }
      });
    }
    if (drawerBackdrop) {
      drawerBackdrop.addEventListener("click", closeDrawer);
    }

    /* Close drawer on Escape key */
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && appShell.classList.contains("drawer-open")) {
        closeDrawer();
      }
    });

    /* Close drawer when a sidebar action is taken (on narrow screens) */
    var sidebarEl = document.getElementById("sidebar");
    if (sidebarEl) {
      sidebarEl.addEventListener("click", function (e) {
        if (window.innerWidth < 760 && appShell.classList.contains("drawer-open")) {
          /* Only close if a real action happened (button, select, link) */
          if (e.target.closest("button, select, a, .load-btn")) {
            setTimeout(closeDrawer, 150);
          }
        }
      });
    }

    /* --- Logo reset --- */
    var appTitle = document.querySelector(".app-title");
    if (appTitle) {
      appTitle.style.cursor = "pointer";
      appTitle.title = "Reset to blank document";
      appTitle.addEventListener("click", function () {
        if (!confirm("This will clear your current document and reset all settings. Continue?")) return;
        editor.value = "";
        initialEditorContent = "";
        currentDocEngine = "none";
        setDocEngine(currentDocEngine);
        pageSize = "A4";
        orientation = "portrait";
        sizeStep = 0;
        weightStep = 0;
        lineStep = 0;
        comfortFont = "Inter";
        fontPickerLabel.textContent = "Inter";
        fontPickerLabel.style.fontFamily = '"Inter", system-ui, sans-serif';
        zoomStep = 100;
        zoomSlider.value = 100;
        zoomValue.textContent = "100%";
        applyZoom();
        contentWidth = 780;
        applyContentWidth();
        showFooter = false;
        mathMode = false;
        mathPromptDismissed = false;
        syncDocControlsUI();
        hideMathPrompt();
        suppressAutosave = false;
        mode = "edit";
        setMode("edit");
        scheduleAutosave();
        showToast("Document cleared");
      });
    }

    document.getElementById("mode-switch").addEventListener("click", function (e) {
      var label = e.target.closest(".mode-switch-label");
      if (label) {
        setMode(label.dataset.mode);
        requestAnimationFrame(checkToolbarOverflow);
      }
    });

    /* Sidebar Load events */
    btnLoadUrl.addEventListener("click", function () {
      loadFromUrlModal();
    });

    btnLoadLocal.addEventListener("click", function () {
      loadFileInput.value = "";
      loadFileInput.click();
    });

    loadFileInput.addEventListener("change", function () {
      var file = loadFileInput.files && loadFileInput.files[0];
      if (!file) return;
      // Route through the dispatcher: .md/.markdown/.txt go via
      // handleFileUpload (FileReader), everything else via the
      // /extract endpoint. Mirrors the drag-and-drop behavior.
      var route = window.FlatwriteExtractDrop
        ? window.FlatwriteExtractDrop.routeDroppedFile(file.name)
        : routeDroppedFileInline(file.name);
      if (route === "plain") {
        handleFileUpload(file);
      } else {
        handleExtractDrop(file);
      }
      // Reset the input so picking the same file again still fires
      // a change event (otherwise the second pick is silently dropped).
      loadFileInput.value = "";
    });

    /* Drag-and-drop import — routes .md/.txt to handleFileUpload, everything
       else to handleExtractDrop. See bindDropZone() and handleExtractDrop(). */
    bindDropZone();

    /* Width handle drag */
    function initWidthHandle(handle, side) {
      var dragging = false, startX, startEdge, wrap;

      handle.addEventListener("mousedown", function (e) {
        if (handle.dataset.mode === "dotted") return;

        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        startX = e.clientX;
        wrap = handle.parentElement;
        startEdge = (wrap.clientWidth - contentWidth) / 2;
        handle.classList.add("dragging");
        widthDragOverlay.classList.remove("hidden");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      });

      window.addEventListener("mousemove", function (e) {
        if (!dragging) return;
        e.preventDefault();
        var delta = e.clientX - startX;

        /* Free drag — derive contentWidth from cursor position */
        var wrapW = wrap.clientWidth;
        var newEdge;
        if (side === "right") {
          newEdge = startEdge - delta;
        } else {
          newEdge = startEdge + delta;
        }
        newEdge = Math.max(0, newEdge);
        var newWidth = Math.max(400, Math.min(1400, wrapW - 2 * newEdge));
        contentWidth = newWidth;
        applyContentWidth();
      });

      window.addEventListener("mouseup", function () {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove("dragging");
        widthDragOverlay.classList.add("hidden");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        scheduleAutosave();
      });
    }

    initWidthHandle(widthHandleLeft, "left");
    initWidthHandle(widthHandleRight, "right");

    window.addEventListener("resize", function () {
      if (mode === "preview" || mode === "read") positionWidthHandles();
      checkToolbarOverflow();
      syncExportActionsTop();
    });

    /* --- Toolbar scroll fade --- */
    var toolbarCenter = document.querySelector(".toolbar-center");
    function checkToolbarOverflow() {
      if (!toolbarCenter) return;
      if (toolbarCenter.scrollWidth > toolbarCenter.clientWidth + 2) {
        toolbarCenter.classList.remove("no-overflow");
      } else {
        toolbarCenter.classList.add("no-overflow");
      }
    }
    if (toolbarCenter) {
      requestAnimationFrame(checkToolbarOverflow);
    }

    /* Surface mode toggle (Doc | App) */
    var surfaceToggle = document.getElementById("surface-toggle");
    if (surfaceToggle) {
      surfaceToggle.addEventListener("click", function (e) {
        var btn = e.target.closest(".surface-btn");
        if (!btn || btn.classList.contains("active")) return;
        setSurfaceMode(btn.dataset.surface);
      });
    }

    /* App framework dropdown */
    var fwDropdownBtn = document.getElementById("fw-dropdown-btn");
    var fwDropdownList = document.getElementById("fw-dropdown-list");
    var fwDropdownLabel = document.getElementById("fw-dropdown-label");
    if (fwDropdownBtn && fwDropdownList) {
      fwDropdownBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        var isOpen = !fwDropdownList.classList.contains("hidden");
        fwDropdownList.classList.add("hidden");
        if (!isOpen) {
          var rect = fwDropdownBtn.getBoundingClientRect();
          fwDropdownList.style.left = rect.left + "px";
          fwDropdownList.style.top = (rect.bottom + 4) + "px";
          fwDropdownList.style.width = rect.width + "px";
          fwDropdownList.classList.remove("hidden");
        }
      });
      fwDropdownList.addEventListener("click", function (e) {
        var item = e.target.closest(".fw-dropdown-item");
        if (!item) return;
        currentAppFramework = item.dataset.fw;
        if (fwDropdownLabel) fwDropdownLabel.textContent = APP_FRAMEWORKS[currentAppFramework] ? APP_FRAMEWORKS[currentAppFramework].label : currentAppFramework;
        fwDropdownList.querySelectorAll(".fw-dropdown-item").forEach(function (el) {
          el.classList.toggle("selected", el.dataset.fw === currentAppFramework);
        });
        fwDropdownList.classList.add("hidden");
        scheduleAutosave();
        if (mode === "preview") renderPreview();
      });
      document.addEventListener("pointerdown", function (e) {
        if (!fwDropdownList.classList.contains("hidden")) {
          if (!fwDropdownList.contains(e.target) && !fwDropdownBtn.contains(e.target)) {
            fwDropdownList.classList.add("hidden");
          }
        }
      });
    }

    /* Component grid */
    var compGrid = document.getElementById("components-grid");
    if (compGrid) {
      compGrid.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-component]");
        if (!btn || btn.disabled) return;
        insertComponent(btn.dataset.component);
      });
    }

    /* Engine toggle */
    if (engineToggle) {
      engineToggle.addEventListener("click", function (e) {
        var btn = e.target.closest(".engine-btn");
        if (!btn || btn.classList.contains("active")) return;
        setDocEngine(btn.dataset.engine);
      });
    }

    /* Document controls */
    if (pageSizeSel) {
      pageSizeSel.addEventListener("change", function () {
        pageSize = this.value;
        scheduleAutosave();
        positionWidthHandles();
        if (mode === "preview" || mode === "read") renderPreview();
      });
    }
    if (pageMarginsLRSel) {
      pageMarginsLRSel.addEventListener("change", function () {
        pageMarginsLR = this.value;
        scheduleAutosave();
        positionWidthHandles();
        if (mode === "preview" || mode === "read") renderPreview();
      });
    }
    if (pageMarginsTBSel) {
      pageMarginsTBSel.addEventListener("change", function () {
        pageMarginsTB = this.value;
        scheduleAutosave();
        if (mode === "preview" || mode === "read") renderPreview();
      });
    }
    if (pageColumnsSel) {
      pageColumnsSel.addEventListener("change", function () {
        pageColumns = parseInt(this.value, 10) || 1;
        scheduleAutosave();
        if (mode === "preview" || mode === "read") renderPreview();
      });
    }
    if (toggleFooterBtn) {
      toggleFooterBtn.addEventListener("click", function () {
        showFooter = !showFooter;
        this.dataset.state = showFooter ? "on" : "off";
        this.textContent = showFooter ? "On" : "Off";
        this.setAttribute("aria-pressed", String(showFooter));
        scheduleAutosave();
        if (mode === "preview" || mode === "read") renderPreview();
      });
    }

    /* Math Mode toolbar toggle + one-shot load dialog */
    var btnMath = document.getElementById("btn-math");
    if (btnMath) {
      btnMath.addEventListener("click", function () {
        setMathMode(!mathMode);
      });
    }
    bindMathPromptDialog();
    syncMathModeUI();

    /* Orientation toggle */
    var orientBtn = document.getElementById("toggle-orient");
    if (orientBtn) {
      orientBtn.addEventListener("click", function () {
        orientation = orientation === "portrait" ? "landscape" : "portrait";
        this.dataset.state = orientation;
        this.textContent = orientation === "portrait" ? "Portrait" : "Landscape";
        scheduleAutosave();
        positionWidthHandles();
        if (mode === "preview" || mode === "read") renderPreview();
      });
    }

    btnExportMd.addEventListener("click", exportMarkdown);
    btnExportHtml.addEventListener("click", exportHTML);
    btnExportPdf.addEventListener("click", exportPDF);
    btnShare.addEventListener("click", shareDocument);

    /* Sidebar share buttons (mobile) */
    var sbMd   = document.getElementById("sidebar-export-md");
    var sbHtml = document.getElementById("sidebar-export-html");
    var sbPdf  = document.getElementById("sidebar-export-pdf");
    var sbUrl  = document.getElementById("sidebar-share-url");
    if (sbMd)   sbMd.addEventListener("click", exportMarkdown);
    if (sbHtml) sbHtml.addEventListener("click", exportHTML);
    if (sbPdf)  sbPdf.addEventListener("click", exportPDF);
    if (sbUrl)  sbUrl.addEventListener("click", shareDocument);

    editor.addEventListener("input", function () {
      suppressAutosave = false;
      scheduleAutosave();
      updateCharCount();
    });

    editor.addEventListener("keydown", function (e) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        var lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 24;
        var direction = e.key === "ArrowUp" ? -1 : 1;
        var scrollTopBefore = editor.scrollTop;
        requestAnimationFrame(function () {
          var delta = editor.scrollTop - scrollTopBefore;
          if (Math.abs(delta) > lineHeight * 1.5) {
            editor.scrollTop = scrollTopBefore + direction * lineHeight;
          }
        });
      }
    });

    fontPicker.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!fontPickerList) return;
      var isOpen = !fontPickerList.classList.contains("hidden");
      fontPickerList.classList.add("hidden");
      if (!isOpen) {
        loadComfortFonts();
        var zoom = zoomStep / 100;
        var rect = fontPicker.getBoundingClientRect();
        fontPickerList.style.left = (rect.left / zoom) + "px";
        fontPickerList.style.top = ((rect.bottom / zoom) + 4) + "px";
        fontPickerList.style.width = (rect.width / zoom) + "px";
        fontPickerList.classList.remove("hidden");
      }
    });

    function closeFontDropdown() {
      if (fontPickerList && !fontPickerList.classList.contains("hidden")) {
        fontPickerList.classList.add("hidden");
      }
    }

    function maybeCloseFontDropdown(e) {
      if (!fontPickerList) return;
      if (fontPickerList.classList.contains("hidden")) return;
      if (fontPickerList.contains(e.target)) return;
      if (fontPicker.contains(e.target)) return;
      fontPickerList.classList.add("hidden");
    }

    document.addEventListener("pointerdown", maybeCloseFontDropdown);
    document.addEventListener("click", maybeCloseFontDropdown);

    fontPickerList.addEventListener("click", function (e) {
      var item = e.target.closest(".font-dropdown-item");
      if (!item) return;
      comfortFont = item.dataset.font;
      fontPickerLabel.textContent = comfortFont;
      fontPickerLabel.style.fontFamily = '"' + comfortFont + '", system-ui, sans-serif';
      fontPickerList.querySelectorAll(".font-dropdown-item").forEach(function (el) {
        el.classList.toggle("selected", el.dataset.font === comfortFont);
      });
      fontPickerList.classList.add("hidden");
      scheduleAutosave();
      if (mode === "preview") renderPreview();
    });

    sizeUpBtn.addEventListener("click", function () {
      if (sizeStep < SIZE_MAX) { sizeStep++; scheduleAutosave(); if (mode === "preview") renderPreview(); }
    });
    sizeDownBtn.addEventListener("click", function () {
      if (sizeStep > SIZE_MIN) { sizeStep--; scheduleAutosave(); if (mode === "preview") renderPreview(); }
    });
    weightUpBtn.addEventListener("click", function () {
      if (weightStep < WEIGHT_MAX) { weightStep++; scheduleAutosave(); if (mode === "preview") renderPreview(); }
    });
    weightDownBtn.addEventListener("click", function () {
      if (weightStep > WEIGHT_MIN) { weightStep--; scheduleAutosave(); if (mode === "preview") renderPreview(); }
    });
    lineUpBtn.addEventListener("click", function () {
      if (lineStep < LINE_MAX) { lineStep++; scheduleAutosave(); if (mode === "preview") renderPreview(); }
    });
    lineDownBtn.addEventListener("click", function () {
      if (lineStep > LINE_MIN) { lineStep--; scheduleAutosave(); if (mode === "preview") renderPreview(); }
    });

    zoomSlider.addEventListener("input", function () {
      zoomStep = parseInt(this.value, 10);
      zoomValue.textContent = zoomStep + "%";
      scheduleAutosave();
      applyZoom();
    });
    zoomSlider.addEventListener("dblclick", function () {
      zoomStep = 100;
      this.value = 100;
      zoomValue.textContent = "100%";
      scheduleAutosave();
      applyZoom();
    });

    mdToolbar.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-md]");
      if (btn) applyMarkdownFormat(btn.dataset.md);
    });

    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        /* A modal's own handler owns Escape while it is open — the load
           modal stops propagation, but guard here too so we never both
           close a dialog AND change editor mode on one keypress. */
        var loadOverlay = document.getElementById("load-modal-overlay");
        var compOverlay = document.getElementById("comp-modal-overlay");
        var mathOverlay = document.getElementById("math-modal-overlay");
        if (mathOverlay && !mathOverlay.classList.contains("hidden")) {
          e.preventDefault();
          mathPromptDismissed = true;
          hideMathPrompt();
          return;
        }
        if ((loadOverlay && !loadOverlay.classList.contains("hidden"))
            || (compOverlay && !compOverlay.classList.contains("hidden"))
            || appShell.classList.contains("drawer-open")) {
          return;
        }
        if (mode === "read") {
          /* Read → View > Plain */
          e.preventDefault();
          setMode("preview");
          setDocEngine("none");
        } else if (mode === "preview") {
          e.preventDefault();
          setMode("edit");
        }
        /* In edit mode with no dialog open, let Escape do its default. */
        return;
      }
      var mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "b" || e.key === "B") { e.preventDefault(); setMode(mode === "edit" ? "preview" : "edit"); }
      if (e.key === "e" || e.key === "E") { e.preventDefault(); exportMarkdown(); }
    });

    /* postMessage listener — receives scroll position from sandboxed iframe */
    window.addEventListener("message", function (e) {
      if (e.source !== previewFrame.contentWindow && e.source !== previewFrameNext.contentWindow) return;
      if (e.data && (e.data.type === "paged-error" || e.data.type === "vivl-error")) {
        onPreviewFrameError(e);
      }
      if (e.data && e.data.type === "scroll") {
        lastScrollRatio = e.data.ratio;
      }
      if (e.data && e.data.type === "iframe-pointerdown") {
        closeFontDropdown();
      }
      if (e.data && e.data.type === "vivl-ready") {
        positionWidthHandles();
        onPreviewFrameReady(e);
      }
      if (e.data && e.data.type === "paged-ready") {
        positionWidthHandles();
        onPreviewFrameReady(e);
      }
      if (e.data && e.data.type === "zoomChanged") {
        positionWidthHandles();
      }
      if (e.data && e.data.type === "dropped-files" && e.data.files && e.data.files.length) {
        processDroppedFile(e.data.files[0]);
      }
      if (e.data && e.data.type === "dblclick" && mode === "preview") {
        setMode("edit");
        editor.focus();
        var md = editor.value;
        var word = e.data.word || "";
        var ctx = e.data.ctx || "";
        var pos = -1;
        var mdLow = md.toLowerCase();
        var wordLow = word.toLowerCase();

        if (ctx && wordLow.length >= 2) {
          var ctxLow = ctx.toLowerCase();
          var ctxIdx = mdLow.indexOf(ctxLow);
          if (ctxIdx !== -1) {
            var searchFrom = ctxIdx + ctxLow.length;
            var wIdx = mdLow.indexOf(wordLow, searchFrom);
            if (wIdx !== -1 && wIdx < searchFrom + 80) {
              pos = wIdx;
            }
          }
          if (pos === -1) {
            var words = ctxLow.split(/\s+/).filter(function (w) { return w.length > 3; });
            for (var k = 0; k < words.length && pos === -1; k++) {
              var wIdx2 = mdLow.indexOf(words[k]);
              if (wIdx2 !== -1) {
                var wIdx3 = mdLow.indexOf(wordLow, wIdx2);
                if (wIdx3 !== -1 && wIdx3 < wIdx2 + 120) {
                  pos = wIdx3;
                }
              }
            }
          }
        }

        if (pos === -1 && wordLow.length >= 2) {
          pos = mdLow.indexOf(wordLow);
        }

        if (pos !== -1) {
          editor.setSelectionRange(pos, pos + word.length);
          var lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 24;
          var linesBefore = md.substring(0, pos).split("\n").length;
          editor.scrollTop = Math.max(0, (linesBefore - 5) * lineHeight);
        }
      }
    });

    bindAssistUi();
  }

  /* ==========================================================================
     UI Zoom
     ========================================================================== */

  function applyZoom() {
    var frame = document.getElementById("preview-frame");
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "setZoom", zoom: zoomStep / 100 }, "*");
    }
  }

  function applyContentWidth() {
    /* Update content width inside the iframe dynamically */
    if (previewFrame.contentWindow) {
      previewFrame.contentWindow.postMessage({type: "setContentWidth", width: contentWidth}, "*");
    }
    positionWidthHandles();
  }

  /* ==========================================================================
     Surface mode toggle (Doc | App)
     ========================================================================== */

  function setSurfaceMode(sm) {
    if (sm !== "doc" && sm !== "app") sm = "doc";
    surfaceMode = sm;
    var appShell = document.querySelector(".app-shell");
    if (appShell) {
      appShell.classList.remove("surface-doc", "surface-app");
      appShell.classList.add("surface-" + sm);
    }
    var toggle = document.getElementById("surface-toggle");
    if (toggle) {
      toggle.className = "surface-toggle " + sm;
      var btns = toggle.querySelectorAll(".surface-btn");
      for (var i = 0; i < btns.length; i++) {
        var active = btns[i].dataset.surface === sm;
        btns[i].classList.toggle("active", active);
        btns[i].setAttribute("aria-pressed", String(active));
      }
    }
    scheduleAutosave();
    if (mode === "preview" || mode === "read") renderPreview();
  }

  /* ==========================================================================
     Document engine selector
     ========================================================================== */

  function setDocEngine(engineKey) {
    if (!DOC_ENGINES[engineKey]) engineKey = "none";
    currentDocEngine = engineKey;
    /* Update toggle UI */
    if (engineToggle) {
      engineToggle.className = "engine-toggle " + engineKey;
      var btns = engineToggle.querySelectorAll(".engine-btn");
      btns.forEach(function (btn) {
        var active = btn.dataset.engine === engineKey;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
    }
    /* Update app-shell engine class */
    var appShell = document.querySelector(".app-shell");
    if (appShell) {
      appShell.classList.remove("engine-pagedjs", "engine-vivliostyle", "engine-none");
      appShell.classList.add("engine-" + engineKey);
    }
    /* Disable PDF export in Plain mode, while keeping its wrapper available
       to surface a useful tooltip for mouse and keyboard users. */
    var btnPdf = document.getElementById("btn-export-pdf");
    var pdfTooltip = engineKey === "none"
      ? "Switch to Paged.js or Vivliostyle to enable PDF export"
      : "Open the paginated document for PDF printing";
    if (btnPdf) {
      btnPdf.disabled = (engineKey === "none");
      btnPdf.dataset.tooltip = pdfTooltip;
      var btnPdfHost = btnPdf.closest(".fw-tooltip-host");
      if (btnPdfHost) {
        btnPdfHost.tabIndex = btnPdf.disabled ? 0 : -1;
        btnPdfHost.dataset.tooltip = pdfTooltip;
        btnPdfHost.setAttribute("aria-label", pdfTooltip);
      }
    }
    var sbPdf = document.getElementById("sidebar-export-pdf");
    if (sbPdf) {
      sbPdf.disabled = (engineKey === "none");
      sbPdf.dataset.tooltip = pdfTooltip;
      var sbPdfHost = sbPdf.closest(".fw-tooltip-host");
      if (sbPdfHost) {
        sbPdfHost.tabIndex = sbPdf.disabled ? 0 : -1;
        sbPdfHost.dataset.tooltip = pdfTooltip;
        sbPdfHost.setAttribute("aria-label", pdfTooltip);
      }
    }
    /* Reset zoom to 100% in Plain mode — zoom is WYSIWYG-irrelevant there */
    if (engineKey === "none" && zoomStep !== 100) {
      zoomStep = 100;
      zoomSlider.value = 100;
      zoomValue.textContent = "100%";
      applyZoom();
    }
    updateDocControlStates();
    scheduleAutosave();
    if (mode === "preview" || mode === "read") renderPreview();
  }

  /* Per-engine control states:
     Plain       → all disabled
     Paged.js    → all enabled
     Vivliostyle → all enabled */
  var DOC_CONTROL_IDS = ["page-size", "toggle-orient", "page-margins-lr", "page-margins-tb", "page-columns", "toggle-footer"];
  var PAGEDJS_DISABLED = {};

  function updateDocControlStates() {
    var allDisabled = (currentDocEngine === "none");
    for (var i = 0; i < DOC_CONTROL_IDS.length; i++) {
      var id = DOC_CONTROL_IDS[i];
      var el = document.getElementById(id);
      if (!el) continue;
      var row = el.closest(".doc-control-row");
      var disabled = allDisabled || PAGEDJS_DISABLED[id] || false;
      el.disabled = disabled;
      if (row) row.classList.toggle("doc-control-disabled", disabled);
    }
  }

  /* ==========================================================================
     buildPageCSS — assemble @page + layout rules from current controls
     ========================================================================== */

  var PAGE_SIZES = {
    A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420],
    A4: [210, 297], A5: [148, 210],
    Letter: [215.9, 279.4], Legal: [215.9, 355.6]
  };
  var PAGE_SIZE_KEYS = ["A0", "A1", "A2", "A3", "A4", "A5", "Letter", "Legal"];
  var MARGIN_MAP = { narrow: "10mm", normal: "20mm", wide: "30mm" };
  /* Footer content has exactly one owner per engine. Paged.js keeps the DOM
     path because its generated margin content must survive a static print
     snapshot; Vivliostyle owns its footer through CSS Paged Media. */
  var FOOTER_OWNERS = { pagedjs: "dom", vivliostyle: "css", none: "none" };

  function getPageCSS() {
    var dims = PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
    var w = orientation === "landscape" ? dims[1] : dims[0];
    var h = orientation === "landscape" ? dims[0] : dims[1];
    return w + "mm " + h + "mm";
  }

  function getPageWidthPx() {
    var dims = PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
    var wMm = orientation === "landscape" ? dims[1] : dims[0];
    return Math.round(wMm * 3.78);
  }

  function getPageHeightPx() {
    var dims = PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
    var hMm = orientation === "landscape" ? dims[0] : dims[1];
    return Math.round(hMm * 3.78);
  }

  function getContentWidthPx() {
    var dims = PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
    var wMm = orientation === "landscape" ? dims[1] : dims[0];
    var lrMm = parseFloat(MARGIN_MAP[pageMarginsLR] || MARGIN_MAP.normal);
    return Math.round((wMm - lrMm * 2) * 3.78);
  }

  function buildPageCSS() {
    var size = getPageCSS();
    var lrMm = MARGIN_MAP[pageMarginsLR] || MARGIN_MAP.normal;
    var tbMm = MARGIN_MAP[pageMarginsTB] || MARGIN_MAP.normal;
    var css = '@page { size: ' + size + '; margin: ' + tbMm + ' ' + lrMm + '; }';
    if (pageColumns > 1) {
      var marginMm = parseFloat(lrMm);
      var gap = (marginMm / 2) + 'mm';
      /* Default to one column when a renderer does not implement CSS
         Multi-column Layout. Paged.js and Vivliostyle opt into the requested
         layout only when they advertise support. */
      css += ' .fw-column-flow { column-count: 1; }';
      css += ' @supports (column-count: 2) { .fw-column-flow { column-count: ' + pageColumns + '; column-gap: ' + gap + '; column-fill: balance; }';
      css += ' .fw-column-flow > h1, .fw-column-flow > h2, .fw-column-flow > h3, .fw-column-flow > h4, .fw-column-flow > pre, .fw-column-flow > table, .fw-column-flow > blockquote, .fw-column-flow > figure { break-inside: avoid; } }';
    }
    /* Footer text is injected directly into the margin-box DOM via
       _applyFooterContent. We deliberately do not rely on the CSS-driven
       path (chapter running heading via string() / counter(page)/counter
       (pages)). Two reasons, both reproducible in the field:
         (a) Paged.js renders the same string twice — once as a ::after
             pseudo-element on .pagedjs_margin-content and again from our
             DOM textContent assignment. Every page shows the chapter title
             twice in the bottom-left.
         (b) counter(page)/counter(pages) only resolve when Paged.js /
             Vivliostyle actively paginate. The print snapshot is emitted
             as static HTML for window.print(), where counters stay at 0
             and the page-count footer breaks the layout (pages counted as
             zero ⇒ margin boxes collapse ⇒ body overflows ⇒ "gross
             misalignment").
       Sole owner of footer content: _applyFooterContent (writes real DOM
       text nodes, resolves the total from the committed page list). */
    return css;
  }

  /* Escape a string for safe interpolation into a CSS `content: "..."`
     value that lives inside an inline <style> element. Beyond the usual
     CSS string escaping (backslash, double-quote, newline), this also
     neutralizes `<` and `&` using CSS numeric escapes so a user-authored
     chapter title containing `</style>` (or an HTML entity) can never
     terminate the style element or inject markup. `\3C ` is `<` and
     `\26 ` is `&`; the trailing space terminates the CSS escape. */
  function escapeCssStringForStyleElement(value) {
    return String(value == null ? "" : value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/</g, "\\3C ")
      .replace(/&/g, "\\26 ")
      .replace(/\r?\n/g, " ");
  }

  function buildFooterCSS(engineKey, chapterTitle) {
    if (FOOTER_OWNERS[engineKey] !== "css") return "";
    if (!showFooter) {
      return '@page { @bottom-left { content: none; } @bottom-right { content: none; } }';
    }
    var safeChapter = escapeCssStringForStyleElement(chapterTitle);
    return '@page {'
      + ' @bottom-left { content: "' + safeChapter + '"; font-size: 8px; color: #666; vertical-align: middle; }'
      + ' @bottom-right { content: "Page " counter(page) " of " counter(pages); font-size: 8px; color: #666; vertical-align: middle; }'
      + ' }';
  }

  function syncDocumentSettingsFromControls() {
    var nextPageSize = pageSizeSel ? pageSizeSel.value : pageSize;
    var orientBtn = document.getElementById("toggle-orient");
    var nextOrientation = orientBtn ? orientBtn.dataset.state : orientation;
    var nextMarginsLR = pageMarginsLRSel ? pageMarginsLRSel.value : pageMarginsLR;
    var nextMarginsTB = pageMarginsTBSel ? pageMarginsTBSel.value : pageMarginsTB;
    var nextColumns = pageColumnsSel ? parseInt(pageColumnsSel.value, 10) : pageColumns;
    var nextFooter = toggleFooterBtn ? toggleFooterBtn.dataset.state === "on" : showFooter;

    if (!PAGE_SIZES[nextPageSize]
        || (nextOrientation !== "portrait" && nextOrientation !== "landscape")
        || !MARGIN_MAP[nextMarginsLR]
        || !MARGIN_MAP[nextMarginsTB]
        || nextColumns < 1 || nextColumns > 3) {
      showToast("Check the document setup before exporting");
      return false;
    }

    pageSize = nextPageSize;
    orientation = nextOrientation;
    pageMarginsLR = nextMarginsLR;
    pageMarginsTB = nextMarginsTB;
    pageColumns = nextColumns;
    showFooter = nextFooter;
    return true;
  }

  function buildDocumentCSS(renderEngineKey) {
    var scale = SIZE_SCALE[String(sizeStep)] || 1;
    var weight = WEIGHT_MAP[String(weightStep)] || 400;
    var lineHeight = LINE_SCALE[String(lineStep)] || 1.75;
    var fontStack = "'" + comfortFont + "', system-ui, sans-serif";
    var headWeight = Math.min(weight + 200, 900);
    return (renderEngineKey === "none" ? "" : buildPageCSS())
      + '*, *::before, *::after { font-family: ' + fontStack + ' !important; box-sizing: border-box; }'
      + 'body { font-size: ' + (15 * scale) + 'px !important; font-weight: ' + weight + ' !important; line-height: ' + lineHeight + ' !important; color: #2d2a3e; margin: 0; overflow-x: hidden; }'
      + 'html { height: 100%; }'
      + 'h1,h2,h3,h4,h5,h6 { font-weight: ' + headWeight + ' !important; overflow-wrap: break-word; word-break: break-word; }'
      + 'h1 { font-size: ' + (15 * scale * 2) + 'px !important; }'
      + 'h2 { font-size: ' + (15 * scale * 1.5) + 'px !important; margin-top: 1.8em !important; }'
      + 'h3 { font-size: ' + (15 * scale * 1.25) + 'px !important; margin-top: 1.4em !important; }'
      + 'h4 { font-size: ' + (15 * scale * 1.1) + 'px !important; }'
      + 'img { max-width: 100%; height: auto; display: block; }'
      + 'pre, code { font-family: "JetBrains Mono", monospace !important; }'
      + 'pre { overflow-x: auto; word-wrap: break-word; white-space: pre-wrap; }'
      + 'table { border-collapse: collapse; table-layout: fixed; width: 100%; }'
      + 'th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; word-wrap: break-word; overflow-wrap: break-word; max-width: 100%; }'
      + 'thead th { background: #333333; color: #fff; }'
      + 'tbody tr:nth-child(even) { background: #f2f2f2; } tbody tr:nth-child(odd) { background: #ffffff; }'
      + 'blockquote { margin: 0; padding: 0 1em; border-left: 3px solid #ccc; }'
      + 'ul, ol { padding-left: 1.8em; margin: 0.2em 0; list-style-position: outside; }'
      + 'li { margin: 0.15em 0; display: list-item; } li > ul, li > ol { margin: 0.15em 0; padding-left: 2em; }'
      + 'li:has(> input[type="checkbox"]), .task-list-item { list-style: none; }'
      + 'li:has(> input[type="checkbox"])::marker, .task-list-item::marker { display: none; }'
      + 'input[type="checkbox"] { margin: 0 0.4em 0 0; vertical-align: middle; }'
      + 'ul { list-style-type: disc; } ul ul { list-style-type: circle; } ul ul ul { list-style-type: disc; } ul ul ul ul { list-style-type: circle; }'
      + 'p { margin: 0.4em 0; } br { margin: 0.3em 0; }'
      + '.fw-pdf-break { display: block; height: calc(var(--fw-break-lines, 1) * 1lh); break-inside: avoid; }';
  }

  /**
   * Build the diagonal-stripe background CSS used in View/Preview mode
   * (the "draft paper" effect behind page content). The previous
   * implementation used `repeating-linear-gradient` with hard 16px
   * grey/white stops, which produced visible horizontal seams at
   * each tile boundary (browser sub-pixel rounding at the gradient
   * wrap — visible as faint horizontal lines every ~32px on tall
   * documents).
   *
   * This version uses a single non-repeating `linear-gradient` with
   * explicit stop pairs that draw the stripes as ONE continuous
   * gradient. No tile boundary, no seams, stripes continue "until
   * infinity" within the iframe. Stripe thickness scales with
   * iframe height (the gradient stretches to fill 100% of the
   * element in both axes), giving ~30-40 stripes per typical 1280px
   * viewport — close to the old 16px stripe density.
   *
   * Colors match the original `#f0f0f0` / `#ffffff` palette.
   */
  function stripePlaceholderCss() {
    var n = 40; // total stripes (must be even: half grey, half white)
    var step = 100 / n; // percentage width of one stripe
    var stops = '';
    for (var i = 0; i < n; i++) {
      var color = (i % 2 === 0) ? '#f0f0f0' : '#ffffff';
      var start = (i * step).toFixed(4);
      var end = ((i + 1) * step).toFixed(4);
      stops += ', ' + color + ' ' + start + '%' + ', ' + color + ' ' + end + '%';
    }
    return 'html { background: linear-gradient(45deg' + stops + ') fixed !important; background-size: 100% 100%; }';
  }

  /**
   * CSS reset + transparent body used by the Vivliostyle iframe
   * sandbox so the stripe placeholder background shows through to
   * the page area.
   */
  function htmlResetCss() {
    return 'html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; } '
      + 'body, #vivl-viewport { background: transparent !important; } ';
  }

  function syncDocControlsUI() {
    if (pageSizeSel)     pageSizeSel.value = pageSize;
    var orientBtn = document.getElementById("toggle-orient");
    if (orientBtn) {
      orientBtn.dataset.state = orientation;
      orientBtn.textContent = orientation === "portrait" ? "Portrait" : "Landscape";
    }
    if (pageMarginsLRSel) pageMarginsLRSel.value = pageMarginsLR;
    if (pageMarginsTBSel) pageMarginsTBSel.value = pageMarginsTB;
    if (pageColumnsSel)  pageColumnsSel.value = String(pageColumns);
    if (toggleFooterBtn) {
      toggleFooterBtn.dataset.state = showFooter ? "on" : "off";
      toggleFooterBtn.textContent = showFooter ? "On" : "Off";
      toggleFooterBtn.setAttribute("aria-pressed", String(showFooter));
    }
    syncMathModeUI();
  }

  function syncMathModeUI() {
    var btn = document.getElementById("btn-math");
    if (btn) {
      btn.classList.toggle("is-active", !!mathMode);
      btn.setAttribute("aria-pressed", String(!!mathMode));
      btn.dataset.state = mathMode ? "on" : "off";
      btn.title = mathMode ? "Math Mode on — click to disable" : "Math Mode off — click to enable KaTeX";
    }
    if (mathMode) hideMathPrompt();
  }

  function hideMathPrompt() {
    var overlay = document.getElementById("math-modal-overlay");
    if (overlay) overlay.classList.add("hidden");
  }

  function showMathPrompt() {
    if (mathMode || mathPromptDismissed) return;
    var overlay = document.getElementById("math-modal-overlay");
    if (!overlay) return;
    overlay.classList.remove("hidden");
    var enableBtn = document.getElementById("math-modal-enable");
    if (enableBtn) enableBtn.focus();
  }

  /**
   * One-shot Math Mode prompt when a *new document is loaded* (share, IDB
   * restore, URL import, file drop). Never on keystroke or autosave.
   * Cheap delimiter heuristic only — no full marked parse.
   */
  function maybePromptMathMode(body) {
    if (mathMode || mathPromptDismissed) {
      hideMathPrompt();
      return;
    }
    var src = body != null ? body : (editor && editor.value) || "";
    src = stripYamlFrontMatter(src);
    var hit = false;
    if (window.FlatWriteMath && typeof FlatWriteMath.hasMathHeuristic === "function") {
      hit = FlatWriteMath.hasMathHeuristic(src);
    }
    if (hit) showMathPrompt();
    else hideMathPrompt();
  }

  function bindMathPromptDialog() {
    var overlay = document.getElementById("math-modal-overlay");
    if (!overlay || overlay.dataset.bound === "1") return;
    overlay.dataset.bound = "1";

    function dismiss() {
      mathPromptDismissed = true;
      hideMathPrompt();
    }

    var enableBtn = document.getElementById("math-modal-enable");
    var dismissBtn = document.getElementById("math-modal-dismiss");
    var closeBtn = document.getElementById("math-modal-close");
    if (enableBtn) {
      enableBtn.addEventListener("click", function () {
        mathPromptDismissed = true;
        hideMathPrompt();
        setMathMode(true);
      });
    }
    if (dismissBtn) dismissBtn.addEventListener("click", dismiss);
    if (closeBtn) closeBtn.addEventListener("click", dismiss);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) dismiss();
    });
  }

  function setMathMode(on, opts) {
    opts = opts || {};
    var next = !!on;
    if (mathMode === next && !opts.force) {
      syncMathModeUI();
      return;
    }
    mathMode = next;
    if (mathMode) {
      mathPromptDismissed = true;
      hideMathPrompt();
    }
    syncMathModeUI();
    if (!opts.skipSave) scheduleAutosave();
    if (!opts.skipRender && (mode === "preview" || mode === "read")) renderPreview();
  }

  function positionWidthHandles() {
    var frame = document.getElementById("preview-frame");
    var hLeft = document.getElementById("width-handle-left");
    var hRight = document.getElementById("width-handle-right");
    if (!frame || !hLeft || !hRight) return;
    /* Read mode is distraction-free — no handles */
    if (mode === "read") return;
    var wrap = frame.parentElement;
    var wrapW = wrap.clientWidth;

    /* Determine effective width based on engine (Read mode always renders as Plain) */
    var effectiveEngineKey = (mode === "read") ? "none" : currentDocEngine;
    var engine = DOC_ENGINES[effectiveEngineKey] || DOC_ENGINES.none;
    var effectiveWidth;
    var isDotted = false;

    if (surfaceMode === "doc" && effectiveEngineKey !== "none") {
      /* Paged.js & Vivliostyle: non-interactive dashed lines at the actual rendered page edges */
      var edge = 0;
      try {
        var iframeDoc = frame.contentDocument;
        var pageEl = effectiveEngineKey === "vivliostyle"
          ? iframeDoc.querySelector("[data-vivliostyle-page-container]")
          : iframeDoc.querySelector(".pagedjs_page");
        if (pageEl) {
          var frameRect = frame.getBoundingClientRect();
          var pageRect = pageEl.getBoundingClientRect();
          var scaledW = pageRect.width;
          edge = Math.max(0, (wrapW - scaledW) / 2);
        }
      } catch (e) {
        edge = 0;
      }
      if (edge === 0) {
        var pageW = getPageWidthPx();
        var pageH = getPageHeightPx();
        var iframeW = wrapW;
        var iframeH = frame.clientHeight || 600;
        var s = Math.min(iframeW / pageW, iframeH / pageH);
        if (orientation === "landscape") s *= 0.92;
        edge = Math.max(0, (wrapW - pageW * s) / 2);
      }

      hLeft.style.left = edge + "px";
      hLeft.style.right = "auto";
      hRight.style.right = edge + "px";
      hRight.style.left = "auto";

      hLeft.style.display = "none";
      hRight.style.display = "none";
      return;
    } else {
      effectiveWidth = contentWidth * (zoomStep / 100);
    }

    var edge = Math.max(0, (wrapW - effectiveWidth) / 2);
    hLeft.style.left = edge + "px";
    hLeft.style.right = "auto";
    hRight.style.right = edge + "px";
    hRight.style.left = "auto";

    hLeft.style.display = "";
    hRight.style.display = "";
    hLeft.classList.remove("width-handle-dotted");
    hRight.classList.remove("width-handle-dotted");
    hLeft.dataset.mode = "free";
    hRight.dataset.mode = "free";
  }

  /* ==========================================================================
     Preview rendering
     ========================================================================== */

  function savePreviewScroll() {
    /* Scroll ratio is kept current by postMessage from the sandboxed iframe.
       No direct contentDocument access needed. */
  }

  function renderPreview() {
    /* Compute sanitized fragment first, then (when Math Mode is ON) pre-render
       KaTeX to static HTML before any engine pagination / iframe commit. */
    var isApp = surfaceMode === "app";
    var renderEngineKey = isApp ? null : ((mode === "read") ? "none" : (currentDocEngine || "none"));
    var contentForRender = isApp
      ? stripYamlFrontMatter(editor.value || "")
      : applyFlatWritePdfBreaks(stripYamlFrontMatter(editor.value || ""), renderEngineKey);
    var rawHTML = renderToFragment(contentForRender);
    var renderedHTML = sanitizeHTML(resolveRelativeUrls(rawHTML));
    finalizeMathHtml(renderedHTML).then(function (finalHTML) {
      _commitPreviewHtml(finalHTML, isApp, renderEngineKey);
    });
  }

  function _commitPreviewHtml(renderedHTML, isApp, renderEngineKey) {
    /* === App Surface: Framework CSS preview === */
    if (isApp) {
      var fw = APP_FRAMEWORKS[currentAppFramework];
      var scale = SIZE_SCALE[String(sizeStep)] || 1;
      var weight = WEIGHT_MAP[String(weightStep)] || 400;
      var lineHeight = LINE_SCALE[String(lineStep)] || 1.75;
      var fontStack = "'" + comfortFont + "', system-ui, sans-serif";
      var headWeight = Math.min(weight + 200, 900);
      var scrollRatio = lastScrollRatio;

      /* Load framework CSS */
      var fwCssLinks = "";
      if (fw && fw.css) {
        var cssArr = typeof fw.css === "string" ? [fw.css] : fw.css;
        for (var ci = 0; ci < cssArr.length; ci++) {
          fwCssLinks += '<link rel="stylesheet" href="' + cssArr[ci] + '">';
        }
      }
      var fwJsTag = (fw && fw.js) ? '<script src="' + fw.js + '" defer><' + '/script>' : "";

      /* Build framework style CSS */
      var fwStyle = "";
      if (fw && typeof fw.style === "function") {
        fwStyle = fw.style("");
      }

      var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
        + '<base target="_blank" rel="noopener noreferrer">'
        + fwCssLinks
        + fwJsTag
        + mathHeadAssets()
        + '<style>'
        + fwStyle
        + mathBodyCss()
        + '*, *::before, *::after { font-family: ' + fontStack + ' !important; box-sizing: border-box; }'
        + 'body { font-size: ' + (15 * scale) + 'px !important;'
        + ' font-weight: ' + weight + ' !important;'
        + ' line-height: ' + lineHeight + ' !important; color: #2d2a3e;'
        + ' max-width: ' + contentWidth + 'px; margin: 2rem auto; padding: 0 1.5rem;'
        + ' overflow-x: hidden; }'
        + 'html::-webkit-scrollbar { display: none; }'
        + 'html { scrollbar-width: none; -ms-overflow-style: none; }'
        + 'h1,h2,h3,h4,h5,h6 { font-weight: ' + headWeight + ' !important; }'
        + 'h1 { font-size: ' + (15 * scale * 2) + 'px !important; }'
        + 'h2 { font-size: ' + (15 * scale * 1.5) + 'px !important; margin-top: 1.8em !important; }'
        + 'h3 { font-size: ' + (15 * scale * 1.25) + 'px !important; margin-top: 1.4em !important; }'
        + 'h4 { font-size: ' + (15 * scale * 1.1) + 'px !important; }'
        + 'img { max-width: 100%; height: auto; display: block; }'
        + 'pre, code { font-family: "JetBrains Mono", monospace !important; }'
        + 'pre { overflow-x: auto; word-wrap: break-word; white-space: pre-wrap; }'
        + 'table { border-collapse: collapse; width: 100%; }'
        + 'th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; word-wrap: break-word; overflow-wrap: break-word; max-width: 100%; }'
        + 'thead th { background: #333333; color: #fff; }'
        + 'tbody tr:nth-child(even) { background: #f2f2f2; }'
        + 'tbody tr:nth-child(odd) { background: #ffffff; }'
        + 'blockquote { margin: 0; padding: 0 1em; border-left: 3px solid #ccc; }'
        + 'ul, ol { padding-left: 1.8em; margin: 0.2em 0; list-style-position: outside; }'
        + 'li { margin: 0.15em 0; display: list-item; }'
        + 'li > ul, li > ol { margin: 0.15em 0; padding-left: 2em; }'
        + 'li:has(> input[type="checkbox"]) { list-style: none; }'
        + 'li:has(> input[type="checkbox"])::marker { display: none; }'
        + '.task-list-item { list-style: none; }'
        + '.task-list-item::marker { display: none; }'
        + 'input[type="checkbox"] { margin: 0 0.4em 0 0; vertical-align: middle; }'
        + 'ul { list-style-type: disc; }'
        + 'ul ul { list-style-type: circle; }'
        + 'ul ul ul { list-style-type: disc; }'
        + 'ul ul ul ul { list-style-type: circle; }'
        + 'p { margin: 0.4em 0; }'
        + '</style>'
        + '</head><body><main>' + renderedHTML + '</main>'
        + '<script>'
        + 'var _scrollRatio = ' + scrollRatio + ';'
        + 'var _max = document.documentElement.scrollHeight - window.innerHeight;'
        + 'if (_max > 0) window.scrollTo(0, Math.round(_scrollRatio * _max));'
        + 'var _scrollTimer;'
        + 'window.addEventListener("scroll", function(){'
        + '  clearTimeout(_scrollTimer);'
        + '  _scrollTimer = setTimeout(function(){'
        + '    var m = document.documentElement.scrollHeight - window.innerHeight;'
        + '    var r = m > 0 ? window.scrollY / m : 0;'
        + '    parent.postMessage({type:"scroll",ratio:r}, "*");'
        + '  }, 150);'
        + '});'
        + 'window.addEventListener("message", function(e){'
        + '  if (e.data && e.data.type === "setScroll") {'
        + '    var mx = document.documentElement.scrollHeight - window.innerHeight;'
        + '    if (mx > 0) window.scrollTo(0, Math.round(e.data.ratio * mx));'
        + '  }'
        + '  if (e.data && e.data.type === "setContentWidth") {'
        + '    document.body.style.maxWidth = e.data.width + "px";'
        + '    document.body.style.marginLeft = "auto";'
        + '    document.body.style.marginRight = "auto";'
        + '  }'
        + '});'
        + 'document.addEventListener("pointerdown", function(){'
        + '  parent.postMessage({type:"iframe-pointerdown"}, "*");'
        + '});'
        + 'document.addEventListener("dblclick", function(e) {'
        + '  var sel = window.getSelection();'
        + '  if (!sel || sel.rangeCount === 0) return;'
        + '  var word = sel.toString().trim();'
        + '  if (!word) return;'
        + '  parent.postMessage({type:"dblclick", word:word, ctx:""}, "*");'
        + '});'
        + iframeDropForwardScript()
        + '<' + '/script>'
        + '</body></html>';

      previewFrameNext.srcdoc = html;
      previewFrameNext.onload = function() { swapPreviewFrames(); };
      setTimeout(positionWidthHandles, 250);
      return;
    }

    /* === Doc Surface: Paged.js preview === */
    /* Read mode always renders as Plain — WYSIWYG, no pagination engine */
    var engine = DOC_ENGINES[renderEngineKey] || DOC_ENGINES.none;
    var chapterMatch = renderedHTML.match(/<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>/i);
    var chapterTitle = chapterMatch ? chapterMatch[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : "";

    var scrollRatio = lastScrollRatio;
    var renderId = ++currentRenderId;

    /* Engine script tag — injects Paged.js (or Vivliostyle) when selected */
    var engineScript = (engine && engine.script && !engine.module)
      ? '<script>window.PagedConfig = { auto: false };<' + '/script>'
        + '<script src="' + engine.script + '" defer><' + '/script>'
      : '';

    /* One canonical stylesheet feeds preview, HTML export, and PDF export. */
    var docCss = buildDocumentCSS(renderEngineKey)
      + buildFooterCSS(renderEngineKey, chapterTitle)
      + ' .pagedjs_page { margin: 8px 0; }'

    var html;
    if (renderEngineKey === 'vivliostyle') {
      /* Vivliostyle: CoreViewer loads a blob document and paginates it */
      var vivlDocHTML = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
        + '<base target="_blank" rel="noopener noreferrer">'
        + '<link href="' + FONT_STYLESHEET_URL + '" rel="stylesheet">'
        + mathHeadAssets()
        + '<style>' + docCss + mathBodyCss() + '</style>'
        + '</head><body><main><div class="fw-column-flow">' + renderedHTML + '</div></main></body></html>';
      html = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
        // Stripe placeholder background for View/Preview mode. The old
        // implementation used `repeating-linear-gradient` with hard 16px
        // grey/white stops, which produced visible horizontal seams at
        // each tile boundary (browser sub-pixel rounding at the gradient
        // wrap). This version uses a single non-repeating `linear-gradient`
        // with many explicit stops so the stripes are drawn as one
        // continuous gradient — no tile boundary, no seams. The stripe
        // thickness scales with the iframe height (~40 stripes per 1280px).
        + '<style id="_fw_vivl_shell">' + stripePlaceholderCss()
        + 'body{background:transparent!important;}#vivl-viewport{width:100%;height:100%;overflow:auto;background:transparent;}[data-vivliostyle-page-container]{border:0!important;outline:0.8px solid #000!important;outline-offset:-0.8px!important;box-sizing:border-box!important;background:#fff!important;box-shadow:none!important;}</style>'
        + '<style id="_fw_document_css">' + docCss + '</style>'
        + '</head><body><div id="vivl-viewport"></div>'
        + '<script type="module">'
        + 'import Vivliostyle from "https://esm.unpkg.com/@vivliostyle/core@2.43.3";'
        + 'const CoreViewer = Vivliostyle.CoreViewer;'
        + 'const docHTML = ' + JSON.stringify(vivlDocHTML) + ';'
        + 'const blob = new Blob([docHTML], { type: "text/html" });'
        + 'const docUrl = URL.createObjectURL(blob);'
        + 'const _pageW = ' + getPageWidthPx() + ';'
        + 'const _pageH = ' + getPageHeightPx() + ';'
        + 'const _orientation = "' + orientation + '";'
        + 'const _scrollRatio = ' + scrollRatio + ';'
        + 'const _renderId = ' + renderId + ';'
        + 'window.__flatwriteRenderId = _renderId;'
        + 'var _zoomFactor = 1;'
        + 'function _computeZoom() {'
        + '  var w = window.innerWidth;'
        + '  var h = window.innerHeight;'
        + '  var inset = 20;'
        + '  var s = Math.min((w - inset * 2) / _pageW, (h - inset * 2) / _pageH) * _zoomFactor;'
        + '  return s;'
        + '}'
        + 'const viewer = new CoreViewer({'
        + '  viewportElement: document.getElementById("vivl-viewport"),'
        + '  userAgentRootURL: "https://unpkg.com/@vivliostyle/core@2.43.3/",'
        + '  window: window'
        + '});'
        + 'viewer.setOptions({ renderAllPages: true, pageViewMode: "autoSpread", zoom: 1, fitToScreen: false, autoResize: false, allowScripts: false });'
        + 'const viewport = document.getElementById("vivl-viewport");'
        + 'function _vivlEnableScroll() {'
        + '  var style = document.getElementById("vivl-scroll-style");'
        + '  if (!style) {'
        + '    style = document.createElement("style");'
        + '    style.id = "vivl-scroll-style";'
        + '    style.textContent = "'
        + htmlResetCss()
        + ' [data-vivliostyle-page-container] { display: block !important; visibility: visible !important; opacity: 1 !important; position: relative !important; overflow: visible !important; margin: 0 auto !important; box-sizing: border-box !important; border: 0 !important; outline: 0.8px solid #000 !important; outline-offset: -0.8px !important; background: #fff !important; box-shadow: none !important; } [data-vivliostyle-spread-container] { display: flex !important; flex-direction: column !important; height: auto !important; width: max-content !important; min-width: 0 !important; align-items: flex-start !important; zoom: 1 !important; transform-origin: top left !important; background: transparent !important; } [data-vivliostyle-outer-zoom-box] { height: auto !important; width: max-content !important; min-width: 0 !important; background: transparent !important; }";'
        + '    document.head.appendChild(style);'
        + '  }'
        + '  /* Smooth zoom: apply CSS transform: scale() to the spread container'
        + '     instead of resizing each page. This avoids content reflow on every'
        + '     zoom change (which made the previous implementation jumpy).'
        + '     The scale combines fit-to-viewport and the user zoom factor so a'
        + '     single page fits at 100% — same approach as Paged.js. */'
        + '  var s = _computeZoom();'
        + '  var spread = document.querySelector("[data-vivliostyle-spread-container]");'
        + '  var outerZoom = document.querySelector("[data-vivliostyle-outer-zoom-box]");'
        + '  var pages = document.querySelectorAll("[data-vivliostyle-page-container]");'
        + '  if (spread) {'
        + '    /* Scale the complete paginated flow, but reserve its scaled visual'
        + '       dimensions on the outer box below. This keeps every page in the'
        + '       scrollable coordinate space instead of clipping later pages. */'
        + '    spread.style.setProperty("transform", "scale(" + s + ")", "important");'
        + '    spread.style.setProperty("transform-origin", "top left", "important");'
        + '    spread.style.setProperty("min-width", "0", "important");'
        + '  }'
        + '  /* Size the outer-zoom-box to the visual scaled size so scrollbars in'
        + '     #vivl-viewport accurately reflect the transformed content. */'
        +   '  if (outerZoom && pages.length > 0) {'
        + '    var scaledW = Math.round(_pageW * s);'
        + '    var scaledH = 0;'
        + '    for (var pi = 0; pi < pages.length; pi++) {'
        + '      scaledH += Math.round(_pageH * s);'
        + '      if (pi < pages.length - 1) scaledH += Math.round(16 * s);'
        + '    }'
        + '    outerZoom.style.setProperty("width", scaledW + "px", "important");'
        + '    outerZoom.style.setProperty("min-width", scaledW + "px", "important");'
        + '    outerZoom.style.setProperty("height", scaledH + "px", "important");'
        + '  }'
        + '  for (var i = 0; i < pages.length; i++) {'
        + '    pages[i].style.zoom = 1;'
        + '    /* Do NOT force pixel width/height on the page container — that'
        + '       overrides Vivliostyle\'s @page sizing and breaks font scaling,'
        + '       line height, and page-break fidelity. Let the @page rule size'
        + '       the page box; only clear conflicting inline styles. As a fallback'
        + '       for when Vivliostyle has not yet applied its CSS, set dimensions'
        + '       only if the page box is currently empty. */'
        + '    if (pages[i].style.width === "" && pages[i].offsetWidth === 0) {'
        + '      pages[i].style.width = _pageW + "px";'
        + '    }'
        + '    if (pages[i].style.height === "" && pages[i].offsetHeight === 0) {'
        + '      pages[i].style.height = _pageH + "px";'
        + '    }'
        + '    pages[i].style.maxWidth = "";'
        + '    pages[i].style.maxHeight = "";'
        + '    pages[i].style.transform = "none";'
        + '    pages[i].style.transformOrigin = "";'
        + '    var child = pages[i].firstElementChild;'
        + '    if (child) {'
        + '      child.style.width = "";'
        + '      child.style.height = "";'
        + '      child.style.maxWidth = "";'
        + '      child.style.maxHeight = "";'
        + '      child.style.transform = "none";'
        + '      child.style.transformOrigin = "";'
        + '    }'
        + '    pages[i].style.setProperty("margin", "8px 0", "important");'
        + '  }'
        + '}'
        + 'function _setVivlCanvasExtent() {'
        + '  _vivlEnableScroll();'
        + '}'
        + 'function _vivlNotify() {'
        + '  _setVivlCanvasExtent();'
        + '  var m = viewport.scrollHeight - viewport.clientHeight;'
        + '  if (m > 0) viewport.scrollTop = Math.round(_scrollRatio * m);'
        + '  else viewport.scrollTop = 0;'
        + '  parent.postMessage({type:"vivl-ready", renderId: _renderId}, "*");'
        + '}'
        + 'viewer.addListener("loaded", _vivlNotify);'
        + '(document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(function(){ viewer.loadDocument(docUrl); });'
        + 'setTimeout(function(){ if (!document.querySelector("[data-vivliostyle-page-container]")) parent.postMessage({type:"vivl-error", renderId:_renderId}, "*"); }, 10000);'
        + 'window.addEventListener("resize", function() { viewer.setOptions({ zoom: 1 }); _vivlEnableScroll(); });'
        + 'viewport.addEventListener("scroll", function() {'
        + '  var m = viewport.scrollHeight - viewport.clientHeight;'
        + '  var r = m > 0 ? viewport.scrollTop / m : 0;'
        + '  parent.postMessage({type:"scroll", ratio:r}, "*");'
        + '});'
        + 'window.addEventListener("message", function(e) {'
        + '  if (e.data && e.data.type === "setScroll") {'
        + '    var m = viewport.scrollHeight - viewport.clientHeight;'
        + '    if (m > 0) viewport.scrollTop = Math.round(e.data.ratio * m);'
        + '  }'
        + '  if (e.data && e.data.type === "setZoom") {'
        + '    _zoomFactor = e.data.zoom || 1;'
        + '    _vivlEnableScroll();'
        + '    _updateVivlPanCursor();'
        + '  }'
        + '});'
        + 'function _updateVivlPanCursor() {'
        + '  var ox = viewport.scrollWidth > viewport.clientWidth;'
        + '  var oy = viewport.scrollHeight > viewport.clientHeight;'
        + '  viewport.style.cursor = (ox || oy) ? "grab" : "";'
        + '}'
        + 'var _vpan = { active: false, x: 0, y: 0, sx: 0, sy: 0 };'
        + 'viewport.addEventListener("pointerdown", function(e) {'
        + '  var ox = viewport.scrollWidth > viewport.clientWidth;'
        + '  var oy = viewport.scrollHeight > viewport.clientHeight;'
        + '  if (!ox && !oy) return;'
        + '  _vpan.active = true;'
        + '  _vpan.x = e.clientX; _vpan.y = e.clientY;'
        + '  _vpan.sx = viewport.scrollLeft; _vpan.sy = viewport.scrollTop;'
        + '  viewport.style.cursor = "grabbing";'
        + '  viewport.style.userSelect = "none";'
        + '  e.preventDefault();'
        + '}, { passive: false });'
        + 'document.addEventListener("pointermove", function(e) {'
        + '  if (!_vpan.active) return;'
        + '  viewport.scrollLeft = _vpan.sx - (e.clientX - _vpan.x);'
        + '  viewport.scrollTop  = _vpan.sy - (e.clientY - _vpan.y);'
        + '});'
        + 'document.addEventListener("pointerup", function() {'
        + '  if (!_vpan.active) return;'
        + '  _vpan.active = false;'
        + '  viewport.style.userSelect = "";'
        + '  _updateVivlPanCursor();'
        + '});'
        + iframeDropForwardScript()
        + '</script>'
        + '</body></html>';
    } else {
      html = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
        + '<base target="_blank" rel="noopener noreferrer">'
        + '<link href="' + FONT_STYLESHEET_URL + '" rel="stylesheet">'
        + mathHeadAssets()
        + engineScript
        + '<style>'
        + docCss
        + mathBodyCss()
        + 'html::-webkit-scrollbar { display: none; }'
        + 'html { scrollbar-width: none; -ms-overflow-style: none; }'
        /* --- Page-boundary dashed borders on all four sides --- */
        + '.pagedjs_page { overflow: visible !important; margin: 8px 0 !important; outline: none !important; border: none !important; box-shadow: none !important; background: transparent !important; }'
        + '.pagedjs_sheet { box-sizing: border-box !important; border: 0 !important; outline: 0.8px solid #000 !important; outline-offset: -0.8px !important; box-shadow: none !important; }'
        + '.pagedjs_pagebox { box-shadow: none !important; outline: none !important; border: none !important; }'
        + '.pagedjs_margin-left, .pagedjs_margin-right { border: none !important; outline: none !important; box-shadow: none !important; }'
        + '.pagedjs_bleed, .pagedjs_bleed-top, .pagedjs_bleed-bottom, .pagedjs_bleed-left, .pagedjs_bleed-right { display: none !important; }'
        /* Plain mode: constrain body width to contentWidth */
        + 'body.engine-none { max-width: ' + contentWidth + 'px; margin: 0 auto; background: #fff !important; }'
        + 'body.engine-none main { padding: 2rem 1rem; }'
        /* Paged modes: body fills the iframe viewport */
        + 'body.engine-pagedjs, body.engine-vivliostyle { max-width: none; margin: 0; background: transparent !important; }'
        + '</style>'
        + (mode !== "read" ? '<style id="_fw_stripe">' + stripePlaceholderCss() + ' .pagedjs_sheet, .pagedjs_pagebox, .pagedjs_area { background: #fff !important; }</style>' : '')
        + '</head><body class="engine-' + renderEngineKey + '"><main><div class="fw-column-flow">' + renderedHTML + '</div></main>'
        + '<script>'
      + 'var _scrollRatio = ' + scrollRatio + ';'
      + 'var _pagedReady = false;'
      + 'var _isPaged = ' + (renderEngineKey !== 'none') + ';'
      + 'var _zoomFactor = 1;'
      + 'var _pageW = ' + getPageWidthPx() + ';'
      + 'var _pageH = ' + getPageHeightPx() + ';'
      + 'var _orientation = "' + orientation + '";'
      + 'var _renderId = ' + renderId + ';'
      + 'window.__flatwriteRenderId = _renderId;'
      + 'var _footerOn = ' + (showFooter ? 'true' : 'false') + ';'
      + 'var _engineKey = "' + renderEngineKey + '";'
      + 'var _footerOwner = "' + (FOOTER_OWNERS[renderEngineKey] || 'none') + '";'
      /* After Paged.js finishes, scale page to fit iframe, center, restore scroll */
      + 'function _setPagedCanvasExtent(flowW, flowH, s) {'
      + '  document.body.style.width = Math.ceil(flowW * s) + "px";'
      + '  document.body.style.height = Math.ceil(flowH * s) + "px";'
      + '  document.documentElement.style.height = Math.ceil(flowH * s) + "px";'
      + '}'
      + 'function _fitPage() {'
      + '  if (!_isPaged) return;'
      + '  var page = document.querySelector(".pagedjs_page");'
      + '  var pages = document.querySelector(".pagedjs_pages");'
      + '  var pageW = page ? page.offsetWidth : _pageW;'
      + '  var pageH = page ? page.offsetHeight : _pageH;'
      + '  var iframeW = window.innerWidth;'
      + '  var iframeH = window.innerHeight;'
      + '  var inset = 20;'
      + '  var s = Math.min((iframeW - inset * 2) / pageW, (iframeH - inset * 2) / pageH) * _zoomFactor;'
      + '  var scaledW = pageW * s;'
      + '  var flowW = pages ? pages.scrollWidth : pageW;'
      + '  var flowH = pages ? pages.scrollHeight : pageH;'
      + '  var marginLeft = Math.max(inset, (iframeW - scaledW) / 2);'
      + '  document.documentElement.style.overflow = "auto";'
      + '  document.body.style.maxWidth = "none";'
      + '  _setPagedCanvasExtent(flowW, flowH, s);'
      + '  document.body.style.transform = "none";'
      + '  if (pages) {'
      + '    pages.style.setProperty("transform", "scale(" + s + ")", "important");'
      + '    pages.style.setProperty("transform-origin", "top left", "important");'
      + '    pages.style.setProperty("width", flowW + "px", "important");'
      + '  }'
      + '  document.body.style.marginLeft = marginLeft + "px";'
      + '  document.body.style.marginRight = "0";'
      + '  window.scrollTo(0, 0);'
      + '  _updatePanCursor();'
      + '}'
      /* Paged.js's CSS string()/counter() margin-box content is fragile —
         it silently resolves to `content: none` on both the bottom-left
         and bottom-right boxes once the full document stylesheet (with its
         !important overrides, :has() selectors, etc.) is combined with the
         @bottom-left/@bottom-right @page rules. Rather than depend on that,
         write the chapter title and "Page N of M" directly into the DOM as
         real text nodes. This also means the footer survives being cloned
         into the PDF print snapshot, since real text nodes (unlike
         CSS-generated ::after content) are preserved by cloneNode(). */
      + 'function _applyFooterContent() {'
      + '  if (!_footerOn || _footerOwner !== "dom") return;'
      + '  /* Scope page selection to Paged.js’s own spread wrapper AND require'
      + '     *direct* child placement of canonical structural classes. The'
      + '     sanitizer allows class attributes on user content, so an author'
      + '     <div class="pagedjs_page">…</div> would match plain descendant'
      + '     selectors. Using :scope > restricts matching to the immediate'
      + '     level paged.js itself emits — never anything paged.js then'
      + '     rendered into .pagedjs_area from user markup. When .pagedjs_pages'
      + '     itself is missing, bail out cleanly rather than scanning the'
      + '     whole document; the footer simply remains empty (better than'
      + '     touching user elements). */'
      + '  var pageList = [];'
      + '  var spread = document.querySelector(".pagedjs_pages");'
      + '  if (spread) {'
      + '    /* Real paged.js structure (verified against the polyfill source):'
      + '         .pagedjs_pages'
      + '           > .pagedjs_page'
      + '               > .pagedjs_sheet'
      + '                   > .pagedjs_pagebox'
      + '                       > [margin holders / .pagedjs_area]'
      + '       Note the order — sheet is the *direct* child of page, and'
      + '       pagebox is the direct child of sheet. Each link must be a'
      + '       direct child so a user-authored wrapper nested inside a real'
      + '       page\'s content area can\'t impersonate a page of its own. */'
      + '    var candidates = spread.querySelectorAll(":scope > .pagedjs_page");'
      + '    for (var ci = 0; ci < candidates.length; ci++) {'
      + '      var cand = candidates[ci];'
      + '      var sheet = cand.querySelector(":scope > .pagedjs_sheet");'
      + '      if (!sheet) continue;'
      + '      var pagebox = sheet.querySelector(":scope > .pagedjs_pagebox");'
      + '      if (!pagebox) continue;'
      + '      pageList.push(cand);'
      + '    }'
      + '  }'
      + '  var pages = pageList;'
      + '  var total = pages.length;'
      + '  /* Pick the chapter title by the most-common h1 across trusted pages.'
      + '     A user <h1> appended at the end would only appear on the last'
      + '     page(s), so it cannot out-vote the real chapter that recurs on'
      + '     every preceding page. Falls back to the first non-empty h1 if'
      + '     every page is unique. */'
      + '  var h1Freq = Object.create(null);'
      + '  var h1Order = [];'
      + '  for (var pi = 0; pi < pages.length; pi++) {'
      + '    var pca = pages[pi].querySelector(".pagedjs_area");'
      + '    if (!pca) continue;'
      + '    var pch1 = pca.querySelector("h1");'
      + '    if (!pch1) continue;'
      + '    /* The map key is user-controlled (h1 textContent), so we cannot'
      + '       safely use `in` on a plain object — prototype names like'
      + '       "toString" or "constructor" would collide. Also trim because'
      + '       whitespace-only headings would otherwise count as valid chapters. */'
      + '    var pct = (pch1.textContent || "").replace(/^\\s+|\\s+$/g, "");'
      + '    if (!pct) continue;'
      + '    if (!Object.prototype.hasOwnProperty.call(h1Freq, pct)) { h1Freq[pct] = 0; h1Order.push(pct); }'
      + '    h1Freq[pct]++;'
      + '  }'
      + '  var chapter = "";'
      + '  if (h1Order.length) {'
      + '    var best = h1Order[0];'
      + '    var bestCount = h1Freq[best];'
      + '    for (var hi = 1; hi < h1Order.length; hi++) {'
      + '      if (h1Freq[h1Order[hi]] > bestCount) { best = h1Order[hi]; bestCount = h1Freq[h1Order[hi]]; }'
      + '    }'
      + '    chapter = best;'
      + '  }'
      + '  for (var i = 0; i < pages.length; i++) {'
      + '    var page = pages[i];'
      + '    /* Walk *direct* children only, following the canonical chain'
      + '       confirmed by the pagebox filter above:'
      + '         .pagedjs_page > .pagedjs_sheet > .pagedjs_pagebox >'
      + '           .pagedjs_margin-bottom > .{left,right} > .pagedjs_margin-content.'
      + '       Each link is resolved as a direct child of its expected parent'
      + '       so a user wrapper nested inside .pagedjs_area cannot satisfy'
      + '       the structural test. */'
      + '    var sheet = page.querySelector(":scope > .pagedjs_sheet");'
      + '    if (!sheet) continue;'
      + '    var pagebox = sheet.querySelector(":scope > .pagedjs_pagebox");'
      + '    if (!pagebox) continue;'
      + '    var bottomGrid = pagebox.querySelector(":scope > .pagedjs_margin-bottom");'
      + '    if (!bottomGrid) continue;'
      + '    var leftBox = bottomGrid.querySelector(":scope > .pagedjs_margin-bottom-left");'
      + '    var rightBox = bottomGrid.querySelector(":scope > .pagedjs_margin-bottom-right");'
      + '    var left = leftBox ? leftBox.querySelector(":scope > .pagedjs_margin-content") : null;'
      + '    var right = rightBox ? rightBox.querySelector(":scope > .pagedjs_margin-content") : null;'
      + '    /* Final safety: the target must be a child of bottomGrid AND of'
      + '       the correct-side margin box. closest() resolves the actual'
      + '       ancestor even when the grid search returned a deeper node. */'
      + '    function isTrustedMarginContent(el, side) {'
      + '      if (!el) return false;'
      + '      var sideBox = el.parentElement;'
      + '      while (sideBox && !sideBox.classList.contains("pagedjs_margin-bottom-" + side)) {'
      + '        sideBox = sideBox.parentElement;'
      + '      }'
      + '      return !!sideBox && bottomGrid && bottomGrid.contains(sideBox);'
      + '    }'
      + '    if (isTrustedMarginContent(left, "left")) left.textContent = chapter;'
      + '    if (isTrustedMarginContent(right, "right")) right.textContent = "Page " + (i + 1) + " of " + total;'
      + '  }'
      + '}'
      + 'function _commitPagedPreview() {'
      + '  /* Same hardened gate as _applyFooterContent uses internally: a direct'
      + '     child of the spread wrapper, never a descendant match — keeps a'
      + '     user-authored <div class="pagedjs_page"> from flipping'
      + '     _pagedReady and triggering footer logic against the wrong tree. */'
      + '  if (_pagedReady) return;'
      + '  var initSpread = document.querySelector(".pagedjs_pages");'
      + '  if (!initSpread || !initSpread.querySelector(":scope > .pagedjs_page")) return;'
      + '  _pagedReady = true;'
      + '  _applyFooterContent();'
      + '  _fitPage();'
      + '  _killBorders();'
      + '  var mx = document.documentElement.scrollHeight - window.innerHeight;'
      + '  if (mx > 0) window.scrollTo(0, Math.round(_scrollRatio * mx));'
      + '  parent.postMessage({type:"paged-ready", renderId: _renderId}, "*");'
      + '}'
      + 'function _startPagedPreview() {'
      + '  if (typeof window.PagedPolyfill === "undefined" || !window.PagedPolyfill.on || !window.PagedPolyfill.preview) return false;'
      + '  window.PagedPolyfill.on("afterPreview", _commitPagedPreview);'
      + '  window.PagedPolyfill.preview().then(_commitPagedPreview).catch(function(){'
      + '    parent.postMessage({type:"paged-error", renderId:_renderId}, "*");'
      + '  });'
      + '  return true;'
      + '}'
      + 'function _initFit() {'
      + '  if (!_isPaged) {'
      + '    var mx = document.documentElement.scrollHeight - window.innerHeight;'
      + '    if (mx > 0) window.scrollTo(0, Math.round(_scrollRatio * mx));'
      + '    return;'
      + '  }'
      + '  if (!_startPagedPreview()) {'
      + '    var tries = 0;'
      + '    var interval = setInterval(function() {'
      + '      tries++;'
      + '      if (_startPagedPreview()) { clearInterval(interval); }'
      + '      else if (tries > 50) { clearInterval(interval); parent.postMessage({type:"paged-error", renderId:_renderId}, "*"); }'
      + '    }, 100);'
      + '  }'
      + '}'
      + 'function _killBorders() {'
      + '  var s = document.getElementById("_fw_kill_borders");'
      + '  if (!s) {'
      + '    s = document.createElement("style");'
      + '    s.id = "_fw_kill_borders";'
      + '    s.textContent = ".pagedjs_page,.pagedjs_pagebox,.pagedjs_margin-left,.pagedjs_margin-right,.pagedjs_area { box-shadow: none !important; outline: none !important; border: none !important; } .pagedjs_page { background: transparent !important; } .pagedjs_sheet { border: 0 !important; outline: 0.8px solid #000 !important; outline-offset: -0.8px !important; box-sizing: border-box !important; background: #fff !important; box-shadow: none !important; } @media screen { .pagedjs_page { box-shadow: none !important; } }";'
      + '    document.head.appendChild(s);'
      + '  }'
      + '}'
      + 'document.addEventListener("DOMContentLoaded", function(){'
      + '  var ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();'
      + '  ready.then(_initFit);'
      + '});'
      + 'var _scrollTimer;'
      + 'window.addEventListener("scroll", function(){'
      + '  clearTimeout(_scrollTimer);'
      + '  _scrollTimer = setTimeout(function(){'
      + '    var m = document.documentElement.scrollHeight - window.innerHeight;'
      + '    var r = m > 0 ? window.scrollY / m : 0;'
      + '    parent.postMessage({type:"scroll",ratio:r}, "*");'
      + '  }, 150);'
      + '});'
      + 'window.addEventListener("message", function(e){'
      + '  if (e.data && e.data.type === "setScroll") {'
      + '    var mx = document.documentElement.scrollHeight - window.innerHeight;'
      + '    if (mx > 0) window.scrollTo(0, Math.round(e.data.ratio * mx));'
      + '  }'
      + '  if (e.data && e.data.type === "setContentWidth") {'
      + '    if (document.body.classList.contains("engine-none")) {'
      + '      document.body.style.maxWidth = e.data.width + "px";'
      + '      document.body.style.marginLeft = "auto";'
      + '      document.body.style.marginRight = "auto";'
      + '    }'
      + '  }'
      + '  if (e.data && e.data.type === "setStripe") {'
      + '    var el = document.getElementById("_fw_stripe");'
      + '    if (el) el.disabled = !e.data.visible;'
      + '  }'
      + '  if (e.data && e.data.type === "setZoom") {'
      + '    _zoomFactor = e.data.zoom || 1;'
      + '    if (_isPaged) {'
      + '      _fitPage();'
      + '    } else {'
      /* Non-paged path: enable document scrolling so the pan handlers
         can move the zoomed content. Without this, html/body are
         overflow:hidden and the content is locked. */
      + '      document.documentElement.style.overflow = "auto";'
      + '      document.body.style.overflow = "auto";'
      + '      document.body.style.overflowX = "auto";'
      + '      document.body.style.zoom = _zoomFactor;'
      + '      parent.postMessage({type:"zoomChanged"}, "*");'
      + '    }'
      + '    _updatePanCursor();'
      + '  }'
      + '});'
      + 'function _overflows() {'
      + '  var de = document.documentElement;'
      + '  return de.scrollWidth > de.clientWidth || de.scrollHeight > de.clientHeight'
      + '    || document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight;'
      + '}'
      + 'function _updatePanCursor() {'
      + '  document.documentElement.style.cursor = _overflows() ? "grab" : "";'
      + '}'
      + 'var _pan = { active: false, x: 0, y: 0, sx: 0, sy: 0 };'
      + 'document.addEventListener("pointerdown", function(e) {'
      + '  if (!_overflows()) return;'
      + '  _pan.active = true;'
      + '  _pan.x = e.clientX; _pan.y = e.clientY;'
      + '  _pan.sx = window.scrollX; _pan.sy = window.scrollY;'
      + '  document.documentElement.style.cursor = "grabbing";'
      + '  document.documentElement.style.userSelect = "none";'
      + '  e.preventDefault();'
      + '}, { passive: false });'
      + 'document.addEventListener("pointermove", function(e) {'
      + '  if (!_pan.active) return;'
      + '  window.scrollTo(_pan.sx - (e.clientX - _pan.x), _pan.sy - (e.clientY - _pan.y));'
      + '});'
      + 'document.addEventListener("pointerup", function() {'
      + '  if (!_pan.active) return;'
      + '  _pan.active = false;'
      + '  document.documentElement.style.cursor = "grab";'
      + '  document.documentElement.style.userSelect = "";'
      + '  _updatePanCursor();'
      + '});'
      + 'document.addEventListener("pointerdown", function(){'
      + '  parent.postMessage({type:"iframe-pointerdown"}, "*");'
      + '});'
      + 'document.addEventListener("dblclick", function(e) {'
      + '  var sel = window.getSelection();'
      + '  if (!sel || sel.rangeCount === 0) return;'
      + '  var word = sel.toString().trim();'
      + '  if (!word) return;'
      + '  var range = sel.getRangeAt(0);'
      + '  var node = e.target;'
      + '  while (node && node !== document.body) {'
      + '    var d = window.getComputedStyle(node).display;'
      + '    if (d === "block" || d === "list-item" || d === "table-cell") break;'
      + '    node = node.parentNode;'
      + '  }'
      + '  var textBefore = "";'
      + '  if (node) {'
      + '    var walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);'
      + '    var chars = 0;'
      + '    var targetOffset = -1;'
      + '    var n;'
      + '    while ((n = walk.nextNode())) {'
      + '      if (n === range.startContainer) { targetOffset = chars + range.startOffset; break; }'
      + '      chars += n.textContent.length;'
      + '    }'
      + '    var full = node.textContent;'
      + '    if (targetOffset > -1) {'
      + '      var start = Math.max(0, targetOffset - 60);'
      + '      textBefore = full.substring(start, targetOffset).trim();'
      + '    }'
      + '  }'
      + '  parent.postMessage({type:"dblclick", word:word, ctx:textBefore}, "*");'
      + '});'
      + iframeDropForwardScript()
      + '<' + '/script>'
      + '</body></html>';
    }

    previewFrameNext.srcdoc = html;
    /* Reposition width handles after iframe content loads */
    previewFrameNext.onload = function() {
      /* Plain mode renders immediately; paged engines wait for postMessage */
      if (renderEngineKey === "none") swapPreviewFrames();
    };
    setTimeout(positionWidthHandles, 250);
  }

  /* ==========================================================================
     Edit / Preview toggle
     ========================================================================== */

  function setMode(newMode) {
    var prevMode = mode;
    mode = newMode;

    /* Read mode is always 100% zoom (WYSIWYG); restore previous zoom when leaving */
    if (mode === "read") {
      readZoomRestore = zoomStep;
      zoomStep = 100;
      zoomSlider.value = 100;
      zoomValue.textContent = "100%";
    } else if (prevMode === "read" && readZoomRestore !== null) {
      zoomStep = readZoomRestore;
      readZoomRestore = null;
      zoomSlider.value = zoomStep;
      zoomValue.textContent = zoomStep + "%";
    }

    var modeSwitch = document.getElementById("mode-switch");
    var appShell = document.querySelector(".app-shell");
    var btnRead = document.getElementById("btn-read");

    appShell.classList.remove("mode-edit", "mode-preview", "mode-read");
    appShell.classList.add("mode-" + mode);

    editorWrap.classList.add("hidden");
    previewWrap.classList.add("hidden");
    btnEdit.classList.remove("active");
    btnPreview.classList.remove("active");
    btnRead.classList.remove("active");
    btnEdit.setAttribute("aria-pressed", "false");
    btnPreview.setAttribute("aria-pressed", "false");
    btnRead.setAttribute("aria-pressed", "false");
    modeSwitch.classList.remove("preview", "read");


    if (mode === "edit") {
      if (prevMode !== "edit") savePreviewScroll();
      editorWrap.classList.remove("hidden");
      btnEdit.classList.add("active");
      btnEdit.setAttribute("aria-pressed", "true");

      /* Restore editor scroll position */
      requestAnimationFrame(function () {
        editor.scrollTop = lastEditorScrollTop;
      });

      if (prevMode === "read") {
        if (window.innerWidth < 760) {
          appShell.classList.remove("focus-mode");
        } else {
          animateLogoBack(appShell);
        }
      } else {
        appShell.classList.remove("focus-mode");
      }
    } else {
      if (prevMode === "edit") {
        lastEditorScrollTop = editor.scrollTop;
        if (editor.scrollHeight > editor.clientHeight) {
          lastScrollRatio = editor.scrollTop / (editor.scrollHeight - editor.clientHeight);
        } else {
          var text = editor.value || "";
          lastScrollRatio = text.length > 0 ? (editor.selectionStart / text.length) : 0;
        }
      }
      previewWrap.classList.remove("hidden");

      /* Render whenever the preview becomes visible (edit -> preview/read, or
         read <-> preview) so the content is current. Render after the wrap is
         visible so the iframe can measure its viewport correctly. */
      if (mode !== "edit") {
        renderPreview();
      }

      /* Re-apply scroll after the iframe is visible. */
      requestAnimationFrame(function () {
        setTimeout(function () {
          if (previewFrame.contentWindow) {
            previewFrame.contentWindow.postMessage({ type: "setScroll", ratio: lastScrollRatio }, "*");
          }
        }, 50);
      });

      /* Smooth fade-in from top when entering from edit */
      if (prevMode === "edit") {
        previewWrap.classList.remove("preview-enter");
        /* Force reflow so the animation restarts even on rapid toggles */
        void previewWrap.offsetWidth;
        previewWrap.classList.add("preview-enter");
        previewWrap.addEventListener("animationend", function handler() {
          previewWrap.classList.remove("preview-enter");
          previewWrap.removeEventListener("animationend", handler);
        });
      }

      if (mode === "read") {
        btnRead.classList.add("active");
        btnRead.setAttribute("aria-pressed", "true");
        modeSwitch.classList.add("read");
        if (window.innerWidth < 760) {
          appShell.classList.add("focus-mode");
        } else {
          animateLogoToCenter(appShell);
        }
      } else {
        btnPreview.classList.add("active");
        btnPreview.setAttribute("aria-pressed", "true");
        modeSwitch.classList.add("preview");
        if (prevMode === "read") {
          if (window.innerWidth < 760) {
            appShell.classList.remove("focus-mode");
          } else {
            animateLogoBack(appShell);
          }
        } else {
          appShell.classList.remove("focus-mode");
        }
      }
    }
    /* Re-align tab bubble after mode switch (toolbar height may change) */
    requestAnimationFrame(syncExportActionsTop);
    scheduleAutosave();
  }

  function animateLogoToCenter(appShell) {
    var sidebarLogo = document.querySelector(".app-title");
    var toolbar = document.querySelector(".toolbar");
    if (!sidebarLogo || !toolbar) return;

    var src = sidebarLogo.getBoundingClientRect();
    var toolbarRect = toolbar.getBoundingClientRect();
    var dstLeft = toolbarRect.left + 5;

    var floater = document.createElement("div");
    floater.className = "read-logo";
    floater.textContent = "FlatWrite";
    floater.style.top = src.top + "px";
    floater.style.left = src.left + "px";
    document.body.appendChild(floater);

    appShell.classList.add("logo-in-flight");

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        floater.classList.add("sliding");
        floater.classList.add("visible");
        floater.style.left = dstLeft + "px";
        appShell.classList.add("focus-mode");

        setTimeout(function () {
          floater.classList.remove("sliding");
          floater.classList.add("settled");
        }, 700);
      });
    });
  }

  function animateLogoBack(appShell) {
    var floater = document.querySelector(".read-logo");
    var sidebarLogo = document.querySelector(".app-title");
    if (!floater || !sidebarLogo) return;

    var dst = sidebarLogo.getBoundingClientRect();

    floater.classList.remove("settled");
    floater.classList.add("sliding");
    floater.style.left = dst.left + "px";
    appShell.classList.remove("focus-mode");

    setTimeout(function () {
      floater.classList.remove("visible");
      appShell.classList.remove("logo-in-flight");

      setTimeout(function () {
        if (floater.parentNode) floater.remove();
      }, 300);
    }, 700);
  }

  /* ==========================================================================
     Markdown formatting toolbar
     ========================================================================== */

  function editorInsert(before, middle, after) {
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    var selected = editor.value.substring(start, end);
    var text = selected || middle;
    var replacement = before + text + after;

    editor.focus();
    if (document.queryCommandSupported && document.queryCommandSupported("insertText")) {
      editor.setSelectionRange(start, end);
      document.execCommand("insertText", false, replacement);
    } else {
      editor.value = editor.value.substring(0, start) + replacement + editor.value.substring(end);
    }

    if (selected) {
      editor.setSelectionRange(start, start + replacement.length);
    } else {
      editor.setSelectionRange(start + before.length, start + before.length + middle.length);
    }
    editor.dispatchEvent(new Event("input"));
  }

  function editorInsertBlock(block) {
    var start = editor.selectionStart;
    var val = editor.value;
    var prefix = (start > 0 && val[start - 1] !== "\n") ? "\n" : "";
    var insertion = prefix + block + "\n";

    editor.focus();
    editor.setSelectionRange(start, start);
    if (document.queryCommandSupported && document.queryCommandSupported("insertText")) {
      document.execCommand("insertText", false, insertion);
    } else {
      editor.value = val.substring(0, start) + insertion + val.substring(start);
    }
    var cursorPos = start + insertion.length;
    editor.setSelectionRange(cursorPos, cursorPos);
    editor.dispatchEvent(new Event("input"));
  }

  function editorInsertPageBreak() {
    var start = editor.selectionStart;
    var val = editor.value;
    var tag = '<fw-break lines="1" />';
    var prefix = (start > 0 && val[start - 1] !== "\n") ? "\n" : "";
    var suffix = (start < val.length && val[start] === "\n") ? "" : "\n";
    var insertion = prefix + tag + suffix;

    editor.focus();
    editor.setSelectionRange(start, start);
    if (document.queryCommandSupported && document.queryCommandSupported("insertText")) {
      document.execCommand("insertText", false, insertion);
    } else {
      editor.value = val.substring(0, start) + insertion + val.substring(start);
    }
    var countStart = start + prefix.length + tag.indexOf("1");
    editor.setSelectionRange(countStart, countStart + 1);
    editor.dispatchEvent(new Event("input"));
  }

  function applyMarkdownFormat(action) {
    if (mode !== "edit") setMode("edit");
    switch (action) {
      case "h1":            editorInsert("# ", "Heading 1", ""); break;
      case "h2":            editorInsert("## ", "Heading 2", ""); break;
      case "h3":            editorInsert("### ", "Heading 3", ""); break;
      case "h4":            editorInsert("#### ", "Heading 4", ""); break;
      case "bold":          editorInsert("**", "bold text", "**"); break;
      case "italic":        editorInsert("*", "italic text", "*"); break;
      case "strikethrough": editorInsert("~~", "strikethrough", "~~"); break;
      case "blockquote":    editorInsert("> ", "quote", ""); break;
      case "inlinecode":    editorInsert("`", "code", "`"); break;
      case "codeblock":     editorInsert("```\n", "code here", "\n```"); break;
      case "ul":            editorInsertBlock("- Item 1\n- Item 2\n- Item 3"); break;
      case "ol":            editorInsertBlock("1. First\n2. Second\n3. Third"); break;
      case "task":          editorInsertBlock("- [ ] Task 1\n- [ ] Task 2\n- [x] Done task"); break;
      case "link":          editorInsert("[", "link text", "](https://example.com)"); break;
      case "image":         editorInsert("![", "alt text", "](https://example.com/image.png)"); break;
      case "hr":            editorInsertBlock("---"); break;
      case "pagebreak":     editorInsertPageBreak(); break;
      default: break;
    }
  }

  /* ==========================================================================
     Export
     ========================================================================== */

  function timestamp() {
    var now = new Date();
    return now.getFullYear()
      + String(now.getMonth() + 1).padStart(2, "0")
      + String(now.getDate()).padStart(2, "0")
      + "-"
      + String(now.getHours()).padStart(2, "0")
      + String(now.getMinutes()).padStart(2, "0");
  }

  function openInNewTab(content, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  function exportMarkdown() {
    openInNewTab(editor.value || "", "text/plain;charset=utf-8");
  }

  function exportHTML() {
    if (surfaceMode === "doc" && !syncDocumentSettingsFromControls()) return;
    /* === App Surface: Framework CSS export === */
    if (surfaceMode === "app") {
      var fw = APP_FRAMEWORKS[currentAppFramework];
      var contentForRender = stripYamlFrontMatter(editor.value || "");
      var rawHTML = renderToFragment(contentForRender);
      var renderedHTML0 = sanitizeHTML(resolveRelativeUrls(rawHTML));
      finalizeMathHtml(renderedHTML0).then(function (renderedHTML) {
      var scale = SIZE_SCALE[String(sizeStep)] || 1;
      var weight = WEIGHT_MAP[String(weightStep)] || 400;
      var lineHeight = LINE_SCALE[String(lineStep)] || 1.75;
      var fontStack = "'" + comfortFont + "', system-ui, sans-serif";
      var headWeight = Math.min(weight + 200, 900);

      var fwCssLinks = "";
      if (fw && fw.css) {
        var cssArr = typeof fw.css === "string" ? [fw.css] : fw.css;
        for (var ci = 0; ci < cssArr.length; ci++) {
          fwCssLinks += '  <link rel="stylesheet" href="' + cssArr[ci] + '">\n';
        }
      }
      var fwJsTag = (fw && fw.js) ? '  <script src="' + fw.js + '" defer><' + '/script>\n' : "";

      var fwStyle = "";
      if (fw && typeof fw.style === "function") {
        fwStyle = fw.style("");
      }

      var html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
        + '  <meta charset="UTF-8">\n'
        + '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
        + '  <title>FlatWrite Export</title>\n'
        + '  <base target="_blank" rel="noopener noreferrer">\n'
        + fwCssLinks + fwJsTag
        + mathHeadAssets()
        + '  <style>\n'
        + '    ' + fwStyle + mathBodyCss() + '\n'
        + '    *, *::before, *::after { font-family: ' + fontStack + ' !important; box-sizing: border-box; }\n'
        + '    body { font-size: ' + (15 * scale) + 'px !important;\n'
        + '      font-weight: ' + weight + ' !important; line-height: ' + lineHeight + ' !important;\n'
        + '      color: #2d2a3e; max-width: ' + contentWidth + 'px;\n'
        + '      margin: 2rem auto; padding: 0 1.5rem; overflow-x: hidden; }\n'
        + '    h1,h2,h3,h4,h5,h6 { font-weight: ' + headWeight + ' !important; }\n'
        + '    h1 { font-size: ' + (15 * scale * 2) + 'px !important; }\n'
        + '    h2 { font-size: ' + (15 * scale * 1.5) + 'px !important; }\n'
        + '    h3 { font-size: ' + (15 * scale * 1.25) + 'px !important; }\n'
        + '    h4 { font-size: ' + (15 * scale * 1.1) + 'px !important; }\n'
        + '    img { max-width: 100%; height: auto; }\n'
        + '    pre, code { font-family: "JetBrains Mono", monospace !important; }\n'
        + '    pre { overflow-x: auto; white-space: pre-wrap; }\n'
        + '    table { table-layout: fixed; width: 100%; }\n'
        + '    blockquote { margin: 0; padding: 0 1em; border-left: 3px solid #ccc; }\n'
        + '  </style>\n'
        + '</head>\n<body>\n  <main>\n'
        + renderedHTML
        + '\n  </main>\n</body>\n</html>';

      openInNewTab(html, "text/html;charset=utf-8");
      });
      return;
    }

    /* Reuse only a preview proven to match the latest render id. Otherwise
       build synchronously below from current controls. */
    var srcdoc = previewFrame.getAttribute("srcdoc");
    if (srcdoc && (mode === "preview" || mode === "read") && isCurrentPreviewCommitted()) {
      openInNewTab(srcdoc.replace(/<style id="_fw_stripe">[\s\S]*?<\/style>/i, ""), "text/html;charset=utf-8");
      return;
    }

    /* === Doc Surface: build from the current committed controls === */
    var engine = DOC_ENGINES[currentDocEngine] || DOC_ENGINES.none;
    var contentForRender = applyFlatWritePdfBreaks(
      stripYamlFrontMatter(editor.value || ""),
      currentDocEngine
    );
    var rawHTML = renderToFragment(contentForRender);
    var renderedHTML0 = sanitizeHTML(resolveRelativeUrls(rawHTML));
    finalizeMathHtml(renderedHTML0).then(function (renderedHTML) {
    var chapterMatch = renderedHTML.match(/<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>/i);
    var chapterTitle = chapterMatch ? chapterMatch[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : "";

    /* Engine script tag — self-paginating HTML export (skip ESM modules) */
    var engineScript = (engine && engine.script && !engine.module)
      ? '  <script src="' + engine.script + '" defer><' + '/script>\n'
      : '';

    var html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
      + '  <meta charset="UTF-8">\n'
      + '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
      + '  <title>FlatWrite Export</title>\n'
      + '  <base target="_blank" rel="noopener noreferrer">\n'
      + '  <link href="' + FONT_STYLESHEET_URL + '" rel="stylesheet">\n'
      + mathHeadAssets()
      + engineScript
      + '  <style>\n'
      + '    ' + buildDocumentCSS(currentDocEngine) + buildFooterCSS(currentDocEngine, chapterTitle) + mathBodyCss() + '\n'
      + '  </style>\n'
      + '</head>\n<body>\n  <main><div class="fw-column-flow">\n'
      + renderedHTML
      + '\n  </div></main>\n'
      + '</body>\n</html>';

    openInNewTab(html, "text/html;charset=utf-8");
    });
  }

  function buildEnginePrintSnapshot(sourceDocument, engineKey) {
    if (!sourceDocument) return "";
    var clone = sourceDocument.documentElement.cloneNode(true);
    clone.querySelectorAll("script, #_fw_stripe, #_fw_kill_borders, link[rel=\"modulepreload\"]").forEach(function (node) {
      node.remove();
    });

    /* The preview already contains the final logical pages. Printing that
       snapshot avoids asking either engine to paginate an already-paginated
       document (the old n × n blank-page failure). */
    var body = clone.querySelector("body");
    if (body) {
      body.removeAttribute("style");
      body.className = "fw-print-snapshot engine-" + engineKey;
    }
    var html = clone;
    html.removeAttribute("style");

    var pagesFlow = clone.querySelector(".pagedjs_pages");
    if (pagesFlow) {
      pagesFlow.removeAttribute("style");
      /* `:scope > .pagedjs_page` restricts to direct children of the
         engine-owned flow container. The sanitizer allows class="pagedjs_page"
         on arbitrary user HTML, so a clone-wide descendant search would
         also catch user-authored .pagedjs_page divs sitting inside <main>
         and inflate the page count. The previous looser filter inside the
         pageBoxes loop only attempted to compensate after the fact. */
      pagesFlow.querySelectorAll(":scope > .pagedjs_page").forEach(function (page) {
        page.removeAttribute("style");
      });
    }

    var spread = clone.querySelector("[data-vivliostyle-spread-container]");
    if (spread) spread.removeAttribute("style");
    var outerZoom = clone.querySelector("[data-vivliostyle-outer-zoom-box]");
    if (outerZoom) outerZoom.removeAttribute("style");
    var viewport = clone.querySelector("#vivl-viewport");
    if (viewport) viewport.removeAttribute("style");
    /* Remove only FlatWrite's known preview-only Vivliostyle styles. Keep the
       engine's generated layout stylesheets: their page-box selectors are
       required by the cloned DOM and print CSS overrides zoom/geometry below. */
    if (engineKey === "vivliostyle") {
      var vivlShellStyle = clone.querySelector("#_fw_vivl_shell");
      if (vivlShellStyle) vivlShellStyle.remove();
    }
    /* Remove Vivliostyle's dynamically injected scroll/zoom style element.
       This <style id="vivl-scroll-style"> contains transform: scale() and
       other overrides that would distort the print snapshot. The print
       snapshot CSS (appended below) provides its own clean page geometry. */
    var vivlScrollStyle = clone.querySelector("#vivl-scroll-style");
    if (vivlScrollStyle) vivlScrollStyle.remove();

    /* Collect Vivliostyle page containers from the engine-owned spread
       root only — direct children via :scope >. The sanitizer allows
       data-* attributes on arbitrary elements, so a clone-wide descendant
       search for [data-vivliostyle-page-container] would catch user-
       authored elements and pollute page count + style stripping. */
    var vivliostylePages = [];
    if (spread) {
      vivliostylePages = Array.prototype.slice.call(
        spread.querySelectorAll(":scope > [data-vivliostyle-page-container]")
      );
      vivliostylePages.forEach(function (page) {
        page.removeAttribute("style");
        /* Selectively remove Vivliostyle-injected layout overrides from
           descendants while preserving author styles (the sanitizer allows
           inline style attributes, so users may have legitimate styles).
           We only strip properties that Vivliostyle uses for zoom/transform
           and page-box sizing — transform, zoom, width, height, position,
           top, left, right, bottom — leaving all other inline styles intact.

           Page-margin boxes (@bottom-left, @bottom-right, etc.) are the one
           exception: Vivliostyle positions and sizes them with exactly the
           same inline properties (position: absolute; left/right/top/bottom;
           width/height) that this pass strips. Stripping those turns every
           margin box into a static, full-width flex child that stacks
           vertically instead of sitting in its own corner — the footer's
           "Page N of M" ends up rendered directly on top of the chapter
           title. Skip margin boxes (and anything inside them) so their
           positioning survives into the print snapshot. */
        page.querySelectorAll("[style]").forEach(function (child) {
          if (child.closest("[data-vivliostyle-page-margin-box]")) return;
          var style = child.getAttribute("style") || "";
          var cleaned = style.replace(
            /\b(transform|zoom|width|height|position|top|left|right|bottom)\s*:\s*[^;]+;?/gi,
            ""
          ).replace(/;\s*;+/g, ";").replace(/^\s+|\s+$/g, "");
          if (cleaned) {
            child.setAttribute("style", cleaned);
          } else {
            child.removeAttribute("style");
          }
        });
      });
    }
    var pageMm = PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
    var printPageW = orientation === "landscape" ? pageMm[1] : pageMm[0];
    var printPageH = orientation === "landscape" ? pageMm[0] : pageMm[1];
    var pageGeometry = "width: " + printPageW + "mm !important; height: " + printPageH + "mm !important;";
    var lrMm = MARGIN_MAP[pageMarginsLR] || MARGIN_MAP.normal;
    var tbMm = MARGIN_MAP[pageMarginsTB] || MARGIN_MAP.normal;

    /* Count committed page boxes so the footer's "Page N of M" can use a
       static total. counter(pages) only resolves when a CSS pagination
       engine runs, but the print snapshot is emitted as static HTML for
       window.print() — so replace it with the actual count.
       pagesWithContent is the same node list AFTER culling empty
       pages (a paged.js artifact where wide content + column layout
       overflows into an intermediate box with no .pagedjs_area in it).
       Those phantom pages must NOT contribute to the public page count,
       which the footer's "Page N of M" relies on. */

    /* Engine-rooted candidate set, NOT clone-wide. The previous code
       queried '.pagedjs_page, [data-vivliostyle-page-container]' across
       the entire cloned document and tried to filter after the fact,
       using class-list membership as a provenance signal. The sanitizer
       permits class="pagedjs_page" and data-vivliostyle-page-container on
       arbitrary user-authored elements, so user HTML could inflate /
       deflate pageCount, dictate phantom-page culling decisions, and
       cause the wrong nodes to be removed or retained in the snapshot.
       Scoping to the engine-emitted containers (.pagedjs_pages and
       [data-vivliostyle-spread-container]) makes the candidate set safe
       regardless of what the user wrote. */
    var pagedPages = pagesFlow
      ? Array.prototype.slice.call(
          pagesFlow.querySelectorAll(":scope > .pagedjs_page")
        )
      : [];
    var allPageBoxes = pagedPages.concat(vivliostylePages);

    var pagesWithContent = allPageBoxes.filter(function (box) {
      if (box.classList.contains("pagedjs_page")) {
        var sheet = box.querySelector(":scope > .pagedjs_sheet");
        var pagebox = sheet ? sheet.querySelector(":scope > .pagedjs_pagebox") : null;
        if (!sheet || !pagebox) return false;
        /* An empty page renders only the margin grid; the .pagedjs_area
           is absent. We treat those as phantom pages. */
        if (!pagebox.querySelector(":scope > .pagedjs_area")) return false;
      } else if (box.hasAttribute("data-vivliostyle-page-container")) {
        if (!box.querySelector("[data-vivliostyle-page-margin-box], main, .pagedjs_area")) return false;
      } else {
        /* The engine-rooted candidates above only contain elements whose
           classList contains "pagedjs_page" or which carry the
           data-vivliostyle-page-container attribute (those are exactly
           what we queried). Anything else would indicate a bug in the
           scoping above. */
        return false;
      }
      return true;
    });
    /* Drop the phantoms so the printed page count matches what the user
       sees — and so the footer's "Page N of M" denominator is accurate. */
    allPageBoxes.forEach(function (box) {
      if (pagesWithContent.indexOf(box) === -1) box.remove();
    });
    var pageCount = pagesWithContent.length;
    if (pageCount === 0) {
      throw new Error("The pagination engine produced no printable pages");
    }
    /* Chrome's @page margin must be 0 for the print snapshot because each
       .pagedjs_page in the body is already sized to the FULL physical page
       (e.g. 420mm x 297mm) with paged.js's own content margins accounted for
       via the inner .pagedjs_pagebox. Adding margins here (e.g. "30mm 20mm")
       shrinks Chrome's printable area below the full page height, so each
       .pagedjs_page spills onto a second Chrome PDF page — producing 10 pages
       instead of 5 when footer is on (which was the historical
       `grossly misaligned` PDF symptom). The footer lives in
       .pagedjs_page .pagedjs_margin-bottom-left with `position: absolute;
       bottom: 0`, so it stays anchored at the page bottom regardless of
       @page margin. */
    var footerMargin = "0";
    var printCss = document.createElement("style");
    printCss.id = "_fw_print_snapshot";
    printCss.textContent =
      "@page { size: " + printPageW + "mm " + printPageH + "mm; margin: " + footerMargin + "; }" +
      "html, body { margin: 0 !important; padding: 0 !important; width: auto !important; height: auto !important; overflow: visible !important; background: #fff !important; }" +
      ".pagedjs_pages, [data-vivliostyle-spread-container], [data-vivliostyle-outer-zoom-box] { display: block !important; width: auto !important; height: auto !important; min-width: 0 !important; transform: none !important; zoom: 1 !important; }" +
      ".pagedjs_page, [data-vivliostyle-page-container] { " + pageGeometry + " display: block !important; position: relative !important; margin: 0 !important; border: 0 !important; outline: 0 !important; box-shadow: none !important; overflow: hidden !important; transform: none !important; break-after: page !important; page-break-after: always !important; }" +
      ".pagedjs_page:last-child, [data-vivliostyle-page-container]:last-child { break-after: auto !important; page-break-after: auto !important; }" +
      "#vivl-viewport { width: auto !important; height: auto !important; overflow: visible !important; }" +
      "@media screen { .pagedjs_page, [data-vivliostyle-page-container] { margin: 10px auto !important; } }" + "@media print { .pagedjs_page, [data-vivliostyle-page-container] { margin: 0 !important; } }";
    /* When footer is on, add CSS to position the margin-box elements that
       Paged.js/Vivliostyle already rendered into the page DOM. The
       @bottom-* at-rules were stripped (browser native print does not
       support them), so we need explicit positioning for the rendered
       footer elements (.pagedjs_margin-bottom-left, .pagedjs_margin-bottom-right).
       These elements exist in the cloned DOM as children of each page
       box, but without the @page margin-box rules they lose their
       positioning. We pin them to the bottom margin area. */
    if (showFooter) {
      /* Pin the footer to the bottom of every page. The CSS must defeat
         *any* transform inherited from the preview (zoom on .pagedjs_pages,
         animation, or a future container) and must not get clipped by the
         page's overflow: hidden when its content height is taller than the
         computed font-size. Stacking at z-index 1 keeps it above the page
         area even if a future rule adds a full-bleed background there. */
      printCss.textContent +=
        ".pagedjs_page .pagedjs_margin-bottom-left, .pagedjs_page .pagedjs_margin-bottom-right {" +
        "position: absolute !important; bottom: 0 !important; left: auto !important; right: auto !important;" +
        "font-size: 8px !important; color: #666 !important; width: auto !important; height: auto !important;" +
        "max-width: 45% !important; overflow: visible !important; transform: none !important; writing-mode: horizontal-tb !important;" +
        "z-index: 1 !important; }" +
        ".pagedjs_page .pagedjs_margin-bottom-left { left: 0 !important; text-align: left !important; }" +
        ".pagedjs_page .pagedjs_margin-bottom-right { right: 0 !important; text-align: right !important; }" +
        ".pagedjs_page .pagedjs_margin-bottom-left .pagedjs_margin-content," +
        ".pagedjs_page .pagedjs_margin-bottom-right .pagedjs_margin-content {" +
        "display: inline-block !important; max-width: 100% !important; white-space: normal !important;" +
        "word-break: break-word !important; }";
    }
    clone.querySelector("head").appendChild(printCss);

    /* Replace counter(pages) in all cloned styles with the static page count.
       The snapshot is printed via window.print() (browser native), which does
       not run Paged.js/Vivliostyle pagination — so counter(pages) stays 0
       and footers read "Page N of 0". */
    clone.querySelectorAll("style").forEach(function (style) {
      if (style.id === "_fw_print_snapshot") return;
      var text = style.textContent;
      if (text.indexOf("counter(pages)") !== -1) {
        style.textContent = text.split("counter(pages)").join(String(pageCount));
      }
        /* Strip CSS Paged Media margin-box rules (@bottom-left, @bottom-right,
           @top-left, etc.) from the cloned styles. The browser's native print
           (which window.print() uses) does not support these at-rules. When
           present, some browsers discard the entire @page block — including
           size and margin — which breaks page sizing for every page. The print
           snapshot CSS (appended separately) already provides the correct
           @page size and margin.

           We remove the margin-box at-rules directly rather than parsing the
           @page block, because @page can contain nested braces (e.g.,
           @page { @bottom-left { ... } }) that break single-level regex
           matching. By targeting only the @bottom- and @top- at-rules with a
           non-greedy pattern, we preserve the @page block's size and margin
           declarations regardless of nesting. */
      if (text.indexOf("@bottom-") !== -1 || text.indexOf("@top-") !== -1) {
        style.textContent = style.textContent.replace(/@(?:bottom|top)-(?:left|center|right)\s*\{[\s\S]*?\}/g, "");
      }
    });

    var printScript = sourceDocument.createElement("script");
    printScript.textContent = "window.addEventListener('load',function(){var f=document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve();f.then(function(){setTimeout(function(){window.print();},100);});});";
    clone.querySelector("body").appendChild(printScript);
    return "<!DOCTYPE html>\n" + clone.outerHTML;
  }

  function buildPagedPrintSnapshot(sourceDocument) {
    return buildEnginePrintSnapshot(sourceDocument, "pagedjs");
  }

  function buildVivliostylePrintSnapshot(sourceDocument) {
    return buildEnginePrintSnapshot(sourceDocument, "vivliostyle");
  }

  function buildPrintSnapshot(sourceDocument, engineKey) {
    if (engineKey === "pagedjs") return buildPagedPrintSnapshot(sourceDocument);
    if (engineKey === "vivliostyle") return buildVivliostylePrintSnapshot(sourceDocument);
    throw new Error("Choose a pagination engine before exporting PDF");
  }

  function exportPDF() {
    if (surfaceMode === "doc" && !syncDocumentSettingsFromControls()) return;
    /* === App Surface: Simple print === */
    if (surfaceMode === "app") {
      /* In App mode, just trigger the browser print dialog */
      if (mode === "preview" || mode === "read") {
        previewFrame.contentWindow.print();
      } else {
        window.print();
      }
      return;
    }

    /* Print the already-committed logical pages exactly once. Never feed
       generated `.pagedjs_page` / Vivliostyle page boxes back through the
       pagination engine: that is what created n² print-preview pages. */
    var sourceDocument = isCurrentPreviewCommitted() ? previewFrame.contentDocument : null;
    var printHtml = "";
    try {
      printHtml = buildPrintSnapshot(sourceDocument, currentDocEngine);
    } catch (err) {
      showToast(err && err.message ? err.message : "Could not build the PDF snapshot");
      return;
    }
    if (!printHtml || (mode !== "preview" && mode !== "read")) {
      showToast("Open View and wait for pagination before exporting PDF");
      return;
    }
    /* Open the print snapshot in a popup sized to the page, not the
       preview iframe. The previous code used the iframe's bounding rect
       as the window dimensions, which constrained the popup to ~800x600
       and clipped all but the first page of a multi-page document. */
    var pageW = getPageWidthPx();
    var pageH = getPageHeightPx();
    var popupW = Math.round(pageW + 40);
    var popupH = Math.min(Math.round(pageH + 80), window.innerHeight - 40);
    var features = "width=" + popupW + ",height=" + popupH + ",resizable=yes,scrollbars=yes";
    var blob = new Blob([printHtml], { type: "text/html;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    window.open(url, "_blank", features);
  }

  /* ==========================================================================
     Font dropdown builder
     ========================================================================== */

  function buildFontDropdown() {
    if (!fontPickerList) {
      fontPickerList = document.createElement("div");
      fontPickerList.className = "font-dropdown-list hidden";
      document.body.appendChild(fontPickerList);
    }
    fontPickerList.innerHTML = "";
    COMFORT_FONTS.forEach(function (f) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "font-dropdown-item" + (f.value === comfortFont ? " selected" : "");
      item.dataset.font = f.value;
      item.textContent = f.label;
      item.style.fontFamily = '"' + f.value + '", system-ui, sans-serif';
      fontPickerList.appendChild(item);
    });
  }

  /* ==========================================================================
     App framework dropdown and component picker
     ========================================================================== */

  function buildAppFrameworkDropdown() {
    var list = document.getElementById("fw-dropdown-list");
    if (!list) {
      list = document.createElement("div");
      list.id = "fw-dropdown-list";
      list.className = "fw-dropdown-list hidden";
      document.body.appendChild(list);
    }
    list.innerHTML = "";
    var keys = Object.keys(APP_FRAMEWORKS);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var fw = APP_FRAMEWORKS[key];
      var item = document.createElement("button");
      item.type = "button";
      item.className = "fw-dropdown-item" + (key === currentAppFramework ? " selected" : "");
      item.dataset.fw = key;
      item.textContent = fw.label;
      list.appendChild(item);
    }
    var label = document.getElementById("fw-dropdown-label");
    if (label) label.textContent = APP_FRAMEWORKS[currentAppFramework] ? APP_FRAMEWORKS[currentAppFramework].label : currentAppFramework;
  }

  function renderComponentGrid() {
    var grid = document.getElementById("components-grid");
    if (!grid) return;
    grid.innerHTML = "";
    for (var i = 0; i < APP_COMPONENTS.length; i++) {
      var comp = APP_COMPONENTS[i];
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "comp-btn";
      btn.dataset.component = comp.id;
      btn.title = comp.label;
      btn.textContent = comp.label;
      grid.appendChild(btn);
    }
  }

  function insertComponent(componentId) {
    var comp = null;
    for (var i = 0; i < APP_COMPONENTS.length; i++) {
      if (APP_COMPONENTS[i].id === componentId) { comp = APP_COMPONENTS[i]; break; }
    }
    if (!comp) return;
    var snippet = comp.snippets[currentAppFramework] || comp.snippets.spectre || "";
    if (!snippet) return;
    if (mode !== "edit") setMode("edit");
    editorInsertBlock(snippet);
  }

  /* ==========================================================================
     Load from URL modal
     ========================================================================== */

  function loadFromUrlModal() {
    var overlay  = document.getElementById("load-modal-overlay");
    var urlInput = document.getElementById("load-url-input");
    var status   = document.getElementById("load-url-status");
    var btnFetch = document.getElementById("load-modal-insert");
    var btnCancel = document.getElementById("load-modal-cancel");
    var btnClose  = document.getElementById("load-modal-close");
    if (!overlay || !urlInput) return;

    var returnFocusTo = document.activeElement;
    urlInput.value = "";
    status.textContent = "";
    status.className = "load-url-status";
    overlay.classList.remove("hidden");
    urlInput.focus();

    function close() {
      overlay.classList.add("hidden");
      if (returnFocusTo && typeof returnFocusTo.focus === "function") {
        returnFocusTo.focus();
      }
    }

    /**
     * POST a webpage URL to /api/import-url (which proxies markdown.new)
     * and load the returned markdown into the editor. Reuses the same
     * dirty-check + setEditorContent + renderPreview flow as every other
     * load path so there is no parallel document model.
     *
     * No method/retain-images pickers are exposed in the UI — markdown.new
     * already knows how to pick the right conversion strategy for a given
     * page. We ask once for "auto" with images retained; markdown.new owns
     * the internal escalation chain for JS-heavy sites.
     */
    function addBrowserRetry(url) {
      var retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn btn-mode load-url-try-browser";
      retry.textContent = "Try browser rendering";
      retry.addEventListener("click", function () { doImportWebpage(url, "browser"); });
      status.appendChild(document.createTextNode(" "));
      status.appendChild(retry);
    }

    function doImportWebpage(url, method) {
      method = method === "browser" ? "browser" : "auto";
      status.textContent = method === "browser" ? "Trying browser rendering…" : "Importing webpage…";
      status.className = "load-url-status loading";
      btnFetch.disabled = true;

      fetch("/api/import-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url, method: method, retain_images: true }),
      })
        .then(function (res) {
          return res.json().catch(function () { return null; }).then(function (data) {
            return { ok: res.ok, status: res.status, data: data };
          });
        })
        .then(function (result) {
          var succeeded = result.ok && result.data && result.data.ok === true && result.data.document;
          btnFetch.disabled = false;
          if (!succeeded) {
            var friendly = (result.data && result.data.error) || "Could not import this page.";
            status.textContent = friendly;
            status.className = "load-url-status error";
            if (method === "auto") addBrowserRetry(url);
            return;
          }

          var doc = result.data.document;
          if (isEditorDirty()) {
            var okReplace = confirm("Replace current content with imported page?");
            if (!okReplace) return;
          }
          close();
          var importedMarkdown = rewriteMarkdownUrls(doc.content, doc.sourceUrl);
          if (window.FlatwriteUrlRouting) {
            importedMarkdown = window.FlatwriteUrlRouting.ensureMarkdownH1(importedMarkdown, doc.title);
          }
          setEditorContent(importedMarkdown);
          // Root-relative and relative image/link paths are common in
          // markdown.new's output (e.g. "/library/originals/photo.jpg").
          // Reuse the same base-URL resolution the GitHub/file-URL load
          // paths already rely on (see setMarkdownUrl/resolveRelativeUrls)
          // so these paths get prefixed with the source page's origin
          // instead of resolving against flatwrite.md and 404ing.
          setMarkdownUrl(doc.sourceUrl);
          mathPromptDismissed = false;
          maybePromptMathMode(importedMarkdown);
          if (mode !== "edit") renderPreview();
          showToast("Imported \u201c" + (doc.title || doc.sourceUrl) + "\u201d");
        })
        .catch(function (err) {
          btnFetch.disabled = false;
          status.textContent = "Could not import this page. Check the URL and try again.";
          status.className = "load-url-status error";
          if (method === "auto") addBrowserRetry(url);
          console.error("[import-url]", err);
        });
    }

    function doFetch() {
      var url = urlInput.value.trim();
      if (!url) { status.textContent = "Enter a URL"; status.className = "load-url-status error"; return; }

      status.textContent = "Loading…";
      status.className = "load-url-status loading";
      btnFetch.disabled = true;

      // Derive a filename from the URL so we can route through the
      // same dispatcher as drops / disk picks. Falls back to "remote"
      // if the URL has no recognizable basename.
      var filename = deriveFilenameFromUrl(url);

      var initialRoute = decideUrlRoute(url, "");
      if (initialRoute === "import") {
        doImportWebpage(url);
        return;
      }

      // Fetch once so extensionless URLs can be routed by response
      // Content-Type. Known raw/file URLs still remain on the direct path.
      fetch(rewriteGitHubUrl(url))
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          var route = decideUrlRoute(url, res.headers.get("Content-Type") || "");
          if (route === "import") {
            doImportWebpage(url);
            return null;
          }
          return res.blob();
        })
        .then(function (blob) {
          if (!blob) return;
          btnFetch.disabled = false;
          close();
          // Wrap the Blob in a File so the dispatcher's filename
          // logic works as if the user had picked it from disk.
          var file = new File([blob], filename, { type: blob.type || "" });
          var route = window.FlatwriteExtractDrop
            ? window.FlatwriteExtractDrop.routeDroppedFile(file.name)
            : routeDroppedFileInline(file.name);
          if (route === "plain") {
            // .md/.markdown/.txt — read as text directly. handleFileUpload
            // also handles the dirty-check + renderPreview() in non-edit
            // modes.
            handleFileUpload(file);
            showToast("Loaded markdown from URL");
          } else {
            handleExtractDrop(file);
          }
        })
        .catch(function (err) {
          if (initialRoute === "probe") {
            doImportWebpage(url);
            return;
          }
          btnFetch.disabled = false;
          var detail = err && err.message ? err.message : "";
          status.textContent = "Could not load. Check the URL and try again."
            + (detail ? " (" + detail + ")" : "");
          status.className = "load-url-status error";
          console.error("[load-url]", err);
        });
    }

    /* Remove any previous listeners by replacing the buttons, then
       re-point our references at the live clones. Without the reassignment
       doFetch()/close() would capture the DETACHED originals, so
       btnFetch.disabled would toggle a node that is no longer in the DOM
       and the visible Fetch button would stay enabled (duplicate submits). */
    var newFetch = btnFetch.cloneNode(true);
    var newCancel = btnCancel.cloneNode(true);
    var newClose = btnClose.cloneNode(true);
    btnFetch.parentNode.replaceChild(newFetch, btnFetch);
    btnCancel.parentNode.replaceChild(newCancel, btnCancel);
    btnClose.parentNode.replaceChild(newClose, btnClose);
    btnFetch = newFetch;
    btnCancel = newCancel;
    btnClose = newClose;

    newFetch.addEventListener("click", doFetch);
    newCancel.addEventListener("click", close);
    newClose.addEventListener("click", close);
    doFetchLatest = doFetch;
    closeLatest = close;

    /* urlInput and overlay are not cloned, so their listeners would
       accumulate on every open. Bind them exactly once. */
    if (!overlay.dataset.fwBound) {
      overlay.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && e.target === urlInput) {
          e.preventDefault();
          doFetchLatest();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeLatest();
          return;
        }
        if (e.key !== "Tab") return;
        var focusable = overlay.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) closeLatest();
      });
      overlay.dataset.fwBound = "1";
    }
  }

  /* The keydown/overlay listeners are bound once but must always call the
     CURRENT modal invocation's handlers. loadFromUrlModal reassigns these
     on each open. */
  var doFetchLatest = function () {};
  var closeLatest = function () {};

  /* ==========================================================================
     Toast feedback
     ========================================================================== */

  function getToastStack() {
    var stack = document.querySelector(".fw-toast-stack");
    if (stack) return stack;
    stack = document.createElement("div");
    stack.className = "fw-toast-stack";
    /* Live region so screen readers announce transient outcomes
       (share failure, load/export errors, validation) that are
       otherwise visual-only. */
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    stack.setAttribute("aria-atomic", "true");
    // Anchored to the editor/preview surface (bottom-center) rather than
    // the viewport — falls back to <body> if that wrapper is missing.
    (mainPanelWrapper || document.body).appendChild(stack);
    return stack;
  }

  function showToast(message) {
    var toast = document.createElement("div");
    toast.className = "fw-toast";
    toast.textContent = message;
    getToastStack().appendChild(toast);
    toast.offsetHeight;
    toast.classList.add("fw-toast-visible");
    setTimeout(function () {
      toast.classList.remove("fw-toast-visible");
      setTimeout(function () { if (toast.parentNode) toast.remove(); }, 300);
    }, 2500);
  }

  /* ==========================================================================
     WebMCP editor bridge — exposes editor state and actions to
     webmcp.js via window.__flatwrite so browser-side MCP tools
     (get_document_state, create_document, open_document, etc.) can
     interact with the editor without DOM scraping.
     ========================================================================== */

  var fwStateVersion = 0;
  var fwDocumentId = "";

  function fwEnsureDocumentId() {
    if (!fwDocumentId) {
      if (currentMarkdownUrl) {
        fwDocumentId = "url:" + btoa(currentMarkdownUrl).replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
      } else {
        fwDocumentId = "doc-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      }
    }
    return fwDocumentId;
  }

  function fwExtractTitle(md) {
    if (!md) return "Untitled";
    var m = md.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : "Untitled";
  }

  function fwBuildShareContent() {
    return buildShareYaml() + editor.value;
  }

  /* ── Helpers for openDocument (extracted for clarity) ─────────────── */

  function fwFetchText(url) {
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw { code: "OPEN_FAILED", message: "HTTP " + r.status };
        return r.text();
      })
      .catch(function (e) {
        throw e.code ? e : { code: "OPEN_FAILED", message: e.message || String(e) };
      });
  }

  function fwApplyContent(content, sourceUrl, opts) {
    opts = opts || {};
    var documentContent = content;
    if (opts.isShare) {
      var parsed = parseShareYaml(content);
      documentContent = parsed.body;
      if (parsed.frontmatter) {
        /* Share path uses the same hydration helper as loadSharedDocument
           so a typo or unknown key silently keeps the prior state instead
           of stomping unrelated globals. applyFrontmatter also syncs the
           form controls so the dropdown always matches the active state. */
        applyFrontmatter(parsed.frontmatter);
        setDocEngine(currentDocEngine);
      }
      setMarkdownUrl("");
    } else {
      setMarkdownUrl(sourceUrl);
    }
    setEditorContent(documentContent);
    fwDocumentId = "";
    fwEnsureDocumentId();
    syncMathModeUI();
    mathPromptDismissed = false;
    maybePromptMathMode(documentContent);
    return {
      documentId: fwDocumentId,
      title: fwExtractTitle(documentContent),
      url: sourceUrl,
    };
  }

  window.__flatwrite = {
    getDocumentState: function () {
      var md = editor.value || "";
      var words = md.trim().split(/\s+/).filter(Boolean).length;
      var shareUrl = "";
      try {
        var sParam = new URLSearchParams(window.location.search).get("s");
        if (sParam) shareUrl = window.location.origin + window.location.pathname + "?s=" + sParam;
      } catch (e) { /* ignore */ }
      return {
        documentId: fwEnsureDocumentId(),
        title: fwExtractTitle(md),
        wordCount: words,
        charCount: md.length,
        unsavedChanges: isEditorDirty(),
        renderMode: mode,
        docEngine: currentDocEngine,
        surfaceMode: surfaceMode,
        url: currentMarkdownUrl || shareUrl,
        availableExports: ["html", "pdf", "markdown"],
        canShare: md.length < 400000,
      };
    },

    createDocument: function (markdown, title) {
      editor.value = markdown || "";
      initialEditorContent = markdown || "";
      fwDocumentId = "";
      fwEnsureDocumentId();
      editor.dispatchEvent(new Event("input"));
      if (mode !== "edit") setMode("edit");
      return {
        documentId: fwDocumentId,
        title: title || fwExtractTitle(markdown || ""),
        url: "",
      };
    },

    openDocument: async function (url) {
      if (!url) throw { code: "INVALID_URL", message: "url is required" };
      var sMatch = url.match(/[?&]s=([^&]+)/);
      if (sMatch) {
        var data;
        try {
          var res = await fetch("/api/s?key=" + encodeURIComponent(sMatch[1]));
          data = await res.json();
        } catch (e) {
          throw { code: "OPEN_FAILED", message: e.message || String(e) };
        }
        if (data.error) throw { code: "OPEN_FAILED", message: data.error };
        return fwApplyContent(data.content || "", url, { isShare: true });
      }
      var content = await fwFetchText(url);
      return fwApplyContent(content, url, { isShare: false });
    },

    updateDocumentContent: function (markdown) {
      setEditorContent(markdown);
      fwStateVersion++;
      return {
        documentId: fwEnsureDocumentId(),
        updatedAt: new Date().toISOString(),
        stateVersion: fwStateVersion,
      };
    },

    listRecentDocuments: async function () {
      /* FlatWrite stores a single active document in IDB. Return it
         along with any URL-loaded document. */
      try {
        var record = await idbGet("activeDocument", "current");
        var docs = [];
        if (record && record.markdown) {
          docs.push({
            documentId: fwEnsureDocumentId(),
            title: fwExtractTitle(record.markdown),
            url: currentMarkdownUrl || "",
            updatedAt: record.updated || new Date().toISOString(),
          });
        }
        return docs;
      } catch (e) {
        return [];
      }
    },

    renderPreview: function () {
      if (mode === "edit") setMode("preview");
      renderPreview();
    },

    /* Browser-initiated export: opens a new tab (HTML) or print
       dialog (PDF). No download URL or page count is reported back
       because the browser handles the output, not the server. */
    exportHTML: function () {
      exportHTML();
      return { documentId: fwEnsureDocumentId() };
    },

    exportPDF: function () {
      exportPDF();
      return { documentId: fwEnsureDocumentId() };
    },

    createShareLink: async function () {
      var content = fwBuildShareContent();
      if (content.length > 400000) {
        throw { code: "TOO_LARGE", message: "Document too large to share" };
      }
      var res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: content,
      });
      if (!res.ok) throw { code: "SHARE_FAILED", message: "HTTP " + res.status };
      var data = await res.json();
      if (data.error) throw { code: "SHARE_FAILED", message: data.error };
      var shareUrl = window.location.origin + window.location.pathname + "?s=" + data.key;
      return {
        documentId: fwEnsureDocumentId(),
        shareUrl: shareUrl,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      };
    },

    /**
     * Morph AI assist — returns { markdown, piece, scope, ... } without applying.
     * Callers (UI / WebMCP) should confirm before writing via updateDocumentContent.
     */
    assistDocument: async function (opts) {
      return runAssistRequest(opts || {});
    },
  };

  /* ==========================================================================
     Morph AI Assist
     ========================================================================== */

  var ASSIST_URL = "https://assist.flatwrite.md/assist";
  var ASSIST_TOKEN_URL = "https://assist.flatwrite.md/mcp-token";
  var assistCachedToken = null;
  var assistInflightToken = null;
  var assistPending = null; // last successful result awaiting Accept
  var assistMode = "rewrite";

  async function getAssistToken() {
    if (assistCachedToken && assistCachedToken.expiresAt > Math.floor(Date.now() / 1000) + 10) {
      return assistCachedToken;
    }
    if (assistInflightToken) return assistInflightToken;
    assistInflightToken = (async function () {
      var res = await fetch(ASSIST_TOKEN_URL, { method: "POST" });
      if (!res.ok) {
        var errText = await res.text().catch(function () { return ""; });
        throw new Error("Token mint failed (" + res.status + ")" + (errText ? ": " + errText.slice(0, 120) : ""));
      }
      var data = await res.json();
      assistCachedToken = { token: data.token, expiresAt: data.expiresAt };
      return assistCachedToken;
    })();
    try {
      return await assistInflightToken;
    } finally {
      assistInflightToken = null;
    }
  }

  function getAssistSelection() {
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    if (typeof start !== "number" || typeof end !== "number" || end <= start) return null;
    return { start: start, end: end, text: editor.value.slice(start, end) };
  }

  function updateAssistScopeHint() {
    var el = document.getElementById("assist-scope-hint");
    if (!el) return;
    var sel = getAssistSelection();
    if (sel) {
      el.textContent = "Selection (" + sel.text.length + " chars)";
    } else {
      el.textContent = "Whole document";
    }
  }

  function setAssistOpen(open) {
    var panel = document.getElementById("assist-panel");
    var btn = document.getElementById("btn-assist");
    if (!panel || !btn) return;
    if (open) {
      panel.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
      updateAssistScopeHint();
    } else {
      panel.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    }
  }

  function setAssistStatus(msg, isError) {
    var el = document.getElementById("assist-status");
    if (!el) return;
    el.textContent = msg || "";
    if (isError) el.classList.add("error");
    else el.classList.remove("error");
  }

  function showAssistResult(result) {
    var box = document.getElementById("assist-result");
    var meta = document.getElementById("assist-result-meta");
    var pre = document.getElementById("assist-result-preview");
    if (!box || !meta || !pre) return;
    assistPending = result;
    var bits = [];
    if (result.model) bits.push(result.model);
    if (result.routing && result.routing.tier) bits.push("tier:" + result.routing.tier);
    if (result.explanation) bits.push(result.explanation);
    meta.textContent = bits.join(" · ");
    pre.textContent = result.piece || result.markdown || "";
    box.classList.remove("hidden");
  }

  function clearAssistResult() {
    assistPending = null;
    var box = document.getElementById("assist-result");
    if (box) box.classList.add("hidden");
  }

  async function runAssistRequest(opts) {
    var mode = (opts && opts.mode) || assistMode || "rewrite";
    var instruction = (opts && typeof opts.instruction === "string")
      ? opts.instruction
      : ((document.getElementById("assist-instruction") || {}).value || "");
    var markdown = (opts && typeof opts.markdown === "string") ? opts.markdown : (editor.value || "");
    var selection = opts && opts.selection !== undefined ? opts.selection : getAssistSelection();

    if (!markdown.trim()) {
      throw { code: "EMPTY_DOCUMENT", message: "Document is empty" };
    }
    if (mode === "custom" && !String(instruction).trim()) {
      throw { code: "MISSING_INSTRUCTION", message: "Custom mode needs an instruction" };
    }

    var tok = await getAssistToken();
    var res = await fetch(ASSIST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mcp-Token": tok.token,
      },
      body: JSON.stringify({
        mode: mode,
        instruction: instruction,
        markdown: markdown,
        selection: selection || undefined,
      }),
    });
    var data;
    try {
      data = await res.json();
    } catch (e) {
      throw { code: "BAD_RESPONSE", message: "Assist returned non-JSON (" + res.status + ")" };
    }
    if (!res.ok || !data.ok) {
      var err = (data && data.error) || {};
      throw {
        code: err.code || "ASSIST_FAILED",
        message: err.message || ("Assist failed (" + res.status + ")"),
        retryable: Boolean(err.retryable),
      };
    }
    return data;
  }

  async function onAssistRun() {
    var runBtn = document.getElementById("assist-run");
    clearAssistResult();
    setAssistStatus("Running…");
    if (runBtn) runBtn.disabled = true;
    try {
      var result = await runAssistRequest({ mode: assistMode });
      showAssistResult(result);
      setAssistStatus("Ready — Accept to apply");
    } catch (e) {
      setAssistStatus((e && e.message) || String(e), true);
    } finally {
      if (runBtn) runBtn.disabled = false;
    }
  }

  function onAssistAccept() {
    if (!assistPending || !assistPending.markdown) return;
    setEditorContent(assistPending.markdown);
    clearAssistResult();
    setAssistStatus("Applied");
    setAssistOpen(false);
  }

  function bindAssistUi() {
    var btn = document.getElementById("btn-assist");
    var close = document.getElementById("assist-close");
    var run = document.getElementById("assist-run");
    var accept = document.getElementById("assist-accept");
    var discard = document.getElementById("assist-discard");
    var modes = document.getElementById("assist-modes");
    if (!btn) return;

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      showToast("AI Assist is coming soon!");
    });
    if (close) close.addEventListener("click", function () { setAssistOpen(false); });
    if (run) run.addEventListener("click", function () { onAssistRun(); });
    if (accept) accept.addEventListener("click", function () { onAssistAccept(); });
    if (discard) discard.addEventListener("click", function () {
      clearAssistResult();
      setAssistStatus("");
    });
    if (modes) {
      modes.addEventListener("click", function (e) {
        var m = e.target.closest("[data-mode]");
        if (!m) return;
        assistMode = m.getAttribute("data-mode") || "rewrite";
        modes.querySelectorAll(".assist-mode").forEach(function (el) {
          el.classList.toggle("active", el === m);
        });
      });
    }
    editor.addEventListener("select", updateAssistScopeHint);
    editor.addEventListener("keyup", updateAssistScopeHint);
    editor.addEventListener("mouseup", updateAssistScopeHint);
  }

  /* ==========================================================================
     Boot
     ========================================================================== */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
