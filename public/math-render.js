/**
 * math-render.js — Browser-side Math Mode support for FlatWrite
 *
 * Loaded as a plain <script> (NOT a module). Attaches to window.FlatWriteMath.
 * Mirrors core/math.js (Node) without require/module so it can drop into <head>.
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
   * Normalize LaTeX from HTML→Markdown importers (markdown.new):
   * doubles every TeX backslash so \theta → \\theta. Two passes recover
   * author-written math without damaging legitimate TeX line breaks
   * (\\ in aligned/matrix/array) or hand-authored \\ pairs:
   *   Pass 1: \\\\ → \\  (un-double importer-quadrupled TeX newlines)
   *   Pass 2: \\(?=[A-Za-z]) → \  (un-double importer-escaped commands)
   * Only collapse \\ when followed by a letter — \\ followed by (, [, etc.
   * may be a TeX row separator, so it is preserved.
   */
  function normalizeLatexBody(tex) {
    if (!tex) return "";
    var s = String(tex);
    // Combined single pass: match 4-backslash sequences BEFORE 2-backslash
    // sequences so that importer-doubled TeX newlines (\\\\ → \\) are
    // preserved and not subsequently collapsed by the command pattern.
    //   \\\\          → \\   (un-double importer-quadrupled TeX newlines)
    //   \\(?=[A-Za-z]) → \    (collapse importer-escaped commands only)
    // A bare \\ (TeX newline) followed by whitespace, (, [, etc. is NOT
    // matched by the second alternative and is preserved.
    s = s.replace(/\\\\\\\\|\\\\(?=[A-Za-z])/g, function (m) {
      return m.length === 4 ? "\\\\" : "\\";
    });
    s = s.replace(/\\_/g, "_");
    s = s.replace(/\\([*{}])/g, "$1");
    // Importer-escaped brackets: \[ → [, \] → ] inside math bodies.
    s = s.replace(/\\([\[\]])/g, "$1");
    // Fix \left{ → \left\{ and \right} → \right\} (source uses unescaped braces).
    s = s.replace(/\\left\{/g, "\\left\\{");
    s = s.replace(/\\right\}/g, "\\right\\}");
    // Fix bare # inside \text{...} — KaTeX rejects # in text mode.
    s = s.replace(/(\\text\{[^}]*?)#/g, "$1\\#");
    // Fix trailing \. (not a valid LaTeX command; source uses it as a period).
    s = s.replace(/\\\.(?=\s*$|\\\s*$)/g, ".");
    s = s.replace(/\\\.(?=\s*\\end)/g, ".");
    return s;
  }

  /**
   * Preprocess a full markdown document when Math Mode is ON:
   * convert importer double-escaped TeX delimiters \\( \\) \\[ \\] to
   * \( \) \[ \]. Leaves fenced code untouched (strip/restore).
   */
  function normalizeMathMarkdown(md) {
    if (!md) return md;
    var fences = [];
    var withoutFences = String(md).replace(/```[\s\S]*?```/g, function (block) {
      fences.push(block);
      return "\0FWFENCE" + (fences.length - 1) + "\0";
    });
    withoutFences = withoutFences.replace(/\\\\([()[\]])/g, "\\$1");
    return withoutFences.replace(/\0FWFENCE(\d+)\0/g, function (_m, i) {
      return fences[Number(i)];
    });
  }

  function hasMathHeuristic(body) {
    if (typeof body !== "string" || !body) return false;
    if (/^```(?:math|latex|tex)\s*$/m.test(body)) return true;
    var withoutFences = body.replace(/```[\s\S]*?```/g, "");
    var withoutIndented = withoutFences.replace(/(^|\n)(?: {4,}|\t)[^\n]*(?:\n(?: {4,}|\t)[^\n]*)*/g, "$1");
    var withoutInlineCode = withoutIndented.replace(/`[^`\n]+`/g, "");
    if (/\$\$(?!\$)/.test(withoutInlineCode)) return true;
    if (/\\{1,2}\(/.test(withoutInlineCode)) return true;
    if (/\\{1,2}\[/.test(withoutInlineCode)) return true;
    if (/\\\\(?:sum|frac|theta|alpha|partial|nabla|left|right|begin|end)\b/.test(withoutInlineCode)) {
      return true;
    }
    if (/(?:^|[^\\])\$(?![\s\d$])/.test(withoutInlineCode)) return true;
    return false;
  }

  var MATH_EXTENSIONS = [
    {
      name: "fw-math-block",
      level: "block",
      start: function (src) { return src.indexOf("$$"); },
      tokenizer: function (src) {
        var m = src.match(/^\$\$(?!\$)([\s\S]+?)\$\$(?!\$)/);
        if (!m) return undefined;
        var inner = normalizeLatexBody(m[1].replace(/^\n+|\n+$/g, "").replace(/\\\$/g, "$"));
        return { type: "fw-math-block", block: true, raw: m[0], text: inner };
      },
      renderer: function (token) {
        return '<div class="fw-math-display" data-latex="' + escapeAttr(token.text) + '"></div>\n';
      }
    },
    {
      name: "fw-math-bracket",
      level: "block",
      start: function (src) { return src.indexOf("\\["); },
      tokenizer: function (src) {
        var m = src.match(/^\\\[([\s\S]*?)\\\]/);
        if (!m) return undefined;
        return {
          type: "fw-math-bracket",
          block: true,
          raw: m[0],
          text: normalizeLatexBody(m[1].replace(/^\n+|\n+$/g, ""))
        };
      },
      renderer: function (token) {
        return '<div class="fw-math-display" data-latex="' + escapeAttr(token.text) + '"></div>\n';
      }
    },
    {
      name: "fw-math-inline",
      level: "inline",
      start: function (src) { return src.indexOf("$"); },
      tokenizer: function (src) {
        var m = src.match(/^\$(?!\$)(?![\s\d])((?:\\$|[^$\n\\]|\\.){1,500}?)\$(?!\$)/);
        if (!m) return undefined;
        if (/\s$/.test(m[1])) return undefined;
        var text = normalizeLatexBody(m[1].replace(/\\$/g, "$"));
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
        var m = src.match(/^\\\(([\s\S]*?)\\\)/);
        if (!m) return undefined;
        return { type: "fw-math-paren", raw: m[0], text: normalizeLatexBody(m[1]) };
      },
      renderer: function (token) {
        return '<span class="fw-math-inline" data-latex="' + escapeAttr(token.text) + '"></span>';
      }
    }
  ];

  var cachedMark = null;
  function createMarkedWithMath() {
    if (cachedMark) return cachedMark;
    var MarkedCtor = window.marked && window.marked.Marked;
    if (!MarkedCtor) return null;
    cachedMark = new MarkedCtor();
    cachedMark.use({
      extensions: MATH_EXTENSIONS,
      renderer: {
        code: function (token) {
          var lang = (token.lang || "").trim().toLowerCase();
          if (lang === "math" || lang === "latex" || lang === "tex") {
            return '<div class="fw-math-display" data-latex="' + escapeAttr(normalizeLatexBody(token.text)) + '"></div>\n';
          }
          return false;
        }
      }
    });
    return cachedMark;
  }

  function parseMarkdown(md, mathEnabled) {
    var src = md == null ? "" : String(md);
    if (mathEnabled) {
      src = normalizeMathMarkdown(src);
      var inst = createMarkedWithMath();
      if (inst) return inst.parse(src);
      if (typeof marked !== "undefined" && marked.use) {
        marked.use({ extensions: MATH_EXTENSIONS });
        return marked.parse(src);
      }
    }
    return marked.parse(src);
  }

  function loadKatex(win) {
    win = win || window;
    if (win.katex && typeof win.katex.render === "function") {
      win.__flatwriteKatexLoaded = true;
      return Promise.resolve();
    }
    if (win.__flatwriteKatexLoaded && win.katex) return Promise.resolve();
    if (win.__flatwriteKatexLoading) return win.__flatwriteKatexLoading;

    win.__flatwriteKatexLoading = new Promise(function (resolve, reject) {
      var doc = win.document;
      if (!doc.head) {
        win.__flatwriteKatexLoading = null;
        reject(new Error("[math] no document head"));
        return;
      }
      if (!doc.getElementById("fw-katex-css")) {
        var link = doc.createElement("link");
        link.id = "fw-katex-css";
        link.rel = "stylesheet";
        link.href = KATEX_BASE + "katex.min.css";
        doc.head.appendChild(link);
      }
      var existing = doc.getElementById("fw-katex-js");
      if (existing) {
        if (win.katex) {
          win.__flatwriteKatexLoaded = true;
          win.__flatwriteKatexLoading = null;
          resolve();
          return;
        }
        existing.addEventListener("load", function () {
          win.__flatwriteKatexLoaded = true;
          win.__flatwriteKatexLoading = null;
          resolve();
        });
        existing.addEventListener("error", function () {
          win.__flatwriteKatexLoading = null;
          reject(new Error("[math] KaTeX JS failed to load"));
        });
        return;
      }
      var script = doc.createElement("script");
      script.id = "fw-katex-js";
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
      doc.head.appendChild(script);
    });
    return win.__flatwriteKatexLoading;
  }

  function renderMathInRoot(win, container) {
    win = win || window;
    if (!win) return Promise.resolve();
    container = container || win.document.body;
    var roots = container.querySelectorAll(".fw-math-inline, .fw-math-display");
    if (!roots.length) return Promise.resolve();
    return loadKatex(win).then(function () {
      var katex = win.katex;
      if (!katex) {
        console.error("[math] katex not available");
        return;
      }
      roots.forEach(function (el) {
        if (el.querySelector(".katex")) return;
        var latex = el.getAttribute("data-latex") || "";
        var isDisplay = el.classList.contains("fw-math-display");
        try {
          katex.render(latex, el, {
            throwOnError: false,
            displayMode: isDisplay,
            errorColor: "#a03340",
            strict: "ignore",
            trust: false,
            output: "htmlAndMathml"
          });
        } catch (err) {
          console.error("[math] render error for:", latex, err);
          el.textContent = latex;
          el.setAttribute("data-latex-fallback", "true");
        }
      });
    }).catch(function (err) {
      console.error("[math] load failed:", err);
    });
  }

  /** Pre-render placeholders in an HTML string to static KaTeX HTML. */
  function renderMathInHtml(html) {
    if (!html || html.indexOf("fw-math-") === -1) return Promise.resolve(html);
    var holder = document.createElement("div");
    holder.innerHTML = html;
    return renderMathInRoot(window, holder).then(function () {
      return holder.innerHTML;
    });
  }

  function katexCssLink() {
    return '<link rel="stylesheet" href="' + KATEX_BASE + 'katex.min.css">';
  }

  window.FlatWriteMath = {
    MATH_EXTENSIONS: MATH_EXTENSIONS,
    hasMathHeuristic: hasMathHeuristic,
    parseMarkdown: parseMarkdown,
    createMarkedWithMath: createMarkedWithMath,
    loadKatex: loadKatex,
    renderMathInRoot: renderMathInRoot,
    renderMathInHtml: renderMathInHtml,
    katexCssLink: katexCssLink,
    KATEX_BASE: KATEX_BASE
  };
})();
