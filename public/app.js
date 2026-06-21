(function () {
  "use strict";

  /* ==========================================================================
     IndexedDB persistence
     Database: flatwrite | Stores: activeDocument, preferences
     ========================================================================== */

  var DB_NAME    = "flatwrite";
  var DB_VERSION = 2;

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains("activeDocument")) db.createObjectStore("activeDocument");
        if (!db.objectStoreNames.contains("preferences"))   db.createObjectStore("preferences");
        /* Migration: rename "framework" key to "docEngine" in preferences */
        var migration = db.transaction("preferences", "readwrite");
        migration.objectStore("preferences").get("current").onsuccess = function(e) {
          var rec = e.target.result;
          if (rec && rec.framework && !rec.docEngine) {
            rec.docEngine = rec.framework;
            rec.framework = undefined;
            migration.objectStore("preferences").put(rec, "current");
          }
        };
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
      docLayout:  { pageSize: pageSize, margins: pageMargins, columns: pageColumns,
                    baseline: pageBaseline, headers: showHeaders, pages: showPages },
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
      "font: " + comfortFont,
      "size: " + sizeStep,
      "weight: " + weightStep,
      "line: " + lineStep,
      "width: " + contentWidth,
      "zoom: " + zoomStep,
      "---"
    ];
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
    vivliostyle: { label: "Vivliostyle", script: null, category: "css-books" },
    none: { label: "Plain CSS", script: null, category: "unstyled" }
  };

  /* ==========================================================================
     Typography presets
     ========================================================================== */

  var COMFORT_FONTS = [
    { value: "Inter",            label: "Inter" },
    { value: "JetBrains Mono",   label: "JetBrains Mono" },
    { value: "Lora",             label: "Lora" },
    { value: "Merriweather",     label: "Merriweather" },
    { value: "Playfair Display", label: "Playfair Display" },
    { value: "Unbounded",        label: "Unbounded" }
  ];

  var SIZE_SCALE = { "-3": 0.76, "-2": 0.84, "-1": 0.92, "0": 1, "1": 1.1, "2": 1.2, "3": 1.32, "4": 1.46 };
  var SIZE_MIN = -3;
  var SIZE_MAX = 4;

  var WEIGHT_MAP = { "-1": 300, "0": 400, "1": 600, "2": 700 };
  var WEIGHT_MIN = -1;
  var WEIGHT_MAX = 2;

  var LINE_SCALE = { "-2": 1.3, "-1": 1.5, "0": 1.75, "1": 2.0, "2": 2.3, "3": 2.6 };
  var LINE_MIN = -2;
  var LINE_MAX = 3;

  var FONTS_URL = "https://fonts.googleapis.com/css2?family=Unbounded:wght@300;400;600;700"
    + "&family=Lato:wght@300;400;700"
    + "&family=Inter:wght@300;400;600;700"
    + "&family=Merriweather:wght@300;400;700"
    + "&family=JetBrains+Mono:wght@300;400;600;700"
    + "&family=Playfair+Display:wght@400;600;700"
    + "&family=Lora:wght@400;500;600;700"
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
  var currentDocEngine = "pagedjs";
  var sizeStep = 0;
  var weightStep = 0;
  var lineStep = 0;
  var comfortFont = "Inter";
  var zoomStep = 100;
  var lastScrollRatio = 0;
  var lastEditorScrollTop = 0;

  /* Document layout state */
  var pageSize     = "A4";
  var pageMargins  = "normal";
  var pageColumns  = 1;
  var pageBaseline = 16;  /* × 0.1 = line-height */
  var showHeaders  = false;
  var showPages    = false;
  /* ==========================================================================
     DOM references
     ========================================================================== */

  /* Engine selector DOM refs */
  var engineToggle      = document.getElementById("engine-toggle");
  var engineSlider      = document.getElementById("engine-slider");

  /* Document controls DOM refs */
  var pageSizeSel       = document.getElementById("page-size");
  var pageMarginsSel    = document.getElementById("page-margins");
  var pageColumnsSel    = document.getElementById("page-columns");
  var pageBaselineRange = document.getElementById("page-baseline");
  var pageBaselineVal   = document.getElementById("page-baseline-val");
  var toggleHeadersBtn  = document.getElementById("toggle-headers");
  var togglePagesBtn    = document.getElementById("toggle-pages");

  var editor            = document.getElementById("editor");
  var editorWrap        = document.getElementById("editor-wrap");
  var previewWrap       = document.getElementById("preview-wrap");
  var previewFrame      = document.getElementById("preview-frame");
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

  function rewriteGitHubUrl(url) {
    var m = url.match(/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)\/(.+)$/);
    if (m) {
      githubBaseUrl = "https://raw.githubusercontent.com/" + m[1] + "/" + m[2] + "/" + m[3] + "/";
      return "https://raw.githubusercontent.com/" + m[1] + "/" + m[2] + "/" + m[3] + "/" + m[4];
    }
    githubBaseUrl = "";
    return url;
  }

  function rewriteRelativeUrls(md) {
    if (!githubBaseUrl) return md;

    function resolveAsset(src) {
      if (/^https?:\/\//.test(src) || /^data:/.test(src)) return null;
      try {
        var resolved = new URL(src, githubBaseUrl).href;
        if (resolved.indexOf("?") === -1) resolved += "?raw=true";
        return resolved;
      } catch (e) { return null; }
    }

    /* Markdown image syntax: ![alt](src) */
    md = md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (match, alt, src) {
      var r = resolveAsset(src);
      return r ? "![" + alt + "](" + r + ")" : match;
    });

    /* HTML img/video/source: <tag src="..."> and <tag src='...'> */
    md = md.replace(/(<(?:img|video|source)\s[^>]*?)src=([\"'])([^\"']+)\2/gi,
      function (match, prefix, quote, src) {
        var r = resolveAsset(src);
        return r ? prefix + "src=" + quote + r + quote : match;
      }
    );

    return md;
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
    };
    reader.readAsText(file);
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
      setDocEngine(currentDocEngine);
      setSurfaceMode(surfaceMode);
      syncDocControlsUI();
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
          if (fm.docEngine && DOC_ENGINES[fm.docEngine]) {
            currentDocEngine = fm.docEngine;
          }
          if (fm.font && COMFORT_FONTS.some(function (f) { return f.value === fm.font; })) {
            comfortFont = fm.font;
            fontPickerLabel.textContent = comfortFont;
          }
          if (fm.size !== undefined)   sizeStep   = clampInt(fm.size,   SIZE_MIN,   SIZE_MAX,   sizeStep);
          if (fm.weight !== undefined) weightStep = clampInt(fm.weight, WEIGHT_MIN, WEIGHT_MAX, weightStep);
          if (fm.line !== undefined)   lineStep   = clampInt(fm.line,   LINE_MIN,   LINE_MAX,   lineStep);
          if (fm.width !== undefined)  contentWidth = clampInt(fm.width, 400, 1400, contentWidth);
          if (fm.zoom !== undefined)   zoomStep     = clampInt(fm.zoom, 100, 120, zoomStep);
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
          "open","align","valign","border","cellpadding","cellspacing"
        ],
        ALLOW_DATA_ATTR: false
      });
    }
    return raw;
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
      if (record.docEngine && DOC_ENGINES[record.docEngine]) {
        currentDocEngine = record.docEngine;
      }
            
      var t = record.typography || {};
      if (t.family && COMFORT_FONTS.some(function (f) { return f.value === t.family; })) {
        comfortFont = t.family;
      }
      fontPickerLabel.textContent = comfortFont;
      if (t.sizeStep !== undefined)   sizeStep   = clampInt(t.sizeStep,   SIZE_MIN,   SIZE_MAX,   sizeStep);
      if (t.weightStep !== undefined) weightStep = clampInt(t.weightStep, WEIGHT_MIN, WEIGHT_MAX, weightStep);
      if (t.lineStep !== undefined)   lineStep   = clampInt(t.lineStep,   LINE_MIN,   LINE_MAX,   lineStep);

      var l = record.layout || {};
      if (l.zoomStep !== undefined)     zoomStep     = clampInt(l.zoomStep, 100, 120, zoomStep);
      if (l.contentWidth !== undefined) contentWidth = clampInt(l.contentWidth, 400, 1400, contentWidth);

      zoomSlider.value = zoomStep;
      zoomValue.textContent = zoomStep + "%";
      applyZoom();
      applyContentWidth();
      setDocEngine(currentDocEngine);

      var dl = record.docLayout || {};
      if (dl.pageSize && PAGE_SIZES[dl.pageSize]) pageSize = dl.pageSize;
      if (dl.margins && MARGIN_MAP[dl.margins])   pageMargins = dl.margins;
      if (dl.columns)   pageColumns  = clampInt(dl.columns, 1, 3, 1);
      if (dl.baseline)  pageBaseline = clampInt(dl.baseline, 12, 20, 16);
      if (dl.headers)   showHeaders  = true;
      if (dl.pages)     showPages    = true;
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
        currentDocEngine = "pagedjs";
        setDocEngine(currentDocEngine);
        sizeStep = 0;
        weightStep = 0;
        lineStep = 0;
        comfortFont = "Inter";
        fontPickerLabel.textContent = "Inter";
        zoomStep = 100;
        zoomSlider.value = 100;
        zoomValue.textContent = "100%";
        applyZoom();
        contentWidth = 780;
        applyContentWidth();
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
      handleFileUpload(file);
    });

    /* Width handle drag */
    function initWidthHandle(handle, side) {
      var dragging = false, startX, startWidth;
      handle.addEventListener("mousedown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        startX = e.clientX;
        startWidth = contentWidth;
        handle.classList.add("dragging");
        widthDragOverlay.classList.remove("hidden");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      });
      window.addEventListener("mousemove", function (e) {
        if (!dragging) return;
        e.preventDefault();
        var delta = e.clientX - startX;
        var newWidth;
        if (side === "right") {
          newWidth = Math.max(400, Math.min(1400, startWidth + delta * 2));
        } else {
          newWidth = Math.max(400, Math.min(1400, startWidth - delta * 2));
        }
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
        if (mode === "preview" || mode === "read") renderPreview();
      });
    }
    if (pageMarginsSel) {
      pageMarginsSel.addEventListener("change", function () {
        pageMargins = this.value;
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
    if (pageBaselineRange) {
      pageBaselineRange.addEventListener("input", function () {
        pageBaseline = parseInt(this.value, 10);
        if (pageBaselineVal) pageBaselineVal.textContent = (pageBaseline / 10).toFixed(1);
        scheduleAutosave();
        if (mode === "preview" || mode === "read") renderPreview();
      });
    }
    if (toggleHeadersBtn) {
      toggleHeadersBtn.addEventListener("click", function () {
        showHeaders = !showHeaders;
        this.dataset.state = showHeaders ? "on" : "off";
        this.textContent = showHeaders ? "On" : "Off";
        scheduleAutosave();
        if (mode === "preview" || mode === "read") renderPreview();
      });
    }
    if (togglePagesBtn) {
      togglePagesBtn.addEventListener("click", function () {
        showPages = !showPages;
        this.dataset.state = showPages ? "on" : "off";
        this.textContent = showPages ? "On" : "Off";
        scheduleAutosave();
        if (mode === "preview" || mode === "read") renderPreview();
      });
    }

    btnExportMd.addEventListener("click", exportMarkdown);
    btnExportHtml.addEventListener("click", exportHTML);
    btnExportPdf.addEventListener("click", exportPDF);
    btnShare.addEventListener("click", shareDocument);

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

    document.addEventListener("pointerdown", function (e) {
      if (!fontPickerList) return;
      if (fontPickerList.classList.contains("hidden")) return;
      if (fontPickerList.contains(e.target)) return;
      if (fontPicker.contains(e.target)) return;
      fontPickerList.classList.add("hidden");
    });

    fontPickerList.addEventListener("click", function (e) {
      var item = e.target.closest(".font-dropdown-item");
      if (!item) return;
      comfortFont = item.dataset.font;
      fontPickerLabel.textContent = comfortFont;
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
      if (e.key === "Escape" && mode === "read") {
        e.preventDefault();
        setMode("preview");
        return;
      }
      var mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "b" || e.key === "B") { e.preventDefault(); setMode(mode === "edit" ? "preview" : "edit"); }
      if (e.key === "e" || e.key === "E") { e.preventDefault(); exportMarkdown(); }
    });

    /* postMessage listener — receives scroll position from sandboxed iframe */
    window.addEventListener("message", function (e) {
      if (e.source !== previewFrame.contentWindow) return;
      if (e.data && e.data.type === "scroll") {
        lastScrollRatio = e.data.ratio;
      }
      if (e.data && e.data.type === "iframe-pointerdown") {
        closeFontDropdown();
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
    document.querySelector(".app-shell").style.zoom = zoomStep / 100;
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
    scheduleAutosave();
    if (mode === "preview" || mode === "read") renderPreview();
  }

  /* ==========================================================================
     buildPageCSS — assemble @page + layout rules from current controls
     ========================================================================== */

  var PAGE_SIZES = { A4: "210mm 297mm", A5: "148mm 210mm", Letter: "8.5in 11in", Legal: "8.5in 14in" };
  var MARGIN_MAP = { narrow: "15mm", normal: "25mm 20mm", wide: "35mm 30mm" };

  function buildPageCSS() {
    var size = PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
    var margin = MARGIN_MAP[pageMargins] || MARGIN_MAP.normal;
    var css = '@page { size: ' + size + '; margin: ' + margin + '; }';
    if (pageColumns > 1) {
      css += ' main { column-count: ' + pageColumns + '; column-gap: 2em; }';
    }
    if (showPages) {
      css += '@page { @bottom-center { content: counter(page); font-size: 10px; color: #888; } }';
    }
    if (showHeaders) {
      css += '@page { @top-center { content: string(chapter); font-size: 10px; color: #888; } }';
      css += 'h1 { string-set: chapter content(); }';
    }
    return css;
  }

  function syncDocControlsUI() {
    if (pageSizeSel)     pageSizeSel.value = pageSize;
    if (pageMarginsSel)  pageMarginsSel.value = pageMargins;
    if (pageColumnsSel)  pageColumnsSel.value = String(pageColumns);
    if (pageBaselineRange) {
      pageBaselineRange.value = pageBaseline;
      if (pageBaselineVal) pageBaselineVal.textContent = (pageBaseline / 10).toFixed(1);
    }
    if (toggleHeadersBtn) {
      toggleHeadersBtn.dataset.state = showHeaders ? "on" : "off";
      toggleHeadersBtn.textContent = showHeaders ? "On" : "Off";
    }
    if (togglePagesBtn) {
      togglePagesBtn.dataset.state = showPages ? "on" : "off";
      togglePagesBtn.textContent = showPages ? "On" : "Off";
    }
  }

  function positionWidthHandles() {
    var frame = document.getElementById("preview-frame");
    var hLeft = document.getElementById("width-handle-left");
    var hRight = document.getElementById("width-handle-right");
    if (!frame || !hLeft || !hRight) return;
    var wrap = frame.parentElement;
    var wrapW = wrap.clientWidth;
    var scale = SIZE_SCALE[String(sizeStep)] || 1;
    var effectiveWidth = contentWidth;
    var edge = Math.max(0, (wrapW - effectiveWidth) / 2);
    hLeft.style.left = edge + "px";
    hLeft.style.right = "auto";
    hRight.style.right = edge + "px";
    hRight.style.left = "auto";
  }

  /* ==========================================================================
     Preview rendering
     ========================================================================== */

  function savePreviewScroll() {
    /* Scroll ratio is kept current by postMessage from the sandboxed iframe.
       No direct contentDocument access needed. */
  }

  function renderPreview() {
    var engine = DOC_ENGINES[currentDocEngine] || DOC_ENGINES.none;
    var contentForRender = stripYamlFrontMatter(editor.value || "");
    var rawHTML = marked.parse(contentForRender);
    var renderedHTML = sanitizeHTML(rawHTML);
    var scale = SIZE_SCALE[String(sizeStep)] || 1;
    var weight = WEIGHT_MAP[String(weightStep)] || 400;
    var lineHeight = LINE_SCALE[String(lineStep)] || 1.75;
    var fontStack = "'" + comfortFont + "', system-ui, sans-serif";
    var headWeight = Math.min(weight + 200, 900);

    var scrollRatio = lastScrollRatio;

    /* Engine script tag — injects Paged.js (or Vivliostyle) when selected */
    var engineScript = (engine && engine.script)
      ? '<script src="' + engine.script + '" defer><' + '/script>'
      : '';

    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
      + '<base target="_blank" rel="noopener noreferrer">'
      + '<link rel="preconnect" href="https://fonts.googleapis.com">'
      + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
      + '<link href="' + FONTS_URL + '" rel="stylesheet">'
      + engineScript
      + '<style>'
      /* --- @page rules from document controls --- */
      + buildPageCSS()
      /* --- Crop marks at page corners --- */
      + '.pagedjs_page { overflow: visible !important; }'
      + '.pagedjs_page::before, .pagedjs_page::after,'
      + '.pagedjs_sheet::before, .pagedjs_sheet::after {'
      + '  content: ""; position: absolute; background: #000; z-index: 9999; }'
      + '.pagedjs_page::before { top: -8px; left: -1px; width: 12px; height: 1px; }'
      + '.pagedjs_page::after  { top: -1px;  left: -8px; width: 1px; height: 12px; }'
      + '.pagedjs_sheet::before { bottom: -8px; right: -1px; width: 12px; height: 1px; }'
      + '.pagedjs_sheet::after  { bottom: -1px;  right: -8px; width: 1px; height: 12px; }'
      /* --- Typography --- */
      + '*, *::before, *::after { font-family: ' + fontStack + ' !important; box-sizing: border-box; }'
      + 'body { font-size: ' + (15 * scale) + 'px !important;'
      + ' font-weight: ' + weight + ' !important;'
      + ' line-height: ' + lineHeight + ' !important; color: #2d2a3e;'
      + ' overflow-x: hidden; }'
      + 'h1,h2,h3,h4,h5,h6 { font-weight: ' + headWeight + ' !important; overflow-wrap: break-word; word-break: break-word; }'
      + 'h1 { font-size: ' + (15 * scale * 2) + 'px !important; }'
      + 'h2 { font-size: ' + (15 * scale * 1.5) + 'px !important; margin-top: 1.8em !important; }'
      + 'h3 { font-size: ' + (15 * scale * 1.25) + 'px !important; margin-top: 1.4em !important; }'
      + 'h4 { font-size: ' + (15 * scale * 1.1) + 'px !important; }'
      + 'img { max-width: 100%; height: auto; display: block; }'
      + 'pre, code { font-family: "JetBrains Mono", monospace !important; }'
      + 'pre { overflow-x: auto; word-wrap: break-word; white-space: pre-wrap; }'
      + 'table { table-layout: fixed; width: 100%; overflow: hidden; }'
      + 'td, th { word-wrap: break-word; overflow-wrap: break-word; max-width: 100%; }'
      + 'blockquote { margin: 0; padding: 0 1em; border-left: 3px solid #ccc; }'
      + 'ul, ol { padding-left: 1.8em; margin: 0.2em 0; list-style-position: outside; }'
      + 'li { margin: 0.15em 0; display: list-item; }'
      + 'li > ul, li > ol { margin: 0.15em 0; }'
      + 'li::marker { display: inline; }'
      + 'p { margin: 0.4em 0; }'
      + 'br { margin: 0.3em 0; }'
      /* --- Fallback if Paged.js fails to load --- */
      + 'body:not(.pagedjs) main { max-width: ' + contentWidth + 'px; margin: 3rem auto; padding: 0 1.5rem; }'
      + '</style>'
      + '</head><body><main>' + renderedHTML + '</main>'
      + '<script>'
      + 'var _scrollRatio = ' + scrollRatio + ';'
      + 'var _pagedReady = false;'
      /* After Paged.js finishes, restore scroll */
      + 'document.addEventListener("DOMContentLoaded", function(){'
      + '  if (typeof window.PagedPolyfill !== "undefined") {'
      + '    window.PagedPolyfill.on("afterRenderation", function(){'
      + '      if (!_pagedReady) { _pagedReady = true;'
      + '        var mx = document.documentElement.scrollHeight - window.innerHeight;'
      + '        if (mx > 0) window.scrollTo(0, Math.round(_scrollRatio * mx));'
      + '      }'
      + '    });'
      + '  } else {'
      /* No engine script — restore scroll immediately */
      + '    var mx = document.documentElement.scrollHeight - window.innerHeight;'
      + '    if (mx > 0) window.scrollTo(0, Math.round(_scrollRatio * mx));'
      + '  }'
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
      + '    document.body.style.maxWidth = e.data.width + "px";'
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

    previewFrame.srcdoc = html;
    /* Reposition width handles after iframe content loads */
    previewFrame.onload = positionWidthHandles;
    setTimeout(positionWidthHandles, 250);
  }

  /* ==========================================================================
     Edit / Preview toggle
     ========================================================================== */

  function setMode(newMode) {
    var prevMode = mode;
    mode = newMode;
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

    /* Reset Read button label */
    btnRead.textContent = "Read";
    btnRead.dataset.mode = "read";

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
        renderPreview();
      }

      previewWrap.classList.remove("hidden");

      /* Re-apply scroll after the iframe is visible; the initial render while
         hidden can mis-measure window.innerHeight, causing a jump to the end. */
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
        /* Relabel Read → Close, exit back to whatever mode we came from */
        btnRead.textContent = "Close";
        btnRead.dataset.mode = prevMode;
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
    var engine = DOC_ENGINES[currentDocEngine] || DOC_ENGINES.none;
    var contentForRender = stripYamlFrontMatter(editor.value || "");
    var rawHTML = marked.parse(contentForRender);
    var renderedHTML = sanitizeHTML(rawHTML);
    var scale = SIZE_SCALE[String(sizeStep)] || 1;
    var weight = WEIGHT_MAP[String(weightStep)] || 400;
    var lineHeight = LINE_SCALE[String(lineStep)] || 1.75;
    var fontStack  = "'" + comfortFont + "', system-ui, sans-serif";
    var headWeight = Math.min(weight + 200, 900);

    /* Engine script tag — self-paginating HTML export */
    var engineScript = (engine && engine.script)
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
      + '      overflow-x: hidden;\n'
      + '    }\n'
      /* Fallback layout when no paged-media engine is active */
      + '    body:not(.pagedjs) main { max-width: ' + contentWidth + 'px; margin: 3rem auto; padding: 0 1.5rem; }\n'
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
      + '    li > ul, li > ol { margin: 0.15em 0; }\n'
      + '    li::marker { display: inline; }\n'
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
    var engine = DOC_ENGINES[currentDocEngine] || DOC_ENGINES.none;
    var contentForRender = stripYamlFrontMatter(editor.value || "");
    var rawHTML = marked.parse(contentForRender);
    var renderedHTML = sanitizeHTML(rawHTML);
    var scale = SIZE_SCALE[String(sizeStep)] || 1;
    var weight = WEIGHT_MAP[String(weightStep)] || 400;
    var lineHeight = LINE_SCALE[String(lineStep)] || 1.75;
    var fontStack  = "'" + comfortFont + "', system-ui, sans-serif";
    var headWeight = Math.min(weight + 200, 900);

    /* Engine script — Paged.js for proper @page pagination */
    var engineScript = (engine && engine.script)
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
      + '      overflow-x: hidden;\n'
      + '    }\n'
      + '    body:not(.pagedjs) main { max-width: ' + contentWidth + 'px; margin: 3rem auto; padding: 0 1.5rem; }\n'
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
      + '    li > ul, li > ol { margin: 0.15em 0; }\n'
      + '    li::marker { display: inline; }\n'
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
     Load from URL modal
     ========================================================================== */

  function loadFromUrlModal() {
    var url = prompt("Enter the URL of the markdown file to load:", "https://");
    if (!url) return;

    showToast("Loading from URL…");
    fetch(rewriteGitHubUrl(url))
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (text) {
        if (isEditorDirty()) {
          var ok = confirm("Replace current content with loaded markdown?");
          if (!ok) return;
        }
        setEditorContent(text);
        setMode("preview");
        showToast("Loaded markdown from URL");
      })
      .catch(function (e) {
        showToast("Could not load from URL. Check the link and try again.");
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
     Boot
     ========================================================================== */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
