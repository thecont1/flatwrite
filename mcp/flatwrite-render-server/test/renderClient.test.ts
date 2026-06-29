/**
 * Tests for the public-style → canonical-style translation.
 *
 * The MCP server exposes a friendly PublicRenderStyle (fontFamily,
 * framework, pageSize, ...) which has to map onto the canonical
 * FlatWrite render frontmatter (font, appFramework, pageSize, ...)
 * — the same shape that the editor's buildShareYaml() writes into
 * shared-URL YAML and that the renderer's resolveRenderOptions()
 * reads.
 */

import { describe, test, expect } from "bun:test";
import {
  ALLOWED_FONT_FAMILIES,
  buildRawMarkdownBody,
  buildRemoteMarkdownBody,
  toCanonicalStyle,
} from "../src/renderClient.js";

describe("toCanonicalStyle — public → canonical translation", () => {
  test("translates fontFamily → font", () => {
    const out = toCanonicalStyle({ fontFamily: "Comfortaa" });
    expect(out.font).toBe("Comfortaa");
  });

  test("translates framework → appFramework", () => {
    const out = toCanonicalStyle({ framework: "spectre" });
    expect(out.appFramework).toBe("spectre");
  });

  test("forwards pageSize, orientation, marginsLR, marginsTB, footer, width, docEngine, surfaceMode, theme", () => {
    const publicStyle = {
      pageSize: "A3",
      orientation: "landscape",
      marginsLR: "wide",
      marginsTB: "narrow",
      footer: true,
      width: 890,
      docEngine: "none",
      surfaceMode: "doc",
      theme: "dark",
    };
    const out = toCanonicalStyle(publicStyle);
    expect(out).toMatchObject(publicStyle);
  });

  test("number-valued fontSize / fontWeight / lineHeight become absolute (fontSize/fontWeight/lineHeight)", () => {
    const out = toCanonicalStyle({
      fontSize: 17,
      fontWeight: 400,
      lineHeight: 1.6,
    });
    // Number values are interpreted as absolute pixel values; they map
    // to the canonical absolute-value fields, not the scale-index
    // fields. This keeps "fontSize: 13" meaning "13 pixels" and
    // "fontSize: \"1\"" meaning "scale step 1" (1.1x).
    expect(out.size).toBeUndefined();
    expect(out.fontSize).toBe(17);
    expect(out.weight).toBeUndefined();
    expect(out.fontWeight).toBe(400);
    expect(out.line).toBeUndefined();
    expect(out.lineHeight).toBe(1.6);
  });

  test("string-valued fontSize / fontWeight / lineHeight become scale indices (size/weight/line)", () => {
    const out = toCanonicalStyle({
      fontSize: "1",
      fontWeight: "0",
      lineHeight: "0",
    });
    // String values are interpreted as scale-token indices (matching the
    // editor's buildShareYaml() that writes "1" / "0" / "-1" etc.).
    expect(out.size).toBe("1");
    expect(out.fontSize).toBeUndefined();
    expect(out.weight).toBe("0");
    expect(out.fontWeight).toBeUndefined();
    expect(out.line).toBe("0");
    expect(out.lineHeight).toBeUndefined();
  });

  test("drops uiZoom (not consumed by canonical renderer)", () => {
    const out = toCanonicalStyle({ uiZoom: 1.2 });
    expect("zoom" in out).toBe(false);
    expect("uiZoom" in out).toBe(false);
  });

  test("empty input → empty output", () => {
    expect(toCanonicalStyle()).toEqual({});
    expect(toCanonicalStyle({})).toEqual({});
  });

  test("undefined values are stripped (no undefined keys leak through)", () => {
    const out = toCanonicalStyle({ fontFamily: "Inter", framework: undefined });
    expect("framework" in out).toBe(false);
    expect(out.font).toBe("Inter");
  });

  test("coerces numeric/boolean to strings when forwarding public aliases", () => {
    // fontFamily is exposed as string. If a caller passes a number we
    // stringify rather than crash.
    const out = toCanonicalStyle({ fontFamily: 123 as unknown as string });
    expect(out.font).toBe("123");
  });
});

describe("buildRawMarkdownBody — wires markdown + translated style", () => {
  test("forwards fontFamily as the canonical font key", () => {
    const body = buildRawMarkdownBody("# Hi", {
      fontFamily: "Comfortaa",
      pageSize: "A3",
      framework: "spectre",
    });
    expect(body.markdown).toBe("# Hi");
    expect(body.font).toBe("Comfortaa");
    expect(body.pageSize).toBe("A3");
    expect(body.appFramework).toBe("spectre");
  });

  test("does NOT leak the public alias fontFamily onto the wire", () => {
    // The renderer only reads canonical keys; sending both would be
    // harmless but noise. We choose to forward only the canonical form
    // so the wire format matches what the editor's YAML writes.
    const body = buildRawMarkdownBody("# Hi", { fontFamily: "Inter" });
    expect("fontFamily" in body).toBe(false);
    expect(body.font).toBe("Inter");
  });
});

describe("buildRemoteMarkdownBody — wires markdownUrl + translated style", () => {
  test("forwards url and translated style", () => {
    const body = buildRemoteMarkdownBody(
      "https://raw.githubusercontent.com/x/y/README.md",
      { fontFamily: "Comfortaa", pageSize: "A3" },
    );
    expect(body.markdownUrl).toBe("https://raw.githubusercontent.com/x/y/README.md");
    expect(body.font).toBe("Comfortaa");
    expect(body.pageSize).toBe("A3");
  });
});

describe("ALLOWED_FONT_FAMILIES — bundled inventory", () => {
  test("matches the canonical font inventory (8 families)", () => {
    expect([...ALLOWED_FONT_FAMILIES].sort()).toEqual([
      "Comfortaa",
      "Inter",
      "JetBrains Mono",
      "Lato",
      "Lora",
      "Merriweather",
      "Playfair Display",
      "Unbounded",
    ]);
  });

});
