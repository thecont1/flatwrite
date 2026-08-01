/**
 * math.js — shared Math Mode support for FlatWrite
 *
 * Copyright (C) 2026 Mahesh Shantaram (flatwrite.md)
 * SPDX-License-Identifier: AGPL-3.0
 *
 * Design summary (see docs/MATH-MODE.md for the full architecture note):
 *
 *   - Math Mode is OFF by default per document. When OFF, NO math parsing,
 *     NO KaTeX assets, NO DOM scanning. Dollar signs / backslash-parens are
 *     literal text — exactly the pre-existing behavior.
 *   - When ON, `marked` is extended with math tokenizers that emit neutral
 *     `<span class="fw-math-inline" data-latex="...">` and
 *     `<div class="fw-math-display" data-latex="...">` placeholders carrying
 *     the raw LaTeX. These survive sanitization cleanly (class + data-* are on
 *     the allow-lists) and never collide with code: marked tokenizes fenced
 *     code blocks and inline code spans BEFORE the inline tokenizer reaches our
 *     extension, so $ inside ``` or `code` is invisible to math.
 *   - The browser lazy-loads KaTeX only when Math Mode is ON and math
 *     placeholders are present. It then calls `katex.render(latex, el)`
 *     directly on each placeholder — synchronous, deterministic, no text-scanning.
 *     This is critical for Paged.js / Vivliostyle: math is rendered to static
 *     HTML/MathML BEFORE pagination runs, so pages never break mid-formula.
 *   - Server-side (core/render.js, Node, no DOM) emits the SAME placeholder
 *     spans and injects a KaTeX `<link>` + inline `<script>` that calls the
 *     direct-render function on load — so /api/render (share previews, MCP,
 *     headless export) is math-aware without needing the katex npm package.
 *
 * The marked extension set + heuristic are pure functions: safe to import from
 * both Node (CommonJS `require`) and the browser (ES module `import`).
 */
'use strict';

/**
 * Escape a string for safe inclusion in an HTML attribute value.
 */
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Cheap, one-shot heuristic: does this document body look like it contains
 * math? Runs only on document load / explicit re-scan, NOT on every keystroke.
 *
 * Returns true if any math-delimiter pattern appears outside of fenced
 * code blocks and inline code spans. The scan is deliberately cheap: a few
 * regex tests, no full marked parse.
 *
 * Signal: presence of $$, \( , \[ , or a $ followed by a letter/backslash
 * (not whitespace/digit, which would be currency or a stray). We do NOT
 * validate delimiter balance — the renderer does that — we only flag
 * "looks like it might be math" to nudge the user.
 */
function hasMathHeuristic(body) {
  if (typeof body !== 'string' || !body) return false;

  // Strip fenced code blocks so $ inside ```lang ... ``` won't false-positive.
  var withoutFences = body.replace(/```[\s\S]*?```/g, '');

  // Strip indented code blocks (4-space indent) — best-effort, cheap.
  // We don't strip lazy continuation, but that's acceptable for a nudge.
  var withoutIndented = withoutFences.replace(/(^|\n)(?: {4,}|\t)(?:.*\n?)+/g, '');

  // Strip inline code spans so `$foo$` in `code` won't match.
  var withoutInlineCode = withoutIndented.replace(/`[^`]*`/g, '');

  // Display-math indicators.
  if (/\$\$(?!\$)/.test(withoutInlineCode)) return true;
  if (/\\\(/g.test(withoutInlineCode)) return true;
  if (/\\\[/g.test(withoutInlineCode)) return true;

  // Inline math: a $ that is NOT escaped, NOT followed by whitespace/digit/$.
  if (/(?<!\\)\$(?![\s\d$])/.test(withoutInlineCode)) return true;

  return false;
}

/**
 * The marked extension set. Each extension has a `name` matching its token
 * `type`, and a distinct renderer that emits the neutral placeholder markup.
 * Order matters: the block `$$...$$` extension is listed before the inline
 * `$...$` extension so display math is consumed first (marked checks block
 * tokenizers top-to-bottom, then inline tokenizers within the paragraph).
 */
var MATH_EXTENSIONS = [
  {
    name: 'fw-math-block',
    level: 'block',
    start: function (src) { return src.indexOf('$$'); },
    tokenizer: function (src) {
      // Display math: $$ ... $$ on one or more lines. KaTeX order: $$
      // is checked before $ so display wins over inline.
      var m = src.match(/^\$\$(?:\\\$|[^$]|\n)*?\$\$/);
      if (!m) return undefined;
      var inner = m[0].slice(2, -2).replace(/\\\$/g, '$');
      return { type: 'fw-math-block', block: true, raw: m[0], text: inner };
    },
    renderer: function (token) {
      return '<div class="fw-math-display" data-latex="' + escapeAttr(token.text) + '"></div>';
    }
  },
  {
    name: 'fw-math-inline',
    level: 'inline',
    start: function (src) { return src.indexOf('$'); },
    tokenizer: function (src) {
      // Inline $...$ — KaTeX/GitHub compatible.
      //   - $$ is NOT inline (display block handles it)
      //   - $ followed by whitespace or digit → currency, skip
      //   - closing $ preceded by whitespace → not math
      //   - escaped \$ allowed inside
      var m = src.match(/^\$(?!\$)(?![\s\d])((?:\\\$|[^\$\\]|\n){1,500}?)\$(?!\$)(?<!\s)/);
      if (!m) return undefined;
      var text = m[1].replace(/\\\$/g, '$');
      return { type: 'fw-math-inline', raw: m[0], text: text };
    },
    renderer: function (token) {
      return '<span class="fw-math-inline" data-latex="' + escapeAttr(token.text) + '"></span>';
    }
  },
  {
    name: 'fw-math-paren',
    level: 'inline',
    start: function (src) { return src.indexOf('\\('); },
    tokenizer: function (src) {
      var m = src.match(new RegExp("^\\\\\\(([\\\\s\\\\S]*?)\\\\\\)"));
      if (!m) return undefined;
      var text = m[0].slice(2, -2);
      return { type: 'fw-math-paren', raw: m[0], text: text };
    },
    renderer: function (token) {
      return '<span class="fw-math-inline" data-latex="' + escapeAttr(token.text) + '"></span>';
    }
  },
  {
    name: 'fw-math-bracket',
    level: 'block',
    start: function (src) { return src.indexOf('\\['); },
    tokenizer: function (src) {
      var m = src.match(new RegExp("^\\\\\\[([\\s\\S]*?)\\\\\\]"));
      if (!m) {
      m = src.match(new RegExp("^\\\\\\[([\\s\\S]*?)\\\\\\]"));
        if (!m) return undefined;
        return { type: 'fw-math-bracket', block: false, raw: m[0], text: m[1] };
      }
      return { type: 'fw-math-bracket', block: true, raw: m[0], text: m[1] };
    },
    renderer: function (token) {
      return '<div class="fw-math-display" data-latex="' + escapeAttr(token.text) + '"></div>';
    }
  }
];

/**
 * Lazily create and cache a `marked` instance pre-configured with the math
 * extensions. We use a dedicated Marked instance (NOT marked.use on the
 * global singleton) so the OFF path remains a pure no-op — no extensions
 * registered, no per-token overhead, zero cost for math-free documents.
 *
 * Works in both Node (require) and the browser (window.marked global).
 */
var cachedMark = null;
function getMarkedCtor() {
  if (typeof require === 'function') return require('marked').Marked;
  if (typeof window !== 'undefined' && window.marked && window.marked.Marked) {
    return window.marked.Marked;
  }
  return null;
}
function createMarkedWithMath() {
  if (cachedMark) return cachedMark;
  var MarkedCtor = getMarkedCtor();
  if (!MarkedCtor) return null;
  cachedMark = new MarkedCtor({ extensions: MATH_EXTENSIONS });
  return cachedMark;
}

/** Exposed for the browser-side app.js to create its own isolated instance. */
function createMarkedInstance() {
  var MarkedCtor = getMarkedCtor();
  if (!MarkedCtor) return null;
  return new MarkedCtor({ extensions: MATH_EXTENSIONS });
}

/**
 * Parse markdown to HTML. When `mathEnabled` is true, use a dedicated Marked
 * instance with math extensions (isolated — does NOT mutate the global).
 * When false, the global marked singleton is used unchanged (zero cost).
 */
function parseMarkdown(markdown, mathEnabled) {
  if (mathEnabled) {
    var instance = createMarkedWithMath();
    if (instance) return instance.parse(markdown);
    // Fallback: use global marked with .use (browser CDN fallback)
    if (typeof marked !== 'undefined' && marked.use) {
      marked.use({ extensions: MATH_EXTENSIONS });
      return marked.parse(markdown);
    }
    return marked.parse(markdown);
  }
  // Global marked (default, no extensions) — the OFF path.
  return typeof marked !== 'undefined' ? marked.parse(markdown) : '';
}

/**
 * Install the math extensions into a marked instance. Gated by a boolean so
 * the OFF path is a pure no-op — no extension registration, no token cost.
 * Kept for backwards-compat / explicit-use callers (e.g. app.js).
 */
function installMathExtensions(markedInstance, enabled) {
  if (!enabled) return;
  if (typeof markedInstance.use !== 'function') return;
  markedInstance.use({ extensions: MATH_EXTENSIONS });
}

/**
 * KaTeX CDN base (same version for CSS, JS, and assets).
 */
var KATEX_BASE = 'https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/';

/**
 * Lazily inject KaTeX CSS + JS into a document. Returns a promise resolving
 * when katex.render is available on `win`. Safe to call concurrently.
 */
function loadKatex(win) {
  win = win || (typeof window !== 'undefined' ? window : null);
  if (!win) return Promise.reject(new Error('[math] no window context'));
  if (win.__flatwriteKatexLoaded) return Promise.resolve();
  if (win.__flatwriteKatexLoading) return win.__flatwriteKatexLoading;

  win.__flatwriteKatexLoading = new Promise(function (resolve, reject) {
    var link = win.document.createElement('link');
    link.rel = 'stylesheet';
    link.href = KATEX_BASE + 'katex.min.css';
    link.onload = function () {
      var script = win.document.createElement('script');
      script.src = KATEX_BASE + 'katex.min.js';
      script.onload = function () {
        win.__flatwriteKatexLoaded = true;
        win.__flatwriteKatexLoading = null;
        resolve();
      };
      script.onerror = function () {
        win.__flatwriteKatexLoading = null;
        reject(new Error('[math] KaTeX JS failed to load'));
      };
      win.document.head.appendChild(script);
    };
    link.onerror = function () {
      win.__flatwriteKatexLoading = null;
      reject(new Error('[math] KaTeX CSS failed to load'));
    };
    win.document.head.appendChild(link);
  });
  return win.__flatwriteKatexLoading;
}

/**
 * Render all math placeholders inside `container` (or document) by calling
 * katex.render(latex, element) directly on each `<span class="fw-math-inline">`
 * / `<div class="fw-math-display">` placeholder that carries a data-latex
 * attribute. Synchronous after KaTeX loads. Non-blocking: KaTeX errors are
 * caught and logged, never thrown; on failure the original LaTeX text is
 * injected as fallback content so it stays visible.
 */
function renderMathInRoot(win, container) {
  win = win || (typeof window !== 'undefined' ? window : null);
  if (!win) return Promise.resolve();
  container = container || win.document.body;
  var roots = container.querySelectorAll('.fw-math-inline, .fw-math-display');
  if (!roots.length) return Promise.resolve();

  return loadKatex(win).then(function () {
    var katex = win.katex;
    if (!katex) {
      console.error('[math] katex not available after load');
      return;
    }
    roots.forEach(function (el) {
      // Skip already-rendered elements (idempotent).
      if (el.querySelector('.katex')) return;
      var latex = el.getAttribute('data-latex') || '';
      var isDisplay = el.classList.contains('fw-math-display');
      try {
        katex.render(latex, el, {
          throwOnError: false,
          displayMode: isDisplay,
          errorColor: '#a03340'
        });
      } catch (err) {
        // Non-throwing render mode: leave original LaTeX visible as fallback.
        console.error('[math] katex render error for:', latex, err);
        el.textContent = latex;
        if (el.getAttribute('data-latex-fallback') !== 'true') {
          el.setAttribute('data-latex-fallback', 'true');
        }
      }
    });
  }).catch(function (err) {
    console.error('[math] load failed:', err);
  });
}

/**
 * Inject the KaTeX <link> + a self-executing inline script into an HTML
 * string (used by core/render.js for server-side /api/render output and
 * the HTML-export path). The script finds every .fw-math-* placeholder in
 * the loaded document and renders it with KaTeX on DOMContentLoaded.
 */
function katexInlineAssets() {
  return (
    '<link rel="stylesheet" href="' + KATEX_BASE + 'katex.min.css">'
    + '<script src="' + KATEX_BASE + 'katex.min.js"><\/script>'
    + '<script>'
    + 'window.addEventListener("DOMContentLoaded",function(){var k=window.katex;if(!k){var s=document.createElement("script");s.src="' + KATEX_BASE + 'katex.min.js";s.onload=function(){renderFwMath(document)};document.head.appendChild(s)}else{renderFwMath(document)}});'
    + 'function renderFwMath(d){var e=d.querySelectorAll(".fw-math-inline,.fw-math-display");if(!e.length)return;k=window.katex||k;if(!k)return;e.forEach(function(el){if(el.querySelector(".katex"))return;var l=el.getAttribute("data-latex")||"";var disp=el.classList.contains("fw-math-display");try{k.render(l,el,{throwOnError:false,displayMode:disp})}catch(err){el.textContent=l}})}'
    + '<\/script>'
  );
}

module.exports = {
  hasMathHeuristic: hasMathHeuristic,
  installMathExtensions: installMathExtensions,
  MATH_EXTENSIONS: MATH_EXTENSIONS,
  createMarkedWithMath: createMarkedWithMath,
  createMarkedInstance: createMarkedInstance,
  parseMarkdown: parseMarkdown,
  loadKatex: loadKatex,
  renderMathInRoot: renderMathInRoot,
  katexInlineAssets: katexInlineAssets
};
