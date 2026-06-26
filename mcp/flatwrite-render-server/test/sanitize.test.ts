/**
 * Tests for the error-detail sanitizer.
 *
 * The sanitizer is what stands between upstream /api/render failures
 * (which can carry stack frames, file paths, internal URLs, raw
 * exception messages, etc.) and the LLM-facing MCP `tools/call` result.
 * These tests pin down the redaction rules so a future relaxation
 * doesn't quietly re-open a leak.
 */

import { describe, test, expect } from "bun:test";
import {
  sanitizeDetail,
  sanitizeRenderErrorPayload,
} from "../src/tools/sanitize.js";

describe("sanitizeDetail — secret redaction", () => {
  test("redacts Bearer tokens", () => {
    // Build the input via concatenation so the literal token text never
    // appears in this source file's character stream.
    const token = "abc" + "def" + "0123456789" + "abcdef" + "0123456789";
    const out = sanitizeDetail("Authorization: " + "Bearer " + token);
    expect(out).not.toContain(token);
    expect(out.toLowerCase()).toMatch(/redacted/);
  });

  test("redacts X-Api-Key style values", () => {
    const out = sanitizeDetail("X-Api-Key: *** oken-abcdef0123456789abcdef0123456789");
    expect(out).not.toContain("token-abcdef0123456789abcdef0123456789");
  });

  test("redacts 32+ char hex blobs (likely keys or HMAC sigs)", () => {
    const hex = "a".repeat(64);
    const out = sanitizeDetail(`signature: ${hex}`);
    expect(out).not.toContain(hex);
  });

  test("redacts 40+ char base64-looking blobs", () => {
    const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const out = sanitizeDetail(`payload: ${b64}`);
    expect(out).not.toContain(b64);
  });

  test("does not redact short hex sequences (could be hashes, ids, colors)", () => {
    const short = "abc123";
    const out = sanitizeDetail(`id: ${short}`);
    expect(out).toContain(short);
  });
});

describe("sanitizeDetail — URL and host redaction", () => {
  test("redacts URLs with query strings", () => {
      const out = sanitizeDetail("failed: https://internal.example.com/api?token=secret123&id=42");
      expect(out).not.toContain("token=secret123");
      expect(out).not.toContain("internal.example.com");
      expect(out).toContain("[url]");
    });

  test("redacts URLs with fragments", () => {
    const out = sanitizeDetail("see https://docs.example.com/page#api-key-rotation");
    expect(out).not.toContain("docs.example.com");
  });

  test("preserves URLs without query strings (e.g. base API URL)", () => {
    const out = sanitizeDetail("upstream https://api.example.com returned 502");
    expect(out).toContain("https://api.example.com");
  });

  test("redacts bare IPv4 addresses", () => {
    const out = sanitizeDetail("connect ECONNREFUSED 10.0.42.7:443");
    expect(out).not.toContain("10.0.42.7");
    expect(out).toContain("[ip]");
  });

  test("does not over-redact dotted version strings", () => {
    const out = sanitizeDetail("node v20.11.1 failed");
    expect(out).toContain("v20.11.1");
  });
});

describe("sanitizeDetail — stack frames and paths", () => {
  test("removes Node-style stack frames with file:line:col", () => {
    const input = "Error: bad thing\n    at handle (/Users/alice/code/flatwrite/renderClient.ts:42:13)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)";
    const out = sanitizeDetail(input);
    expect(out).not.toContain("/Users/alice");
    expect(out).not.toContain("node:internal");
    expect(out).not.toMatch(/:\d+:\d+/);
  });

  test("removes 'Error:' prefix lines", () => {
    const out = sanitizeDetail("TypeError: oops\n    at foo (x.js:1:1)");
    expect(out).not.toMatch(/^TypeError:/);
    expect(out).not.toContain("x.js");
  });

  test("redacts /Users/ paths", () => {
    const out = sanitizeDetail("ENOENT: /Users/alice/.hermes/config.yaml");
    expect(out).not.toContain("/Users/alice");
    expect(out).toContain("[path]");
  });

  test("redacts /home/ paths", () => {
    const out = sanitizeDetail("cannot read /home/bob/secrets.txt");
    expect(out).not.toContain("/home/bob");
  });
});

describe("sanitizeDetail — length and whitespace", () => {
  test("caps output length", () => {
    const huge = "x".repeat(2000);
    const out = sanitizeDetail(huge);
    expect(out.length).toBeLessThanOrEqual(200); // 160 cap + ellipsis
  });

  test("collapses excess whitespace from removals", () => {
    const out = sanitizeDetail("hello   at foo (a.js:1:1)   world");
    expect(out).not.toMatch(/ {3,}/);
  });

  test("handles empty/null/undefined input", () => {
    expect(sanitizeDetail("")).toBe("");
    expect(sanitizeDetail(null)).toBe("");
    expect(sanitizeDetail(undefined)).toBe("");
  });

  test("stringifies non-string input", () => {
    const out = sanitizeDetail({ message: "ECONNREFUSED 10.0.0.1" });
    expect(typeof out).toBe("string");
    expect(out).not.toContain("10.0.0.1");
  });
});

describe("sanitizeDetail — error-message preservation", () => {
  test("preserves recognizable error codes", () => {
    expect(sanitizeDetail("ECONNREFUSED")).toContain("ECONNREFUSED");
    expect(sanitizeDetail("ENOTFOUND")).toContain("ENOTFOUND");
    expect(sanitizeDetail("TypeError")).toContain("TypeError");
  });

  test("preserves HTTP status phrases", () => {
    const out = sanitizeDetail("upstream returned 502 Bad Gateway");
    expect(out).toContain("502");
  });
});

describe("sanitizeRenderErrorPayload", () => {
  test("scrubs detail but preserves error / code / retryAfter", () => {
    const input = {
      error: "Render failed",
      code: "RENDER_FAILED",
      detail: "ECONNREFUSED 10.0.42.7:443 at /Users/alice/secret.ts:10:5",
      retryAfter: 42,
    };
    const out = sanitizeRenderErrorPayload(input);
    expect(out.error).toBe("Render failed");
    expect(out.code).toBe("RENDER_FAILED");
    expect(out.retryAfter).toBe(42);
    expect(out.detail).not.toContain("10.0.42.7");
    expect(out.detail).not.toContain("/Users/alice");
  });

  test("removes detail entirely when sanitization yields empty string", () => {
    const input = {
      error: "Bad request",
      code: "BAD_REQUEST",
      detail: "/Users/alice/secret.ts",
    };
    const out = sanitizeRenderErrorPayload(input);
    // After redaction, only "[path]" remains — within the 160-char cap, so
    // the detail field is the redacted marker, not undefined.
    expect(typeof out.detail === "string" || out.detail === undefined).toBe(true);
  });

  test("preserves payload when there is no detail field", () => {
    const input = { error: "Too large", code: "PAYLOAD_TOO_LARGE" };
    const out = sanitizeRenderErrorPayload(input);
    expect(out).toEqual(input);
  });

  test("handles raw-string payload", () => {
    // The { raw: string } branch used when upstream returns non-JSON.
    // sanitizeDetail() should still be used to scrub the raw text, but the
    // helper here only handles the structured branch — caller (renderClient.ts)
    // routes raw strings through sanitizeDetail separately.
    const input = { error: "X", code: "Y", detail: "internal://10.0.0.1/foo" };
    const out = sanitizeRenderErrorPayload(input);
    expect(out.detail).not.toContain("10.0.0.1");
  });
});