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
 *   - Fenced ```math / ```latex / ```tex blocks become display math via a
 *     custom code renderer on the isolated Marked instance only.
 *   - The browser lazy-loads KaTeX only when Math Mode is ON and math
 *     placeholders are present. It then calls `katex.render(latex, el)`
 *     directly on each placeholder — synchronous, deterministic, no text-scanning.
 *     This is critical for Paged.js / Vivliostyle: math is rendered to static
 *     HTML/MathML BEFORE pagination runs, so pages never break mid-formula.
 *   - Server-side (core/render.js, Node, no DOM) emits the SAME placeholder
 *     spans and injects a KaTeX <link> + inline <script> that calls the
 *     direct-render function on load — so /api/render (share previews, MCP,
 *     headless export) is math-aware without needing the katex npm package.
 */
'use strict';

/** Escape a string for safe inclusion in an HTML attribute value. */
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Normalize LaTeX body text produced by HTML→Markdown importers
 * (notably Cloudflare markdown.new). Those pipelines typically:
 *   1. Escape underscores as \_ (markdown-safe) inside math
 *   2. Double every TeX backslash so \theta becomes \\theta and
 *      \( becomes \\(
 * KaTeX wants single-backslash TeX. Two passes recover author-written
 * math without damaging hand-authored single-backslash sources or
 * legitimate TeX line breaks (\\ in aligned/matrix/array):
 *   Pass 1: \\\\ → \\  (un-double importer-quadrupled TeX newlines)
 *   Pass 2: \\(?=[A-Za-z(\[]) → \  (un-double importer-escaped commands)
 */
function normalizeLatexBody(tex) {
  if (!tex) return '';
  var s = String(tex);
  // Combined single pass: match 4-backslash sequences BEFORE 2-backslash
  // sequences so that importer-doubled TeX newlines (\\\\ → \\) are
  // preserved and not subsequently collapsed by the command pattern.
  //   \\\\       → \\   (un-double importer-quadrupled TeX newlines)
  //   \\(?=cmd)  → \    (collapse importer-escaped commands/delimiters)
  // A bare \\ (hand-authored TeX newline) is typically followed by
  // whitespace/newline and is NOT matched by the second alternative.
  s = s.replace(/\\\\\\\\|\\\\(?=[A-Za-z()\[\]])/g, function (m) {
    return m.length === 4 ? '\\\\' : '\\';
  });
  // Markdown underscore escapes that survived → real subscripts.
  s = s.replace(/\\_/g, '_');
  // Occasional markdown escapes of * and {} in importer output.
  s = s.replace(/\\([*{}])/g, '$1');
  // Importer-escaped brackets: \[ → [, \] → ] inside math bodies.
  // markdown.new escapes [ and ] even inside $$ blocks; KaTeX rejects
  // \left\[ and E_i\[ as invalid delimiter types.
  s = s.replace(/\\([\[\]])/g, '$1');
  // Fix \left{ and \right} — source uses unescaped braces after \left/\right.
  // KaTeX requires \left\{ ... \right\}. Only match when brace is not already
  // preceded by a backslash (avoid double-escaping \left\{).
  s = s.replace(/\\left\{/g, '\\left\\{');
  s = s.replace(/\\right\}/g, '\\right\\}');
  // Fix bare # inside \text{...} — KaTeX rejects # in text mode.
  // Convert # to \# only within \text{} arguments.
  s = s.replace(/(\\text\{[^}]*?)#/g, '$1\\#');
  // Fix trailing \. (not a valid LaTeX command; source uses it as a period).
  s = s.replace(/\\\.(?=\s*$|\\\s*$)/g, '.');
  s = s.replace(/\\\.(?=\s*\\end)/g, '.');
  return s;
}

/**
 * Preprocess a full markdown document when Math Mode is ON:
 * convert importer double-escaped TeX delimiters \\( \\) \\[ \\] to \( \) \[ \].
 * Does not touch fenced code (strip/restore).
 */
function normalizeMathMarkdown(md) {
  if (!md) return md;
  var fences = [];
  var withoutFences = String(md).replace(/```[\s\S]*?```/g, function (block) {
    fences.push(block);
    return '\0FWFENCE' + (fences.length - 1) + '\0';
  });
  // \\( → \(, \\) → \), \\[ → \[, \\] → \]  (double-escaped delimiters)
  withoutFences = withoutFences.replace(/\\\\([()[\]])/g, '\\$1');
  return withoutFences.replace(/\0FWFENCE(\d+)\0/g, function (_m, i) {
    return fences[Number(i)];
  });
}

/**
 * Cheap, one-shot heuristic: does this document body look like it contains
 * math? Runs only on document load / explicit re-scan, NOT on every keystroke.
 *
 * Returns true if any math-delimiter pattern appears outside of fenced
 * code blocks and inline code spans. The scan is deliberately cheap: a few
 * regex tests, no full marked parse.
 */
function hasMathHeuristic(body) {
  if (typeof body !== 'string' || !body) return false;

  // Fenced math language is an explicit author signal — check before stripping.
  if (/^```(?:math|latex|tex)\s*$/m.test(body)) return true;

  // Strip fenced code blocks so $ inside ```lang ... ``` won't false-positive.
  var withoutFences = body.replace(/```[\s\S]*?```/g, '');

  // Strip indented code blocks (4-space indent) — best-effort, cheap.
  var withoutIndented = withoutFences.replace(/(^|\n)(?: {4,}|\t)(?:.*\n?)+/g, '$1');

  // Strip inline code spans so `$foo$` in `code` won't match.
  var withoutInlineCode = withoutIndented.replace(/`[^`\n]+`/g, '');

  // Display-math indicators (single- or double-escaped TeX delims from importers).
  if (/\$\$(?!\$)/.test(withoutInlineCode)) return true;
  if (/\\{1,2}\(/.test(withoutInlineCode)) return true;
  if (/\\{1,2}\[/.test(withoutInlineCode)) return true;
  // Common doubled TeX commands from markdown.new without needing delimiters.
  if (/\\\\(?:sum|frac|theta|alpha|partial|nabla|left|right|begin|end)\b/.test(withoutInlineCode)) {
    return true;
  }

  // Inline math: a $ that is NOT escaped, NOT followed by whitespace/digit/$.
  // Avoid bare currency like $100 and lone $$.
  // Use a capture group instead of lookbehind for broad browser/webview support.
  if (/(?:^|[^\\])\$(?![\s\d$])/.test(withoutInlineCode)) return true;

  return false;
}

/**
 * marked extension set. Order: block $$ before inline $; block \[ before
 * paragraph text so display forms win.
 */
var MATH_EXTENSIONS = [
  {
    name: 'fw-math-block',
    level: 'block',
    start: function (src) { return src.indexOf('$$'); },
    tokenizer: function (src) {
      // Display math: $$ ... $$ (single or multi-line).
      var m = src.match(/^\$\$(?!\$)([\s\S]+?)\$\$(?!\$)/);
      if (!m) return undefined;
      var inner = normalizeLatexBody(m[1].replace(/^\n+|\n+$/g, '').replace(/\\\$/g, '$'));
      return { type: 'fw-math-block', block: true, raw: m[0], text: inner };
    },
    renderer: function (token) {
      return '<div class="fw-math-display" data-latex="' + escapeAttr(token.text) + '"></div>\n';
    }
  },
  {
    name: 'fw-math-bracket',
    level: 'block',
    start: function (src) { return src.indexOf('\\['); },
    tokenizer: function (src) {
      // Display: \[ ... \]
      var m = src.match(/^\\\[([\s\S]*?)\\\]/);
      if (!m) return undefined;
      return {
        type: 'fw-math-bracket',
        block: true,
        raw: m[0],
        text: normalizeLatexBody(m[1].replace(/^\n+|\n+$/g, ''))
      };
    },
    renderer: function (token) {
      return '<div class="fw-math-display" data-latex="' + escapeAttr(token.text) + '"></div>\n';
    }
  },
  {
    name: 'fw-math-inline',
    level: 'inline',
    start: function (src) { return src.indexOf('$'); },
    tokenizer: function (src) {
      // Inline $...$ — GitHub/KaTeX compatible:
      //   - $$ is display (handled by block tokenizer)
      //   - $ followed by whitespace or digit → currency, skip
      //   - closing $ preceded by whitespace → not math
      //   - escaped \$ allowed inside
      // Post-check instead of lookbehind (?<!\s) for broad browser/webview support.
      var m = src.match(/^\$(?!\$)(?![\s\d])((?:\\\$|[^$\n\\]|\\.){1,500}?)\$(?!\$)/);
      if (!m) return undefined;
      // Closing $ must not be preceded by whitespace (replaces (?<!\s) lookbehind).
      if (/\s$/.test(m[1])) return undefined;
      var text = normalizeLatexBody(m[1].replace(/\\\$/g, '$'));
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
      // Inline: \( ... \)
      var m = src.match(/^\\\(([\s\S]*?)\\\)/);
      if (!m) return undefined;
      return { type: 'fw-math-paren', raw: m[0], text: normalizeLatexBody(m[1]) };
    },
    renderer: function (token) {
      return '<span class="fw-math-inline" data-latex="' + escapeAttr(token.text) + '"></span>';
    }
  }
];

/** Resolve the marked package / global in Node and browser. */
function getMarkedApi() {
  if (typeof require === 'function') {
    try {
      var mod = require('marked');
      // marked v9+: { marked, Marked, ... }
      if (mod && (mod.Marked || mod.marked)) {
        return {
          Marked: mod.Marked || (mod.marked && mod.marked.Marked),
          parse: (mod.marked && mod.marked.parse)
            ? mod.marked.parse.bind(mod.marked)
            : (typeof mod.parse === 'function' ? mod.parse.bind(mod) : null)
        };
      }
    } catch (e) { /* fall through */ }
  }
  if (typeof marked !== 'undefined') {
    return {
      Marked: marked.Marked || null,
      parse: typeof marked.parse === 'function' ? marked.parse.bind(marked) : null
    };
  }
  if (typeof window !== 'undefined' && window.marked) {
    return {
      Marked: window.marked.Marked || null,
      parse: typeof window.marked.parse === 'function'
        ? window.marked.parse.bind(window.marked)
        : null
    };
  }
  return { Marked: null, parse: null };
}

/**
 * Dedicated Marked instance with math extensions. Isolated from the global
 * singleton so the OFF path remains a pure no-op.
 */
var cachedMark = null;
function createMarkedWithMath() {
  if (cachedMark) return cachedMark;
  var api = getMarkedApi();
  if (!api.Marked) return null;

  cachedMark = new api.Marked();
  cachedMark.use({
    extensions: MATH_EXTENSIONS,
    renderer: {
      // Fenced ```math / ```latex / ```tex → display math (ON path only).
      code: function (token) {
        var lang = (token.lang || '').trim().toLowerCase();
        if (lang === 'math' || lang === 'latex' || lang === 'tex') {
          return '<div class="fw-math-display" data-latex="' + escapeAttr(normalizeLatexBody(token.text)) + '"></div>\n';
        }
        return false; // default fenced-code renderer
      }
    }
  });
  return cachedMark;
}

/** Exposed for the browser-side app to create its own isolated instance. */
function createMarkedInstance() {
  cachedMark = null;
  var inst = createMarkedWithMath();
  cachedMark = null; // don't pin the caller's instance as the module cache
  return inst;
}

/**
 * Parse markdown to HTML.
 * When mathEnabled: isolated Marked + math extensions.
 * When false: default marked.parse with zero extension cost.
 */
function parseMarkdown(markdown, mathEnabled) {
  var src = markdown == null ? '' : String(markdown);
  if (mathEnabled) {
    src = normalizeMathMarkdown(src);
    var instance = createMarkedWithMath();
    if (instance) return instance.parse(src);
    // Last-resort browser fallback: mutate global once.
    if (typeof marked !== 'undefined' && marked.use) {
      marked.use({ extensions: MATH_EXTENSIONS });
      return marked.parse(src);
    }
  }
  var api = getMarkedApi();
  if (api.parse) return api.parse(src);
  return '';
}

/** Install math extensions into a marked instance (explicit-use callers). */
function installMathExtensions(markedInstance, enabled) {
  if (!enabled) return;
  if (!markedInstance || typeof markedInstance.use !== 'function') return;
  markedInstance.use({ extensions: MATH_EXTENSIONS });
}

/** KaTeX CDN base (pin a single version for CSS + JS + fonts). */
var KATEX_BASE = 'https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/';

/**
 * Lazily inject KaTeX CSS + JS into a document. Returns a promise resolving
 * when katex.render is available on `win`. Safe to call concurrently.
 */
function loadKatex(win) {
  win = win || (typeof window !== 'undefined' ? window : null);
  if (!win) return Promise.reject(new Error('[math] no window context'));
  if (win.katex && typeof win.katex.render === 'function') {
    win.__flatwriteKatexLoaded = true;
    return Promise.resolve();
  }
  if (win.__flatwriteKatexLoaded && win.katex) return Promise.resolve();
  if (win.__flatwriteKatexLoading) return win.__flatwriteKatexLoading;

  win.__flatwriteKatexLoading = new Promise(function (resolve, reject) {
    var doc = win.document;
    if (!doc.head) {
      win.__flatwriteKatexLoading = null;
      reject(new Error('[math] no document head'));
      return;
    }

    function injectCss() {
      if (doc.getElementById('fw-katex-css')) return;
      var link = doc.createElement('link');
      link.id = 'fw-katex-css';
      link.rel = 'stylesheet';
      link.href = KATEX_BASE + 'katex.min.css';
      doc.head.appendChild(link);
    }

    function injectJs() {
      var existing = doc.getElementById('fw-katex-js');
      if (existing) {
        if (win.katex) {
          win.__flatwriteKatexLoaded = true;
          win.__flatwriteKatexLoading = null;
          resolve();
          return;
        }
        existing.addEventListener('load', function () {
          win.__flatwriteKatexLoaded = true;
          win.__flatwriteKatexLoading = null;
          resolve();
        });
        existing.addEventListener('error', function () {
          win.__flatwriteKatexLoading = null;
          reject(new Error('[math] KaTeX JS failed to load'));
        });
        return;
      }
      var script = doc.createElement('script');
      script.id = 'fw-katex-js';
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
      doc.head.appendChild(script);
    }

    injectCss();
    injectJs();
  });
  return win.__flatwriteKatexLoading;
}

/**
 * Render all math placeholders inside `container` by calling katex.render
 * directly. Non-throwing: errors leave original LaTeX visible.
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
      if (el.querySelector('.katex')) return;
      var latex = el.getAttribute('data-latex') || '';
      var isDisplay = el.classList.contains('fw-math-display');
      try {
        katex.render(latex, el, {
          throwOnError: false,
          displayMode: isDisplay,
          errorColor: '#a03340',
          strict: 'ignore',
          trust: false,
          output: 'htmlAndMathml'
        });
      } catch (err) {
        console.error('[math] katex render error for:', latex, err);
        el.textContent = latex;
        el.setAttribute('data-latex-fallback', 'true');
      }
    });
  }).catch(function (err) {
    console.error('[math] load failed:', err);
  });
}

/**
 * Inject KaTeX <link> + self-executing inline script into an HTML string
 * (server-side /api/render and HTML-export path).
 */
function katexInlineAssets() {
  return (
    '<link rel="stylesheet" href="' + KATEX_BASE + 'katex.min.css">'
    + '<script src="' + KATEX_BASE + 'katex.min.js"><\\/script>'
    + '<script>'
    + 'window.addEventListener("DOMContentLoaded",function(){'
    + 'function renderFwMath(d){var k=window.katex;if(!k)return;'
    + 'd.querySelectorAll(".fw-math-inline,.fw-math-display").forEach(function(el){'
    + 'if(el.querySelector(".katex"))return;'
    + 'var l=el.getAttribute("data-latex")||"";'
    + 'var disp=el.classList.contains("fw-math-display");'
    + 'try{k.render(l,el,{throwOnError:false,displayMode:disp,strict:"ignore",output:"htmlAndMathml"})}'
    + 'catch(err){el.textContent=l}})}'
    + 'if(window.katex){renderFwMath(document)}'
    + 'else{var s=document.createElement("script");s.src="' + KATEX_BASE + 'katex.min.js";'
    + 's.onload=function(){renderFwMath(document)};document.head.appendChild(s)}'
    + '});'
    + '<\\/script>'
  );
}

/** Link tag only — used when parent already pre-rendered math into static HTML. */
function katexCssLink() {
  return '<link rel="stylesheet" href="' + KATEX_BASE + 'katex.min.css">';
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
  katexInlineAssets: katexInlineAssets,
  katexCssLink: katexCssLink,
  KATEX_BASE: KATEX_BASE,
  escapeAttr: escapeAttr,
  normalizeLatexBody: normalizeLatexBody,
  normalizeMathMarkdown: normalizeMathMarkdown
};
