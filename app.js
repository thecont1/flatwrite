/* ==========================================================================
   FlatWrite — app.js
   Core logic: framework selection (preview-only), edit/preview toggle,
   component insertion with per-framework support, font controls, export,
   and localStorage persistence.
   FlatWrite is backend-agnostic — works as static files, compatible with
   Bun dev servers, and could integrate with Python tools (via uv) later.
   ========================================================================== */

(function () {
  "use strict";

  /* ==========================================================================
     Framework definitions
     These CSS frameworks are loaded ONLY inside the preview iframe and in
     HTML exports. They never touch the app shell's own design.
     ========================================================================== */

  const FRAMEWORKS = {
    poshui: {
      label: "PoshUI",
      css: "https://poshui-components.netlify.app/css/main.css",
      js: "https://poshui-components.netlify.app/js/main.js",
    },
    oat: {
      label: "Oat",
      css: "https://unpkg.com/@knadh/oat/oat.min.css",
      js: "https://unpkg.com/@knadh/oat/oat.min.js",
    },
    spectre: {
      label: "Spectre.css",
      css: "https://unpkg.com/spectre.css/dist/spectre.min.css",
      js: null,
    },
  };

  /* ==========================================================================
     UI Component catalogue
     Each component has: emoji, label, snippet, and a support map per framework.
     ========================================================================== */

  const COMPONENTS = [
    {
      id: "button",
      emoji: "🔘",
      label: "Button",
      support: { poshui: true, oat: true, spectre: true },
      snippets: {
        poshui:  '<button class="btn btn-primary-bg">Primary</button>\n<button class="btn btn-secondary-bg">Secondary</button>',
        oat:     "<button>Default</button>\n<button class=\"primary\">Primary</button>",
        spectre: '<button class="btn btn-primary">Primary</button>\n<button class="btn">Default</button>',
      },
    },
    {
      id: "card",
      emoji: "🃏",
      label: "Card",
      support: { poshui: true, oat: true, spectre: true },
      snippets: {
        poshui:  '<div class="card">\n  <div class="card-header">\n    <h3>Card Title</h3>\n  </div>\n  <div class="card-body">\n    <p>Card content goes here.</p>\n  </div>\n</div>',
        oat:     "<div class=\"card\">\n  <h3>Card Title</h3>\n  <p>Card content goes here.</p>\n</div>",
        spectre: '<div class="card">\n  <div class="card-header">\n    <div class="card-title h5">Card Title</div>\n    <div class="card-subtitle text-gray">Subtitle</div>\n  </div>\n  <div class="card-body">Card content goes here.</div>\n</div>',
      },
    },
    {
      id: "alert",
      emoji: "⚠️",
      label: "Alert",
      support: { poshui: true, oat: true, spectre: true },
      snippets: {
        poshui:  '<div class="alert alert-warning">\n  <strong>Warning:</strong> This is an alert.\n</div>',
        oat:     '<div class="alert warning">\n  <strong>Warning:</strong> This is an alert.\n</div>',
        spectre: '<div class="toast toast-warning">\n  <button class="btn btn-clear float-right"></button>\n  <strong>Warning:</strong> This is an alert.\n</div>',
      },
    },
    {
      id: "badge",
      emoji: "🏷️",
      label: "Badge",
      support: { poshui: true, oat: true, spectre: true },
      snippets: {
        poshui:  '<span class="badge badge-primary-bg">Primary</span> <span class="badge badge-secondary-bg">Secondary</span>',
        oat:     '<span class="badge">Default</span> <span class="badge primary">Primary</span>',
        spectre: '<span class="label label-primary">Primary</span> <span class="label label-secondary">Secondary</span>',
      },
    },
    {
      id: "avatar",
      emoji: "👤",
      label: "Avatar",
      support: { poshui: true, oat: false, spectre: true },
      snippets: {
        poshui:  '<div class="avatar avatar-md">\n  <img src="https://i.pravatar.cc/150" alt="avatar" />\n</div>',
        oat:     "",
        spectre: '<figure class="avatar avatar-lg">\n  <img src="https://i.pravatar.cc/150" alt="avatar" />\n</figure>',
      },
    },
    {
      id: "table",
      emoji: "📊",
      label: "Table",
      support: { poshui: false, oat: true, spectre: true },
      snippets: {
        poshui:  "",
        oat:     "<table>\n  <thead>\n    <tr><th>Column 1</th><th>Column 2</th><th>Column 3</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>Cell 1</td><td>Cell 2</td><td>Cell 3</td></tr>\n    <tr><td>Cell 4</td><td>Cell 5</td><td>Cell 6</td></tr>\n  </tbody>\n</table>",
        spectre: '<table class="table table-striped table-hover">\n  <thead>\n    <tr><th>Column 1</th><th>Column 2</th><th>Column 3</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>Cell 1</td><td>Cell 2</td><td>Cell 3</td></tr>\n    <tr><td>Cell 4</td><td>Cell 5</td><td>Cell 6</td></tr>\n  </tbody>\n</table>',
      },
    },
    {
      id: "accordion",
      emoji: "🪗",
      label: "Accordion",
      support: { poshui: false, oat: true, spectre: true },
      snippets: {
        poshui:  "",
        oat:     "<details>\n  <summary>Click to expand</summary>\n  <p>Hidden content goes here.</p>\n</details>",
        spectre: '<div class="accordion">\n  <input type="checkbox" id="accordion-1" name="accordion-checkbox" hidden>\n  <label class="accordion-header" for="accordion-1">\n    <i class="icon icon-arrow-right mr-1"></i> Click to expand\n  </label>\n  <div class="accordion-body">\n    <p>Hidden content goes here.</p>\n  </div>\n</div>',
      },
    },
    {
      id: "modal",
      emoji: "🪟",
      label: "Modal",
      support: { poshui: true, oat: false, spectre: true },
      snippets: {
        poshui:  '<div class="modal">\n  <div class="modal-content">\n    <h3>Modal Title</h3>\n    <p>Modal body content.</p>\n    <button class="btn btn-primary-bg">Close</button>\n  </div>\n</div>',
        oat:     "",
        spectre: '<div class="modal active">\n  <a class="modal-overlay" href="#close"></a>\n  <div class="modal-container">\n    <div class="modal-header">\n      <div class="modal-title h5">Modal Title</div>\n    </div>\n    <div class="modal-body">\n      <p>Modal body content.</p>\n    </div>\n    <div class="modal-footer">\n      <button class="btn btn-primary">Close</button>\n    </div>\n  </div>\n</div>',
      },
    },
    {
      id: "tooltip",
      emoji: "💬",
      label: "Tooltip",
      support: { poshui: true, oat: true, spectre: true },
      snippets: {
        poshui:  '<span class="tooltip" data-tooltip="Tooltip text">Hover me</span>',
        oat:     '<span class="tooltip" data-tooltip="Tooltip text">Hover me</span>',
        spectre: '<span class="tooltip" data-tooltip="Tooltip text">Hover me</span>',
      },
    },
    {
      id: "toast",
      emoji: "🍞",
      label: "Toast",
      support: { poshui: true, oat: true, spectre: true },
      snippets: {
        poshui:  '<div class="toast toast-success">\n  <p>Success! Operation completed.</p>\n</div>',
        oat:     '<div class="toast success">\n  Success! Operation completed.\n</div>',
        spectre: '<div class="toast toast-success">\n  <button class="btn btn-clear float-right"></button>\n  Success! Operation completed.\n</div>',
      },
    },
    {
      id: "nav",
      emoji: "🧭",
      label: "Nav",
      support: { poshui: true, oat: false, spectre: true },
      snippets: {
        poshui:  '<nav class="navigation">\n  <a href="#">Home</a>\n  <a href="#">About</a>\n  <a href="#">Contact</a>\n</nav>',
        oat:     "",
        spectre: '<ul class="nav">\n  <li class="nav-item"><a href="#">Home</a></li>\n  <li class="nav-item"><a href="#">About</a></li>\n  <li class="nav-item"><a href="#">Contact</a></li>\n</ul>',
      },
    },
    {
      id: "tabs",
      emoji: "📑",
      label: "Tabs",
      support: { poshui: false, oat: true, spectre: true },
      snippets: {
        poshui:  "",
        oat:     '<div class="tabs">\n  <a href="#" class="active">Tab 1</a>\n  <a href="#">Tab 2</a>\n  <a href="#">Tab 3</a>\n</div>',
        spectre: '<ul class="tab">\n  <li class="tab-item active"><a href="#">Tab 1</a></li>\n  <li class="tab-item"><a href="#">Tab 2</a></li>\n  <li class="tab-item"><a href="#">Tab 3</a></li>\n</ul>',
      },
    },
    {
      id: "progress",
      emoji: "📶",
      label: "Progress",
      support: { poshui: false, oat: true, spectre: true },
      snippets: {
        poshui:  "",
        oat:     '<progress value="60" max="100">60%</progress>',
        spectre: '<div class="bar">\n  <div class="bar-item" role="progressbar" style="width:60%;" aria-valuenow="60" aria-valuemin="0" aria-valuemax="100"></div>\n</div>',
      },
    },
    {
      id: "input",
      emoji: "✏️",
      label: "Form Input",
      support: { poshui: true, oat: true, spectre: true },
      snippets: {
        poshui:  '<div class="input-container">\n  <label>Email</label>\n  <input type="email" placeholder="you@example.com" />\n</div>',
        oat:     '<label>Email\n  <input type="email" placeholder="you@example.com" />\n</label>',
        spectre: '<div class="form-group">\n  <label class="form-label" for="input-email">Email</label>\n  <input class="form-input" type="email" id="input-email" placeholder="you@example.com" />\n</div>',
      },
    },
    {
      id: "image",
      emoji: "🖼️",
      label: "Image",
      support: { poshui: true, oat: false, spectre: true },
      snippets: {
        poshui:  '<img class="img-responsive" src="https://picsum.photos/600/300" alt="Sample image" />',
        oat:     "",
        spectre: '<img class="img-responsive" src="https://picsum.photos/600/300" alt="Sample image" />',
      },
    },
    {
      id: "list",
      emoji: "📋",
      label: "List",
      support: { poshui: true, oat: false, spectre: false },
      snippets: {
        poshui:  '<ul class="list list-style-disc">\n  <li>First item</li>\n  <li>Second item</li>\n  <li>Third item</li>\n</ul>',
        oat:     "",
        spectre: "",
      },
    },
    {
      id: "slider",
      emoji: "🎚️",
      label: "Slider",
      support: { poshui: true, oat: false, spectre: false },
      snippets: {
        poshui:  '<input type="range" class="slider" min="0" max="100" value="50" />',
        oat:     "",
        spectre: "",
      },
    },
    {
      id: "rating",
      emoji: "⭐",
      label: "Rating",
      support: { poshui: true, oat: false, spectre: false },
      snippets: {
        poshui:  '<div class="rating">\n  <span class="rating-star">★</span>\n  <span class="rating-star">★</span>\n  <span class="rating-star">★</span>\n  <span class="rating-star">☆</span>\n  <span class="rating-star">☆</span>\n</div>',
        oat:     "",
        spectre: "",
      },
    },
    {
      id: "switch",
      emoji: "🔀",
      label: "Switch",
      support: { poshui: false, oat: true, spectre: false },
      snippets: {
        poshui:  "",
        oat:     '<label class="switch">\n  <input type="checkbox" />\n  Enable feature\n</label>',
        spectre: "",
      },
    },
    {
      id: "spinner",
      emoji: "🔄",
      label: "Spinner",
      support: { poshui: false, oat: true, spectre: false },
      snippets: {
        poshui:  "",
        oat:     '<div class="spinner"></div>',
        spectre: "",
      },
    },
    {
      id: "breadcrumb",
      emoji: "🥖",
      label: "Breadcrumb",
      support: { poshui: false, oat: false, spectre: true },
      snippets: {
        poshui:  "",
        oat:     "",
        spectre: '<ul class="breadcrumb">\n  <li class="breadcrumb-item"><a href="#">Home</a></li>\n  <li class="breadcrumb-item"><a href="#">Docs</a></li>\n  <li class="breadcrumb-item">Current</li>\n</ul>',
      },
    },
    {
      id: "chip",
      emoji: "🏅",
      label: "Chip",
      support: { poshui: false, oat: false, spectre: true },
      snippets: {
        poshui:  "",
        oat:     "",
        spectre: '<span class="chip">Tag One<button class="btn btn-clear" aria-label="Close"></button></span>\n<span class="chip">Tag Two<button class="btn btn-clear" aria-label="Close"></button></span>',
      },
    },
    {
      id: "panel",
      emoji: "📦",
      label: "Panel",
      support: { poshui: false, oat: false, spectre: true },
      snippets: {
        poshui:  "",
        oat:     "",
        spectre: '<div class="panel">\n  <div class="panel-header">\n    <div class="panel-title">Panel Title</div>\n  </div>\n  <div class="panel-body">\n    <p>Panel content goes here.</p>\n  </div>\n</div>',
      },
    },
    {
      id: "steps",
      emoji: "👣",
      label: "Steps",
      support: { poshui: false, oat: false, spectre: true },
      snippets: {
        poshui:  "",
        oat:     "",
        spectre: '<ul class="step">\n  <li class="step-item active"><a href="#">Step 1</a></li>\n  <li class="step-item"><a href="#">Step 2</a></li>\n  <li class="step-item"><a href="#">Step 3</a></li>\n</ul>',
      },
    },
    {
      id: "dropdown",
      emoji: "🔽",
      label: "Dropdown",
      support: { poshui: false, oat: true, spectre: false },
      snippets: {
        poshui:  "",
        oat:     '<div class="dropdown">\n  <button>Open Menu</button>\n  <div class="items">\n    <a href="#">Option 1</a>\n    <a href="#">Option 2</a>\n    <a href="#">Option 3</a>\n  </div>\n</div>',
        spectre: "",
      },
    },
    {
      id: "skeleton",
      emoji: "🦴",
      label: "Skeleton",
      support: { poshui: false, oat: true, spectre: false },
      snippets: {
        poshui:  "",
        oat:     '<div class="skeleton">\n  <div class="line"></div>\n  <div class="line"></div>\n  <div class="line short"></div>\n</div>',
        spectre: "",
      },
    },
    {
      id: "meter",
      emoji: "📏",
      label: "Meter",
      support: { poshui: false, oat: true, spectre: false },
      snippets: {
        poshui:  "",
        oat:     '<meter min="0" max="100" value="65" low="25" high="75" optimum="80">65%</meter>',
        spectre: "",
      },
    },
    {
      id: "sidebar_comp",
      emoji: "📐",
      label: "Sidebar",
      support: { poshui: false, oat: true, spectre: false },
      snippets: {
        poshui:  "",
        oat:     '<div class="sidebar">\n  <nav>\n    <a href="#">Link 1</a>\n    <a href="#">Link 2</a>\n    <a href="#">Link 3</a>\n  </nav>\n</div>',
        spectre: "",
      },
    },
    {
      id: "dialog",
      emoji: "🗨️",
      label: "Dialog",
      support: { poshui: false, oat: true, spectre: false },
      snippets: {
        poshui:  "",
        oat:     '<dialog open>\n  <h3>Dialog Title</h3>\n  <p>Dialog body content.</p>\n  <form method="dialog">\n    <button>Close</button>\n  </form>\n</dialog>',
        spectre: "",
      },
    },
  ];

  /* ==========================================================================
     LocalStorage keys
     ========================================================================== */

  const LS_CONTENT   = "flatwrite_content";
  const LS_FRAMEWORK = "flatwrite_framework";
  const LS_SIZESTEP    = "flatwrite_sizestep";
  const LS_WEIGHTSTEP  = "flatwrite_weightstep";
  const LS_LINESTEP    = "flatwrite_linestep";
  const LS_COMFORTFONT = "flatwrite_comfortfont";

  /* Comfort font options (preview only — never affects export) */
  const COMFORT_FONTS = [
    { value: "Unbounded",         label: "Unbounded" },
    { value: "Lato",              label: "Lato" },
    { value: "Inter",             label: "Inter" },
    { value: "Merriweather",      label: "Merriweather" },
    { value: "Playfair Display",  label: "Playfair Display" },
    { value: "Space Grotesk",     label: "Space Grotesk" },
    { value: "Crimson Text",      label: "Crimson Text" },
    { value: "Outfit",            label: "Outfit" },
    { value: "Bitter",            label: "Bitter" },
    { value: "DM Serif Display",  label: "DM Serif Display" },
    { value: "JetBrains Mono",    label: "JetBrains Mono" },
    { value: "Source Code Pro",   label: "Source Code Pro" },
  ];

  /* Size steps: each step adds/removes ~2px equivalent via a scale factor.
     Step 0 = 1.0x (default 15px base). Range: -3 to +4. */
  const SIZE_SCALE = { "-3": 0.76, "-2": 0.84, "-1": 0.92, "0": 1, "1": 1.1, "2": 1.2, "3": 1.32, "4": 1.46 };
  const SIZE_MIN = -3;
  const SIZE_MAX = 4;

  /* Weight steps: 0 = 400 (regular), -1 = 300 (light), +1 = 600 (semi), +2 = 700 (bold) */
  const WEIGHT_MAP = { "-1": 300, "0": 400, "1": 600, "2": 700 };
  const WEIGHT_MIN = -1;
  const WEIGHT_MAX = 2;

  /* Line-height steps: 0 = 1.75 (default). Range: -2 to +3. */
  const LINE_SCALE = { "-2": 1.3, "-1": 1.5, "0": 1.75, "1": 2.0, "2": 2.3, "3": 2.6 };
  const LINE_MIN = -2;
  const LINE_MAX = 3;

  /* ==========================================================================
     State
     ========================================================================== */

  let mode = "edit"; // "edit" | "preview"
  let currentFramework = "poshui";
  let sizeStep = 0;              // default = 1.0x scale
  let weightStep = 0;            // default = 400 (regular)
  let lineStep = 0;              // default = 1.75 line-height
  let comfortFont = "Unbounded"; // default body font for preview
  let debounceTimer = null;

  /* ==========================================================================
     DOM references
     ========================================================================== */

  const frameworkDropdown = document.getElementById("framework-dropdown");
  const frameworkCurrent  = document.getElementById("framework-current");
  const editor            = document.getElementById("editor");
  const editorWrap        = document.getElementById("editor-wrap");
  const previewWrap       = document.getElementById("preview-wrap");
  const previewFrame      = document.getElementById("preview-frame");
  const btnEdit           = document.getElementById("btn-edit");
  const btnPreview        = document.getElementById("btn-preview");
  const btnExportMd       = document.getElementById("btn-export-md");
  const btnExportHtml     = document.getElementById("btn-export-html");
  const btnExportPdf      = document.getElementById("btn-export-pdf");
  const mdToolbar         = document.getElementById("md-toolbar");
  const componentsGrid    = document.getElementById("components-grid");
  const sizeDownBtn       = document.getElementById("size-down");
  const sizeUpBtn         = document.getElementById("size-up");
  const weightDownBtn     = document.getElementById("weight-down");
  const weightUpBtn       = document.getElementById("weight-up");
  const fontPicker        = document.getElementById("font-picker");
  const lineDownBtn       = document.getElementById("line-down");
  const lineUpBtn         = document.getElementById("line-up");
  const modalOverlay      = document.getElementById("comp-modal-overlay");
  const modalTitle        = document.getElementById("comp-modal-title");
  const modalBody         = document.getElementById("comp-modal-body");
  const modalInsertBtn    = document.getElementById("comp-modal-insert");
  const modalCancelBtn    = document.getElementById("comp-modal-cancel");
  const modalCloseBtn     = document.getElementById("comp-modal-close");

  /* ==========================================================================
     Initialisation
     ========================================================================== */

  function init() {
    restoreFromStorage();
    renderComponentGrid();
    bindEvents();
  }

  /* ---------- Restore persisted state ---------- */
  function restoreFromStorage() {
    // Restore content
    const savedContent = localStorage.getItem(LS_CONTENT);
    if (savedContent !== null) {
      editor.value = savedContent;
    }

    // Restore framework
    const savedFw = localStorage.getItem(LS_FRAMEWORK);
    if (savedFw && FRAMEWORKS[savedFw]) {
      currentFramework = savedFw;
    }
    frameworkDropdown.value = currentFramework;
    applyFramework(currentFramework);

    // Restore size step
    const savedSize = localStorage.getItem(LS_SIZESTEP);
    if (savedSize !== null) {
      sizeStep = Math.max(SIZE_MIN, Math.min(SIZE_MAX, parseInt(savedSize, 10)));
    }

    // Restore weight step
    const savedWeight = localStorage.getItem(LS_WEIGHTSTEP);
    if (savedWeight !== null) {
      weightStep = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, parseInt(savedWeight, 10)));
    }

    // Restore line step
    const savedLine = localStorage.getItem(LS_LINESTEP);
    if (savedLine !== null) {
      lineStep = Math.max(LINE_MIN, Math.min(LINE_MAX, parseInt(savedLine, 10)));
    }

    // Restore comfort font
    const savedFont = localStorage.getItem(LS_COMFORTFONT);
    if (savedFont && COMFORT_FONTS.some(function (f) { return f.value === savedFont; })) {
      comfortFont = savedFont;
    }
    fontPicker.value = comfortFont;
  }

  /* ---------- Bind all event listeners ---------- */
  function bindEvents() {
    // Framework change
    frameworkDropdown.addEventListener("change", function () {
      currentFramework = frameworkDropdown.value;
      applyFramework(currentFramework);
      localStorage.setItem(LS_FRAMEWORK, currentFramework);
    });

    // Size +/−
    sizeUpBtn.addEventListener("click", function () {
      if (sizeStep < SIZE_MAX) {
        sizeStep++;
        localStorage.setItem(LS_SIZESTEP, sizeStep);
        if (mode === "preview") renderPreview();
      }
    });
    sizeDownBtn.addEventListener("click", function () {
      if (sizeStep > SIZE_MIN) {
        sizeStep--;
        localStorage.setItem(LS_SIZESTEP, sizeStep);
        if (mode === "preview") renderPreview();
      }
    });

    // Weight +/−
    weightUpBtn.addEventListener("click", function () {
      if (weightStep < WEIGHT_MAX) {
        weightStep++;
        localStorage.setItem(LS_WEIGHTSTEP, weightStep);
        if (mode === "preview") renderPreview();
      }
    });
    weightDownBtn.addEventListener("click", function () {
      if (weightStep > WEIGHT_MIN) {
        weightStep--;
        localStorage.setItem(LS_WEIGHTSTEP, weightStep);
        if (mode === "preview") renderPreview();
      }
    });

    // Line spacing +/−
    lineUpBtn.addEventListener("click", function () {
      if (lineStep < LINE_MAX) {
        lineStep++;
        localStorage.setItem(LS_LINESTEP, lineStep);
        if (mode === "preview") renderPreview();
      }
    });
    lineDownBtn.addEventListener("click", function () {
      if (lineStep > LINE_MIN) {
        lineStep--;
        localStorage.setItem(LS_LINESTEP, lineStep);
        if (mode === "preview") renderPreview();
      }
    });

    // Font family picker
    fontPicker.addEventListener("change", function () {
      comfortFont = fontPicker.value;
      localStorage.setItem(LS_COMFORTFONT, comfortFont);
      if (mode === "preview") renderPreview();
    });

    // Mode toggle buttons
    btnEdit.addEventListener("click", function () {
      setMode("edit");
    });
    btnPreview.addEventListener("click", function () {
      setMode("preview");
    });

    // Export icon buttons
    btnExportMd.addEventListener("click", exportMarkdown);
    btnExportHtml.addEventListener("click", exportHTML);
    btnExportPdf.addEventListener("click", exportPDF);

    // Autosave on input (debounced at 400ms)
    editor.addEventListener("input", function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        localStorage.setItem(LS_CONTENT, editor.value);
      }, 400);
    });

    // Markdown formatting toolbar (delegated click)
    mdToolbar.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-md]");
      if (!btn) return;
      applyMarkdownFormat(btn.dataset.md);
    });

    // UI Component snippets (delegated click)
    componentsGrid.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-component]");
      if (!btn || btn.disabled) return;
      insertComponent(btn.dataset.component);
    });

    // Component modal buttons
    modalInsertBtn.addEventListener("click", handleModalInsert);
    modalCancelBtn.addEventListener("click", closeComponentModal);
    modalCloseBtn.addEventListener("click", closeComponentModal);
    modalOverlay.addEventListener("click", function (e) {
      if (e.target === modalOverlay) closeComponentModal();
    });

    // Keyboard shortcuts
    // Ctrl/Cmd + B → toggle edit/preview
    // Ctrl/Cmd + E → export markdown
    // Escape → close modal
    window.addEventListener("keydown", function (e) {
      // Escape closes modal
      if (e.key === "Escape" && !modalOverlay.classList.contains("hidden")) {
        e.preventDefault();
        closeComponentModal();
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        setMode(mode === "edit" ? "preview" : "edit");
      }

      if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        exportMarkdown();
      }
    });
  }

  /* ==========================================================================
     Framework selection
     Frameworks only affect the preview and export — never the app shell.
     ========================================================================== */

  function applyFramework(fwKey) {
    currentFramework = fwKey;
    document.documentElement.dataset.framework = fwKey;
    var fw = FRAMEWORKS[fwKey];
    frameworkCurrent.textContent = "Active: " + (fw ? fw.label : fwKey);

    // Re-render component grid to enable/disable per framework
    renderComponentGrid();

    // If preview is currently visible, re-render it with new framework
    if (mode === "preview") {
      renderPreview();
    }
  }

  /* ==========================================================================
     Component grid rendering
     Builds buttons dynamically; disables those unsupported by the active
     framework.
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

      var supported = comp.support[currentFramework];
      if (!supported) {
        btn.disabled = true;
        btn.classList.add("comp-btn-disabled");
        btn.title = comp.label + " (not supported by " + FRAMEWORKS[currentFramework].label + ")";
      }

      componentsGrid.appendChild(btn);
    });
  }

  /* ==========================================================================
     Edit / Preview toggle
     Preview renders into a sandboxed iframe so framework CSS cannot leak
     into the app shell.
     ========================================================================== */

  function setMode(newMode) {
    mode = newMode;

    if (mode === "edit") {
      editorWrap.classList.remove("hidden");
      previewWrap.classList.add("hidden");
      btnEdit.classList.add("active");
      btnPreview.classList.remove("active");
    } else {
      renderPreview();
      editorWrap.classList.add("hidden");
      previewWrap.classList.remove("hidden");
      btnPreview.classList.add("active");
      btnEdit.classList.remove("active");
    }
  }

  /* Build the preview HTML and inject it into the iframe.
     Comfort settings (font, size scale, weight) use !important to override
     any framework CSS defaults. These are preview-only — export ignores them. */
  function renderPreview() {
    var fw = FRAMEWORKS[currentFramework];
    var renderedHTML = marked.parse(editor.value || "");
    var scale = SIZE_SCALE[String(sizeStep)] || 1;
    var weight = WEIGHT_MAP[String(weightStep)] || 400;
    var lineHeight = LINE_SCALE[String(lineStep)] || 1.75;
    var fontStack = '"' + comfortFont + '", system-ui, sans-serif';
    var fontsUrl = 'https://fonts.googleapis.com/css2?family=Unbounded:wght@300;400;600;700'
      + '&family=Lato:wght@300;400;700'
      + '&family=Inter:wght@300;400;600;700'
      + '&family=Merriweather:wght@300;400;700'
      + '&family=Source+Code+Pro:wght@300;400;600;700'
      + '&family=Playfair+Display:wght@400;600;700'
      + '&family=Space+Grotesk:wght@300;400;600;700'
      + '&family=Crimson+Text:wght@400;600;700'
      + '&family=Outfit:wght@300;400;600;700'
      + '&family=Bitter:wght@300;400;600;700'
      + '&family=DM+Serif+Display'
      + '&family=JetBrains+Mono:wght@300;400;600;700'
      + '&display=swap';

    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
      + '<link rel="preconnect" href="https://fonts.googleapis.com">'
      + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
      + '<link href="' + fontsUrl + '" rel="stylesheet">'
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
      + 'h4 { margin-top: 1.2em !important; }'
      + 'img { max-width: 100%; }'
      + 'pre, code { font-family: "Source Code Pro", monospace !important; }'
      + 'pre { overflow-x: auto; }'
      + '</style>'
      + (fw.js ? '<script src="' + fw.js + '" defer></' + 'script>' : '')
      + '</head><body><main>' + renderedHTML + '</main></body></html>';

    // Use srcdoc to avoid document.write parsing issues with <script> tags
    previewFrame.srcdoc = html;
  }

  /* ==========================================================================
     Markdown formatting toolbar
     Wraps or prefixes selected text with markdown syntax. If no text is
     selected, inserts placeholder text at the cursor position.
     ========================================================================== */

  /* Helper: get selection range, insert text, restore cursor, trigger save */
  function editorInsert(before, middle, after) {
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    var selected = editor.value.substring(start, end);
    var text = selected || middle;
    var replacement = before + text + after;

    editor.focus();
    // Use execCommand for undo support where available, fall back to manual
    if (document.queryCommandSupported && document.queryCommandSupported("insertText")) {
      editor.setSelectionRange(start, end);
      document.execCommand("insertText", false, replacement);
    } else {
      editor.value =
        editor.value.substring(0, start) + replacement + editor.value.substring(end);
    }

    // Place cursor: if there was a selection, select the replaced text;
    // otherwise place cursor inside the markers for easy typing
    if (selected) {
      editor.setSelectionRange(start, start + replacement.length);
    } else {
      editor.setSelectionRange(start + before.length, start + before.length + middle.length);
    }

    // Trigger autosave
    editor.dispatchEvent(new Event("input"));
  }

  /* Helper: insert text at cursor on its own line(s) */
  function editorInsertBlock(block) {
    var start = editor.selectionStart;
    var val = editor.value;
    var prefix = (start > 0 && val[start - 1] !== "\n") ? "\n" : "";
    var suffix = "\n";

    editor.focus();
    editor.setSelectionRange(start, start);
    var insertion = prefix + block + suffix;

    if (document.queryCommandSupported && document.queryCommandSupported("insertText")) {
      document.execCommand("insertText", false, insertion);
    } else {
      editor.value = val.substring(0, start) + insertion + val.substring(start);
    }

    var cursorPos = start + insertion.length;
    editor.setSelectionRange(cursorPos, cursorPos);
    editor.dispatchEvent(new Event("input"));
  }

  /* Apply a markdown format based on the toolbar button's data-md value */
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
     UI Component snippet insertion
     Inserts the framework-specific snippet for the selected component.
     ========================================================================== */

  /* Components that get a modal form instead of direct insertion */
  var MODAL_COMPONENTS = ["table", "card", "list", "image"];
  var activeModalComponent = null; // tracks which component the modal is for

  function insertComponent(componentId) {
    var comp = COMPONENTS.find(function (c) { return c.id === componentId; });
    if (!comp) return;
    if (!comp.support[currentFramework]) return;

    // Route modal-enabled components through the form
    if (MODAL_COMPONENTS.indexOf(componentId) !== -1) {
      openComponentModal(componentId, comp);
      return;
    }

    // All other components: direct insertion
    var snippet = comp.snippets[currentFramework];
    if (!snippet) return;
    if (mode !== "edit") setMode("edit");
    editorInsertBlock(snippet);
  }

  /* ==========================================================================
     Component Modal — friendly forms for Table, Card, List, Image
     ========================================================================== */

  function openComponentModal(componentId, comp) {
    activeModalComponent = componentId;
    modalTitle.textContent = comp.emoji + " Insert " + comp.label;
    modalBody.innerHTML = "";

    switch (componentId) {
      case "table":  buildTableForm();  break;
      case "card":   buildCardForm();   break;
      case "list":   buildListForm();   break;
      case "image":  buildImageForm();  break;
    }

    modalOverlay.classList.remove("hidden");
    // Focus first input
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
      case "table":  snippet = generateTableSnippet();  break;
      case "card":   snippet = generateCardSnippet();   break;
      case "list":   snippet = generateListSnippet();   break;
      case "image":  snippet = generateImageSnippet();  break;
    }

    if (snippet) {
      if (mode !== "edit") setMode("edit");
      editorInsertBlock(snippet);
    }
    closeComponentModal();
  }

  /* ---------- TABLE form & generator ---------- */

  function buildTableForm() {
    modalBody.innerHTML =
      '<div class="modal-row">'
      + '  <div><label for="tbl-cols">Columns</label>'
      + '  <input type="number" id="tbl-cols" value="3" min="1" max="10" /></div>'
      + '  <div><label for="tbl-rows">Rows</label>'
      + '  <input type="number" id="tbl-rows" value="3" min="1" max="20" /></div>'
      + '</div>'
      + '<label for="tbl-headers">Column headers (comma-separated)</label>'
      + '<input type="text" id="tbl-headers" placeholder="Name, Age, City" />'
      + '<p class="modal-hint">Leave blank for generic headers (Column 1, Column 2…)</p>';
  }

  function generateTableSnippet() {
    var cols = Math.max(1, Math.min(10, parseInt(document.getElementById("tbl-cols").value, 10) || 3));
    var rows = Math.max(1, Math.min(20, parseInt(document.getElementById("tbl-rows").value, 10) || 3));
    var headersRaw = document.getElementById("tbl-headers").value.trim();
    var headers = headersRaw
      ? headersRaw.split(",").map(function (h) { return h.trim(); })
      : [];

    // Pad or trim headers to match column count
    while (headers.length < cols) headers.push("Column " + (headers.length + 1));
    headers = headers.slice(0, cols);

    // Build markdown table
    var headerRow = "| " + headers.join(" | ") + " |";
    var sepRow = "| " + headers.map(function () { return "---"; }).join(" | ") + " |";
    var bodyRows = [];
    for (var r = 0; r < rows; r++) {
      var cells = [];
      for (var c = 0; c < cols; c++) cells.push(" ");
      bodyRows.push("| " + cells.join(" | ") + " |");
    }

    return headerRow + "\n" + sepRow + "\n" + bodyRows.join("\n");
  }

  /* ---------- CARD form & generator ---------- */

  function buildCardForm() {
    modalBody.innerHTML =
      '<label for="card-title">Card title</label>'
      + '<input type="text" id="card-title" placeholder="My Card" />'
      + '<label for="card-subtitle">Subtitle (optional)</label>'
      + '<input type="text" id="card-subtitle" placeholder="A short subtitle" />'
      + '<label for="card-body">Card content</label>'
      + '<textarea id="card-body" rows="3" placeholder="Write your card content here…"></textarea>';
  }

  function generateCardSnippet() {
    var title = document.getElementById("card-title").value.trim() || "Card Title";
    var subtitle = document.getElementById("card-subtitle").value.trim();
    var body = document.getElementById("card-body").value.trim() || "Card content goes here.";
    var fw = currentFramework;

    if (fw === "poshui") {
      return '<div class="card">\n  <div class="card-header">\n    <h3>' + title + '</h3>'
        + (subtitle ? '\n    <p>' + subtitle + '</p>' : '')
        + '\n  </div>\n  <div class="card-body">\n    <p>' + body + '</p>\n  </div>\n</div>';
    } else if (fw === "oat") {
      return '<div class="card">\n  <h3>' + title + '</h3>'
        + (subtitle ? '\n  <p><em>' + subtitle + '</em></p>' : '')
        + '\n  <p>' + body + '</p>\n</div>';
    } else {
      return '<div class="card">\n  <div class="card-header">\n    <div class="card-title h5">' + title + '</div>'
        + (subtitle ? '\n    <div class="card-subtitle text-gray">' + subtitle + '</div>' : '')
        + '\n  </div>\n  <div class="card-body">' + body + '</div>\n</div>';
    }
  }

  /* ---------- LIST form & generator ---------- */

  function buildListForm() {
    modalBody.innerHTML =
      '<label for="list-type">List type</label>'
      + '<select id="list-type">'
      + '  <option value="ul">Bullet list</option>'
      + '  <option value="ol">Numbered list</option>'
      + '  <option value="task">Task list</option>'
      + '</select>'
      + '<label for="list-items">Items (one per line)</label>'
      + '<textarea id="list-items" rows="5" placeholder="First item\nSecond item\nThird item"></textarea>'
      + '<p class="modal-hint">Each line becomes a list item</p>';
  }

  function generateListSnippet() {
    var type = document.getElementById("list-type").value;
    var raw = document.getElementById("list-items").value.trim();
    var items = raw ? raw.split("\n").filter(function (l) { return l.trim(); }) : ["Item 1", "Item 2", "Item 3"];

    if (type === "ul") {
      return items.map(function (item) { return "- " + item.trim(); }).join("\n");
    } else if (type === "ol") {
      return items.map(function (item, i) { return (i + 1) + ". " + item.trim(); }).join("\n");
    } else {
      return items.map(function (item) { return "- [ ] " + item.trim(); }).join("\n");
    }
  }

  /* ---------- IMAGE form & generator ---------- */

  function buildImageForm() {
    modalBody.innerHTML =
      '<label for="img-url">Image URL</label>'
      + '<input type="url" id="img-url" placeholder="https://example.com/photo.jpg" />'
      + '<label for="img-alt">Alt text (description)</label>'
      + '<input type="text" id="img-alt" placeholder="A beautiful sunset" />'
      + '<label for="img-caption">Caption (optional)</label>'
      + '<input type="text" id="img-caption" placeholder="Photo by Jane Doe" />'
      + '<p class="modal-hint">Caption appears below the image as italic text</p>';
  }

  function generateImageSnippet() {
    var url = document.getElementById("img-url").value.trim() || "https://picsum.photos/600/300";
    var alt = document.getElementById("img-alt").value.trim() || "Image";
    var caption = document.getElementById("img-caption").value.trim();

    var md = "![" + alt + "](" + url + ")";
    if (caption) {
      md += "\n\n*" + caption + "*";
    }
    return md;
  }

  /* ==========================================================================
     Export functions
     ========================================================================== */

  function timestamp() {
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const h = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");
    return y + mo + d + "-" + h + mi;
  }

  function openInNewTab(content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  }

  function exportMarkdown() {
    const content = editor.value || "";
    openInNewTab(content, "text/plain;charset=utf-8");
  }

  /* Export full HTML page with the selected framework CSS */
  function exportHTML() {
    const mdContent = editor.value || "";
    const renderedHTML = marked.parse(mdContent);
    const fw = FRAMEWORKS[currentFramework];

    /* Export uses clean defaults — comfort settings (font, size, weight) are
       intentionally NOT included since they are for visual comfort only. */
    const htmlString = '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
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
      + (fw.js ? '  <script src="' + fw.js + '" defer><\/script>\n' : '')
      + '</head>\n<body>\n  <main>\n'
      + renderedHTML
      + '\n  </main>\n</body>\n</html>';

    openInNewTab(htmlString, "text/html;charset=utf-8");
  }

  /* Export as PDF — renders styled HTML then opens PDF in new tab */
  function exportPDF() {
    const mdContent = editor.value || "";
    const renderedHTML = marked.parse(mdContent);

    // Build a temporary container with full styling
    var container = document.createElement("div");
    container.innerHTML = renderedHTML;
    container.style.fontFamily = '"Lato", system-ui, sans-serif';
    container.style.lineHeight = "1.7";
    container.style.maxWidth = "780px";
    container.style.margin = "0 auto";
    container.style.padding = "0 1.5rem";
    container.style.color = "#2d2a3e";

    // Style headings
    var headings = container.querySelectorAll("h1,h2,h3,h4,h5,h6");
    for (var i = 0; i < headings.length; i++) {
      headings[i].style.fontFamily = '"Unbounded", system-ui, sans-serif';
    }

    // Style images to fit
    var imgs = container.querySelectorAll("img");
    for (var j = 0; j < imgs.length; j++) {
      imgs[j].style.maxWidth = "100%";
    }

    document.body.appendChild(container);

    var opt = {
      margin:       [12, 12, 12, 12],
      filename:     "flatwrite-" + timestamp() + ".pdf",
      image:        { type: "jpeg", quality: 0.95 },
      html2canvas:  { scale: 2, useCORS: true, logging: false },
      jsPDF:        { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak:    { mode: ["avoid-all", "css", "legacy"] }
    };

    html2pdf().set(opt).from(container).outputPdf("blob").then(function (pdfBlob) {
      document.body.removeChild(container);
      var url = URL.createObjectURL(pdfBlob);
      window.open(url, "_blank");
    }).catch(function () {
      document.body.removeChild(container);
    });
  }

  /* ---------- Boot ---------- */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
