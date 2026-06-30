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
 * Tests for the markdown URL pre-flight validation in renderMarkdownFromUrl.ts.
 *
 * The validator mirrors the host allowlist enforced upstream by
 * api/render.js (`ALLOWED_MARKDOWN_HOSTS`). Keeping the check in the MCP
 * tool gives callers a structured failure immediately, without waiting
 * for a 502 roundtrip to /api/render.
 */

import { describe, test, expect } from "bun:test";
import {
  ALLOWED_MARKDOWN_HOSTS,
  validateMarkdownUrl,
} from "../src/tools/renderMarkdownFromUrl.js";

describe("validateMarkdownUrl", () => {
  test("accepts an https URL on an allowlisted host", () => {
    const r = validateMarkdownUrl(
      "https://raw.githubusercontent.com/thecont1/ngl-storyteller/main/README.md",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.host).toBe("raw.githubusercontent.com");
      expect(r.url).toContain("raw.githubusercontent.com");
    }
  });

  test("accepts http:// on an allowlisted host", () => {
    const r = validateMarkdownUrl("http://raw.githubusercontent.com/x/y/README.md");
    expect(r.ok).toBe(true);
  });

  test("accepts the other two allowlisted hosts", () => {
    for (const host of ["raw.gitlab.com", "bitbucket.org"]) {
      const r = validateMarkdownUrl(`https://${host}/x/y/README.md`);
      expect(r.ok).toBe(true);
    }
  });

  test("host match is case-insensitive (hostname lowercased)", () => {
    // raw.githubusercontent.com in mixed case — should be accepted.
    const r = validateMarkdownUrl("https://RAW.GITHUBUSERCONTENT.COM/x/y/README.md");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.host).toBe("raw.githubusercontent.com");
    }
  });

  test("rejects github.com (not raw.githubusercontent.com)", () => {
    const r = validateMarkdownUrl("https://github.com/thecont1/x/README.md");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("DISALLOWED_HOST");
      expect(r.host).toBe("github.com");
      expect(r.message).toContain("not on the markdown URL allowlist");
    }
  });

  test("rejects non-allowlisted hosts", () => {
    const cases = [
      "https://evil.com/x.md",
      "https://gist.githubusercontent.com/x/y.md",
      "https://gitlab.com/x/y.md",
      "https://example.com/x.md",
    ];
    for (const url of cases) {
      const r = validateMarkdownUrl(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("DISALLOWED_HOST");
    }
  });

  test("rejects non-http(s) schemes", () => {
    const cases = [
      "ftp://raw.githubusercontent.com/x/y",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/plain,hi",
    ];
    for (const url of cases) {
      const r = validateMarkdownUrl(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("UNSUPPORTED_SCHEME");
    }
  });

  test("rejects malformed URLs", () => {
    const cases = ["", "not a url", "raw.githubusercontent.com/x/y"];
    for (const url of cases) {
      const r = validateMarkdownUrl(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("INVALID_URL");
    }
  });
});

describe("ALLOWED_MARKDOWN_HOSTS registry", () => {
  test("contains exactly the three expected hosts", () => {
    expect([...ALLOWED_MARKDOWN_HOSTS].sort()).toEqual([
      "bitbucket.org",
      "raw.githubusercontent.com",
      "raw.gitlab.com",
    ]);
  });

  test("is in sync with api/render.js's ALLOWED_MARKDOWN_HOSTS", async () => {
    // Read the canonical source from the repo and assert the same names
    // appear in both. If this test ever fails, one side has drifted.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const canonicalPath = path.resolve(
      import.meta.dir,
      "..",
      "..",
      "..",
      "api",
      "render.js",
    );
    const src = fs.readFileSync(canonicalPath, "utf-8");
    const matches = [...src.matchAll(/'([a-z0-9.-]+\.[a-z]+)'/g)].map((m) => m[1]);
    const expectedHosts = matches.filter((h) =>
      h.endsWith("githubusercontent.com") ||
      h.endsWith("gitlab.com") ||
      h.endsWith("bitbucket.org")
    );
    expect([...ALLOWED_MARKDOWN_HOSTS].sort()).toEqual(expectedHosts.sort());
  });
});
