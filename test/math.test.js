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
    expect(bracket).toContain("sum x");
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
