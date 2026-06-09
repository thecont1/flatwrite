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

  /* ==========================================================================
     Component grid — shows all 15, greys out unsupported for current framework
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
     Framework class application
     ========================================================================== */

  function applyFrameworkClasses(iframeDoc, fwKey) {
    var fw = FRAMEWORKS[fwKey];
    if (fw && typeof fw.style === "function") {
      fw.style(iframeDoc);
    }
  }

  /* ==========================================================================
     Preview rendering
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
      + '.fw-list { margin-left: 1.5rem; }'
      + '.fw-list li { margin-bottom: 0.3rem; }'
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
    modalTitle.textContent = comp.emoji + " Insert " + comp.label;
    modalBody.innerHTML = "";

    switch (componentId) {
      case "table": buildTableForm(); break;
      case "card":  buildCardForm();  break;
      case "list":  buildListForm();  break;
      case "image": buildImageForm(); break;
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
      case "table": snippet = generateTableSnippet(); break;
      case "card":  snippet = generateCardSnippet();  break;
      case "list":  snippet = generateListSnippet();  break;
      case "image": snippet = generateImageSnippet();  break;
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
