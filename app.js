(function () {
  "use strict";

  /* ==========================================================================
     State compression for URL sharing
     Uses browser-native gzip when available, base64url fallback.
     ========================================================================== */

  /** Efficient Uint8Array → base64url (chunked to avoid quadratic strings). */
  function uint8ToB64url(bytes) {
    var CHUNK = 8192;
    var parts = [];
    for (var i = 0; i < bytes.length; i += CHUNK) {
      var slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
      parts.push(String.fromCharCode.apply(null, slice));
    }
    return btoa(parts.join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function compressState(state) {
    var json = JSON.stringify(state);
    var bytes = new TextEncoder().encode(json);

    /* Use gzip when CompressionStream is available (all modern browsers). */
    if (typeof CompressionStream !== "undefined") {
      try {
        var cs = new CompressionStream("gzip");
        var writer = cs.writable.getWriter();
        writer.write(bytes);
        writer.close();
        var chunks = [];
        var reader = cs.readable.getReader();
        while (true) {
          var r = await reader.read();
          if (r.done) break;
          chunks.push(r.value);
        }
        var total = chunks.reduce(function (a, c) { return a + c.length; }, 0);
        var merged = new Uint8Array(total);
        var off = 0;
        chunks.forEach(function (c) { merged.set(c, off); off += c.length; });
        return uint8ToB64url(merged);
      } catch (e) { /* fall through to plain */ }
    }

    return uint8ToB64url(bytes);
  }

  async function decompressState(hash) {
    var padded = hash.replace(/-/g, "+").replace(/_/g, "/");
    while (padded.length % 4) padded += "=";
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    /* Try gzip first — matches compressState() output. */
    if (typeof DecompressionStream !== "undefined") {
      try {
        var ds = new DecompressionStream("gzip");
        var writer = ds.writable.getWriter();
        writer.write(bytes);
        writer.close();
        var chunks = [];
        var reader = ds.readable.getReader();
        while (true) {
          var result = await reader.read();
          if (result.done) break;
          chunks.push(result.value);
        }
        var total = chunks.reduce(function (a, c) { return a + c.length; }, 0);
        var merged = new Uint8Array(total);
        var offset = 0;
        chunks.forEach(function (c) { merged.set(c, offset); offset += c.length; });
        return JSON.parse(new TextDecoder().decode(merged));
      } catch (e) { /* not gzip — fall through */ }
    }

    /* Plain base64url (no gzip). */
    return JSON.parse(new TextDecoder().decode(bytes));
  }

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
        doc.querySelectorAll("button").forEach(function (b) { b.className = "btn btn-primary"; });
        doc.querySelectorAll(".fw-form").forEach(function (f) { f.classList.add("form-group"); });
        doc.querySelectorAll(".fw-form label").forEach(function (l) { l.classList.add("form-label"); });
        doc.querySelectorAll(".fw-form input[type=text], .fw-form input[type=email], .fw-form textarea").forEach(function (el) { el.classList.add("form-input"); });
        doc.querySelectorAll(".fw-form select").forEach(function (s) { s.classList.add("form-select"); });
        doc.querySelectorAll(".fw-card").forEach(function (c) { c.classList.add("card"); });
        doc.querySelectorAll(".fw-card-header").forEach(function (h) { h.classList.add("card-header"); });
        doc.querySelectorAll(".fw-card-title").forEach(function (t) { t.classList.add("card-title", "h5"); });
        doc.querySelectorAll(".fw-card-body").forEach(function (b) { b.classList.add("card-body"); });
        doc.querySelectorAll(".fw-alert").forEach(function (a) { a.classList.add("toast"); });
        doc.querySelectorAll(".fw-alert-success").forEach(function (a) { a.classList.add("toast-success"); });
        doc.querySelectorAll(".fw-alert-warning").forEach(function (a) { a.classList.add("toast-warning"); });
        doc.querySelectorAll(".fw-alert-error").forEach(function (a) { a.classList.add("toast-error"); });
        doc.querySelectorAll(".fw-chip").forEach(function (c) { c.classList.add("chip"); });
        doc.querySelectorAll(".fw-avatar img").forEach(function (i) { i.parentElement.classList.add("avatar"); });
        doc.querySelectorAll(".fw-hero").forEach(function (h) { h.classList.add("hero", "hero-lg", "bg-gray"); });
      }
    },
    poshui: {
      label: "PoshUI",
      css: "https://poshui-components.netlify.app/css/main.css",
      js: "https://poshui-components.netlify.app/js/main.js",
      category: "component-rich",
      style: function (doc) {
        doc.querySelectorAll("button").forEach(function (b) { b.className = "btn btn-primary-bg"; });
        doc.querySelectorAll(".fw-form label").forEach(function (l) { l.classList.add("form-label"); });
        doc.querySelectorAll(".fw-form input[type=text], .fw-form input[type=email], .fw-form textarea").forEach(function (el) { el.classList.add("form-control"); });
        doc.querySelectorAll(".fw-form select").forEach(function (s) { s.classList.add("form-control"); });
        doc.querySelectorAll(".fw-card").forEach(function (c) { c.classList.add("card"); });
        doc.querySelectorAll(".fw-card-header").forEach(function (h) { h.classList.add("card-header"); });
        doc.querySelectorAll(".fw-card-body").forEach(function (b) { b.classList.add("card-body"); });
        doc.querySelectorAll(".fw-alert").forEach(function (a) { a.classList.add("alert"); });
        doc.querySelectorAll(".fw-alert-success").forEach(function (a) { a.classList.add("alert-success"); });
        doc.querySelectorAll(".fw-alert-warning").forEach(function (a) { a.classList.add("alert-warning"); });
        doc.querySelectorAll(".fw-alert-error").forEach(function (a) { a.classList.add("alert-danger"); });
        doc.querySelectorAll(".fw-badge-primary").forEach(function (b) { b.classList.add("badge", "badge-primary-bg"); });
        doc.querySelectorAll(".fw-badge-secondary").forEach(function (b) { b.classList.add("badge", "badge-secondary-bg"); });
        doc.querySelectorAll(".fw-avatar img").forEach(function (i) { i.parentElement.classList.add("avatar"); });
        doc.querySelectorAll(".fw-list").forEach(function (l) { l.classList.add("list", "list-style-disc"); });
      }
    },
    oat: {
      label: "Oat",
      css: "https://unpkg.com/@knadh/oat/oat.min.css",
      js: "https://unpkg.com/@knadh/oat/oat.min.js",
      category: "semantic-first",
      style: function (doc) {
        doc.querySelectorAll(".fw-card").forEach(function (c) { c.classList.add("card"); });
        doc.querySelectorAll(".fw-card-header").forEach(function (h) {
          var el = doc.createElement("header");
          el.innerHTML = h.innerHTML;
          h.parentNode.replaceChild(el, h);
        });
        doc.querySelectorAll(".fw-alert").forEach(function (a) { a.setAttribute("role", "alert"); });
        doc.querySelectorAll(".fw-badge-primary").forEach(function (b) { b.classList.add("badge"); });
        doc.querySelectorAll(".fw-badge-secondary").forEach(function (b) { b.classList.add("badge", "secondary"); });
        doc.querySelectorAll(".fw-tabs button").forEach(function (b, i) { if (i === 0) b.classList.add("active"); });
      }
    },
    pico: {
      label: "Pico CSS",
      css: "https://unpkg.com/@picocss/pico/css/pico.min.css",
      js: null,
      category: "semantic-first",
      style: function (doc) {
        doc.querySelectorAll(".fw-alert").forEach(function (a) { a.setAttribute("role", "alert"); });
        doc.querySelectorAll(".fw-badge-primary").forEach(function (b) { b.classList.add("badge"); });
        doc.querySelectorAll(".fw-badge-secondary").forEach(function (b) { b.classList.add("badge", "secondary"); });
        doc.querySelectorAll(".fw-chip").forEach(function (c) { c.style.display = "inline-block"; c.style.padding = "0.2em 0.6em"; c.style.borderRadius = "1em"; c.style.fontSize = "0.9em"; c.style.background = "var(--pico-primary-background)"; c.style.color = "var(--pico-primary-inverse)"; });
        doc.querySelectorAll(".fw-hero").forEach(function (h) { h.style.padding = "2rem 1rem"; h.style.textAlign = "center"; h.style.background = "#f5f5f5"; h.style.borderRadius = "0.5rem"; h.style.margin = "1rem 0"; });
      }
    },
    milligram: {
      label: "Milligram",
      css: "https://unpkg.com/milligram/dist/milligram.min.css",
      js: null,
      category: "class-based",
      style: function (doc) {
        doc.querySelectorAll("button").forEach(function (b) { b.classList.add("button"); });
        doc.querySelectorAll(".fw-card").forEach(function (c) { c.style.padding = "1.5rem"; c.style.borderRadius = "0.4rem"; c.style.border = "1px solid #e0e0e0"; });
        doc.querySelectorAll(".fw-chip").forEach(function (c) { c.style.display = "inline-block"; c.style.padding = "0.2rem 0.8rem"; c.style.borderRadius = "4px"; c.style.background = "#f4f4f4"; c.style.margin = "0.2rem"; });
        doc.querySelectorAll(".fw-hero").forEach(function (h) { h.style.padding = "2rem 1rem"; h.style.textAlign = "center"; h.style.background = "#f5f5f5"; h.style.borderRadius = "0.5rem"; h.style.margin = "1rem 0"; });
        doc.querySelectorAll(".fw-badge-primary").forEach(function (b) { b.style.background = "#9b4dca"; b.style.color = "#fff"; b.style.padding = "0.2em 0.6em"; b.style.borderRadius = "4px"; });
        doc.querySelectorAll(".fw-badge-secondary").forEach(function (b) { b.style.background = "#606c76"; b.style.color = "#fff"; b.style.padding = "0.2em 0.6em"; b.style.borderRadius = "4px"; });
      }
    },
    chota: {
      label: "Chota",
      css: "https://unpkg.com/chota/dist/chota.min.css",
      js: null,
      category: "class-based",
      style: function (doc) {
        doc.querySelectorAll("button").forEach(function (b) { b.classList.add("btn", "primary"); });
        doc.querySelectorAll(".fw-form input[type=text], .fw-form input[type=email], .fw-form textarea").forEach(function (el) { el.classList.add("input"); });
        doc.querySelectorAll(".fw-form select").forEach(function (s) { s.classList.add("input"); });
        doc.querySelectorAll(".fw-card").forEach(function (c) { c.classList.add("card"); });
        doc.querySelectorAll(".fw-chip").forEach(function (c) { c.style.display = "inline-block"; c.style.padding = "0.2em 0.6em"; c.style.borderRadius = "4px"; c.style.background = "#eee"; c.style.margin = "0.2rem"; });
        doc.querySelectorAll(".fw-hero").forEach(function (h) { h.style.padding = "2rem 1rem"; h.style.textAlign = "center"; h.style.background = "#f5f5f5"; h.style.borderRadius = "0.5rem"; h.style.margin = "1rem 0"; });
        doc.querySelectorAll(".fw-badge-primary").forEach(function (b) { b.style.background = "#14854f"; b.style.color = "#fff"; b.style.padding = "0.2em 0.6em"; b.style.borderRadius = "4px"; });
        doc.querySelectorAll(".fw-badge-secondary").forEach(function (b) { b.style.background = "#333"; b.style.color = "#fff"; b.style.padding = "0.2em 0.6em"; b.style.borderRadius = "4px"; });
      }
    },
    simple: {
      label: "Simple.css",
      css: "https://unpkg.com/simpledotcss/simple.min.css",
      js: null,
      category: "semantic-first",
      style: function (doc) {
        doc.querySelectorAll(".fw-alert").forEach(function (a) { a.setAttribute("role", "alert"); a.style.borderLeft = "3px solid #666"; });
        doc.querySelectorAll(".fw-chip").forEach(function (c) { c.style.display = "inline-block"; c.style.padding = "0.2em 0.6em"; c.style.borderRadius = "1em"; c.style.background = "#eee"; c.style.margin = "0.2rem"; });
        doc.querySelectorAll(".fw-hero").forEach(function (h) { h.style.padding = "2rem 1rem"; h.style.textAlign = "center"; h.style.background = "#f5f5f5"; h.style.borderRadius = "0.5rem"; h.style.margin = "1rem 0"; });
        doc.querySelectorAll(".fw-badge-primary").forEach(function (b) { b.style.background = "#5a3e7a"; b.style.color = "#fff"; b.style.padding = "0.2em 0.6em"; b.style.borderRadius = "4px"; });
        doc.querySelectorAll(".fw-badge-secondary").forEach(function (b) { b.style.background = "#666"; b.style.color = "#fff"; b.style.padding = "0.2em 0.6em"; b.style.borderRadius = "4px"; });
      }
    }
  };

  /* ==========================================================================
     Component catalogue — all 15 original components
     Each component: id, emoji, label, support map, per-framework snippets.
     support[frameworkKey] = true if component should be clickable.
     ========================================================================== */

  var COMPONENTS = [
    {
      id: "accordion", emoji: "\u23f1", label: "Accordion",
      support: { spectre: true, poshui: true, oat: true, pico: true, milligram: false, chota: false, simple: true },
      snippets: {
        poshui: '<details>\n  <summary>Click to expand</summary>\n  <p>Hidden content goes here.</p>\n</details>',
        oat: '<details>\n  <summary>Click to expand</summary>\n  <p>Hidden content goes here.</p>\n</details>',
        spectre: '<div class="accordion">\n  <input type="checkbox" id="acc-1" hidden />\n  <label class="accordion-header" for="acc-1">\n    <i class="icon icon-arrow-right mr-1"></i> Click to expand\n  </label>\n  <div class="accordion-body">\n    <p>Hidden content goes here.</p>\n  </div>\n</div>',
        pico: '<details>\n  <summary>Click to expand</summary>\n  <p>Hidden content goes here.</p>\n</details>',
        milligram: '<details>\n  <summary>Click to expand</summary>\n  <p>Hidden content goes here.</p>\n</details>',
        chota: '<details>\n  <summary>Click to expand</summary>\n  <p>Hidden content goes here.</p>\n</details>',
        simple: '<details>\n  <summary>Click to expand</summary>\n  <p>Hidden content goes here.</p>\n</details>'
      }
    },
    {
      id: "alert", emoji: "\u26a0", label: "Alert",
      support: { spectre: true, poshui: true, oat: true, pico: true, milligram: true, chota: true, simple: true },
      snippets: {
        poshui: '<div class="fw-alert fw-alert-warning">\n  <strong>Warning:</strong> This is an alert.\n</div>',
        oat: '<div class="fw-alert fw-alert-warning" role="alert">\n  <strong>Warning:</strong> This is an alert.\n</div>',
        spectre: '<div class="fw-alert fw-alert-warning">\n  <strong>Warning:</strong> This is an alert.\n</div>',
        pico: '<div class="fw-alert fw-alert-warning" role="alert">\n  <strong>Warning:</strong> This is an alert.\n</div>',
        milligram: '<div class="fw-alert fw-alert-warning" role="alert">\n  <strong>Warning:</strong> This is an alert.\n</div>',
        chota: '<div class="fw-alert fw-alert-warning" role="alert">\n  <strong>Warning:</strong> This is an alert.\n</div>',
        simple: '<div class="fw-alert fw-alert-warning" role="alert">\n  <strong>Warning:</strong> This is an alert.\n</div>'
      }
    },
    {
      id: "avatar", emoji: "\ud83d\udc64", label: "Avatar",
      support: { spectre: true, poshui: true, oat: false, pico: false, milligram: false, chota: false, simple: false },
      snippets: {
        poshui: '<div class="fw-avatar" style="display:inline-block; margin:0.5rem 0">\n  <img src="https://i.pravatar.cc/150" alt="avatar" width="60" height="60" style="border-radius:50%" />\n</div>',
        oat: '',
        spectre: '<div class="fw-avatar">\n  <img src="https://i.pravatar.cc/150" alt="avatar" width="60" height="60" style="border-radius:50%" />\n</div>',
        pico: '',
        milligram: '',
        chota: '',
        simple: ''
      }
    },
    {
      id: "badge", emoji: "\ud83c\udff7", label: "Badge",
      support: { spectre: true, poshui: true, oat: true, pico: true, milligram: true, chota: true, simple: true },
      snippets: {
        poshui: '<span class="fw-badge-primary">Primary</span> <span class="fw-badge-secondary">Secondary</span>',
        oat: '<span class="fw-badge-primary">Default</span> <span class="fw-badge-secondary">Secondary</span>',
        spectre: '<span class="fw-badge-primary">Primary</span> <span class="fw-badge-secondary">Secondary</span>',
        pico: '<span class="fw-badge-primary">Primary</span> <span class="fw-badge-secondary">Secondary</span>',
        milligram: '<span class="fw-badge-primary">Primary</span> <span class="fw-badge-secondary">Secondary</span>',
        chota: '<span class="fw-badge-primary">Primary</span> <span class="fw-badge-secondary">Secondary</span>',
        simple: '<span class="fw-badge-primary">Primary</span> <span class="fw-badge-secondary">Secondary</span>'
      }
    },
    {
      id: "button", emoji: "\ud83d\udd33", label: "Button",
      support: { spectre: true, poshui: true, oat: true, pico: true, milligram: true, chota: true, simple: true },
      snippets: {
        poshui: '<button class="btn btn-primary-bg">Primary</button>\n<button class="btn btn-secondary-bg">Secondary</button>',
        oat: '<button>Default</button>\n<button class="primary">Primary</button>',
        spectre: '<button class="btn btn-primary">Primary</button>\n<button class="btn">Default</button>',
        pico: '<button>Default</button>\n<button class="secondary">Secondary</button>',
        milligram: '<button class="button button-primary">Primary</button>\n<button class="button button-clear">Clear</button>',
        chota: '<button class="btn primary">Primary</button>\n<button>Default</button>',
        simple: '<button>Default</button>\n<button>Confirm</button>'
      }
    },
    {
      id: "card", emoji: "\ud83c\udccf", label: "Card",
      support: { spectre: true, poshui: true, oat: true, pico: true, milligram: true, chota: true, simple: true },
      snippets: {
        poshui: '<div class="fw-card">\n  <div class="fw-card-header">\n    <div class="fw-card-title">Card Title</div>\n  </div>\n  <div class="fw-card-body">\n    <p>Card content goes here.</p>\n  </div>\n</div>',
        oat: '<article class="card">\n  <header>\n    <h3>Card Title</h3>\n  </header>\n  <p>Card content goes here.</p>\n</article>',
        spectre: '<div class="fw-card">\n  <div class="fw-card-header">\n    <div class="fw-card-title">Card Title</div>\n  </div>\n  <div class="fw-card-body">Card content goes here.</div>\n</div>',
        pico: '<div class="fw-card" style="border:1px solid var(--pico-card-border-color, #ddd); border-radius:6px; padding:1.5rem; margin:1rem 0">\n  <h4>Card Title</h4>\n  <p>Card content goes here.</p>\n</div>',
        milligram: '<div class="fw-card">\n  <h4>Card Title</h4>\n  <p>Card content goes here.</p>\n</div>',
        chota: '<div class="card">\n  <h4>Card Title</h4>\n  <p>Card content goes here.</p>\n</div>',
        simple: '<div class="fw-card" style="border:1px solid #ddd; border-radius:6px; padding:1.5rem; margin:1rem 0">\n  <h4>Card Title</h4>\n  <p>Card content goes here.</p>\n</div>'
      }
    },
    {
      id: "chip", emoji: "\ud83c\udfc5", label: "Chip",
      support: { spectre: true, poshui: false, oat: false, pico: true, milligram: true, chota: true, simple: true },
      snippets: {
        poshui: '',
        oat: '',
        spectre: '<span class="fw-chip">Tag One</span>\n<span class="fw-chip">Tag Two</span>\n<span class="fw-chip">Tag Three</span>',
        pico: '<span class="fw-chip">Tag One</span>\n<span class="fw-chip">Tag Two</span>\n<span class="fw-chip">Tag Three</span>',
        milligram: '<span class="fw-chip">Tag One</span>\n<span class="fw-chip">Tag Two</span>\n<span class="fw-chip">Tag Three</span>',
        chota: '<span class="fw-chip">Tag One</span>\n<span class="fw-chip">Tag Two</span>\n<span class="fw-chip">Tag Three</span>',
        simple: '<span class="fw-chip">Tag One</span>\n<span class="fw-chip">Tag Two</span>\n<span class="fw-chip">Tag Three</span>'
      }
    },
    {
      id: "grid", emoji: "\ud83d\udcd0", label: "Grid",
      support: { spectre: true, poshui: true, oat: true, pico: true, milligram: true, chota: true, simple: true },
      snippets: {
        poshui: '<div class="grid grid-cols-2">\n  <div><p>Column 1</p></div>\n  <div><p>Column 2</p></div>\n</div>',
        oat: '<div class="container">\n  <div class="row">\n    <div class="col-6">Column 1</div>\n    <div class="col-6">Column 2</div>\n  </div>\n</div>',
        spectre: '<div class="columns">\n  <div class="column col-6">Column 1</div>\n  <div class="column col-6">Column 2</div>\n</div>',
        pico: '<div style="display:grid; grid-template-columns:1fr 1fr; gap:1rem">\n  <div><p>Column 1</p></div>\n  <div><p>Column 2</p></div>\n</div>',
        milligram: '<div class="row">\n  <div class="column">Column 1</div>\n  <div class="column">Column 2</div>\n</div>',
        chota: '<div class="row">\n  <div class="col">Column 1</div>\n  <div class="col">Column 2</div>\n</div>',
        simple: '<div style="display:grid; grid-template-columns:1fr 1fr; gap:1rem">\n  <div><p>Column 1</p></div>\n  <div><p>Column 2</p></div>\n</div>'
      }
    },
    {
      id: "hero", emoji: "\ud83e\uddb9", label: "Hero",
      support: { spectre: true, poshui: false, oat: false, pico: true, milligram: false, chota: false, simple: true },
      snippets: {
        poshui: '',
        oat: '',
        spectre: '<div class="fw-hero">\n  <h1>Hero Title</h1>\n  <p>This is a hero subtitle or description.</p>\n</div>',
        pico: '<div class="fw-hero">\n  <h1>Hero Title</h1>\n  <p>This is a hero subtitle or description.</p>\n</div>',
        milligram: '',
        chota: '',
        simple: '<div class="fw-hero">\n  <h1>Hero Title</h1>\n  <p>This is a hero subtitle or description.</p>\n</div>'
      }
    },
    {
      id: "image", emoji: "\ud83d\uddbc", label: "Image",
      support: { spectre: true, poshui: true, oat: true, pico: true, milligram: true, chota: true, simple: true },
      snippets: {
        poshui: '<img class="img-responsive" src="https://picsum.photos/600/300" alt="Sample image" />',
        oat: '<img src="https://picsum.photos/600/300" alt="Sample image" style="max-width:100%" />',
        spectre: '<img class="img-responsive" src="https://picsum.photos/600/300" alt="Sample image" />',
        pico: '<img src="https://picsum.photos/600/300" alt="Sample image" width="100%" />',
        milligram: '<img src="https://picsum.photos/600/300" alt="Sample image" width="100%" />',
        chota: '<img src="https://picsum.photos/600/300" alt="Sample image" style="max-width:100%" />',
        simple: '<img src="https://picsum.photos/600/300" alt="Sample image" style="max-width:100%" />'
      }
    },
    {
      id: "list", emoji: "\ud83d\udccb", label: "List",
      support: { spectre: true, poshui: true, oat: true, pico: true, milligram: true, chota: true, simple: true },
      snippets: {
        poshui: '<ul class="fw-list">\n  <li>First item</li>\n  <li>Second item</li>\n  <li>Third item</li>\n</ul>',
        oat: '<ul>\n  <li>First item</li>\n  <li>Second item</li>\n  <li>Third item</li>\n</ul>',
        spectre: '<ul>\n  <li>First item</li>\n  <li>Second item</li>\n  <li>Third item</li>\n</ul>',
        pico: '<ul>\n  <li>First item</li>\n  <li>Second item</li>\n  <li>Third item</li>\n</ul>',
        milligram: '<ul>\n  <li>First item</li>\n  <li>Second item</li>\n  <li>Third item</li>\n</ul>',
        chota: '<ul>\n  <li>First item</li>\n  <li>Second item</li>\n  <li>Third item</li>\n</ul>',
        simple: '<ul>\n  <li>First item</li>\n  <li>Second item</li>\n  <li>Third item</li>\n</ul>'
      }
    },
    {
      id: "panel", emoji: "\ud83d\udce6", label: "Panel",
      support: { spectre: true, poshui: false, oat: false, pico: false, milligram: false, chota: false, simple: false },
      snippets: {
        poshui: '',
        oat: '',
        spectre: '<div class="panel">\n  <div class="panel-header">\n    <div class="panel-title">Panel Title</div>\n  </div>\n  <div class="panel-body">\n    <p>Panel content goes here.</p>\n  </div>\n</div>',
        pico: '',
        milligram: '',
        chota: '',
        simple: ''
      }
    },
    {
      id: "table", emoji: "\ud83d\udcca", label: "Table",
      support: { spectre: true, poshui: true, oat: true, pico: true, milligram: true, chota: true, simple: true },
      snippets: {
        poshui: '<table>\n  <thead>\n    <tr><th>Col 1</th><th>Col 2</th><th>Col 3</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>Cell 1</td><td>Cell 2</td><td>Cell 3</td></tr>\n  </tbody>\n</table>',
        oat: '<table>\n  <thead>\n    <tr><th>Col 1</th><th>Col 2</th><th>Col 3</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>Cell 1</td><td>Cell 2</td><td>Cell 3</td></tr>\n  </tbody>\n</table>',
        spectre: '<table class="table table-striped table-hover">\n  <thead>\n    <tr><th>Col 1</th><th>Col 2</th><th>Col 3</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>Cell 1</td><td>Cell 2</td><td>Cell 3</td></tr>\n  </tbody>\n</table>',
        pico: '<table>\n  <thead>\n    <tr><th>Col 1</th><th>Col 2</th><th>Col 3</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>Cell 1</td><td>Cell 2</td><td>Cell 3</td></tr>\n  </tbody>\n</table>',
        milligram: '<table>\n  <thead>\n    <tr><th>Col 1</th><th>Col 2</th><th>Col 3</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>Cell 1</td><td>Cell 2</td><td>Cell 3</td></tr>\n  </tbody>\n</table>',
        chota: '<table class="table">\n  <thead>\n    <tr><th>Col 1</th><th>Col 2</th><th>Col 3</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>Cell 1</td><td>Cell 2</td><td>Cell 3</td></tr>\n  </tbody>\n</table>',
        simple: '<table>\n  <thead>\n    <tr><th>Col 1</th><th>Col 2</th><th>Col 3</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>Cell 1</td><td>Cell 2</td><td>Cell 3</td></tr>\n  </tbody>\n</table>'
      }
    },
    {
      id: "tabs", emoji: "\ud83d\udd00", label: "Tabs",
      support: { spectre: true, poshui: false, oat: true, pico: false, milligram: false, chota: false, simple: false },
      snippets: {
        poshui: '',
        oat: '<ot-tabs>\n  <div role="tablist">\n    <button role="tab">Tab 1</button>\n    <button role="tab">Tab 2</button>\n  </div>\n  <div role="tabpanel"><p>Tab 1 content</p></div>\n  <div role="tabpanel"><p>Tab 2 content</p></div>\n</ot-tabs>',
        spectre: '<ul class="tab">\n  <li class="tab-item active"><a href="#">Tab 1</a></li>\n  <li class="tab-item"><a href="#">Tab 2</a></li>\n  <li class="tab-item"><a href="#">Tab 3</a></li>\n</ul>',
        pico: '',
        milligram: '',
        chota: '',
        simple: ''
      }
    }
  ];

  /* ==========================================================================
     Modal components — components that get a configuration form
     ========================================================================== */

  var MODAL_COMPONENTS = ["table", "card", "list", "image"];

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
  var LS_CONTENTWIDTH = "flatwrite_contentwidth";

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
  var currentFramework = "spectre";
  var sizeStep = 0;
  var weightStep = 0;
  var lineStep = 0;
  var comfortFont = "Inter";
  var zoomStep = 100;
  var debounceTimer = null;
  var activeModalComponent = null;
  var lastScrollRatio = 0;
  var lastEditorScrollTop = 0;

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
  var modalOverlay      = document.getElementById("comp-modal-overlay");
  var modalTitle        = document.getElementById("comp-modal-title");
  var modalBody         = document.getElementById("comp-modal-body");
  var modalInsertBtn    = document.getElementById("comp-modal-insert");
  var modalCancelBtn    = document.getElementById("comp-modal-cancel");
  var modalCloseBtn     = document.getElementById("comp-modal-close");
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
    if (!exportActions || !editor || !mainPanelWrapper) return;
    /* On mobile (<760px) the export actions are inline — clear any desktop alignment */
    if (window.innerWidth < 760) {
      exportActions.style.top = "";
      return;
    }
    var editorRect = editor.getBoundingClientRect();
    var wrapperRect = mainPanelWrapper.getBoundingClientRect();
    exportActions.style.top = (editorRect.top - wrapperRect.top) + "px";
  }

  /* ==========================================================================
     Markdown Loader
     ========================================================================== */

  var initialEditorContent = "";
  var contentWidth = 780;
  var LS_CONTENTWIDTH = "flatwrite_contentwidth";
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
    md = md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (match, alt, src) {
      if (/^https?:\/\//.test(src) || /^data:/.test(src)) return match;
      var resolved = githubBaseUrl + src.replace(/^\//, "") + "?raw=true";
      return "![" + alt + "](" + resolved + ")";
    });
    return md;
  }

  function isEditorDirty() {
    return editor.value !== initialEditorContent;
  }

  function setEditorContent(text) {
    editor.value = text;
    editor.dispatchEvent(new Event("input"));
    localStorage.setItem(LS_CONTENT, text);
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
    var hash = window.location.hash.slice(1);
    if (hash) {
      decompressState(hash).then(function (state) {
        restoreFromState(state);
        initialEditorContent = editor.value;
        buildFontDropdown();
        renderComponentGrid();
        bindEvents();
        requestAnimationFrame(syncExportActionsTop);
      }).catch(function () {
        restoreFromStorage();
        initialEditorContent = editor.value;
        buildFontDropdown();
        renderComponentGrid();
        bindEvents();
        requestAnimationFrame(syncExportActionsTop);
      });
    } else {
      restoreFromStorage();
      initialEditorContent = editor.value;
      buildFontDropdown();
      renderComponentGrid();
      bindEvents();
    }
    /* Align tab bubble after first layout */
    requestAnimationFrame(syncExportActionsTop);
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
     localStorage persistence
     ========================================================================== */

  function clampInt(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function restoreFromStorage() {
    var savedContent = localStorage.getItem(LS_CONTENT);
    if (savedContent !== null) editor.value = savedContent;

    var savedFw = localStorage.getItem(LS_FRAMEWORK);
    if (savedFw && FRAMEWORKS[savedFw]) currentFramework = savedFw;
    frameworkDropdown.value = currentFramework;

    sizeStep = clampInt(localStorage.getItem(LS_SIZESTEP), SIZE_MIN, SIZE_MAX, sizeStep);

    weightStep = clampInt(localStorage.getItem(LS_WEIGHTSTEP), WEIGHT_MIN, WEIGHT_MAX, weightStep);

    lineStep = clampInt(localStorage.getItem(LS_LINESTEP), LINE_MIN, LINE_MAX, lineStep);

    var savedFont = localStorage.getItem(LS_FONT);
    if (savedFont && COMFORT_FONTS.some(function (f) { return f.value === savedFont; })) comfortFont = savedFont;
    fontPickerLabel.textContent = comfortFont;

    zoomStep = clampInt(localStorage.getItem(LS_ZOOMSTEP), 100, 120, zoomStep);
    zoomSlider.value = zoomStep;
    zoomValue.textContent = zoomStep + "%";
    applyZoom();

    var savedWidth = parseInt(localStorage.getItem(LS_CONTENTWIDTH), 10);
    if (Number.isFinite(savedWidth) && savedWidth >= 400 && savedWidth <= 1400) contentWidth = savedWidth;
    applyContentWidth();
  }

  function restoreFromState(state) {
    if (state.content !== undefined) editor.value = state.content;
    if (state.framework && FRAMEWORKS[state.framework]) currentFramework = state.framework;
    frameworkDropdown.value = currentFramework;
    if (state.sizeStep !== undefined) sizeStep = clampInt(state.sizeStep, SIZE_MIN, SIZE_MAX, sizeStep);
    if (state.weightStep !== undefined) weightStep = clampInt(state.weightStep, WEIGHT_MIN, WEIGHT_MAX, weightStep);
    if (state.lineStep !== undefined) lineStep = clampInt(state.lineStep, LINE_MIN, LINE_MAX, lineStep);
    if (state.font && COMFORT_FONTS.some(function (f) { return f.value === state.font; })) comfortFont = state.font;
    fontPickerLabel.textContent = comfortFont;
    if (state.zoomStep !== undefined) zoomStep = clampInt(state.zoomStep, 100, 120, zoomStep);
    zoomSlider.value = zoomStep;
    zoomValue.textContent = zoomStep + "%";
    applyZoom();
    if (state.contentWidth !== undefined) {
      contentWidth = clampInt(state.contentWidth, 400, 1400, contentWidth);
      applyContentWidth();
    }
  }

  async function shareState() {
    var state = {
      content: editor.value,
      framework: currentFramework,
      sizeStep: sizeStep,
      weightStep: weightStep,
      lineStep: lineStep,
      font: comfortFont,
      zoomStep: zoomStep,
      contentWidth: contentWidth
    };
    var encoded = await compressState(state);
    var url = window.location.origin + window.location.pathname + "#" + encoded;

    if (url.length > 8000) {
      showToast("URL is " + url.length + " chars — may be too long for some browsers");
    }

    navigator.clipboard.writeText(url).then(function () {
      showToast("Copied share URL to clipboard");
    }).catch(function () {
      prompt("Copy this URL:", url);
    });
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

    frameworkDropdown.addEventListener("change", function () {
      currentFramework = frameworkDropdown.value;
      localStorage.setItem(LS_FRAMEWORK, currentFramework);
      renderComponentGrid();
      if (mode === "preview") renderPreview();
    });

    document.getElementById("mode-switch").addEventListener("click", function (e) {
      var label = e.target.closest(".mode-switch-label");
      if (label) {
        setMode(label.dataset.mode);
        requestAnimationFrame(checkToolbarOverflow);
      }
    });

    /* Sidebar Load events */
    btnLoadUrl.addEventListener("click", function () {
      openComponentModal("load-url", null);
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
        localStorage.setItem(LS_CONTENTWIDTH, contentWidth);
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

    btnExportMd.addEventListener("click", exportMarkdown);
    btnExportHtml.addEventListener("click", exportHTML);
    btnExportPdf.addEventListener("click", exportPDF);
    btnShare.addEventListener("click", shareState);

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

  function initModalDrag() {
    var modal = document.getElementById("comp-modal");
    var header = document.getElementById("comp-modal-title").parentElement;
    var isDragging = false, startX, startY, startLeft, startTop;

    header.addEventListener("mousedown", function (e) {
      if (e.target.closest(".comp-modal-close")) return;
      isDragging = true;
      var rect = modalOverlay.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!isDragging) return;
      modalOverlay.style.left = (startLeft + e.clientX - startX) + "px";
      modalOverlay.style.top = (startTop + e.clientY - startY) + "px";
      modalOverlay.style.right = "auto";
    });
    window.addEventListener("mouseup", function () { isDragging = false; });
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
     Component grid — shows all 15, greys out unsupported for current framework
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

  function renderComponentGrid() {
    componentsGrid.innerHTML = "";
    COMPONENTS.forEach(function (comp) {
      var btn = document.createElement("button");
      btn.className = "comp-btn";
      btn.type = "button";
      btn.dataset.component = comp.id;
      btn.title = comp.label;
      btn.textContent = comp.label;

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
     Preview rendering
     ========================================================================== */

  function savePreviewScroll() {
    /* Scroll ratio is kept current by postMessage from the sandboxed iframe.
       No direct contentDocument access needed. */
  }

  function renderPreview() {
    var fw = FRAMEWORKS[currentFramework];
    var rawHTML = marked.parse(editor.value || "");
    var renderedHTML = sanitizeHTML(rawHTML);
    var scale = SIZE_SCALE[String(sizeStep)] || 1;
    var weight = WEIGHT_MAP[String(weightStep)] || 400;
    var lineHeight = LINE_SCALE[String(lineStep)] || 1.75;
    var fontStack = '"' + comfortFont + '", system-ui, sans-serif';

    /* Serialize the framework style function so the sandboxed iframe can
       apply framework-specific classes without parent↔iframe DOM access. */
    var styleFnStr = (fw && typeof fw.style === "function")
      ? fw.style.toString()
      : "function(doc){}";

    var scrollRatio = lastScrollRatio;

    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
      + '<base target="_blank" rel="noopener noreferrer">'
      + '<link rel="preconnect" href="https://fonts.googleapis.com">'
      + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
      + '<link href="' + FONTS_URL + '" rel="stylesheet">'
      + (fw.css ? '<link rel="stylesheet" href="' + fw.css + '">' : '')
      + '<style>'
      + '*, *::before, *::after { font-family: ' + fontStack + ' !important; box-sizing: border-box; }'
      + 'body { font-size: ' + (15 * scale) + 'px !important;'
      + ' font-weight: ' + weight + ' !important;'
      + ' line-height: ' + lineHeight + ' !important; color: #2d2a3e;'
      + ' max-width: ' + contentWidth + 'px; margin: 3rem auto; padding: 0 1.5rem;'
      + ' overflow-x: hidden; }'
      + 'h1,h2,h3,h4,h5,h6 { font-weight: ' + Math.min(weight + 200, 900) + ' !important; overflow-wrap: break-word; word-break: break-word; }'
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
      + '.fw-alert { padding: 0.8rem 1rem; border-radius: 4px; margin: 0.6rem 0; }'
      + '.fw-card { border: 1px solid #ddd; border-radius: 4px; margin: 1rem 0; }'
      + '.fw-card-header { padding: 1rem 1.2rem 0.4rem; }'
      + '.fw-card-title { font-weight: 700; font-size: 1.1em; }'
      + '.fw-card-body { padding: 0.4rem 1.2rem 1rem; }'
      + '.fw-form label { display: block; margin: 0.8rem 0 0.3rem; font-weight: 600; }'
      + '.fw-form input[type=text], .fw-form input[type=email], .fw-form textarea, .fw-form select { display: block; width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.95em; }'
      + '.fw-form button { margin-top: 1rem; }'
      + '.fw-list { margin-left: 1.5rem; }'
      + '.fw-list li { margin-bottom: 0.3rem; }'
      + '</style>'
      + (fw.js ? '<script src="' + fw.js + '" defer><' + '/script>' : '')
      + '</head><body><main>' + renderedHTML + '</main>'
      + '<script>'
      /* --- In-iframe runtime: framework classes, scroll, messaging --- */
      + '(function(){'
      /* Apply framework-specific classes */
      + 'var styleFn = (' + styleFnStr + ');'
      + 'if (typeof styleFn === "function") styleFn(document);'
      /* Restore scroll from parent */
      + 'var _scrollRatio = ' + scrollRatio + ';'
      + 'var _max = document.documentElement.scrollHeight - window.innerHeight;'
      + 'if (_max > 0) window.scrollTo(0, Math.round(_scrollRatio * _max));'
      /* Report scroll changes to parent (debounced) */
      + 'var _scrollTimer;'
      + 'window.addEventListener("scroll", function(){'
      + '  clearTimeout(_scrollTimer);'
      + '  _scrollTimer = setTimeout(function(){'
      + '    var m = document.documentElement.scrollHeight - window.innerHeight;'
      + '    var r = m > 0 ? window.scrollY / m : 0;'
      + '    parent.postMessage({type:"scroll",ratio:r}, "*");'
      + '  }, 150);'
      + '});'
      /* Receive scroll commands from parent */
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
      + '})();'
      + '<' + '/script>'
      + '<script>'
      /* Component interaction stubs */
      + 'document.addEventListener("click", function(e) {'
      + '  var btn = e.target.closest("button");'
      + '  if (!btn || btn.closest("form")) return;'
      + '  e.preventDefault();'
      + '});'
      + 'document.addEventListener("submit", function(e) {'
      + '  e.preventDefault();'
      + '});'
      /* Double-click → tell parent to switch to Edit mode at clicked word */
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
     Component insertion
     ========================================================================== */

  function insertComponent(componentId) {
    var comp = COMPONENTS.find(function (c) { return c.id === componentId; });
    if (!comp) return;
    if (!comp.support[currentFramework]) return;

    // Route modal-enabled components through the form
    if (MODAL_COMPONENTS.indexOf(componentId) !== -1) {
      openComponentModal(componentId, comp);
      return;
    }

    // Direct insertion from framework-specific snippet
    var snippet = comp.snippets[currentFramework];
    if (!snippet) return;
    if (mode !== "edit") setMode("edit");
    editorInsertBlock(snippet);
  }

  /* ==========================================================================
     Component modal
     ========================================================================== */

  function openComponentModal(componentId, comp) {
    activeModalComponent = componentId;
    if (comp) {
      modalTitle.textContent = "Insert " + comp.label;
    } else if (componentId === "load-url") {
      modalTitle.textContent = "Load from URL";
    }
    modalBody.innerHTML = "";

    switch (componentId) {
      case "table": buildTableForm(); break;
      case "card":  buildCardForm();  break;
      case "list":  buildListForm();  break;
      case "image": buildImageForm(); break;
      case "load-url": buildLoadUrlForm(); break;
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
    if (activeModalComponent === "load-url") {
      handleLoadUrlModalInsert();
      return;
    }
    var snippet = "";
    switch (activeModalComponent) {
      case "table": snippet = generateTableSnippet(); break;
      case "card":  snippet = generateCardSnippet();  break;
      case "list":  snippet = generateListSnippet();  break;
      case "image": snippet = generateImageSnippet(); break;
    }
    if (snippet) {
      if (mode !== "edit") setMode("edit");
      editorInsertBlock(snippet);
      showToast("Inserted <strong>" + activeModalComponent + "</strong> component");
    }
    closeComponentModal();
  }

  /* TABLE form & generator */

  function buildTableForm() {
    modalBody.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      + '<div><label for="tbl-cols">Columns</label><input type="number" id="tbl-cols" value="3" min="1" max="10" /></div>'
      + '<div><label for="tbl-rows">Rows</label><input type="number" id="tbl-rows" value="3" min="1" max="20" /></div>'
      + '</div>'
      + '<label for="tbl-headers">Column headers (comma-separated)</label>'
      + '<input type="text" id="tbl-headers" placeholder="Name, Age, City" />'
      + '<p style="font-size:0.78rem;color:#888;font-style:italic">Leave blank for generic headers</p>';
  }

  function generateTableSnippet() {
    var cols = Math.max(1, Math.min(10, parseInt(document.getElementById("tbl-cols").value, 10) || 3));
    var rows = Math.max(1, Math.min(20, parseInt(document.getElementById("tbl-rows").value, 10) || 3));
    var headersRaw = document.getElementById("tbl-headers").value.trim();
    var headers = headersRaw ? headersRaw.split(",").map(function (h) { return h.trim(); }) : [];
    while (headers.length < cols) headers.push("Column " + (headers.length + 1));
    headers = headers.slice(0, cols);

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

  /* CARD form & generator */

  function buildCardForm() {
    modalBody.innerHTML =
      '<label for="card-title">Card title</label>'
      + '<input type="text" id="card-title" placeholder="My Card" />'
      + '<label for="card-subtitle">Subtitle (optional)</label>'
      + '<input type="text" id="card-subtitle" placeholder="A short subtitle" />'
      + '<label for="card-body">Card content</label>'
      + '<textarea id="card-body" rows="3" placeholder="Write your card content here..."></textarea>';
  }

  function generateCardSnippet() {
    var title = document.getElementById("card-title").value.trim() || "Card Title";
    var subtitle = document.getElementById("card-subtitle").value.trim();
    var body = document.getElementById("card-body").value.trim() || "Card content goes here.";
    var fw = currentFramework;

    if (fw === "poshui") {
      return '<div class="fw-card">\n  <div class="fw-card-header">\n    <div class="fw-card-title">' + title + '</div>'
        + (subtitle ? '\n    <p>' + subtitle + '</p>' : '')
        + '\n  </div>\n  <div class="fw-card-body">\n    <p>' + body + '</p>\n  </div>\n</div>';
    } else if (fw === "oat") {
      return '<article class="card">\n  <header>\n    <h3>' + title + '</h3>'
        + (subtitle ? '\n    <p>' + subtitle + '</p>' : '')
        + '\n  </header>\n  <p>' + body + '</p>\n</article>';
    } else {
      return '<div class="fw-card">\n  <div class="fw-card-header">\n    <div class="fw-card-title">' + title + '</div>'
        + (subtitle ? '\n    <p>' + subtitle + '</p>' : '')
        + '\n  </div>\n  <div class="fw-card-body">\n    <p>' + body + '</p>\n  </div>\n</div>';
    }
  }

  /* LIST form & generator */

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
      + '<p style="font-size:0.78rem;color:#888;font-style:italic">Each line becomes a list item</p>';
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

  /* IMAGE form & generator */

  function buildImageForm() {
    modalBody.innerHTML =
      '<label for="img-url">Image URL</label>'
      + '<input type="url" id="img-url" placeholder="https://example.com/photo.jpg" />'
      + '<label for="img-alt">Alt text (description)</label>'
      + '<input type="text" id="img-alt" placeholder="A beautiful sunset" />'
      + '<label for="img-caption">Caption (optional)</label>'
      + '<input type="text" id="img-caption" placeholder="Photo by Jane Doe" />'
      + '<p style="font-size:0.78rem;color:#888;font-style:italic">Caption appears below the image as italic text</p>';
  }

  function generateImageSnippet() {
    var url = document.getElementById("img-url").value.trim() || "https://picsum.photos/600/300";
    var alt = document.getElementById("img-alt").value.trim() || "Image";
    var caption = document.getElementById("img-caption").value.trim();
    var fw = currentFramework;

    var imgTag;
    if (fw === "spectre" || fw === "poshui") {
      imgTag = '<img class="img-responsive" src="' + url + '" alt="' + alt + '" />';
    } else {
      imgTag = '<img src="' + url + '" alt="' + alt + '" style="max-width:100%" />';
    }

    var md = imgTag;
    if (caption) md += "\n\n*" + caption + "*";
    return md;
  }

  /* LOAD URL form & handler */

  function buildLoadUrlForm() {
    modalBody.innerHTML =
      '<label for="load-url-modal-input">Markdown URL</label>'
      + '<input type="url" id="load-url-modal-input" placeholder="https://github.com/user/repo/blob/main/README.md" />'
      + '<p class="modal-hint">GitHub blob URLs are auto-converted to raw URLs.</p>'
      + '<div class="load-modal-error hidden" id="load-modal-error" role="alert" style="color:#c0392b;font-size:0.78rem;margin-top:4px"></div>';
  }

  async function handleLoadUrlModalInsert() {
    var input = document.getElementById("load-url-modal-input");
    var errorEl = document.getElementById("load-modal-error");
    var url = (input ? input.value.trim() : "");

    if (errorEl) { errorEl.textContent = ""; errorEl.classList.add("hidden"); }

    if (!url) {
      if (errorEl) { errorEl.textContent = "Please enter a URL."; errorEl.classList.remove("hidden"); }
      return;
    }

    var rewritten = rewriteGitHubUrl(url);
    var insertBtn = document.getElementById("comp-modal-insert");
    if (insertBtn) { insertBtn.disabled = true; insertBtn.textContent = "Fetching\u2026"; }

    try {
      var res = await fetch(rewritten);
      if (!res.ok) throw new Error("HTTP " + res.status);
      var text = await res.text();
      if (githubBaseUrl) text = rewriteRelativeUrls(text);
      if (isEditorDirty()) {
        var ok = confirm("Replace current content with loaded markdown?");
        if (!ok) return;
      }
      setEditorContent(text);
      closeComponentModal();
      setMode("preview");
      showToast("Loaded markdown from URL");
    } catch (e) {
      try {
        var proxy = "https://corsproxy.io/?" + encodeURIComponent(rewritten);
        var res2 = await fetch(proxy);
        if (!res2.ok) throw new Error("HTTP " + res2.status);
        var text2 = await res2.text();
        if (githubBaseUrl) text2 = rewriteRelativeUrls(text2);
        if (isEditorDirty()) {
          var ok2 = confirm("Replace current content with loaded markdown?");
          if (!ok2) return;
        }
        setEditorContent(text2);
        closeComponentModal();
        setMode("preview");
        showToast("Loaded markdown from URL");
      } catch (e2) {
        if (errorEl) { errorEl.textContent = "Could not fetch URL. Check the link and try again."; errorEl.classList.remove("hidden"); }
      }
    } finally {
      if (insertBtn) { insertBtn.disabled = false; insertBtn.textContent = "Insert"; }
    }
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
    var rawHTML = marked.parse(editor.value || "");
    var renderedHTML = sanitizeHTML(rawHTML);
    var fw = FRAMEWORKS[currentFramework];

    var htmlString = '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
      + '  <meta charset="UTF-8" />\n'
      + '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n'
      + '  <title>FlatWrite Export</title>\n'
      + '  <link rel="preconnect" href="https://fonts.googleapis.com" />\n'
      + '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n'
      + '  <link href="' + FONTS_URL + '" rel="stylesheet" />\n'
      + (fw.css ? '  <link rel="stylesheet" href="' + fw.css + '" />\n' : '')
      + '  <style>\n'
      + '    body {\n'
      + '      font-family: "' + comfortFont + '", system-ui, sans-serif;\n'
      + '      line-height: 1.7;\n'
      + '      max-width: ' + contentWidth + 'px;\n'
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

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = url;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  var html2pdfUrl = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.2/html2pdf.bundle.min.js";

  function exportPDF() {
    var rawHTML = marked.parse(editor.value || "");
    var renderedHTML = sanitizeHTML(rawHTML);
    var container = document.createElement("div");
    container.innerHTML = renderedHTML;
    container.style.fontFamily = '"' + comfortFont + '", system-ui, sans-serif';
    container.style.lineHeight = "1.7";
    container.style.maxWidth = contentWidth + "px";
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

    var ready = typeof html2pdf !== "undefined" ? Promise.resolve() : loadScript(html2pdfUrl);
    ready.then(function () {
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
