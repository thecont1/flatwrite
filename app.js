(function () {
  "use strict";

  /* ==========================================================================
     Framework registry
     Each framework: label, css/js URLs, category, style function.
     style(doc) applies framework-specific classes to DOM elements in preview.
     ========================================================================== */

  var FRAMEWORKS = {
    spectre: {
      label: "Spectre.css",
      css: "https://unpkg.com/spectre.css/dist/spectre.min.css",
      js: null,
      category: "component-rich",
      style: function (doc) {
        doc.querySelectorAll("button").forEach(function (b) {
          b.className = "btn btn-primary";
        });
        doc.querySelectorAll(".fw-form").forEach(function (f) {
          f.classList.add("form-group");
        });
        doc.querySelectorAll(".fw-form label").forEach(function (l) {
          l.classList.add("form-label");
        });
        doc.querySelectorAll(".fw-form input[type=text], .fw-form input[type=email], .fw-form textarea").forEach(function (el) {
          el.classList.add("form-input");
        });
        doc.querySelectorAll(".fw-form select").forEach(function (s) {
          s.classList.add("form-select");
        });
        doc.querySelectorAll(".fw-card").forEach(function (c) {
          c.classList.add("card");
        });
        doc.querySelectorAll(".fw-card-header").forEach(function (h) {
          h.classList.add("card-header");
        });
        doc.querySelectorAll(".fw-card-title").forEach(function (t) {
          t.classList.add("card-title", "h5");
        });
        doc.querySelectorAll(".fw-card-body").forEach(function (b) {
          b.classList.add("card-body");
        });
        doc.querySelectorAll(".fw-alert").forEach(function (a) {
          a.classList.add("toast");
        });
        doc.querySelectorAll(".fw-alert-success").forEach(function (a) {
          a.classList.add("toast-success");
        });
        doc.querySelectorAll(".fw-alert-warning").forEach(function (a) {
          a.classList.add("toast-warning");
        });
        doc.querySelectorAll(".fw-alert-error").forEach(function (a) {
          a.classList.add("toast-error");
        });
      }
    },

    poshui: {
      label: "PoshUI",
      css: "https://poshui-components.netlify.app/css/main.css",
      js: "https://poshui-components.netlify.app/js/main.js",
      category: "component-rich",
      style: function (doc) {
        doc.querySelectorAll("button").forEach(function (b) {
          b.className = "btn btn-primary-bg";
        });
        doc.querySelectorAll(".fw-form label").forEach(function (l) {
          l.classList.add("form-label");
        });
        doc.querySelectorAll(".fw-form input[type=text], .fw-form input[type=email], .fw-form textarea").forEach(function (el) {
          el.classList.add("form-control");
        });
        doc.querySelectorAll(".fw-form select").forEach(function (s) {
          s.classList.add("form-control");
        });
        doc.querySelectorAll(".fw-card").forEach(function (c) {
          c.classList.add("card");
        });
        doc.querySelectorAll(".fw-card-header").forEach(function (h) {
          h.classList.add("card-header");
        });
        doc.querySelectorAll(".fw-card-body").forEach(function (b) {
          b.classList.add("card-body");
        });
        doc.querySelectorAll(".fw-alert").forEach(function (a) {
          a.classList.add("alert");
        });
        doc.querySelectorAll(".fw-alert-success").forEach(function (a) {
          a.classList.add("alert-success");
        });
        doc.querySelectorAll(".fw-alert-warning").forEach(function (a) {
          a.classList.add("alert-warning");
        });
        doc.querySelectorAll(".fw-alert-error").forEach(function (a) {
          a.classList.add("alert-danger");
        });
      }
    },

    oat: {
      label: "Oat",
      css: "https://unpkg.com/@knadh/oat/oat.min.css",
      js: "https://unpkg.com/@knadh/oat/oat.min.js",
      category: "semantic-first",
      style: function (doc) {
        doc.querySelectorAll(".fw-card").forEach(function (c) {
          c.classList.add("card");
        });
        doc.querySelectorAll(".fw-card-header").forEach(function (h) {
          var el = doc.createElement("header");
          el.innerHTML = h.innerHTML;
          h.parentNode.replaceChild(el, h);
        });
        doc.querySelectorAll(".fw-alert").forEach(function (a) {
          a.setAttribute("role", "alert");
        });
      }
    },

    pico: {
      label: "Pico CSS",
      css: "https://unpkg.com/@picocss/pico/css/pico.min.css",
      js: null,
      category: "semantic-first",
      style: function () {}
    },

    milligram: {
      label: "Milligram",
      css: "https://unpkg.com/milligram/dist/milligram.min.css",
      js: null,
      category: "class-based",
      style: function (doc) {
        doc.querySelectorAll("button").forEach(function (b) {
          b.classList.add("button");
        });
        doc.querySelectorAll(".fw-card").forEach(function (c) {
          c.style.padding = "1.5rem";
          c.style.borderRadius = "0.4rem";
          c.style.border = "1px solid #e0e0e0";
        });
      }
    },

    chota: {
      label: "Chota",
      css: "https://unpkg.com/chota/dist/chota.min.css",
      js: null,
      category: "class-based",
      style: function (doc) {
        doc.querySelectorAll("button").forEach(function (b) {
          b.classList.add("btn", "primary");
        });
        doc.querySelectorAll(".fw-form input[type=text], .fw-form input[type=email], .fw-form textarea").forEach(function (el) {
          el.classList.add("input");
        });
        doc.querySelectorAll(".fw-form select").forEach(function (s) {
          s.classList.add("input");
        });
        doc.querySelectorAll(".fw-card").forEach(function (c) {
          c.classList.add("card");
        });
      }
    },

    simple: {
      label: "Simple.css",
      css: "https://unpkg.com/simpledotcss/simple.min.css",
      js: null,
      category: "semantic-first",
      style: function () {}
    }
  };

  /* ==========================================================================
     Core component set — minimal test surface for framework comparison
     ========================================================================== */

  var COMPONENTS = [
    { id: "button",  emoji: "\u25cf",  label: "Buttons" },
    { id: "form",    emoji: "\u25a1",  label: "Form" },
    { id: "card",    emoji: "\u25a3",  label: "Card" },
    { id: "alert",   emoji: "\u25b2",  label: "Alerts" },
    { id: "text",    emoji: "\u2016",  label: "Text" }
  ];

  /* ==========================================================================
     Component templates — framework-neutral markup with .fw- hook classes.
     style(doc) applies framework-specific classes on top.
     ========================================================================== */

  var BUTTON_TEMPLATE =
    '<button>Action</button>\n'
    + '<button>Confirm</button>\n'
    + '<button>Cancel</button>';

  var FORM_TEMPLATE =
    '<form class="fw-form" onsubmit="return false">\n'
    + '  <label for="demo-name">Name</label>\n'
    + '  <input type="text" id="demo-name" placeholder="Your name" />\n'
    + '  <div class="fw-form">\n'
    + '    <label for="demo-email">Email</label>\n'
    + '    <input type="email" id="demo-email" placeholder="you@example.com" />\n'
    + '  </div>\n'
    + '  <div class="fw-form">\n'
    + '    <label for="demo-msg">Message</label>\n'
    + '    <textarea id="demo-msg" rows="3" placeholder="Write something..."></textarea>\n'
    + '  </div>\n'
    + '  <label>\n'
    + '    <input type="checkbox" checked />\n'
    + '    Subscribe to newsletter\n'
    + '  </label>\n'
    + '  <button type="submit">Submit</button>\n'
    + '</form>';

  var CARD_TEMPLATE =
    '<div class="fw-card">\n'
    + '  <div class="fw-card-header">\n'
    + '    <div class="fw-card-title">Card Title</div>\n'
    + '    <p>Subtitle text</p>\n'
    + '  </div>\n'
    + '  <div class="fw-card-body">\n'
    + '    <p>Card content goes here. This tests how each framework handles structured containers with headers and body regions.</p>\n'
    + '  </div>\n'
    + '</div>';

  var ALERT_TEMPLATES =
    '<div class="fw-alert fw-alert-success">\n'
    + '  <strong>Success:</strong> Operation completed.\n'
    + '</div>\n'
    + '<div class="fw-alert fw-alert-warning">\n'
    + '  <strong>Warning:</strong> Check your input.\n'
    + '</div>\n'
    + '<div class="fw-alert fw-alert-error">\n'
    + '  <strong>Error:</strong> Something went wrong.\n'
    + '</div>';

  var TEXT_TEMPLATE =
    '## Typography Test\n\n'
    + 'This is a paragraph with **bold**, *italic*, and `inline code`.\n\n'
    + '> A blockquote to test how frameworks style quoted text.\n\n'
    + '- Bullet item one\n'
    + '- Bullet item two\n'
    + '- Bullet item three\n\n'
    + '1. Numbered item one\n'
    + '2. Numbered item two\n'
    + '3. Numbered item three';

  /* ==========================================================================
     Component modal set — components that need a configuration form
     ========================================================================== */

  var MODAL_COMPONENTS = ["button", "form", "card"];

  /* ==========================================================================
     localStorage keys
     ========================================================================== */

  var LS_CONTENT   = "flatwrite_content";
  var LS_FRAMEWORK = "flatwrite_framework";
  var LS_SIZESTEP  = "flatwrite_sizestep";
  var LS_WEIGHTSTEP = "flatwrite_weightstep";
  var LS_LINESTEP  = "flatwrite_linestep";
  var LS_FONT      = "flatwrite_comfortfont";
  var LS_ZOOMSTEP  = "flatwrite_zoomstep";

  /* ==========================================================================
     Typography presets
     ========================================================================== */

  var COMFORT_FONTS = [
    { value: "Inter",            label: "Inter" },
    { value: "Merriweather",     label: "Merriweather" },
    { value: "Playfair Display", label: "Playfair Display" },
    { value: "Lora",             label: "Lora" },
    { value: "JetBrains Mono",   label: "JetBrains Mono" }
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

  /* ==========================================================================
     State
     ========================================================================== */

  var mode = "edit";
  var currentFramework = "spectre";
  var sizeStep = 0;
  var weightStep = 0;
  var lineStep = 0;
  var comfortFont = "Inter";
  var zoomStep = 100;
  var debounceTimer = null;
  var activeModalComponent = null;
  var lastEditScrollRatio = 0;

  /* ==========================================================================
     DOM references
     ========================================================================== */

  var frameworkDropdown = document.getElementById("framework-dropdown");
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
  var componentsGrid    = document.getElementById("components-grid");
  var fontPicker        = document.getElementById("font-picker");
  var sizeDownBtn       = document.getElementById("size-down");
  var sizeUpBtn         = document.getElementById("size-up");
  var weightDownBtn     = document.getElementById("weight-down");
  var weightUpBtn       = document.getElementById("weight-up");
  var lineDownBtn       = document.getElementById("line-down");
  var lineUpBtn         = document.getElementById("line-up");
  var zoomSlider        = document.getElementById("zoom-slider");
  var zoomValue         = document.getElementById("zoom-value");
  var modalOverlay      = document.getElementById("comp-modal-overlay");
  var modalTitle        = document.getElementById("comp-modal-title");
  var modalBody         = document.getElementById("comp-modal-body");
  var modalInsertBtn    = document.getElementById("comp-modal-insert");
  var modalCancelBtn    = document.getElementById("comp-modal-cancel");
  var modalCloseBtn     = document.getElementById("comp-modal-close");

  /* ==========================================================================
     Init
     ========================================================================== */

  function init() {
    marked.setOptions({ html: true, gfm: true, breaks: false });
    restoreFromStorage();
    renderComponentGrid();
    bindEvents();
  }

  /* ==========================================================================
     localStorage persistence
     ========================================================================== */

  function restoreFromStorage() {
    var savedContent = localStorage.getItem(LS_CONTENT);
    if (savedContent !== null) editor.value = savedContent;

    var savedFw = localStorage.getItem(LS_FRAMEWORK);
    if (savedFw && FRAMEWORKS[savedFw]) currentFramework = savedFw;
    frameworkDropdown.value = currentFramework;

    var savedSize = localStorage.getItem(LS_SIZESTEP);
    if (savedSize !== null) sizeStep = Math.max(SIZE_MIN, Math.min(SIZE_MAX, parseInt(savedSize, 10)));

    var savedWeight = localStorage.getItem(LS_WEIGHTSTEP);
    if (savedWeight !== null) weightStep = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, parseInt(savedWeight, 10)));

    var savedLine = localStorage.getItem(LS_LINESTEP);
    if (savedLine !== null) lineStep = Math.max(LINE_MIN, Math.min(LINE_MAX, parseInt(savedLine, 10)));

    var savedFont = localStorage.getItem(LS_FONT);
    if (savedFont && COMFORT_FONTS.some(function (f) { return f.value === savedFont; })) comfortFont = savedFont;
    fontPicker.value = comfortFont;

    var savedZoom = localStorage.getItem(LS_ZOOMSTEP);
    if (savedZoom !== null) zoomStep = Math.max(100, Math.min(120, parseInt(savedZoom, 10)));
    zoomSlider.value = zoomStep;
    zoomValue.textContent = zoomStep + "%";
    applyZoom();
  }

  /* ==========================================================================
     Event binding
     ========================================================================== */

  function bindEvents() {
    frameworkDropdown.addEventListener("change", function () {
      currentFramework = frameworkDropdown.value;
      localStorage.setItem(LS_FRAMEWORK, currentFramework);
      renderComponentGrid();
      if (mode === "preview") renderPreview();
    });

    document.getElementById("mode-switch").addEventListener("click", function (e) {
      var label = e.target.closest(".mode-switch-label");
      if (label) setMode(label.dataset.mode);
    });

    btnExportMd.addEventListener("click", exportMarkdown);
    btnExportHtml.addEventListener("click", exportHTML);
    btnExportPdf.addEventListener("click", exportPDF);

    componentsGrid.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-component]");
      if (!btn || btn.disabled) return;
      insertComponent(btn.dataset.component);
    });

    editor.addEventListener("input", function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        localStorage.setItem(LS_CONTENT, editor.value);
      }, 400);
    });

    fontPicker.addEventListener("change", function () {
      comfortFont = fontPicker.value;
      localStorage.setItem(LS_FONT, comfortFont);
      if (mode === "preview") renderPreview();
    });

    sizeUpBtn.addEventListener("click", function () {
      if (sizeStep < SIZE_MAX) { sizeStep++; localStorage.setItem(LS_SIZESTEP, sizeStep); if (mode === "preview") renderPreview(); }
    });
    sizeDownBtn.addEventListener("click", function () {
      if (sizeStep > SIZE_MIN) { sizeStep--; localStorage.setItem(LS_SIZESTEP, sizeStep); if (mode === "preview") renderPreview(); }
    });
    weightUpBtn.addEventListener("click", function () {
      if (weightStep < WEIGHT_MAX) { weightStep++; localStorage.setItem(LS_WEIGHTSTEP, weightStep); if (mode === "preview") renderPreview(); }
    });
    weightDownBtn.addEventListener("click", function () {
      if (weightStep > WEIGHT_MIN) { weightStep--; localStorage.setItem(LS_WEIGHTSTEP, weightStep); if (mode === "preview") renderPreview(); }
    });
    lineUpBtn.addEventListener("click", function () {
      if (lineStep < LINE_MAX) { lineStep++; localStorage.setItem(LS_LINESTEP, lineStep); if (mode === "preview") renderPreview(); }
    });
    lineDownBtn.addEventListener("click", function () {
      if (lineStep > LINE_MIN) { lineStep--; localStorage.setItem(LS_LINESTEP, lineStep); if (mode === "preview") renderPreview(); }
    });

    zoomSlider.addEventListener("input", function () {
      zoomStep = parseInt(this.value, 10);
      zoomValue.textContent = zoomStep + "%";
      localStorage.setItem(LS_ZOOMSTEP, zoomStep);
      applyZoom();
    });

    mdToolbar.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-md]");
      if (btn) applyMarkdownFormat(btn.dataset.md);
    });

    modalInsertBtn.addEventListener("click", handleModalInsert);
    modalCancelBtn.addEventListener("click", closeComponentModal);
    modalCloseBtn.addEventListener("click", closeComponentModal);

    initModalDrag();

    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modalOverlay.classList.contains("hidden")) {
        e.preventDefault();
        closeComponentModal();
        return;
      }
      var mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "b" || e.key === "B") { e.preventDefault(); setMode(mode === "edit" ? "preview" : "edit"); }
      if (e.key === "e" || e.key === "E") { e.preventDefault(); exportMarkdown(); }
    });
  }

  function initModalDrag() {
    var modal = document.getElementById("comp-modal");
    var header = document.getElementById("comp-modal-title").parentElement;
    var isDragging = false, startX, startY, startLeft, startTop;

    header.addEventListener("mousedown", function (e) {
      if (e.target.closest(".comp-modal-close")) return;
      isDragging = true;
      var rect = modalOverlay.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!isDragging) return;
      modalOverlay.style.left = (startLeft + e.clientX - startX) + "px";
      modalOverlay.style.top = (startTop + e.clientY - startY) + "px";
      modalOverlay.style.right = "auto";
    });
    window.addEventListener("mouseup", function () {
      isDragging = false;
    });
  }

  /* ==========================================================================
     UI Zoom
     ========================================================================== */

  function applyZoom() {
    document.querySelector(".app-shell").style.zoom = zoomStep / 100;
  }

  /* ==========================================================================
     Component grid — always renders all 5 (all frameworks support all 5)
     ========================================================================== */

  function renderComponentGrid() {
    componentsGrid.innerHTML = "";
    COMPONENTS.forEach(function (comp) {
      var btn = document.createElement("button");
      btn.className = "comp-btn";
      btn.type = "button";
      btn.dataset.component = comp.id;
      btn.title = comp.label;
      btn.textContent = comp.emoji + " " + comp.label;
      componentsGrid.appendChild(btn);
    });
  }

  /* ==========================================================================
     Framework class application
     Applies framework-specific CSS classes to .fw- hook elements in preview DOM.
     ========================================================================== */

  function applyFrameworkClasses(iframeDoc, fwKey) {
    var fw = FRAMEWORKS[fwKey];
    if (fw && typeof fw.style === "function") {
      fw.style(iframeDoc);
    }
  }

  /* ==========================================================================
     Preview rendering
     Builds a sandboxed iframe with framework CSS, markdown content,
     interactive behaviors, and comfort typography overrides.
     ========================================================================== */

  function renderPreview() {
    var fw = FRAMEWORKS[currentFramework];
    var renderedHTML = marked.parse(editor.value || "");
    var scale = SIZE_SCALE[String(sizeStep)] || 1;
    var weight = WEIGHT_MAP[String(weightStep)] || 400;
    var lineHeight = LINE_SCALE[String(lineStep)] || 1.75;
    var fontStack = '"' + comfortFont + '", system-ui, sans-serif';

    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
      + '<link rel="preconnect" href="https://fonts.googleapis.com">'
      + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
      + '<link href="' + FONTS_URL + '" rel="stylesheet">'
      + (fw.css ? '<link rel="stylesheet" href="' + fw.css + '">' : '')
      + '<style>'
      + '*, *::before, *::after { font-family: ' + fontStack + ' !important; }'
      + 'body { font-size: 15px !important;'
      + ' font-weight: ' + weight + ' !important;'
      + ' line-height: ' + lineHeight + ' !important; color: #2d2a3e;'
      + ' max-width: 780px; margin: 1.5rem auto; padding: 0 1.5rem;'
      + ' zoom: ' + scale + '; }'
      + 'h1,h2,h3,h4,h5,h6 { font-weight: ' + Math.min(weight + 200, 900) + ' !important; }'
      + 'h2 { margin-top: 1.8em !important; }'
      + 'h3 { margin-top: 1.4em !important; }'
      + 'img { max-width: 100%; }'
      + 'pre, code { font-family: "JetBrains Mono", monospace !important; }'
      + 'pre { overflow-x: auto; }'
      + '.fw-alert { padding: 0.8rem 1rem; border-radius: 4px; margin: 0.6rem 0; }'
      + '.fw-card { border: 1px solid #ddd; border-radius: 4px; margin: 1rem 0; }'
      + '.fw-card-header { padding: 1rem 1.2rem 0.4rem; }'
      + '.fw-card-title { font-weight: 700; font-size: 1.1em; }'
      + '.fw-card-body { padding: 0.4rem 1.2rem 1rem; }'
      + '.fw-form label { display: block; margin: 0.8rem 0 0.3rem; font-weight: 600; }'
      + '.fw-form input[type=text], .fw-form input[type=email], .fw-form textarea, .fw-form select { display: block; width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.95em; }'
      + '.fw-form button { margin-top: 1rem; }'
      + '</style>'
      + (fw.js ? '<script src="' + fw.js + '" defer><' + '/script>' : '')
      + '</head><body><main>' + renderedHTML + '</main>'
      + '<script>'
      + 'document.addEventListener("click", function(e) {'
      + '  var btn = e.target.closest("button");'
      + '  if (!btn || btn.closest("form")) return;'
      + '  e.preventDefault();'
      + '  alert("Clicked: " + btn.textContent.trim());'
      + '});'
      + 'document.addEventListener("submit", function(e) {'
      + '  e.preventDefault();'
      + '  var form = e.target;'
      + '  var data = new FormData(form);'
      + '  var out = [];'
      + '  data.forEach(function(v, k) { out.push(k + "=" + v); });'
      + '  alert("Form submitted! " + out.join(", "));'
      + '});'
      + '</' + 'script>'
      + '</body></html>';

    previewFrame.srcdoc = html;

    previewFrame.onload = function () {
      try {
        var iframeDoc = previewFrame.contentDocument || previewFrame.contentWindow.document;
        applyFrameworkClasses(iframeDoc, currentFramework);
        var scrollMax = iframeDoc.documentElement.scrollHeight - previewFrame.clientHeight;
        if (scrollMax > 0) {
          previewFrame.contentWindow.scrollTo(0, Math.round(lastEditScrollRatio * scrollMax));
        }
      } catch (e) { /* sandbox safety */ }
    };
  }

  /* ==========================================================================
     Edit / Preview toggle
     ========================================================================== */

  function setMode(newMode) {
    mode = newMode;
    var modeSwitch = document.getElementById("mode-switch");

    if (mode === "edit") {
      editorWrap.classList.remove("hidden");
      previewWrap.classList.add("hidden");
      btnEdit.classList.add("active");
      btnPreview.classList.remove("active");
      modeSwitch.classList.remove("preview");
    } else {
      if (editor.scrollHeight > editor.clientHeight) {
        lastEditScrollRatio = editor.scrollTop / (editor.scrollHeight - editor.clientHeight);
      } else {
        var text = editor.value || "";
        lastEditScrollRatio = text.length > 0 ? (editor.selectionStart / text.length) : 0;
      }
      renderPreview();
      editorWrap.classList.add("hidden");
      previewWrap.classList.remove("hidden");
      btnPreview.classList.add("active");
      btnEdit.classList.remove("active");
      modeSwitch.classList.add("preview");
    }
  }

  /* ==========================================================================
     Component insertion
     ========================================================================== */

  function insertComponent(componentId) {
    var comp = COMPONENTS.find(function (c) { return c.id === componentId; });
    if (!comp) return;

    if (MODAL_COMPONENTS.indexOf(componentId) !== -1) {
      openComponentModal(componentId, comp);
      return;
    }

    var snippet = getComponentSnippet(componentId);
    if (!snippet) return;
    if (mode !== "edit") setMode("edit");
    editorInsertBlock(snippet);
  }

  function getComponentSnippet(id) {
    switch (id) {
      case "alert": return ALERT_TEMPLATES;
      case "text":  return TEXT_TEMPLATE;
      default:      return "";
    }
  }

  /* ==========================================================================
     Component modal
     ========================================================================== */

  function openComponentModal(componentId, comp) {
    activeModalComponent = componentId;
    modalTitle.textContent = comp.emoji + " Insert " + comp.label;
    modalBody.innerHTML = "";

    switch (componentId) {
      case "button": buildButtonForm(); break;
      case "form":   buildFormForm();   break;
      case "card":   buildCardForm();   break;
    }

    modalOverlay.style.left = "";
    modalOverlay.style.top = "";
    modalOverlay.style.right = "";
    modalOverlay.classList.remove("hidden");
    var firstInput = modalBody.querySelector("input, textarea, select");
    if (firstInput) setTimeout(function () { firstInput.focus(); }, 80);
  }

  function closeComponentModal() {
    modalOverlay.classList.add("hidden");
    activeModalComponent = null;
    modalBody.innerHTML = "";
  }

  function handleModalInsert() {
    var snippet = "";
    switch (activeModalComponent) {
      case "button": snippet = generateButtonSnippet(); break;
      case "form":   snippet = generateFormSnippet();   break;
      case "card":   snippet = generateCardSnippet();   break;
    }
    if (snippet) {
      if (mode !== "edit") setMode("edit");
      editorInsertBlock(snippet);
    }
    closeComponentModal();
  }

  /* Button form & generator */

  function buildButtonForm() {
    modalBody.innerHTML =
      '<label for="btn-count">Number of buttons</label>'
      + '<input type="number" id="btn-count" value="3" min="1" max="8" />'
      + '<label for="btn-labels">Labels (comma-separated)</label>'
      + '<input type="text" id="btn-labels" placeholder="Action, Confirm, Cancel" />'
      + '<p class="modal-hint">Leave blank for default labels</p>';
  }

  function generateButtonSnippet() {
    var count = Math.max(1, Math.min(8, parseInt(document.getElementById("btn-count").value, 10) || 3));
    var raw = document.getElementById("btn-labels").value.trim();
    var labels = raw
      ? raw.split(",").map(function (l) { return l.trim(); }).filter(Boolean)
      : ["Action", "Confirm", "Cancel"];
    while (labels.length < count) labels.push("Button " + (labels.length + 1));
    labels = labels.slice(0, count);
    return labels.map(function (l) { return "<button>" + l + "</button>"; }).join("\n");
  }

  /* Form form & generator */

  function buildFormForm() {
    modalBody.innerHTML =
      '<label for="form-fields">Number of fields</label>'
      + '<input type="number" id="form-fields" value="3" min="1" max="8" />'
      + '<label for="form-labels">Field labels (comma-separated)</label>'
      + '<input type="text" id="form-labels" placeholder="Name, Email, Message" />'
      + '<p class="modal-hint">Leave blank for default fields (Name, Email, Message)</p>';
  }

  function generateFormSnippet() {
    var count = Math.max(1, Math.min(8, parseInt(document.getElementById("form-fields").value, 10) || 3));
    var raw = document.getElementById("form-labels").value.trim();
    var labels = raw
      ? raw.split(",").map(function (l) { return l.trim(); }).filter(Boolean)
      : ["Name", "Email", "Message"];
    while (labels.length < count) labels.push("Field " + (labels.length + 1));
    labels = labels.slice(0, count);

    var lines = ['<form class="fw-form" onsubmit="return false">'];
    labels.forEach(function (label) {
      var id = "demo-" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      var isTextarea = /message|comment|bio|description/i.test(label);
      lines.push('  <label for="' + id + '">' + label + '</label>');
      if (isTextarea) {
        lines.push('  <textarea id="' + id + '" rows="3" placeholder="Enter ' + label.toLowerCase() + '..."></textarea>');
      } else {
        var type = /email/i.test(label) ? "email" : "text";
        lines.push('  <input type="' + type + '" id="' + id + '" placeholder="Enter ' + label.toLowerCase() + '" />');
      }
    });
    lines.push('  <button type="submit">Submit</button>');
    lines.push('</form>');
    return lines.join("\n");
  }

  /* Card form & generator */

  function buildCardForm() {
    modalBody.innerHTML =
      '<label for="card-title">Card title</label>'
      + '<input type="text" id="card-title" placeholder="Card Title" />'
      + '<label for="card-subtitle">Subtitle (optional)</label>'
      + '<input type="text" id="card-subtitle" placeholder="A short subtitle" />'
      + '<label for="card-body">Card content</label>'
      + '<textarea id="card-body" rows="3" placeholder="Card content goes here..."></textarea>';
  }

  function generateCardSnippet() {
    var title = document.getElementById("card-title").value.trim() || "Card Title";
    var subtitle = document.getElementById("card-subtitle").value.trim();
    var body = document.getElementById("card-body").value.trim() || "Card content goes here.";

    return '<div class="fw-card">\n'
      + '  <div class="fw-card-header">\n'
      + '    <div class="fw-card-title">' + title + '</div>\n'
      + (subtitle ? '    <p>' + subtitle + '</p>\n' : '')
      + '  </div>\n'
      + '  <div class="fw-card-body">\n'
      + '    <p>' + body + '</p>\n'
      + '  </div>\n'
      + '</div>';
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
    window.open(URL.createObjectURL(blob), "_blank");
  }

  function exportMarkdown() {
    openInNewTab(editor.value || "", "text/plain;charset=utf-8");
  }

  function exportHTML() {
    var renderedHTML = marked.parse(editor.value || "");
    var fw = FRAMEWORKS[currentFramework];

    var htmlString = '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
      + '  <meta charset="UTF-8" />\n'
      + '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n'
      + '  <title>FlatWrite Export</title>\n'
      + '  <link rel="preconnect" href="https://fonts.googleapis.com" />\n'
      + '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n'
      + '  <link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@300;400;600;700&family=Lato:wght@300;400;700&display=swap" rel="stylesheet" />\n'
      + (fw.css ? '  <link rel="stylesheet" href="' + fw.css + '" />\n' : '')
      + '  <style>\n'
      + '    body {\n'
      + '      font-family: "Lato", system-ui, sans-serif;\n'
      + '      line-height: 1.7;\n'
      + '      max-width: 780px;\n'
      + '      margin: 2rem auto;\n'
      + '      padding: 0 1.5rem;\n'
      + '      color: #2d2a3e;\n'
      + '    }\n'
      + '    h1, h2, h3, h4, h5, h6 {\n'
      + '      font-family: "Unbounded", system-ui, sans-serif;\n'
      + '    }\n'
      + '  </style>\n'
      + (fw.js ? '  <script src="' + fw.js + '" defer><' + '/script>\n' : '')
      + '</head>\n<body>\n  <main>\n'
      + renderedHTML
      + '\n  </main>\n</body>\n</html>';

    openInNewTab(htmlString, "text/html;charset=utf-8");
  }

  function exportPDF() {
    var renderedHTML = marked.parse(editor.value || "");
    var container = document.createElement("div");
    container.innerHTML = renderedHTML;
    container.style.fontFamily = '"Lato", system-ui, sans-serif';
    container.style.lineHeight = "1.7";
    container.style.maxWidth = "780px";
    container.style.margin = "0 auto";
    container.style.padding = "0 1.5rem";
    container.style.color = "#2d2a3e";

    var headings = container.querySelectorAll("h1,h2,h3,h4,h5,h6");
    for (var i = 0; i < headings.length; i++) {
      headings[i].style.fontFamily = '"Unbounded", system-ui, sans-serif';
    }
    var imgs = container.querySelectorAll("img");
    for (var j = 0; j < imgs.length; j++) {
      imgs[j].style.maxWidth = "100%";
    }

    document.body.appendChild(container);

    html2pdf().set({
      margin: [12, 12, 12, 12],
      filename: "flatwrite-" + timestamp() + ".pdf",
      image: { type: "jpeg", quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, logging: false },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["avoid-all", "css", "legacy"] }
    }).from(container).outputPdf("blob").then(function (pdfBlob) {
      document.body.removeChild(container);
      window.open(URL.createObjectURL(pdfBlob), "_blank");
    }).catch(function () {
      document.body.removeChild(container);
    });
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
