import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const SRC = readFileSync(resolve(import.meta.dir, "..", "app.js"), "utf-8");

/* ─── helpers ─────────────────────────────────────────────────────────── */

/** Return the body of the first function whose name matches `name`. */
function fnBody(name) {
  const re = new RegExp(
    `function\\s+${name}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\}`,
    "m"
  );
  const m = SRC.match(re);
  if (!m) throw new Error(`Could not extract function body for "${name}"`);
  return m[1];
}

/**
 * Check whether a function body references a CSS property.
 * Matches property names appearing inside CSS strings or comments.
 */
function bodyContainsCSSProp(body, prop) {
  const re = new RegExp(prop + "\\s*:", "i");
  return re.test(body);
}

/* ─── tests ───────────────────────────────────────────────────────────── */

describe("syncExportActionsTop", () => {
  const body = fnBody("syncExportActionsTop");

  test("computes position from the toolbar, not the animated content wrap", () => {
    expect(body).toContain("toolbar");
    expect(body).toContain("mainInner");
    expect(body).not.toContain("editorWrap");
    expect(body).not.toContain("previewWrap");
  });

  test("reads the flex rowGap from .main-inner", () => {
    expect(body).toContain("getComputedStyle");
    expect(body).toContain("rowGap");
    expect(body).toContain(".gap");
  });

  test("does not use paddingTop from .main-inner", () => {
    expect(body).not.toContain("paddingTop");
  });

  test("clears top on mobile viewports", () => {
    expect(body).toContain("innerWidth < 760");
    expect(body).toContain('style.top = ""');
  });
});

describe("exportHTML CSS parity with renderPreview", () => {
  const body = fnBody("exportHTML");

  test("uses dynamic font-size from sizeStep (15 * scale)", () => {
    expect(body).toContain("15 * scale");
    expect(body).toContain("font-size");
  });

  test("uses dynamic font-weight from weightStep", () => {
    expect(body).toContain("font-weight");
    expect(body).toMatch(/font-weight.*weight\b/);
  });

  test("uses dynamic lineHeight from lineStep", () => {
    expect(body).toContain("lineHeight");
    expect(body).toContain("line-height");
  });

  test("headings use headWeight (min of weight+200, 900)", () => {
    expect(body).toContain("headWeight");
    expect(body).toContain("Math.min(weight + 200, 900)");
  });

  test("heading sizes are proportional to base scale", () => {
    expect(body).toContain("15 * scale * 2");    // h1
    expect(body).toContain("15 * scale * 1.5");  // h2
    expect(body).toContain("15 * scale * 1.25"); // h3
    expect(body).toContain("15 * scale * 1.1");  // h4
  });

  test("code blocks use JetBrains Mono", () => {
    expect(body).toContain("JetBrains Mono");
  });

  test("sets * font-family with !important to override frameworks", () => {
    expect(body).toContain("font-family: ' + fontStack + ' !important");
  });

  test("includes base target=_blank for links", () => {
    expect(body).toContain('target="_blank"');
  });

  test("serialises and calls framework style function", () => {
    expect(body).toContain("styleFnStr");
    expect(body).toContain("styleFn(document)");
  });

  test("loads framework CSS and JS when available", () => {
    expect(body).toContain("fw.css");
    expect(body).toContain("fw.js");
  });

  for (const prop of ["table-layout", "border-left", "list-style-position",
                       "overflow-wrap", "white-space", "overflow-x"]) {
    test(`includes ${prop} (missing in old bare-bones export)`, () => {
      expect(bodyContainsCSSProp(body, prop)).toBe(true);
    });
  }
});

describe("exportPDF CSS parity with renderPreview", () => {
  const body = fnBody("exportPDF");

  test("uses dynamic font-size from sizeStep (15 * scale)", () => {
    expect(body).toContain("15 * scale");
    expect(body).toContain("font-size");
  });

  test("uses dynamic font-weight from weightStep", () => {
    expect(body).toContain("font-weight");
    expect(body).toMatch(/font-weight.*weight\b/);
  });

  test("uses dynamic lineHeight from lineStep", () => {
    expect(body).toContain("lineHeight");
    expect(body).toContain("line-height");
  });

  test("CSS scoped under .fw-pdf-export to prevent host-page bleed", () => {
    expect(body).toContain(".fw-pdf-export");
  });

  test("code blocks use JetBrains Mono", () => {
    expect(body).toContain("JetBrains Mono");
  });

  test("applies framework style function on a detached document", () => {
    expect(body).toContain("fw.style(tmpDoc)");
    expect(body).toContain("DOMParser");
    // Must NOT pass the live document — that rewrites host-page elements
    expect(body).not.toMatch(/fw\.style\(document\)/);
  });

  test("cleans up injected <style> on success and failure", () => {
    expect(body).toContain("removeChild(styleEl)");
    expect(body).toMatch(/styleEl\.parentNode.*removeChild/s);
  });

  test("keeps the export container off-screen while rendering", () => {
    expect(body).toContain("container.style.position");
    expect(body).toContain('"-9999px"');
  });

  for (const prop of ["table-layout", "border-left", "list-style-position",
                       "overflow-wrap", "white-space", "overflow-x"]) {
    test(`includes ${prop} (missing in old bare-bones export)`, () => {
      expect(bodyContainsCSSProp(body, prop)).toBe(true);
    });
  }
});

describe("preview ↔ export CSS selector inventory", () => {
  /**
   * Every CSS selector in renderPreview's <style> block should also appear
   * in exportHTML and exportPDF — otherwise a rule added to the preview
   * will be missing from the exported file.
   */
  const exportBody = fnBody("exportHTML");
  const pdfBody    = fnBody("exportPDF");

  const CSS_SELECTORS = [
    "*", "*::before", "*::after",
    "body",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "img",
    "pre", "code",
    "table", "td", "th",
    "blockquote",
    "ul", "ol", "li",
    "li > ul", "li > ol",
    "li::marker",
    "p", "br",
    ".fw-alert", ".fw-card", ".fw-card-header", ".fw-card-title",
    ".fw-card-body",
    ".fw-form label",
    ".fw-form input[type=text]", ".fw-form input[type=email]",
    ".fw-form textarea", ".fw-form select",
    ".fw-form button",
    ".fw-list", ".fw-list li",
  ];

  for (const sel of CSS_SELECTORS) {
    test(`"${sel}" present in exportHTML`, () => {
      expect(exportBody).toContain(sel);
    });

    test(`"${sel}" present in exportPDF (scoped)`, () => {
      const scoped = ".fw-pdf-export " + sel;
      const bare   = sel;
      expect(pdfBody.includes(scoped) || pdfBody.includes(bare)).toBe(true);
    });
  }
});
