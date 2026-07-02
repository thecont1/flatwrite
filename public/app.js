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
                    footer: showFooter },
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
      "footer: " + showFooter,
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

    var fm = {};
    match[1].split("\n").forEach(function (line) {
      var idx = line.indexOf(":");
      if (idx === -1) return;
      var key = line.substring(0, idx).trim();
      var val = line.substring(idx + 1).trim();
      fm[key] = val;
    });

    return { frontmatter: fm, body: md.substring(match[0].length) };
  }

  /* ==========================================================================
     Document Engine registry
     Each engine: label, script URL (optional), category.
     ========================================================================== */

  var DOC_ENGINES = {
    pagedjs: { label: "Paged.js", script: "https://unpkg.com/pagedjs/dist/paged.polyfill.js", category: "paged-media" },
    vivliostyle: { label: "Vivliostyle", script: "https://esm.unpkg.com/@vivliostyle/core@2.43.3", category: "css-books", module: true },
    none: { label: "Plain CSS", script: null, category: "unstyled" }
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

  /* Document layout state */
  var pageSize     = "A4";
  var orientation  = "portrait";
  var pageMarginsLR = "normal";
  var pageMarginsTB = "normal";
  var pageColumns  = 1;
  var showFooter   = false;
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

    function resolveAgainst(url) {
      if (!url) return url;
      if (/^(?:https?:|data:|mailto:|#)/i.test(url)) return url;
      if (/^\/\//i.test(url)) return url;
      try {
        return new URL(url, githubBaseUrl).href;
      } catch (e) {
        return url;
      }
    }

    // Image-like src — apply ?raw=true on GitHub
    html = html.replace(
      /<(?:img|video|source)\s[^>]*?src=(["'])([^"']+)\1/gi,
      function (match, q, src) {
        var resolved = resolveAgainst(src);
        if (resolved === src) return match;
        return match.slice(0, match.length - src.length - q.length - 1)
          + "src=" + q + stampRaw(resolved) + q;
      }
    );

    // Anchor href — never stamp ?raw=true (would break link navigation)
    html = html.replace(
      /<a\s[^>]*?href=(["'])([^"']+)\1/gi,
      function (match, q, href) {
        var resolved = resolveAgainst(href);
        if (resolved === href) return match;
        var idx = match.indexOf("href");
        return match.slice(0, idx + 5) + q + resolved + q + match.slice(idx + 6 + href.length);
      }
    );

    return html;
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
    reader.onload = function () {
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
    if (!filename || typeof filename !== "string") return "plain";
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

  var EXTRACT_URL = "https://extract.flatwrite.md/extract";
  var EXTRACT_TOKEN_URL = "https://extract.flatwrite.md/mcp-token";
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
      setEditorContent(data.markdown);
      currentMarkdownUrl = "";
      githubBaseUrl = "";
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
   * Global drag/drop dispatcher. Called from the listeners attached in
   * bindEvents(). Routes .md/.txt/.markdown to handleFileUpload, everything
   * else to handleExtractDrop. Toggles the `drop-target` class on
   * .app-shell so the CSS overlay appears.
   */
  function onDroppedFiles(e) {
    if (!e.dataTransfer || !e.dataTransfer.files) return;
    var files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    // v1 — single file only.
    var file = files[0];
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
        editor.value = data.content; /* keep full source including YAML for IDB + .md export */

        /* Apply preferences from YAML front-matter if present */
        if (parsed.frontmatter) {
          var fm = parsed.frontmatter;
          if (fm.url) setMarkdownUrl(fm.url);
          if (fm.docEngine && DOC_ENGINES[fm.docEngine]) {
            currentDocEngine = fm.docEngine;
          }
          if (fm.surfaceMode === "doc" || fm.surfaceMode === "app") {
            surfaceMode = fm.surfaceMode;
          }
          if (fm.appFramework && APP_FRAMEWORKS[fm.appFramework]) {
            currentAppFramework = fm.appFramework;
          }
          if (fm.pageSize && PAGE_SIZES[fm.pageSize]) pageSize = fm.pageSize;
          if (fm.orientation === "portrait" || fm.orientation === "landscape") orientation = fm.orientation;
          if (fm.marginsLR && MARGIN_MAP[fm.marginsLR]) pageMarginsLR = fm.marginsLR;
          if (fm.marginsTB && MARGIN_MAP[fm.marginsTB]) pageMarginsTB = fm.marginsTB;
          if (fm.footer === "true" || fm.footer === "on") showFooter = true;
          if (fm.font && COMFORT_FONTS.some(function (f) { return f.value === fm.font; })) {
            comfortFont = fm.font;
            fontPickerLabel.textContent = comfortFont;
      fontPickerLabel.style.fontFamily = '"' + comfortFont + '", system-ui, sans-serif';
          }
          if (fm.size !== undefined)   sizeStep   = clampInt(fm.size,   SIZE_MIN,   SIZE_MAX,   sizeStep);
          if (fm.weight !== undefined) weightStep = clampInt(fm.weight, WEIGHT_MIN, WEIGHT_MAX, weightStep);
          if (fm.line !== undefined)   lineStep   = clampInt(fm.line,   LINE_MIN,   LINE_MAX,   lineStep);
          if (fm.width !== undefined)  contentWidth = clampInt(fm.width, 400, 1400, contentWidth);
          if (fm.zoom !== undefined)   zoomStep     = clampInt(fm.zoom, 50, 150, zoomStep);
          zoomSlider.value = zoomStep;
          zoomValue.textContent = zoomStep + "%";
          applyZoom();
          applyContentWidth();
          setDocEngine(currentDocEngine);
        }

        editor.setSelectionRange(0, 0);
        initialEditorContent = data.content;
        lastScrollRatio = 0;
        setMode("read");
        /* Strip ?s= from URL so refresh doesn't re-fetch the shared doc */
        history.replaceState(null, "", window.location.pathname);
      })
      .catch(function () {
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
          "mark","abbr","cite","q","pre","kbd","sup"
        ],
        ALLOWED_ATTR: [
          "href","src","alt","width","height","class","id","type","name",
          "value","placeholder","checked","disabled","for","role",
          "aria-label","aria-hidden","tabindex","colspan","rowspan","style",
          "data-md","data-component","data-tooltip","target","rel","title",
          "open","align","valign","border","cellpadding","cellspacing",
          "start"
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
    return classifyTaskListItems(fixTaskListNumberedItems(marked.parse(markdown)));
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
      if (dl.pageSize && PAGE_SIZES[dl.pageSize]) pageSize = dl.pageSize;
      if (dl.orientation === "portrait" || dl.orientation === "landscape") orientation = dl.orientation;
      if (dl.marginsLR && MARGIN_MAP[dl.marginsLR]) pageMarginsLR = dl.marginsLR;
      if (dl.marginsTB && MARGIN_MAP[dl.marginsTB]) pageMarginsTB = dl.marginsTB;
      if (dl.margins && MARGIN_MAP[dl.margins]) { pageMarginsLR = dl.margins; pageMarginsTB = dl.margins; }
      if (dl.columns)   pageColumns  = clampInt(dl.columns, 1, 3, 1);
      if (dl.footer)    showFooter   = true;
      syncDocControlsUI();
    }).catch(function (err) {
      console.error("IDB restore failed:", err);
    });
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
      btnShare.title = len >= SHARE_CHAR_LIMIT ? "Document too large to share" : "Share as URL";
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
    }
    function closeDrawer() {
      appShell.classList.remove("drawer-open");
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
        syncDocControlsUI();
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
        scheduleAutosave();
        if (mode === "preview" || mode === "read") renderPreview();
      });
    }
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

    mdToolbar.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-md]");
      if (btn) applyMarkdownFormat(btn.dataset.md);
    });

    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (mode === "read") {
          /* Read → View > Plain */
          setMode("preview");
          setDocEngine("none");
        } else if (mode === "preview") {
          setMode("edit");
        }
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
        btns[i].classList.toggle("active", btns[i].dataset.surface === sm);
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
        btn.classList.toggle("active", btn.dataset.engine === engineKey);
      });
    }
    /* Update app-shell engine class */
    var appShell = document.querySelector(".app-shell");
    if (appShell) {
      appShell.classList.remove("engine-pagedjs", "engine-vivliostyle", "engine-none");
      appShell.classList.add("engine-" + engineKey);
    }
    /* Disable PDF export in Plain mode — use a paged engine for PDF */
    var btnPdf = document.getElementById("btn-export-pdf");
    if (btnPdf) btnPdf.disabled = (engineKey === "none");
    var sbPdf = document.getElementById("sidebar-export-pdf");
    if (sbPdf) sbPdf.disabled = (engineKey === "none");
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
      css += ' main { column-count: ' + pageColumns + '; column-gap: ' + gap + '; }';
    }
    /* Always capture the L1 heading so it can be used by the footer */
    css += 'h1 { string-set: chapter content(); }';
    if (showFooter) {
      css += '@page { @bottom-left { content: string(chapter, first); font-size: 8px; color: #888; vertical-align: bottom; padding-bottom: 3mm; }';
      css += ' @bottom-right { content: "Page " counter(page) " of " counter(pages); font-size: 8px; color: #888; vertical-align: bottom; padding-bottom: 3mm; } }';
    }
    return css;
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
    return 'html { background: linear-gradient(135deg' + stops + ') !important; }';
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
    }
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
    /* === App Surface: Framework CSS preview === */
    if (surfaceMode === "app") {
      var fw = APP_FRAMEWORKS[currentAppFramework];
      var contentForRender = stripYamlFrontMatter(editor.value || "");
      var rawHTML = renderToFragment(contentForRender);
      var renderedHTML = sanitizeHTML(resolveRelativeUrls(rawHTML));
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
        + '<style>'
        + fwStyle
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
        + '<' + '/script>'
        + '</body></html>';

      previewFrameNext.srcdoc = html;
      previewFrameNext.onload = function() { swapPreviewFrames(); };
      setTimeout(positionWidthHandles, 250);
      return;
    }

    /* === Doc Surface: Paged.js preview === */
    /* Read mode always renders as Plain — WYSIWYG, no pagination engine */
    var renderEngineKey = (mode === "read") ? "none" : (currentDocEngine || "none");
    var engine = DOC_ENGINES[renderEngineKey] || DOC_ENGINES.none;
    var contentForRender = stripYamlFrontMatter(editor.value || "");
    var rawHTML = renderToFragment(contentForRender);
    var renderedHTML = sanitizeHTML(resolveRelativeUrls(rawHTML));
    var scale = SIZE_SCALE[String(sizeStep)] || 1;
    var weight = WEIGHT_MAP[String(weightStep)] || 400;
    var lineHeight = LINE_SCALE[String(lineStep)] || 1.75;
    var fontStack = "'" + comfortFont + "', system-ui, sans-serif";
    var headWeight = Math.min(weight + 200, 900);

    var scrollRatio = lastScrollRatio;
    var renderId = ++currentRenderId;

    /* Engine script tag — injects Paged.js (or Vivliostyle) when selected */
    var engineScript = (engine && engine.script && !engine.module)
      ? '<script src="' + engine.script + '" defer><' + '/script>'
      : '';

    /* Shared document CSS (without engine-specific page-boundary rules) */
    /* Plain/Read: skip @page, columns and footer — none apply in a WYSIWYG flow */
    var docCss = (renderEngineKey === "none" ? "" : buildPageCSS())
      + '*, *::before, *::after { font-family: ' + fontStack + ' !important; box-sizing: border-box; }'
      + 'body { font-size: ' + (15 * scale) + 'px !important;'
      + ' font-weight: ' + weight + ' !important;'
      + ' line-height: ' + lineHeight + ' !important; color: #2d2a3e;'
      + ' margin: 0; overflow-x: hidden; }'
      + 'html { height: 100%; }'
      + 'h1,h2,h3,h4,h5,h6 { font-weight: ' + headWeight + ' !important; overflow-wrap: break-word; word-break: break-word; }'
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
      + 'li::marker { display: inline; }'
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
      + 'br { margin: 0.3em 0; }'
      + ' .pagedjs_page { margin: 8px 0; }'

    var html;
    if (renderEngineKey === 'vivliostyle') {
      /* Vivliostyle: CoreViewer loads a blob document and paginates it */
      var vivlDocHTML = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
        + '<base target="_blank" rel="noopener noreferrer">'
        + '<link rel="preconnect" href="https://fonts.googleapis.com">'
        + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
        + '<link href="' + FONTS_URL + '" rel="stylesheet">'
        + '<style>' + docCss + '</style>'
        + '</head><body><main>' + renderedHTML + '</main></body></html>';
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
        + stripePlaceholderCss()
        + 'body{background:transparent!important;}#vivl-viewport{width:100%;height:100%;overflow:auto;background:transparent;}[data-vivliostyle-page-container]{border:0.8px solid #000!important;box-sizing:border-box!important;background:#fff!important;box-shadow:none!important;}</style>'
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
        + ' [data-vivliostyle-page-container] { display: block !important; visibility: visible !important; opacity: 1 !important; position: relative !important; overflow: visible !important; margin: 0 auto !important; box-sizing: border-box !important; border: 0.8px solid #000 !important; background: #fff !important; box-shadow: none !important; } [data-vivliostyle-spread-container] { display: flex !important; flex-direction: column !important; height: auto !important; width: max-content !important; min-width: 0 !important; align-items: flex-start !important; zoom: 1 !important; transform-origin: top left !important; background: transparent !important; } [data-vivliostyle-outer-zoom-box] { height: auto !important; width: max-content !important; min-width: 0 !important; background: transparent !important; }";'
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
        + '    spread.style.setProperty("transform", "scale(" + s + ")", "important");'
        + '    spread.style.setProperty("transform-origin", "top left", "important");'
        + '    spread.style.setProperty("min-width", "0", "important");'
        + '    spread.style.width = "";'
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
        + '    /* Keep pages at their natural page size — the parent transform'
        + '       handles visual scaling. This avoids content reflow when the'
        + '       user changes zoom. */'
        + '    pages[i].style.width = _pageW + "px";'
        + '    pages[i].style.height = _pageH + "px";'
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
        + 'function _vivlNotify() {'
        + '  _vivlEnableScroll();'
        + '  var m = viewport.scrollHeight - viewport.clientHeight;'
        + '  if (m > 0) viewport.scrollTop = Math.round(_scrollRatio * m);'
        + '  else viewport.scrollTop = 0;'
        + '  parent.postMessage({type:"vivl-ready", renderId: _renderId}, "*");'
        + '}'
        + 'viewer.addListener("loaded", _vivlNotify);'
        + 'viewer.loadDocument(docUrl);'
        + 'setTimeout(_vivlNotify, 3000);'
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
        + '</script>'
        + '</body></html>';
    } else {
      html = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
        + '<base target="_blank" rel="noopener noreferrer">'
        + '<link rel="preconnect" href="https://fonts.googleapis.com">'
        + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
        + '<link href="' + FONTS_URL + '" rel="stylesheet">'
        + engineScript
        + '<style>'
        + docCss
        + 'html::-webkit-scrollbar { display: none; }'
        + 'html { scrollbar-width: none; -ms-overflow-style: none; }'
        /* --- Page-boundary dashed borders on all four sides --- */
        + '.pagedjs_page { overflow: visible !important; margin: 8px 0 !important; outline: none !important; border: none !important; box-shadow: none !important; background: transparent !important; }'
        + '.pagedjs_sheet { box-sizing: border-box !important; border: 0.8px solid #000 !important; outline: none !important; box-shadow: none !important; }'
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
        + '</head><body class="engine-' + renderEngineKey + '"><main>' + renderedHTML + '</main>'
        + '<script>'
      + 'var _scrollRatio = ' + scrollRatio + ';'
      + 'var _pagedReady = false;'
      + 'var _isPaged = ' + (renderEngineKey !== 'none') + ';'
      + 'var _zoomFactor = 1;'
      + 'var _pageW = ' + getPageWidthPx() + ';'
      + 'var _pageH = ' + getPageHeightPx() + ';'
      + 'var _orientation = "' + orientation + '";'
      + 'var _renderId = ' + renderId + ';'
      /* After Paged.js finishes, scale page to fit iframe, center, restore scroll */
      + 'function _fitPage() {'
      + '  if (!_isPaged) return;'
      + '  var page = document.querySelector(".pagedjs_page");'
      + '  var pageW = page ? page.offsetWidth : _pageW;'
      + '  var pageH = page ? page.offsetHeight : _pageH;'
      + '  var iframeW = window.innerWidth;'
      + '  var iframeH = window.innerHeight;'
      + '  var inset = 20;'
      + '  var s = Math.min((iframeW - inset * 2) / pageW, (iframeH - inset * 2) / pageH) * _zoomFactor;'
      + '  var scaledW = pageW * s;'
      + '  var marginLeft = Math.max(inset, (iframeW - scaledW) / 2);'
      + '  document.documentElement.style.overflow = "auto";'
      + '  document.body.style.maxWidth = "none";'
      + '  document.body.style.width = pageW + "px";'
      + '  document.body.style.transform = "scale(" + s + ")";'
      + '  document.body.style.transformOrigin = "top left";'
      + '  document.body.style.marginLeft = marginLeft + "px";'
      + '  document.body.style.marginRight = "0";'
      + '  window.scrollTo(0, 0);'
      + '  _updatePanCursor();'
      + '}'
      + 'function _registerPagedHook() {'
      + '  if (typeof window.PagedPolyfill !== "undefined" && window.PagedPolyfill.on) {'
      + '    window.PagedPolyfill.on("afterPreview", function() {'
      + '      _fitPage();'
      + '      _killBorders();'
      + '      if (!_pagedReady) { _pagedReady = true;'
      + '        var mx = document.documentElement.scrollHeight - window.innerHeight;'
      + '        if (mx > 0) window.scrollTo(0, Math.round(_scrollRatio * mx));'
      + '      }'
      + '      parent.postMessage({type:"paged-ready", renderId: _renderId}, "*");'
      + '    });'
      + '    return true;'
      + '  }'
      + '  return false;'
      + '}'
      + 'function _initFit() {'
      + '  if (!_isPaged) {'
      + '    var mx = document.documentElement.scrollHeight - window.innerHeight;'
      + '    if (mx > 0) window.scrollTo(0, Math.round(_scrollRatio * mx));'
      + '    return;'
      + '  }'
      + '  if (!_registerPagedHook()) {'
      + '    var tries = 0;'
      + '    var interval = setInterval(function() {'
      + '      tries++;'
      + '      if (_registerPagedHook() || tries > 50) { clearInterval(interval); _fitPage(); }'
      + '    }, 100);'
      + '  }'
      + '  window.addEventListener("load", function() {'
      + '    _fitPage();'
      + '    if (!_pagedReady) { _pagedReady = true;'
      + '      var mx = document.documentElement.scrollHeight - window.innerHeight;'
      + '      if (mx > 0) window.scrollTo(0, Math.round(_scrollRatio * mx));'
      + '    }'
      + '    parent.postMessage({type:"paged-ready", renderId: _renderId}, "*");'
      + '  });'
      + '  var observer = new MutationObserver(function() {'
      + '    if (document.querySelector(".pagedjs_page")) { _fitPage(); _killBorders(); }'
      + '  });'
      + '  observer.observe(document.body, { childList: true, subtree: true });'
      + '  _fitPage();'
      + '}'
      + 'function _killBorders() {'
      + '  var s = document.getElementById("_fw_kill_borders");'
      + '  if (!s) {'
      + '    s = document.createElement("style");'
      + '    s.id = "_fw_kill_borders";'
      + '    s.textContent = ".pagedjs_page,.pagedjs_pagebox,.pagedjs_sheet,.pagedjs_margin-left,.pagedjs_margin-right,.pagedjs_area { box-shadow: none !important; outline: none !important; } .pagedjs_page,.pagedjs_pagebox,.pagedjs_margin-left,.pagedjs_margin-right,.pagedjs_area { border: none !important; } .pagedjs_page { background: transparent !important; } .pagedjs_sheet { border: 0.8px solid #000 !important; box-sizing: border-box !important; background: #fff !important; } @media screen { .pagedjs_page { box-shadow: none !important; } }";'
      + '    document.head.appendChild(s);'
      + '  }'
      + '}'
      + 'document.addEventListener("DOMContentLoaded", _initFit);'
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
    modeSwitch.classList.remove("preview", "read");


    if (mode === "edit") {
      if (prevMode !== "edit") savePreviewScroll();
      editorWrap.classList.remove("hidden");
      btnEdit.classList.add("active");

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
        modeSwitch.classList.add("read");
        if (window.innerWidth < 760) {
          appShell.classList.add("focus-mode");
        } else {
          animateLogoToCenter(appShell);
        }
      } else {
        btnPreview.classList.add("active");
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
    var dstLeft = toolbarRect.left;

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
    /* === App Surface: Framework CSS export === */
    if (surfaceMode === "app") {
      var fw = APP_FRAMEWORKS[currentAppFramework];
      var contentForRender = stripYamlFrontMatter(editor.value || "");
      var rawHTML = renderToFragment(contentForRender);
      var renderedHTML = sanitizeHTML(resolveRelativeUrls(rawHTML));
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
        + '  <style>\n'
        + '    ' + fwStyle + '\n'
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
      return;
    }

    /* === Doc Surface: reuse the rendered preview for an exact Read-mode match === */
    var srcdoc = previewFrame.getAttribute("srcdoc");
    if (srcdoc && (mode === "preview" || mode === "read")) {
      openInNewTab(srcdoc.replace(/<style id="_fw_stripe">[\s\S]*?<\/style>/i, ""), "text/html;charset=utf-8");
      return;
    }

    /* === Doc Surface fallback: build a self-paginating HTML from scratch === */
    var engine = DOC_ENGINES[currentDocEngine] || DOC_ENGINES.none;
    var contentForRender = stripYamlFrontMatter(editor.value || "");
    var rawHTML = renderToFragment(contentForRender);
    var renderedHTML = sanitizeHTML(resolveRelativeUrls(rawHTML));
    var scale = SIZE_SCALE[String(sizeStep)] || 1;
    var weight = WEIGHT_MAP[String(weightStep)] || 400;
    var lineHeight = LINE_SCALE[String(lineStep)] || 1.75;
    var fontStack  = "'" + comfortFont + "', system-ui, sans-serif";
    var headWeight = Math.min(weight + 200, 900);

    /* Engine script tag — self-paginating HTML export (skip ESM modules) */
    var engineScript = (engine && engine.script && !engine.module)
      ? '  <script src="' + engine.script + '" defer><' + '/script>\n'
      : '';

    var html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
      + '  <meta charset="UTF-8">\n'
      + '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
      + '  <title>FlatWrite Export</title>\n'
      + '  <base target="_blank" rel="noopener noreferrer">\n'
      + '  <link rel="preconnect" href="https://fonts.googleapis.com">\n'
      + '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
      + '  <link href="' + FONTS_URL + '" rel="stylesheet">\n'
      + engineScript
      + '  <style>\n'
      /* --- @page rules from document controls --- */
      + '    ' + buildPageCSS() + '\n'
      /* --- Typography --- */
      + '    *, *::before, *::after { font-family: ' + fontStack + ' !important; box-sizing: border-box; }\n'
      + '    body {\n'
      + '      font-size: ' + (15 * scale) + 'px !important;\n'
      + '      font-weight: ' + weight + ' !important;\n'
      + '      line-height: ' + lineHeight + ' !important;\n'
      + '      color: #2d2a3e;\n'
      + '      margin: 0;\n'
      + '      overflow-x: hidden;\n'
      + '    }\n'
      /* Fallback layout when no paged-media engine is active */
      + '    body:not(.pagedjs) main { padding: 0.5rem 1rem; }\n'
      + '    h1, h2, h3, h4, h5, h6 {\n'
      + '      font-weight: ' + headWeight + ' !important;\n'
      + '      overflow-wrap: break-word;\n'
      + '      word-break: break-word;\n'
      + '    }\n'
      + '    h1 { font-size: ' + (15 * scale * 2) + 'px !important; }\n'
      + '    h2 { font-size: ' + (15 * scale * 1.5) + 'px !important; margin-top: 1.8em !important; }\n'
      + '    h3 { font-size: ' + (15 * scale * 1.25) + 'px !important; margin-top: 1.4em !important; }\n'
      + '    h4 { font-size: ' + (15 * scale * 1.1) + 'px !important; }\n'
      + '    img { max-width: 100%; height: auto; display: block; }\n'
      + '    pre, code { font-family: "JetBrains Mono", monospace !important; }\n'
      + '    pre { overflow-x: auto; word-wrap: break-word; white-space: pre-wrap; }\n'
      + '    table { table-layout: fixed; width: 100%; overflow: hidden; }\n'
      + '    td, th { word-wrap: break-word; overflow-wrap: break-word; max-width: 100%; }\n'
      + '    blockquote { margin: 0; padding: 0 1em; border-left: 3px solid #ccc; }\n'
      + '    ul, ol { padding-left: 1.8em; margin: 0.2em 0; list-style-position: outside; }\n'
      + '    li { margin: 0.15em 0; display: list-item; }\n'
      + '    li > ul, li > ol { margin: 0.15em 0; padding-left: 2em; }\n'
      + '    li::marker { display: inline; }\n'
      + '    li:has(> input[type="checkbox"]) { list-style: none; }\n'
      + '    li:has(> input[type="checkbox"])::marker { display: none; }\n'
      + '    .task-list-item { list-style: none; }\n'
      + '    .task-list-item::marker { display: none; }\n'
      + '    input[type="checkbox"] { margin: 0 0.4em 0 0; vertical-align: middle; }\n'
      + '    ul { list-style-type: disc; }\n'
      + '    ul ul { list-style-type: circle; }\n'
      + '    ul ul ul { list-style-type: disc; }\n'
      + '    ul ul ul ul { list-style-type: circle; }\n'
      + '    p { margin: 0.4em 0; }\n'
      + '    br { margin: 0.3em 0; }\n'
      + '  </style>\n'
      + '</head>\n<body>\n  <main>\n'
      + renderedHTML
      + '\n  </main>\n'
      + '</body>\n</html>';

    openInNewTab(html, "text/html;charset=utf-8");
  }

  function exportPDF() {
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

    /* === Doc Surface: print the exact rendered preview ===
       When the preview has been rendered, reuse its srcdoc so the PDF engine,
       pagination, scaling, and layout match what the user sees in view mode. */
    var srcdoc = previewFrame.getAttribute("srcdoc");
    if (srcdoc) srcdoc = srcdoc.replace(/<style id="_fw_stripe">[\s\S]*?<\/style>/i, "");
    if (srcdoc && (mode === "preview" || mode === "read")) {
      var printScript = '<script>'
        + '(function(){'
        + '  function doPrint(){'
        + '    document.body.style.transform = "";'
        + '    document.body.style.width = "";'
        + '    document.documentElement.style.overflow = "";'
        + '    document.body.style.overflow = "";'
        + '    var vp = document.getElementById("vivl-viewport");'
        + '    if (vp) { vp.style.overflow = ""; vp.style.height = ""; vp.style.width = ""; }'
        + '    var s = document.createElement("style");'
        + '    s.media = "print";'
        + '    s.textContent = "@media print { html, body { overflow: visible !important; height: auto !important; transform: none !important; } .pagedjs_page { margin: 0 !important; } .pagedjs_sheet { border: none !important; } }";'
        + '    document.head.appendChild(s);'
        + '    window.print();'
        + '  }'
        + '  if (typeof window.PagedPolyfill !== "undefined" && window.PagedPolyfill.on) {'
        + '    var done=false; var p=function(){ if (done) return; done=true; setTimeout(doPrint, 200); };'
        + '    window.PagedPolyfill.on("afterPreview", p);'
        + '    window.PagedPolyfill.on("afterRenderation", p);'
        + '    setTimeout(p, 5000);'
        + '  } else if (document.getElementById("vivl-viewport")) {'
        + '    var check=function(){'
        + '      var pages=document.querySelectorAll("[data-vivliostyle-page-container]");'
        + '      if (pages.length > 0) { doPrint(); }'
        + '      else { setTimeout(check, 500); }'
        + '    };'
        + '    setTimeout(check, 1000);'
        + '  } else {'
        + '    window.addEventListener("load", function(){ setTimeout(doPrint, 500); });'
        + '    if (document.readyState === "complete") { setTimeout(doPrint, 500); }'
        + '  }'
        + '})();'
        + '</script>';
      var printHtml = srcdoc.replace(/<\/body>/i, printScript + '</body>');
      /* Add centering for paged pages in the new tab */
      printHtml = printHtml.replace(/<\/head>/i, '<style>.pagedjs_pages { display: flex; flex-direction: column; align-items: center; } [data-vivliostyle-spread-container] { align-items: center !important; } html { display: flex; justify-content: center; } body { margin: 0 auto !important; }</style></head>');
      var iframeRect = previewFrame.getBoundingClientRect();
      var width = Math.round(iframeRect.width);
      var height = Math.round(iframeRect.height);
      var features = "width=" + width + ",height=" + height + ",resizable=yes,scrollbars=yes";
      var blob = new Blob([printHtml], { type: "text/html;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      window.open(url, "_blank", features);
      return;
    }

    /* === Doc Surface fallback: render from scratch for direct export === */
    var engine = DOC_ENGINES[currentDocEngine] || DOC_ENGINES.none;
    var contentForRender = stripYamlFrontMatter(editor.value || "");
    var rawHTML = renderToFragment(contentForRender);
    var renderedHTML = sanitizeHTML(resolveRelativeUrls(rawHTML));
    var scale = SIZE_SCALE[String(sizeStep)] || 1;
    var weight = WEIGHT_MAP[String(weightStep)] || 400;
    var lineHeight = LINE_SCALE[String(lineStep)] || 1.75;
    var fontStack  = "'" + comfortFont + "', system-ui, sans-serif";
    var headWeight = Math.min(weight + 200, 900);

    /* Engine script — Paged.js for proper @page pagination (skip ESM modules) */
    var engineScript = (engine && engine.script && !engine.module)
      ? '  <script src="' + engine.script + '"><' + '/script>\n'
      : '';

    var html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
      + '  <meta charset="UTF-8">\n'
      + '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
      + '  <title>FlatWrite PDF</title>\n'
      + '  <link rel="preconnect" href="https://fonts.googleapis.com">\n'
      + '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
      + '  <link href="' + FONTS_URL + '" rel="stylesheet">\n'
      + engineScript
      + '  <style>\n'
      + '    ' + buildPageCSS() + '\n'
      + '    *, *::before, *::after { font-family: ' + fontStack + ' !important; box-sizing: border-box; }\n'
      + '    body {\n'
      + '      font-size: ' + (15 * scale) + 'px !important;\n'
      + '      font-weight: ' + weight + ' !important;\n'
      + '      line-height: ' + lineHeight + ' !important;\n'
      + '      color: #2d2a3e;\n'
      + '      max-width: ' + contentWidth + 'px;\n'
      + '      margin: 0 auto;\n'
      + '      overflow-x: hidden;\n'
      + '    }\n'
      + '    body:not(.pagedjs) main { padding: 0.5rem 1rem; }\n'
      + '    h1, h2, h3, h4, h5, h6 {\n'
      + '      font-weight: ' + headWeight + ' !important;\n'
      + '      overflow-wrap: break-word; word-break: break-word;\n'
      + '    }\n'
      + '    h1 { font-size: ' + (15 * scale * 2) + 'px !important; }\n'
      + '    h2 { font-size: ' + (15 * scale * 1.5) + 'px !important; margin-top: 1.8em !important; }\n'
      + '    h3 { font-size: ' + (15 * scale * 1.25) + 'px !important; margin-top: 1.4em !important; }\n'
      + '    h4 { font-size: ' + (15 * scale * 1.1) + 'px !important; }\n'
      + '    img { max-width: 100%; height: auto; display: block; }\n'
      + '    pre, code { font-family: "JetBrains Mono", monospace !important; }\n'
      + '    pre { overflow-x: auto; word-wrap: break-word; white-space: pre-wrap; }\n'
      + '    table { table-layout: fixed; width: 100%; overflow: hidden; }\n'
      + '    td, th { word-wrap: break-word; overflow-wrap: break-word; max-width: 100%; }\n'
      + '    blockquote { margin: 0; padding: 0 1em; border-left: 3px solid #ccc; }\n'
      + '    ul, ol { padding-left: 1.8em; margin: 0.2em 0; list-style-position: outside; }\n'
      + '    li { margin: 0.15em 0; display: list-item; }\n'
      + '    li > ul, li > ol { margin: 0.15em 0; padding-left: 2em; }\n'
      + '    li::marker { display: inline; }\n'
      + '    li:has(> input[type="checkbox"]) { list-style: none; }\n'
      + '    li:has(> input[type="checkbox"])::marker { display: none; }\n'
      + '    .task-list-item { list-style: none; }\n'
      + '    .task-list-item::marker { display: none; }\n'
      + '    input[type="checkbox"] { margin: 0 0.4em 0 0; vertical-align: middle; }\n'
      + '    ul { list-style-type: disc; }\n'
      + '    ul ul { list-style-type: circle; }\n'
      + '    ul ul ul { list-style-type: disc; }\n'
      + '    ul ul ul ul { list-style-type: circle; }\n'
      + '    p { margin: 0.4em 0; }\n'
      + '    br { margin: 0.3em 0; }\n'
      + '  </style>\n'
      + '</head>\n<body>\n  <main>\n'
      + renderedHTML
      + '\n  </main>\n'
      /* Auto-print after Paged.js renders */
      + '  <script>\n'
      + '    document.addEventListener("DOMContentLoaded", function() {\n'
      + '      if (typeof window.PagedPolyfill !== "undefined") {\n'
      + '        window.PagedPolyfill.on("afterRenderation", function() {\n'
      + '          setTimeout(function() { window.print(); }, 200);\n'
      + '        });\n'
      + '      } else {\n'
      + '        setTimeout(function() { window.print(); }, 500);\n'
      + '      }\n'
      + '    });\n'
      + '  <' + '/script>\n'
      + '</body>\n</html>';

    openInNewTab(html, "text/html;charset=utf-8");
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

    urlInput.value = "";
    status.textContent = "";
    status.className = "load-url-status";
    overlay.classList.remove("hidden");
    urlInput.focus();

    function close() { overlay.classList.add("hidden"); }

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

      // Always fetch as a Blob so binary files (PDF, PPTX, etc.) are
      // preserved through the network hop. Routing is decided after
      // we know the byte length and filename.
      fetch(rewriteGitHubUrl(url))
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.blob();
        })
        .then(function (blob) {
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
          btnFetch.disabled = false;
          var detail = err && err.message ? err.message : "";
          status.textContent = "Could not load. Check the URL and try again."
            + (detail ? " (" + detail + ")" : "");
          status.className = "load-url-status error";
          console.error("[load-url]", err);
        });
    }

    /* Remove any previous listeners by replacing elements */
    var newFetch = btnFetch.cloneNode(true);
    var newCancel = btnCancel.cloneNode(true);
    var newClose = btnClose.cloneNode(true);
    btnFetch.parentNode.replaceChild(newFetch, btnFetch);
    btnCancel.parentNode.replaceChild(newCancel, btnCancel);
    btnClose.parentNode.replaceChild(newClose, btnClose);

    newFetch.addEventListener("click", doFetch);
    newCancel.addEventListener("click", close);
    newClose.addEventListener("click", close);
    urlInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); doFetch(); }
      if (e.key === "Escape") close();
    });
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
  }

  /* ==========================================================================
     Toast feedback
     ========================================================================== */

  function showToast(message) {
    var toast = document.createElement("div");
    toast.className = "fw-toast";
    toast.innerHTML = message;
    document.body.appendChild(toast);
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
    if (opts.isShare) {
      var parsed = parseShareYaml(content);
      if (parsed.frontmatter) {
        var fm = parsed.frontmatter;
        if (fm.docEngine && DOC_ENGINES[fm.docEngine]) currentDocEngine = fm.docEngine;
        if (fm.surfaceMode === "doc" || fm.surfaceMode === "app") surfaceMode = fm.surfaceMode;
        if (fm.font) comfortFont = fm.font;
        setDocEngine(currentDocEngine);
      }
      setMarkdownUrl("");
    } else {
      setMarkdownUrl(sourceUrl);
    }
    setEditorContent(content);
    fwDocumentId = "";
    fwEnsureDocumentId();
    return {
      documentId: fwDocumentId,
      title: fwExtractTitle(content),
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
  };

  /* ==========================================================================
     Boot
     ========================================================================== */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
