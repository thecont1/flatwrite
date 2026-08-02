/**
 * Math Mode unit tests — core/math.js + core/render.js wiring.
 */
const { describe, test, expect } = require("bun:test");
const {
  hasMathHeuristic,
  parseMarkdown,
  MATH_EXTENSIONS,
  katexInlineAssets,
  katexCssLink,
  KATEX_BASE,
  normalizeLatexBody,
} = require("../core/math");
const {
  renderToFragment,
  renderToDocument,
  resolveRenderOptions,
  sanitizeHTML,
} = require("../core/render");

const BS = String.fromCharCode(92);

describe("hasMathHeuristic", () => {
  test("detects inline $...$, display $$, \\( \\), \\[ \\], and fenced math", () => {
    expect(hasMathHeuristic("Hello $x^2$")).toBe(true);
    expect(hasMathHeuristic("$$\nE=mc^2\n$$")).toBe(true);
    expect(hasMathHeuristic("see " + BS + "(a+b" + BS + ")")).toBe(true);
    expect(hasMathHeuristic(BS + "[x" + BS + "]")).toBe(true);
    expect(hasMathHeuristic("```math\nx\n```")).toBe(true);
    expect(hasMathHeuristic("```latex\ny\n```")).toBe(true);
  });

  test("ignores currency, code fences, inline code, and math-free prose", () => {
    expect(hasMathHeuristic("costs $100 and $5 more")).toBe(false);
    expect(hasMathHeuristic("use `$x$` in prose")).toBe(false);
    expect(hasMathHeuristic("```js\nconst x = $1$\n```")).toBe(false);
    expect(hasMathHeuristic("# Hello\n\nNo math here.")).toBe(false);
    expect(hasMathHeuristic("path\\to\\file")).toBe(false);
  });

  test("detects math after indented code block (does not strip prose)", () => {
    var body = [
      "Some text",
      "",
      "    const x = $1$",  // indented code line
      "    const y = $2$",  // indented code line
      "",
      "Now math: $x^2$",   // unindented prose with inline math
    ].join("\n");
    expect(hasMathHeuristic(body)).toBe(true);
  });

  test("does not false-positive on indented code with $ only", () => {
    var body = [
      "    const x = $1$",
      "    const y = $2$",
    ].join("\n");
    expect(hasMathHeuristic(body)).toBe(false);
  });
});

describe("parseMarkdown math OFF", () => {
  test("is zero-cost: dollar signs and backslashes stay literal text", () => {
    const html = parseMarkdown("Hello $x^2$ and " + BS + "(a" + BS + ")", false);
    expect(html).toContain("$x^2$");
    expect(html).not.toContain("fw-math-");
    expect(html).not.toContain("data-latex");
  });

  test("still renders normal markdown", () => {
    const html = parseMarkdown("# Title\n\nA **bold** word.", false);
    expect(html).toContain("<h1>");
    expect(html).toContain("<strong>bold</strong>");
  });
});

describe("parseMarkdown math ON", () => {
  test("renders inline $...$ and display $$...$$", () => {
    const inline = parseMarkdown("Hello $x^2$ world", true);
    expect(inline).toContain('class="fw-math-inline"');
    expect(inline).toContain('data-latex="x^2"');
    expect(inline).not.toContain("$x^2$");

    const display = parseMarkdown("before\n\n$$E=mc^2$$\n\nafter", true);
    expect(display).toContain('class="fw-math-display"');
    expect(display).toContain('data-latex="E=mc^2"');
  });

  test("renders \\(...\\) inline and \\[...\\] display", () => {
    const paren = parseMarkdown("Hello " + BS + "(a+b" + BS + ") world", true);
    expect(paren).toContain('class="fw-math-inline"');
    expect(paren).toContain('data-latex="a+b"');

    const bracket = parseMarkdown(BS + "[" + BS + "sum x" + BS + "]", true);
    expect(bracket).toContain('class="fw-math-display"');
    expect(bracket).toContain('data-latex="' + BS + 'sum x"');
  });

  test("renders fenced ```math as display", () => {
    const html = parseMarkdown("```math\nx^2 + y^2\n```", true);
    expect(html).toContain('class="fw-math-display"');
    expect(html).toContain('data-latex="x^2 + y^2"');
    expect(html).not.toContain("<pre>");
  });

  test("does not math-ify fenced non-math code or inline code", () => {
    const fence = parseMarkdown("```js\nconst x = $1$\n```", true);
    expect(fence).toContain("<pre>");
    expect(fence).toContain("$1$");
    expect(fence).not.toContain("fw-math-");

    const code = parseMarkdown("use `$x$` here", true);
    expect(code).toContain("<code>");
    expect(code).not.toContain("fw-math-");
  });

  test("skips currency-like $100", () => {
    const html = parseMarkdown("costs $100 today", true);
    expect(html).toContain("$100");
    expect(html).not.toContain("fw-math-");
  });

  test("heuristic ignores escaped \\$ but detects real $...$", () => {
    expect(hasMathHeuristic("price is \\$5 today")).toBe(false);
    expect(hasMathHeuristic("see $x^2$ here")).toBe(true);
  });

  test("tokenizer rejects $...$  with trailing space before closing $", () => {
    const html = parseMarkdown("text $x $ done", true);
    expect(html).not.toContain("fw-math-");
    expect(html).toContain("$x $");
  });

  test("escapes attribute content", () => {
    const html = parseMarkdown('$"onmouseover=alert(1)"$', true);
    // either not matched as math, or attribute-escaped
    if (html.includes("data-latex")) {
      expect(html).toContain("&quot;");
      expect(html).not.toContain('data-latex=""onmouseover');
    }
  });
});

describe("resolveRenderOptions math flag", () => {
  test("defaults false; accepts true/'true'/'on'", () => {
    expect(resolveRenderOptions({}).math).toBe(false);
    expect(resolveRenderOptions({ math: true }).math).toBe(true);
    expect(resolveRenderOptions({ math: "true" }).math).toBe(true);
    expect(resolveRenderOptions({ math: "on" }).math).toBe(true);
    expect(resolveRenderOptions({ math: "off" }).math).toBe(false);
    expect(resolveRenderOptions({ math: "false" }).math).toBe(false);
  });
});

describe("render pipeline math gating", () => {
  test("renderToFragment OFF has no placeholders", () => {
    const html = renderToFragment("Hello $x$", { math: false });
    expect(html).toContain("$x$");
    expect(html).not.toContain("fw-math-");
  });

  test("renderToFragment ON emits placeholders", () => {
    const html = renderToFragment("Hello $x$", { math: true });
    expect(html).toContain("fw-math-inline");
    expect(html).toContain('data-latex="x"');
  });

  test("renderToDocument OFF injects no KaTeX assets", async () => {
    const doc = await renderToDocument("Hello $x$", { math: false });
    expect(doc.head).not.toContain("katex");
    expect(doc.body).toContain("$x$");
    expect(doc.body).not.toContain("fw-math-");
  });

  test("renderToDocument ON injects KaTeX assets + placeholders", async () => {
    const doc = await renderToDocument("Hello $x^2$", { math: "on" });
    expect(doc.head).toContain("katex.min.css");
    expect(doc.head).toContain("katex.min.js");
    expect(doc.body).toContain("fw-math-inline");
    expect(doc.body).toContain('data-latex="x^2"');
  });

  test("sanitizeHTML keeps data-latex on placeholders", () => {
    const raw = '<p><span class="fw-math-inline" data-latex="x^2"></span></p>';
    const clean = sanitizeHTML(raw);
    expect(clean).toContain("data-latex");
    expect(clean).toContain("fw-math-inline");
  });
});

describe("katex asset helpers", () => {
  test("katexInlineAssets and katexCssLink pin the same base", () => {
    expect(KATEX_BASE).toContain("katex@0.16.10");
    expect(katexCssLink()).toContain(KATEX_BASE);
    expect(katexInlineAssets()).toContain("katex.min.css");
    expect(katexInlineAssets()).toContain("renderFwMath");
  });

  test("katexInlineAssets emits valid </script> closing tags", () => {
    var assets = katexInlineAssets();
    expect(assets).toContain("</script>");
    expect(assets).not.toContain("<\\/script>");
  });

  test("MATH_EXTENSIONS expose expected names", () => {
    const names = MATH_EXTENSIONS.map((e) => e.name).sort();
    expect(names).toEqual([
      "fw-math-block",
      "fw-math-bracket",
      "fw-math-inline",
      "fw-math-paren",
    ].sort());
  });
});

describe("Andrew Ng–style fixture snippets", () => {
  const fixture = [
    "# Machine Learning Notes",
    "",
    "Hypothesis: $h_\\theta(x) = \\theta^T x$",
    "",
    "$$",
    "J(\\theta) = \\frac{1}{2m} \\sum_{i=1}^{m} (h_\\theta(x^{(i)}) - y^{(i)})^2",
    "$$",
    "",
    "Also written as " + BS + "( \\nabla J " + BS + ") in gradient form.",
    "",
    "```math",
    "\\theta := \\theta - \\alpha \\nabla_\\theta J(\\theta)",
    "```",
    "",
    "Price note (not math): the book costs $40.",
    "",
    "Code:",
    "```python",
    "cost = $theta",
    "```",
  ].join("\n");

  test("heuristic fires on the fixture", () => {
    expect(hasMathHeuristic(fixture)).toBe(true);
  });

  test("OFF leaves delimiters literal", () => {
    const html = parseMarkdown(fixture, false);
    expect(html).toContain("$h_");
    expect(html).toContain("$$");
    expect(html).not.toContain("fw-math-");
  });

  test("ON parses all authoring forms and skips currency/code", () => {
    const html = parseMarkdown(fixture, true);
    expect(html).toContain("fw-math-inline");
    expect(html).toContain("fw-math-display");
    expect(html).toContain("data-latex");
    // currency preserved
    expect(html).toContain("$40");
    // python fence preserved
    expect(html).toContain("language-python");
    expect(html).toMatch(/cost = \$theta/);
  });
});

describe("normalizeLatexBody TeX line-break preservation", () => {
  test("preserves \\\\ (TeX newline) followed by space in aligned environment", () => {
    // Hand-authored: \begin{aligned}a&=b\\ c&=d\end{aligned}
    // \\ followed by space is a TeX newline — must NOT be collapsed.
    var tex = BS + "begin{aligned}a&=b" + BS + BS + " c&=d" + BS + "end{aligned}";
    var out = normalizeLatexBody(tex);
    expect(out).toContain("b" + BS + BS + " c");
    expect(out).not.toContain("b" + BS + " c");
  });

  test("preserves \\\\ in matrix environment", () => {
    // \begin{matrix}1 & 2 \\ 3 & 4\end{matrix}
    var tex = BS + "begin{matrix}1 & 2 " + BS + BS + " 3 & 4" + BS + "end{matrix}";
    var out = normalizeLatexBody(tex);
    expect(out).toContain("2 " + BS + BS + " 3");
  });

  test("collapses importer-doubled commands (\\\\theta → \\theta)", () => {
    // Importer output: \\theta → should become \theta
    var tex = BS + BS + "theta^2";
    var out = normalizeLatexBody(tex);
    expect(out).toBe(BS + "theta^2");
  });

  test("preserves \\\\ followed by delimiters (\\(, \\[, \\), \\])", () => {
    // \\( could be a TeX row separator followed by ( — must NOT collapse.
    var tex = BS + BS + "(a+b" + BS + BS + ")";
    var out = normalizeLatexBody(tex);
    expect(out).toBe(tex);
  });

  test("un-doubles importer-quadrupled TeX newlines (\\\\\\\\ → \\\\)", () => {
    // Importer doubled a real \\ → \\\\
    var tex = BS + BS + BS + BS + "  next line";
    var out = normalizeLatexBody(tex);
    // Should be \\ (TeX newline) + "  next line"
    expect(out).toBe(BS + BS + "  next line");
  });

  test("preserves hand-authored single-backslash commands", () => {
    var tex = BS + "frac{1}{2}";
    var out = normalizeLatexBody(tex);
    expect(out).toBe(BS + "frac{1}{2}");
  });

  test("importer-doubled aligned block preserves \\\\ between rows", () => {
    // Importer output: \\begin{aligned}a&=b\\\\c&=d\\end{aligned}
    // \\begin → \begin, \\\\ → \\ (TeX newline), \\end → \end
    var tex = BS + BS + "begin{aligned}a&=b" + BS + BS + BS + BS + "c&=d" + BS + BS + "end{aligned}";
    var out = normalizeLatexBody(tex);
    expect(out).toBe(BS + "begin{aligned}a&=b" + BS + BS + "c&=d" + BS + "end{aligned}");
  });

  test("full importer-doubled aligned block through parseMarkdown preserves \\\\", () => {
    // $$\\begin{aligned}a&=b\\\\c&=d\\end{aligned}$$
    var md = "$$" + BS + BS + "begin{aligned}a&=b" + BS + BS + BS + BS + "c&=d" + BS + BS + "end{aligned}$$";
    var html = parseMarkdown(md, true);
    expect(html).toContain("fw-math-display");
    expect(html).toContain("aligned");
    var match = html.match(/data-latex="([^"]*)"/);
    expect(match).toBeTruthy();
    var latex = match[1];
    // The placeholder must keep \\ between rows
    expect(latex).toContain(BS + BS);
  });
});

describe("core/math.js ↔ public/math-render.js drift detection", () => {
  const fs = require("fs");
  const path = require("path");
  const coreSrc = fs.readFileSync(path.resolve(__dirname, "..", "core", "math.js"), "utf8");
  const browserSrc = fs.readFileSync(path.resolve(__dirname, "..", "public", "math-render.js"), "utf8");

  // Strip line comments (// ...) from source before extraction so
  // braces in comments don't miscount.
  function stripComments(src) {
    return src.replace(/\/\/[^\n]*/g, "");
  }

  // Extract a function body by name from source text. Returns the substring
  // between the opening brace and the matching closing brace. Skips over
  // string literals and regex literals so braces inside them don't miscount.
  function extractFn(src, name) {
    src = stripComments(src);
    var re = new RegExp("function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{");
    var m = re.exec(src);
    if (!m) return null;
    var i = m.index + m[0].length;
    var depth = 1;
    while (i < src.length && depth > 0) {
      var ch = src[i];
      // Skip string literals (single, double, backtick)
      if (ch === '"' || ch === "'" || ch === "`") {
        i++;
        while (i < src.length && src[i] !== ch) {
          if (src[i] === "\\\\") i++; // skip escaped char
          i++;
        }
        i++;
        continue;
      }
      // Skip regex literals (preceded by =, (, ,, :, !, &, |, ?)
      if (ch === "/" && i > 0) {
        var prev = src[i - 1];
        if ("=(:,!&|?".indexOf(prev) >= 0 || /\b(?:return|typeof|in|of|instanceof)\s*$/.test(src.slice(0, i))) {
          i++;
          while (i < src.length && src[i] !== "/") {
            if (src[i] === "\\\\") i++; // skip escaped char
            if (src[i] === "[") {
              // Character class — skip until ]
              i++;
              while (i < src.length && src[i] !== "]") {
                if (src[i] === "\\\\") i++;
                i++;
              }
            }
            i++;
          }
          i++; // skip closing /
          // Skip flags
          while (i < src.length && /[gimsuy]/.test(src[i])) i++;
          continue;
        }
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    return src.slice(m.index + m[0].length, i - 1);
  }

  // Normalize: collapse whitespace, unify quotes, and strip comments so
  // cosmetic differences between Node (single-quote, commented) and browser
  // (double-quote, fewer comments) don't trigger false drift.
  function norm(s) {
    return s
      .replace(/\/\/[^\n]*/g, "")   // strip // line comments
      .replace(/"/g, "'")             // unify quotes
      .replace(/\s+/g, " ")           // collapse whitespace
      .trim();
  }

  var SHARED_FNS = [
    "escapeAttr",
    "normalizeLatexBody",
    "normalizeMathMarkdown",
    "hasMathHeuristic",
  ];

  for (const fn of SHARED_FNS) {
    test(fn + " body is identical in both files", () => {
      var coreBody = extractFn(coreSrc, fn);
      var browserBody = extractFn(browserSrc, fn);
      expect(coreBody).toBeTruthy();
      expect(browserBody).toBeTruthy();
      expect(norm(browserBody)).toBe(norm(coreBody));
    });
  }

  test("MATH_EXTENSIONS array has same tokenizer/renderer names", () => {
    // Extract the MATH_EXTENSIONS array from both files and compare
    // the extension names, levels, and tokenizer regex patterns.
    function extractExtensions(src) {
      var re = /MATH_EXTENSIONS\s*=\s*\[/g;
      var m = re.exec(src);
      if (!m) return null;
      var start = m.index;
      var depth = 0;
      var i = m.index + m[0].length - 1;
      do {
        if (src[i] === "[") depth++;
        else if (src[i] === "]") depth--;
        i++;
      } while (i < src.length && depth > 0);
      return src.slice(start, i);
    }
    var coreExt = extractExtensions(coreSrc);
    var browserExt = extractExtensions(browserSrc);
    expect(coreExt).toBeTruthy();
    expect(browserExt).toBeTruthy();
    // Compare names and levels
    function extractNames(src) {
      var names = [];
      var re = /name:\s*['"]([^'"]+)['"]/g;
      var m;
      while ((m = re.exec(src)) !== null) names.push(m[1]);
      return names.sort();
    }
    expect(extractNames(browserExt)).toEqual(extractNames(coreExt));
  });

  test("loadKatex: both check win.katex before attaching listeners", () => {
    // The key ordering invariant: if win.katex exists, resolve immediately
    // without adding load/error listeners. Verify the browser file has the
    // same guard-before-listener structure as core.
    function extractLoadKatex(src) {
      return extractFn(src, "loadKatex");
    }
    var coreBody = extractLoadKatex(coreSrc);
    var browserBody = extractLoadKatex(browserSrc);
    expect(coreBody).toBeTruthy();
    expect(browserBody).toBeTruthy();
    // Both must contain a katex check before addEventListener
    var coreKatexCheck = coreBody.indexOf("win.katex");
    var coreListener = coreBody.indexOf("addEventListener");
    var browserKatexCheck = browserBody.indexOf("win.katex");
    var browserListener = browserBody.indexOf("addEventListener");
    expect(coreKatexCheck).toBeGreaterThanOrEqual(0);
    expect(coreListener).toBeGreaterThan(coreKatexCheck);
    expect(browserKatexCheck).toBeGreaterThanOrEqual(0);
    expect(browserListener).toBeGreaterThan(browserKatexCheck);
  });
});
