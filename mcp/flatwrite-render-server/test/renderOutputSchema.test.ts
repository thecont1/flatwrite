/**
 * flatwrite.md - Minimalist Markdown Editor
 *
 * Copyright (C) 2026 Mahesh Shantaram
 * Sole Proprietary Owner. All Rights Reserved.
 *
 * This file is part of flatwrite.md.
 * flatwrite.md is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * For commercial, closed-source embedding, and SaaS deployment exemptions,
 * a valid Commercial License Agreement is required. Contact: sales@flatwrite.md
 */

/**
 * Tests for renderOutputSchema.ts's buildRenderEnvelope helper and
 * mcpShared.ts's generateManifest sentinel guard.
 *
 * buildRenderEnvelope is the single source of envelope-construction
 * logic used by renderMarkdown.ts, renderMarkdownFromUrl.ts, and
 * streamableHttpServer.ts — keeping it tested at the helper level
 * means we can change the upstream callers without re-asserting the
 * envelope shape.
 *
 * generateManifest's sentinel guard is exercised against the compiled
 * dist/ artefact (the same path build-manifest.mjs uses) so the test
 * reflects the actual runtime contract rather than the source-only one.
 */

import { describe, test, expect } from "bun:test";
import {
  buildRenderEnvelope,
  RenderOutputSchema,
} from "../src/shared/renderOutputSchema.js";

const FAKE_RESULT = { head: "<style>/* mock */</style>", body: "<h1>x</h1>" };

describe("buildRenderEnvelope", () => {
  test("URL path (no markdownSource) zeroes metadata", () => {
    const env = buildRenderEnvelope(FAKE_RESULT);
    expect(env.ok).toBe(true);
    expect(env.kind).toBe("html");
    expect(env.document).toEqual({ title: "", wordCount: 0, charCount: 0 });
    expect(env.artifacts).toEqual(FAKE_RESULT);
    expect(env.warnings).toEqual([]);
  });

  test("inline H1 is extracted and trimmed", () => {
    const md = "#   Hello World  \n\nbody";
    const env = buildRenderEnvelope(FAKE_RESULT, md);
    expect(env.document?.title).toBe("Hello World");
    expect(env.document?.wordCount).toBe(4);
    expect(env.document?.charCount).toBe(md.length);
  });

  test("inline path without H1 leaves title empty", () => {
    const env = buildRenderEnvelope(FAKE_RESULT, "no heading here\njust text");
    expect(env.document?.title).toBe("");
  });

  test("H1 inside a fenced code block is ignored", () => {
    const md = "```\n# not a title\n```\n\n# Real Title";
    const env = buildRenderEnvelope(FAKE_RESULT, md);
    expect(env.document?.title).toBe("Real Title");
  });

  test("H1 inside a tilde-fenced code block is ignored", () => {
    const md = "~~~\n# not a title\n~~~\n\n# Real Title";
    const env = buildRenderEnvelope(FAKE_RESULT, md);
    expect(env.document?.title).toBe("Real Title");
  });

  test("H1 inside inline backticks is ignored", () => {
    const md = "Use `# fake` syntax\n\n# Real Title";
    const env = buildRenderEnvelope(FAKE_RESULT, md);
    expect(env.document?.title).toBe("Real Title");
  });

  test("word/char counting on whitespace-padded input", () => {
    const md = "   one two three   \n\n  four  ";
    const env = buildRenderEnvelope(FAKE_RESULT, md);
    expect(env.document?.wordCount).toBe(4);
    expect(env.document?.charCount).toBe(md.length);
  });

  test("word/char counting includes text inside code fences", () => {
    const md = "# Real\n\n```\n# fake\nmore fake\n```";
    const env = buildRenderEnvelope(FAKE_RESULT, md);
    expect(env.document?.title).toBe("Real");
    // wordCount/charCount are derived from the original markdown
    expect(env.document?.wordCount).toBeGreaterThan(0);
    expect(env.document?.charCount).toBe(md.length);
  });

  test("empty / undefined markdown is safe, metadata zeros", () => {
    for (const md of ["", undefined, null, "   \n\n  "]) {
      const env = buildRenderEnvelope(FAKE_RESULT, md as string | undefined);
      expect(env.ok).toBe(true);
      expect(env.document?.title).toBe("");
      // charCount is always the length of the original markdownSource string
      expect(env.document?.charCount).toBe((md ?? "").length);
      expect(env.document?.wordCount).toBe(0);
    }
  });

  test("returned envelope validates against RenderOutputSchema", () => {
    const env = buildRenderEnvelope(FAKE_RESULT, "# Heading\n\nbody");
    expect(() => RenderOutputSchema.parse(env)).not.toThrow();
  });
});

describe("generateManifest — sentinel guard", () => {
  test("throws when tool.outputSchema is a sentinel Symbol", async () => {
    // Load the compiled module the same way build-manifest.mjs does.
    // Going through dist/ ensures the test exercises the actual
    // exported code rather than a re-evaluated source copy.
    const path = await import("node:path");
    const distShared = path.resolve(
      import.meta.dir,
      "..",
      "dist",
      "shared",
      "mcpShared.js",
    );
    const { generateManifest, HANDLER_DOCS } = await import(distShared);
    const FAKE_SENTINEL = Symbol("FAKE_SENTINEL");
    const tools = [
      {
        name: "fake_tool",
        description: "A tool whose outputSchema is a sentinel that wasn't injected.",
        surfaceMode: "doc",
        category: "discovery",
        inputFields: [],
        requiredFields: [],
        outputSchema: FAKE_SENTINEL,
        annotations: { readOnlyHint: true },
        displayHints: { inputFieldAliases: {} },
      },
    ];
    expect(() => generateManifest("doc", tools, [HANDLER_DOCS])).toThrow(
      /fake_tool/,
    );
    expect(() => generateManifest("doc", tools, [HANDLER_DOCS])).toThrow(
      /inject/,
    );
  });
});

/**
 * PR-B: unit tests for the 5 Zod schemas that replaced the
 * hand-written output-schema constants. Each `describe` block
 * verifies (a) the schema accepts a canonical happy-path literal,
 * (b) the schema rejects malformed input. Envelopes are
 * constructed inline — no builder helpers, since the schema's
 * `.parse()` is what we're asserting against.
 */

import { RenderOptionsOutputSchema } from "../src/shared/renderOptionsOutputSchema.js";
import { RenderPreviewOutputSchema } from "../src/shared/renderPreviewOutputSchema.js";
import { ExportHtmlOutputSchema } from "../src/shared/exportHtmlOutputSchema.js";
import { ExportPdfOutputSchema } from "../src/shared/exportPdfOutputSchema.js";
import { ShareLinkOutputSchema } from "../src/shared/shareLinkOutputSchema.js";

describe("RenderOptionsOutputSchema", () => {
  test("accepts the canonical envelope shape", () => {
    const env = {
      ok: true,
      options: {
        fonts: ["Inter"],
        frameworks: ["spectre"],
        docEngines: ["none"],
        pageSizes: ["A4"],
        orientations: ["portrait"],
        margins: ["normal"],
        surfaceModes: ["doc"],
      },
      defaults: {
        font: "Inter",
        docEngine: "none",
        surfaceMode: "doc",
        pageSize: "A4",
        orientation: "portrait",
      },
    };
    expect(env.ok).toBe(true);
    expect(env.options.fonts.length).toBeGreaterThan(0);
    expect(env.options.frameworks).toContain("spectre");
    expect(() => RenderOptionsOutputSchema.parse(env)).not.toThrow();
  });

  test("omitted defaults block still parses", () => {
    const env = {
      ok: true,
      options: {
        fonts: ["Inter"],
        frameworks: ["spectre"],
        docEngines: ["none"],
        pageSizes: ["A4"],
        orientations: ["portrait"],
        margins: ["normal"],
        surfaceModes: ["doc"],
      },
    };
    expect(() => RenderOptionsOutputSchema.parse(env)).not.toThrow();
  });

  test("rejects missing required `options` block", () => {
    expect(() =>
      RenderOptionsOutputSchema.parse({ ok: true }),
    ).toThrow();
  });
});

describe("RenderPreviewOutputSchema", () => {
  test("accepts canonical envelope", () => {
    const env = { ok: true, kind: "preview", documentId: "doc-1" };
    expect(env.ok).toBe(true);
    expect(env.kind).toBe("preview");
    expect(env.documentId).toBe("doc-1");
    expect(() => RenderPreviewOutputSchema.parse(env)).not.toThrow();
  });

  test("omitted documentId and warnings still parse", () => {
    const env = { ok: true, kind: "preview" };
    expect(() => RenderPreviewOutputSchema.parse(env)).not.toThrow();
  });

  test("rejects wrong kind literal", () => {
    expect(() =>
      RenderPreviewOutputSchema.parse({ ok: true, kind: "html" }),
    ).toThrow();
  });
});

describe("ExportHtmlOutputSchema", () => {
  test("accepts canonical envelope", () => {
    const env = {
      ok: true,
      documentId: "doc-1",
      format: "html",
      downloadUrl: "blob:abc",
    };
    expect(env.ok).toBe(true);
    expect(env.format).toBe("html");
    expect(env.documentId).toBe("doc-1");
    expect(env.downloadUrl).toBe("blob:abc");
    expect(() => ExportHtmlOutputSchema.parse(env)).not.toThrow();
  });

  test("omitted downloadUrl and warnings still parse", () => {
    const env = { ok: true, documentId: "doc-1", format: "html" };
    expect(() => ExportHtmlOutputSchema.parse(env)).not.toThrow();
  });

  test("rejects wrong format literal", () => {
    expect(() =>
      ExportHtmlOutputSchema.parse({
        ok: true,
        documentId: "doc-1",
        format: "pdf",
      }),
    ).toThrow();
  });
});

describe("ExportPdfOutputSchema", () => {
  test("accepts canonical envelope", () => {
    const env = { ok: true, documentId: "doc-1", format: "pdf", pageCount: 5 };
    expect(env.ok).toBe(true);
    expect(env.format).toBe("pdf");
    expect(env.pageCount).toBe(5);
    expect(() => ExportPdfOutputSchema.parse(env)).not.toThrow();
  });

  test("omitted pageCount and warnings still parse", () => {
    const env = { ok: true, documentId: "doc-1", format: "pdf" };
    expect(() => ExportPdfOutputSchema.parse(env)).not.toThrow();
  });

  test("rejects wrong format literal", () => {
    expect(() =>
      ExportPdfOutputSchema.parse({
        ok: true,
        documentId: "doc-1",
        format: "html",
      }),
    ).toThrow();
  });
});

describe("ShareLinkOutputSchema", () => {
  test("accepts canonical envelope", () => {
    const env = {
      ok: true,
      documentId: "doc-1",
      shareUrl: "https://flatwrite.md/s/abc",
      expiresAt: "2026-08-01T00:00:00Z",
    };
    expect(env.ok).toBe(true);
    expect(env.shareUrl).toContain("flatwrite.md");
    expect(env.expiresAt).toBe("2026-08-01T00:00:00Z");
    expect(() => ShareLinkOutputSchema.parse(env)).not.toThrow();
  });

  test("omitted expiresAt still parses", () => {
    const env = {
      ok: true,
      documentId: "doc-1",
      shareUrl: "https://flatwrite.md/s/abc",
    };
    expect(() => ShareLinkOutputSchema.parse(env)).not.toThrow();
  });

  test("rejects missing shareUrl", () => {
    expect(() =>
      ShareLinkOutputSchema.parse({ ok: true, documentId: "doc-1" }),
    ).toThrow();
  });
});