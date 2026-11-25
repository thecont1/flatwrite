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

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
const dns = require("dns");
const { EventEmitter } = require("events");

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

// ── Mock helpers ─────────────────────────────────────────────────────────

let ipCounter = 1;
function nextIp() {
  ipCounter = (ipCounter + 1) % 250;
  return "203.0.113." + ipCounter;
}

function mockReq({ method = "POST", headers = {}, body = null, ip } = {}) {
  const bodyStr = body === null ? "" : (typeof body === "string" ? body : JSON.stringify(body));
  const req = new EventEmitter();
  req.method = method;
  req.headers = Object.assign({}, headers);
  req.socket = { remoteAddress: ip || nextIp() };
  req.destroy = () => {};
  process.nextTick(() => {
    if (bodyStr) req.emit("data", bodyStr);
    req.emit("end");
  });
  return req;
}

function mockRes() {
  const res = { _status: 200, _headers: {}, _rawBody: null, _body: null };
  res.setHeader = (k, v) => { res._headers[k] = v; };
  res.end = (d) => {
    res._rawBody = d;
    if (typeof d === "string") {
      try { res._body = JSON.parse(d); } catch { res._body = d; }
    } else {
      res._body = d;
    }
    return res;
  };
  Object.defineProperty(res, "statusCode", {
    set(v) { res._status = v; },
    get() { return res._status; },
  });
  return res;
}

function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  return new TextEncoder().encode(String(input));
}

function streamBody(chunks) {
  const encoded = chunks.map(bytesOf);
  let index = 0;
  let cancelled = false;
  return {
    cancelled: () => cancelled,
    cancel() {
      cancelled = true;
      return Promise.resolve();
    },
    getReader() {
      return {
        read() {
          if (cancelled || index >= encoded.length) {
            return Promise.resolve({ done: true, value: undefined });
          }
          const value = encoded[index++];
          return Promise.resolve({ done: false, value });
        },
        cancel() {
          cancelled = true;
          return Promise.resolve();
        },
      };
    },
  };
}

function mockResponse({ status = 200, headers = {}, body = "", chunks = null } = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = value;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const value = normalized[String(name).toLowerCase()];
        return value === undefined ? null : value;
      },
    },
    body: chunks === null && body === null ? null : streamBody(chunks || [body]),
  };
}

function mockDocumentResponse(overrides = {}) {
  return mockResponse({
    status: 200,
    headers: { "content-type": "text/csv" },
    body: "col1,col2\na,1\n",
    ...overrides,
  });
}

function mockFetchHandler(fn) {
  global.fetch = fn;
}

function mockSimpleDocumentFetch(overrides = {}) {
  const calls = [];
  mockFetchHandler(async (url, opts) => {
    calls.push({ url: String(url), opts });
    return mockDocumentResponse(overrides);
  });
  return calls;
}

function mockPublicDns() {
  dns.promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
}

const REAL_FETCH = global.fetch;
const REAL_DNS_LOOKUP = dns.promises.lookup;
const REAL_DNS_RESOLVE4 = dns.promises.resolve4;
const REAL_DNS_RESOLVE6 = dns.promises.resolve6;

mockPublicDns();
const handler = require("../api/fetch-document.js");

async function invoke(body, options = {}) {
  const req = mockReq({ body, method: options.method || "POST", ip: options.ip, headers: options.headers || {} });
  const res = mockRes();
  await handler(req, res);
  return res;
}

beforeEach(() => {
  mockPublicDns();
});

afterEach(() => {
  global.fetch = REAL_FETCH;
  dns.promises.lookup = REAL_DNS_LOOKUP;
  dns.promises.resolve4 = REAL_DNS_RESOLVE4;
  dns.promises.resolve6 = REAL_DNS_RESOLVE6;
});

afterAll(() => {
  global.fetch = REAL_FETCH;
  dns.promises.lookup = REAL_DNS_LOOKUP;
  dns.promises.resolve4 = REAL_DNS_RESOLVE4;
  dns.promises.resolve6 = REAL_DNS_RESOLVE6;
});

describe("api/fetch-document.js", () => {
  test("valid URL to a CSV document → 200 binary passthrough with FlatWrite headers", async () => {
    mockPublicDns();
    const calls = mockSimpleDocumentFetch();
    const res = await invoke({ url: "https://example.com/data.csv" });

    expect(res._status).toBe(200);
    expect(res._headers["Content-Type"]).toBe("application/octet-stream");
    expect(res._headers["X-Flatwrite-Filename"]).toBe("data.csv");
    expect(res._headers["X-Flatwrite-Source-Url"]).toBe("https://example.com/data.csv");
    expect(res._headers["X-Flatwrite-Source-Content-Type"]).toBe("text/csv");
    expect(res._headers["Cache-Control"]).toBe("no-store");
    expect(Buffer.from(res._rawBody).toString()).toBe("col1,col2\na,1\n");
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.redirect).toBe("manual");
  });

  test("binary bytes pass through unchanged", async () => {
    mockPublicDns();
    const original = new Uint8Array([0, 1, 2, 127, 128, 159, 254, 255]);
    mockFetchHandler(async () => mockDocumentResponse({ chunks: [original] }));
    const res = await invoke({ url: "https://example.com/blob.pdf" });
    expect(res._status).toBe(200);
    expect(Array.from(Buffer.from(res._rawBody))).toEqual(Array.from(original));
  });

  test("filename header is URI-encoded when the path contains spaces/unicode", async () => {
    mockPublicDns();
    mockSimpleDocumentFetch();
    const res = await invoke({ url: "https://example.com/files/rapport%20fin%C3%A9.pdf" });
    expect(res._status).toBe(200);
    expect(res._headers["X-Flatwrite-Filename"]).toBe(encodeURIComponent("rapport finé.pdf"));
    expect(decodeURIComponent(res._headers["X-Flatwrite-Filename"])).toBe("rapport finé.pdf");
  });

  test("URL with no extension but supported MIME gets a synthetic filename", async () => {
    mockPublicDns();
    mockSimpleDocumentFetch({ headers: { "content-type": "application/pdf" }, body: "%PDF-1.4" });
    const res = await invoke({ url: "https://example.com/download" });
    expect(res._status).toBe(200);
    expect(res._headers["X-Flatwrite-Filename"]).toBe("document.pdf");
  });

  test("unknown MIME with no extension → 400", async () => {
    mockPublicDns();
    mockSimpleDocumentFetch({ headers: { "content-type": "application/octet-stream" }, body: "???" });
    const res = await invoke({ url: "https://example.com/unknown" });
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/filename or supported MIME/);
  });

  test("unsupported extension fails fast with 415", async () => {
    mockPublicDns();
    mockSimpleDocumentFetch({ headers: { "content-type": "application/octet-stream" }, body: "MZ" });
    const res = await invoke({ url: "https://example.com/program.exe" });
    expect(res._status).toBe(415);
    expect(res._body.error).toBe("unsupported extension '.exe'");
  });

  test("HTML content type → 415", async () => {
    mockPublicDns();
    mockSimpleDocumentFetch({ headers: { "content-type": "text/html; charset=utf-8" }, body: "<html></html>" });
    const res = await invoke({ url: "https://example.com/page" });
    expect(res._status).toBe(415);
    expect(res._body.error).toBe("This URL points to an HTML page. Only document files (PDF, DOCX, PPTX, XLSX, etc.) can be imported locally with AnyDoc.");
  });

  test("empty source response → 502", async () => {
    mockPublicDns();
    mockSimpleDocumentFetch({ body: "" });
    const res = await invoke({ url: "https://example.com/data.csv" });
    expect(res._status).toBe(502);
    expect(res._body.error).toBe("The URL returned an empty document.");
  });

  test("upstream 404 propagates as 404", async () => {
    mockPublicDns();
    mockSimpleDocumentFetch({ status: 404, body: "not here" });
    const res = await invoke({ url: "https://example.com/missing.pdf" });
    expect(res._status).toBe(404);
    expect(res._body.error).toBe("Source URL returned 404");
  });

  test("upstream non-200 response → 502 without leaking raw upstream body", async () => {
    mockPublicDns();
    mockSimpleDocumentFetch({ status: 500, headers: { "content-type": "text/html" }, body: "<html>secret internal error page</html>" });
    const res = await invoke({ url: "https://example.com/data.csv" });
    expect(res._status).toBe(502);
    expect(JSON.stringify(res._body)).not.toContain("secret internal error page");
  });

  test("upstream network failure (fetch throws) → 502 with sanitized message", async () => {
    mockPublicDns();
    mockFetchHandler(async () => { throw new Error("network down"); });
    const res = await invoke({ url: "https://example.com/data.csv" });
    expect(res._status).toBe(502);
    // Transport exceptions can embed internal detail, so the client gets a
    // stable public message that must not contain the thrown text.
    expect(res._body.error).toBe("Could not fetch the URL.");
    expect(JSON.stringify(res._body)).not.toContain("network down");
  });

  test("upstream timeout (AbortError) → 504", async () => {
    mockPublicDns();
    mockFetchHandler(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
    const res = await invoke({ url: "https://example.com/data.csv" });
    expect(res._status).toBe(504);
    expect(res._body.error).toMatch(/timed out/);
  });

  test("oversized document is rejected during streaming → 413", async () => {
    mockPublicDns();
    const oversized = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    mockFetchHandler(async () => mockDocumentResponse({ chunks: [oversized] }));
    const res = await invoke({ url: "https://example.com/data.csv" });
    expect(res._status).toBe(413);
    expect(res._body.error).toBe("Document is too large (25 MB max)");
  });

  test("Content-Length header exceeding cap → early 413", async () => {
    mockPublicDns();
    mockSimpleDocumentFetch({
      headers: { "content-type": "text/csv", "content-length": String(MAX_DOCUMENT_BYTES + 1) },
      body: "x",
    });
    const res = await invoke({ url: "https://example.com/data.csv" });
    expect(res._status).toBe(413);
  });

  test("relative redirect is followed, revalidated, and final URL/filename are emitted", async () => {
    mockPublicDns();
    const calls = [];
    mockFetchHandler(async (url) => {
      const u = String(url);
      calls.push(u);
      if (u === "https://example.com/start.pdf") {
        return mockResponse({ status: 302, headers: { location: "/files/final.pdf" }, body: null });
      }
      if (u === "https://example.com/files/final.pdf") {
        return mockDocumentResponse({ headers: { "content-type": "application/pdf" }, body: "%PDF-1.4" });
      }
      throw new Error("unexpected fetch " + u);
    });
    const res = await invoke({ url: "https://example.com/start.pdf" });
    expect(res._status).toBe(200);
    expect(calls).toEqual(["https://example.com/start.pdf", "https://example.com/files/final.pdf"]);
    expect(res._headers["X-Flatwrite-Source-Url"]).toBe("https://example.com/files/final.pdf");
    expect(res._headers["X-Flatwrite-Filename"]).toBe("final.pdf");
  });

  test("redirect chain to a private IP is blocked before the second fetch", async () => {
    mockPublicDns();
    const calls = [];
    mockFetchHandler(async (url) => {
      calls.push(String(url));
      return mockResponse({ status: 302, headers: { location: "http://127.0.0.1/admin.pdf" }, body: null });
    });
    const res = await invoke({ url: "https://example.com/start.pdf" });
    expect(res._status).toBe(400);
    expect(res._body.error).toBe("Private network addresses are not allowed");
    expect(calls).toEqual(["https://example.com/start.pdf"]);
  });

  test("redirect chain to a hostname resolving private is blocked", async () => {
    mockPublicDns();
    const calls = [];
    mockFetchHandler(async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return mockResponse({ status: 302, headers: { location: "https://rebind.example.com/doc.pdf" }, body: null });
      }
      return mockDocumentResponse();
    });
    dns.promises.lookup = async (hostname) => {
      if (hostname === "rebind.example.com") return [{ address: "10.1.2.3", family: 4 }];
      return [{ address: "93.184.216.34", family: 4 }];
    };
    const res = await invoke({ url: "https://example.com/start.pdf" });
    expect(res._status).toBe(400);
    expect(res._body.error).toBe("URL resolves to a private network address");
    expect(calls).toEqual(["https://example.com/start.pdf"]);
  });

  test("more than five redirect hops → 502", async () => {
    mockPublicDns();
    let count = 0;
    mockFetchHandler(async () => {
      count += 1;
      return mockResponse({ status: 302, headers: { location: "/hop-" + count + ".pdf" }, body: null });
    });
    const res = await invoke({ url: "https://example.com/start.pdf" });
    expect(res._status).toBe(502);
    expect(res._body.error).toBe("Source URL returned too many redirects");
    expect(count).toBe(6);
  });

  test("invalid URL → 400", async () => {
    mockPublicDns();
    const res = await invoke({ url: "not a url" });
    expect(res._status).toBe(400);
    expect(res._body.error).toBe("Invalid URL");
  });

  test("non-http(s) protocol → 400", async () => {
    mockPublicDns();
    const res = await invoke({ url: "ftp://example.com/file" });
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/http or https/);
  });

  test("localhost URL → 400", async () => {
    mockPublicDns();
    const res = await invoke({ url: "http://localhost:3000/secret" });
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/[Ll]ocalhost/);
  });

  test("private IPv4 literals → 400", async () => {
    mockPublicDns();
    for (const url of ["http://127.0.0.1/admin", "http://10.0.0.5/internal", "http://192.168.1.1/router"]) {
      const res = await invoke({ url });
      expect(res._status).toBe(400);
      expect(res._body.error).toMatch(/[Pp]rivate/);
    }
  });

  test("IPv6 loopback literal → 400", async () => {
    mockPublicDns();
    const res = await invoke({ url: "http://[::1]/admin.pdf" });
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/[Pp]rivate/);
  });

  test("hostname resolving (DNS rebinding) to a private IP → 400", async () => {
    dns.promises.lookup = async () => [{ address: "10.1.2.3", family: 4 }];
    const res = await invoke({ url: "https://rebind.example.com/page" });
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/private network/);
  });

  test("hostname with multiple A/AAAA records where any one is private → 400", async () => {
    dns.promises.lookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.1.2.3", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ];
    const res = await invoke({ url: "https://mixed.example.com/page" });
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/private network/);
  });

  test("Workers DNS fallback path uses resolve4/resolve6 when lookup is unimplemented", async () => {
    dns.promises.lookup = async () => {
      throw Object.assign(new Error("Not implemented"), { code: "ERR_NOT_IMPLEMENTED" });
    };
    dns.promises.resolve4 = async () => ["93.184.216.34"];
    dns.promises.resolve6 = async () => [];
    mockSimpleDocumentFetch();
    const res = await invoke({ url: "https://example.com/data.csv" });
    expect(res._status).toBe(200);
  });

  test("Workers DNS fallback rejects a private resolve4 result", async () => {
    dns.promises.lookup = async () => {
      throw Object.assign(new Error("Not implemented"), { code: "ERR_NOT_IMPLEMENTED" });
    };
    dns.promises.resolve4 = async () => ["10.0.0.8"];
    dns.promises.resolve6 = async () => [];
    const res = await invoke({ url: "https://example.com/data.csv" });
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/private network/);
  });

  test("GET method → 405", async () => {
    mockPublicDns();
    const res = await invoke(null, { method: "GET" });
    expect(res._status).toBe(405);
    expect(res._body).toMatchObject({ ok: false, error: "POST only" });
  });

  test("invalid JSON body → 400", async () => {
    mockPublicDns();
    const res = await invoke("not json");
    expect(res._status).toBe(400);
    expect(res._body.error).toBe("Invalid JSON");
  });

  test("missing url → 400", async () => {
    mockPublicDns();
    const res = await invoke({ method: "auto" });
    expect(res._status).toBe(400);
    expect(res._body.error).toBe("URL is required");
  });

  test("SSRF matrix: literal private/transition/transition-embedded targets are rejected before any fetch", async () => {
    // Counting fetch mock installed BEFORE any blocked invocation: the
    // rejection proof is not just the 400 but that zero fetch calls happen,
    // and the positive cases prove the mock itself is reachable.
    const fetchCalls = mockSimpleDocumentFetch();
    const blocked = [
      "http://127.0.0.1/a.pdf",
      "http://2130706433/a.pdf",        // decimal loopback — rejected by URL parse or resolution
      "http://0x7f000001/a.pdf",        // hex loopback
      "http://10.0.0.1/a.pdf",
      "http://169.254.169.254/a.pdf",   // link-local metadata
      "http://100.64.0.1/a.pdf",        // CGNAT
      "http://192.168.0.1/a.pdf",
      "http://224.0.0.1/a.pdf",         // multicast
      "http://240.0.0.1/a.pdf",         // reserved
      "http://192.0.0.1/a.pdf",         // protocol assignments
      "http://198.18.0.1/a.pdf",        // benchmarking
      "http://[::1]/a.pdf",
      "http://[::ffff:7f00:1]/a.pdf",   // hex IPv4-mapped loopback
      "http://[::ffff:127.0.0.1]/a.pdf",
      "http://[::7f00:1]/a.pdf",        // IPv4-compatible loopback
      "http://[64:ff9b::7f00:1]/a.pdf", // NAT64 loopback
      "http://[2002:7f00:1::]/a.pdf",   // 6to4 loopback
      "http://[fec0::1]/a.pdf",         // deprecated site-local
      "http://[ff02::1]/a.pdf",         // multicast v6
      "http://[fe80::1]/a.pdf",         // link-local
      "http://[febf::1]/a.pdf",         // link-local range end
      "http://[fc00::1]/a.pdf",         // ULA
    ];
    for (const url of blocked) {
      const res = await invoke({ url });
      expect(res._status).toBe(400);
    }
    expect(fetchCalls.length).toBe(0);
    // Public embeddings of the same transition forms must stay valid —
    // the guard rejects private targets, not the mechanisms themselves.
    // Literal IPs skip DNS, so they reach the same mock.
    for (const url of ["http://[::ffff:808:808]/a.pdf", "http://[64:ff9b::808:808]/a.pdf"]) {
      const res = await invoke({ url });
      expect(res._status).toBe(200);
    }
    expect(fetchCalls.length).toBe(2);
  });

  test("rate limit is enforced after 20 requests per IP", async () => {
    mockPublicDns();
    mockSimpleDocumentFetch();
    const ip = "198.51.100.5";
    const statuses = [];
    for (let i = 0; i < 21; i++) {
      const res = await invoke({ url: "https://example.com/data.csv" }, { ip });
      statuses.push(res._status);
    }
    // Each of the first 20 requests succeeds; only the 21st is rejected.
    // Asserting per-request catches regressions where earlier requests are
    // throttled or the cap drifts.
    expect(statuses.slice(0, 20)).toEqual(new Array(20).fill(200));
    expect(statuses[20]).toBe(429);
  });

  test("successful responses include rate-limit headers", async () => {
    mockPublicDns();
    mockSimpleDocumentFetch();
    const res = await invoke({ url: "https://example.com/data.csv" });
    expect(res._headers["X-RateLimit-Limit"]).toBe("20");
    expect(res._headers["X-RateLimit-Remaining"]).toMatch(/^\d+$/);
  });
});
