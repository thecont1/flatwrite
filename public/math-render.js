/**
 * math-render.js — Browser-side Math Mode support for FlatWrite
 *
 * Loaded as a plain <script> (NOT a module). Attaches to window.FlatWriteMath.
 * The pure marked-extension set and heuristic mirror core/math.js (Node side)
 * but use the browser-global `marked` and `window` instead of require/module.
 *
 * Kept deliberately free of Nodeisms so it can be dropped into any <head>.
 */
(function () {
  "use strict";

  if (typeof window === "undefined") return;

  var KATEX_BASE = "https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/";

  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /**
   * Cheap, one-shot heuristic: does this document body look like it contains
   * math? Runs only on document load / explicit re-scan, NOT on every keystroke.
   */
  function hasMathHeuristic(body) {
    if (typeof body !== "string" || !body) return false;

    // Strip fenced code blocks so $ inside ```lang ... ``` won't false-positive.
    var withoutFences = body.replace(/```[\s\S]*?```/g, "");

    // Strip indented code blocks (4-space indent) — best-effort, cheap.
    var withoutIndented = withoutFences.replace(/(^|\n)(?: {4,}|\t)(?:.*\n?)+/g, "");

    // Strip inline code spans so `$foo$` in `code` won't match.
    var withoutInlineCode = withoutIndented.replace(/`[^`]*`/g, "");

    // Display-math indicators.
    if (/\$\$(?!\$)/.test(withoutInlineCode)) return true;
    if (/\\\(/g.test(withoutInlineCode)) return true;
    if (/\\\[/g.test(withoutInlineCode)) return true;

    // Inline math: a $ that is NOT escaped, NOT followed by whitespace/digit/$.
    if (/(?<!\\)\$(?![\s\d$])/.test(withoutInlineCode)) return true;

    return false;
  }

  var MATH_EXTENSIONS = [
    {
      name: "fw-math-block",
      level: "block",
      start: function (src) { return src.indexOf("$$"); },
      tokenizer: function (src) {
        var m = src.match(/^\$\$(?:\\\$|[^$]|\n)*?\$\$/);
        if (!m) return undefined;
        var inner = m[0].slice(2, -2).replace(/\\\$/g, "$");
        return { type: "fw-math-block", block: true, raw: m[0], text: inner };
      },
      renderer: function (token) {
        return '<div class="fw-math-display" data-latex="' + escapeAttr(token.text) + '"></div>';
      }
    },
    {
      name: "fw-math-inline",
      level: "inline",
      start: function (src) { return src.indexOf("$"); },
      tokenizer: function (src) {
        var m = src.match(/^\$(?!\$)(?![\s\d])((?:\\\$|[^\$\\]|\n){1,500}?)\$(?!\$)(?<!\s)/);
        if (!m) return undefined;
        var text = m[1].replace(/\\\$/g, "$");
        return { type: "fw-math-inline", raw: m[0], text: text };
      },
      renderer: function (token) {
        return '<span class="fw-math-inline" data-latex="' + escapeAttr(token.text) + '"></span>';
      }
    },
    {
      name: "fw-math-paren",
      level: "inline",
      start: function (src) { return src.indexOf("\\("); },
      tokenizer: function (src) {
        var m = src.match(/^\\\((\\\(|\\[^\)]*?)?\\\)/);
        if (!m) return undefined;
        // Actually use a simpler match: \( ... \)
        m = src.match(/^\\\((?:\\\)|[^\)]*?)\\\)/);
        if (!m) return undefined;
        var text = m[0].slice(2, -2);
        return { type: "fw-math-paren", raw: m[0], text: text };
      },
      renderer: function (token) {
        return '<span class="fw-math-inline" data-latex="' + escapeAttr(token.text) + '"></span>';
      }
    },
    {
      name: "fw-math-bracket",
      level: "block",
      start: function (src) { return src.indexOf("\\["); },
      tokenizer: function (src) {
        var m = src.match(/^\\\[\s*([\s\S]*?)\s*\\\]\n?\n/);
        if (!m) {
          m = src.match(/^\\\[\s*([\s\S]*?)\s*\\\]/);
          if (!m) return undefined;
          return { type: "fw-math-bracket", block: false, raw: m[0], text: m[1] };
        }
        return { type: "fw-math-bracket", block: true, raw: m[0], text: m[1] };
      },
      renderer: function (token) {
        return '<div class="fw-math-display" data-latex="' + escapeAttr(token.text) + '"></div>';
      }
    }
  ];

  /**
   * Create a dedicated marked.Marked instance with math extensions.
   * Isolated from the global marked so the OFF path has zero cost.
   */
  var cachedMark = null;
  function createMarkedWithMath() {
    if (cachedMark) return cachedMark;
    if (typeof window !== "undefined" && window.marked && window.marked.Marked) {
      cachedMark = new window.marked.Marked({ extensions: MATH_EXTENSIONS });
      return cachedMark;
    }
    return null;
  }

  /**
   * Parse markdown to HTML. When mathEnabled is true, use the isolated
   * math-enabled instance; otherwise use the global marked (zero cost).
   */
  function parseMarkdown(markdown, mathEnabled) {
    if (mathEnabled) {
      var inst = createMarkedWithMath();
      if (inst) return inst.parse(markdown);
      // Fallback: register on global (acceptable one-time cost when no Marked ctor)
      if (typeof marked !== "undefined" && marked.use) {
        marked.use({ extensions: MATH_EXTENSIONS });
        return marked.parse(markdown);
      }
      return marked.parse(markdown);
    }
    return marked.parse(markdown);
  }

  /**
   * Lazily inject KaTeX CSS + JS into a window. Returns a promise.
   */
  function loadKatex(win) {
    win = win || window;
    if (win.__flatwriteKatexLoaded) return Promise.resolve();
    if (win.__flatwriteKatexLoading) return win.__flatwriteKatexLoading;

    win.__flatwriteKatexLoading = new Promise(function (resolve, reject) {
      var link = win.document.createElement("link");
      link.rel = "stylesheet";
      link.href = KATEX_BASE + "katex.min.css";
      link.onload = function () {
        var script = win.document.createElement("script");
        script.src = KATEX_BASE + "katex.min.js";
        script.onload = function () {
          win.__flatwriteKatexLoaded = true;
          win.__flatwriteKatexLoading = null;
          resolve();
        };
        script.onerror = function () {
          win.__flatwriteKatexLoading = null;
          reject(new Error("[math] KaTeX JS failed to load"));
        };
        win.document.head.appendChild(script);
      };
      link.onerror = function () {
        win.__flatwriteKatexLoading = null;
        reject(new Error("[math] KaTeX CSS failed to load"));
      };
      win.document.head.appendChild(link);
    });
    return win.__flatwriteKatexLoading;
  }

  /**
   * Render all math placeholders in a container by calling katex.render
   * directly. Synchronous after KaTeX loads. Non-blocking on error.
   */
  function renderMathInRoot(win, container) {
    win = win || window;
    if (!win) return Promise.resolve();
    container = container || win.document.body;
    var roots = container.querySelectorAll(".fw-math-inline, .fw-math-display");
    if (!roots.length) return Promise.resolve();

    return loadKatex(win).then(function () {
      var katex = win.katex;
      if (!katex) {
        console.error("[math] katex not available after load");
        return;
      }
      roots.forEach(function (el) {
        // Skip already-rendered (idempotent).
        if (el.querySelector(".katex")) return;
        var latex = el.getAttribute("data-latex") || "";
        var isDisplay = el.classList.contains("fw-math-display");
        try {
          katex.render(latex, el, {
            throwOnError: false,
            displayMode: isDisplay,
            errorColor: "#a03340"
          });
        } catch (err) {
          console.error("[math] katex render error for:", latex, err);
          el.textContent = latex;
        }
      });
    }).catch(function (err) {
      console.error("[math] load failed:", err);
    });
  }

  window.FlatWriteMath = {
    MATH_EXTENSIONS: MATH_EXTENSIONS,
    hasMathHeuristic: hasMathHeuristic,
    parseMarkdown: parseMarkdown,
    createMarkedWithMath: createMarkedWithMath,
    loadKatex: loadKatex,
    renderMathInRoot: renderMathInRoot,
    KATEX_BASE: KATEX_BASE,
  };
})();
