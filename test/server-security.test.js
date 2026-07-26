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

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PORT = 39841;
const BASE = `http://localhost:${PORT}`;
const FIXTURE = "shared-mini.md";

let proc = null;

function spawnServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("node", ["public/server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(PORT),
        NODE_ENV: "",
        FW_STUB_SHARES: "",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error(
        "server didn't print 'Server running at' within 10s. Got: " + buf
      ));
    }, 10000);
    p.stdout.on("data", (c) => {
      buf += c.toString();
      if (buf.includes("Server running at")) {
        clearTimeout(timer);
        resolve(p);
      }
    });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.stderr.on("data", (c) => { process.stderr.write("[server] " + c.toString()); });
  });
}

async function killServer(p) {
  if (!p || p.killed) return;
  return new Promise((resolve) => {
    p.on("exit", resolve);
    try { p.kill("SIGTERM"); } catch { resolve(); }
    setTimeout(() => { try { p.kill("SIGKILL"); } catch {} resolve(); }, 1500);
  });
}

async function waitUntilReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.status === 200) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server didn't become ready on " + BASE);
}

beforeAll(async () => {
  proc = await spawnServer({ FW_STUB_SHARES: "1" });
  await waitUntilReady();
});

afterAll(async () => {
  await killServer(proc);
  proc = null;
});

describe("/api/s hardening", () => {
  test("serves a fixture with a valid key", async () => {
    const res = await fetch(`${BASE}/api/s?key=${FIXTURE}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.content).toBe("string");
    expect(body.content.length).toBeGreaterThan(0);
  });

  test("returns 400 missing_key when key is absent", async () => {
    const res = await fetch(`${BASE}/api/s`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("missing_key");
  });

  test("returns 400 missing_key when key is empty", async () => {
    const res = await fetch(`${BASE}/api/s?key=`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("missing_key");
  });

  test("returns 405 method_not_allowed for POST", async () => {
    const res = await fetch(`${BASE}/api/s?key=${FIXTURE}`, { method: "POST" });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe("method_not_allowed");
  });

  test("rejects parent-directory traversal in key", async () => {
    const res = await fetch(`${BASE}/api/s?key=../../../../etc/passwd`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_key");
  });

  test("rejects URL-encoded parent-directory traversal in key", async () => {
    /* %2F..%2Fetc%2Fpasswd decodes to /../etc/passwd. The slash is
       outside the allowlist even after the regex AND path containment
       would each independently catch it; the test guarantees both
       defenses stay in place. */
    const res = await fetch(`${BASE}/api/s?key=%2F..%2Fetc%2Fpasswd`);
    expect(res.status).toBe(400);
  });

  test("rejects keys containing forward slashes", async () => {
    const res = await fetch(`${BASE}/api/s?key=foo/bar`);
    expect(res.status).toBe(400);
  });

  test("rejects keys containing backslashes", async () => {
    const res = await fetch(`${BASE}/api/s?key=foo%5Cbar`);
    expect(res.status).toBe(400);
  });

  test("rejects '..' substring even when rest of key is allowlisted", async () => {
    /* The allowlist regex [A-Za-z0-9._-]+ would accept 'a..b.md',
       but the dedicated '..' reject and the path containment check
       should still refuse it. */
    const res = await fetch(`${BASE}/api/s?key=a..b.md`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_key");
  });

  test("rejects absolute-path key", async () => {
    const res = await fetch(`${BASE}/api/s?key=%2Fetc%2Fpasswd`);
    expect(res.status).toBe(400);
  });

  test("returns 404 for a well-formed but missing fixture", async () => {
    const res = await fetch(`${BASE}/api/s?key=does-not-exist.md`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  test("exact /api/s match: /api/sx does not invoke the stub", async () => {
    const res = await fetch(`${BASE}/api/sx?key=${FIXTURE}`);
    /* Falls through to the static-file branch, which 404s because
       /api/sx is not a static asset. The previous startsWith()
       check would have wrongly routed to the fixture reader. */
    expect(res.status).toBe(404);
  });

  test("exact /api/s match: /api/s/anything does not invoke the stub", async () => {
    const res = await fetch(`${BASE}/api/s/${FIXTURE}`);
    expect(res.status).toBe(404);
  });
});

describe("/api/s stub gating (FW_STUB_SHARES + NODE_ENV)", () => {
  /* These tests need to restart the server with different env, so
     they manage their own proc lifecycle and restore the dev server
     at the end. */
  let savedProc = null;

  async function swapProc(env) {
    savedProc = proc;
    proc = null;
    await killServer(savedProc);
    proc = await spawnServer(env);
    await waitUntilReady();
  }

  async function restoreProc() {
    await killServer(proc);
    proc = null;
    savedProc = await spawnServer({ FW_STUB_SHARES: "1" });
    proc = savedProc;
    savedProc = null;
    await waitUntilReady();
  }

  test("NODE_ENV=production with no FW_STUB_SHARES => stub OFF", async () => {
    await swapProc({ NODE_ENV: "production", FW_STUB_SHARES: "" });
    try {
      const res = await fetch(`${BASE}/api/s?key=${FIXTURE}`);
      expect(res.status).toBe(404);
    } finally {
      await restoreProc();
    }
  });

  test("NODE_ENV=production + FW_STUB_SHARES=1 => stub ON", async () => {
    await swapProc({ NODE_ENV: "production", FW_STUB_SHARES: "1" });
    try {
      const res = await fetch(`${BASE}/api/s?key=${FIXTURE}`);
      expect(res.status).toBe(200);
    } finally {
      await restoreProc();
    }
  });

  test("NODE_ENV=development + FW_STUB_SHARES=0 => stub OFF", async () => {
    await swapProc({ NODE_ENV: "development", FW_STUB_SHARES: "0" });
    try {
      const res = await fetch(`${BASE}/api/s?key=${FIXTURE}`);
      expect(res.status).toBe(404);
    } finally {
      await restoreProc();
    }
  });
});

describe("/api/s source hardening", () => {
  /* Static checks on public/server.js source so a future refactor
     can't silently remove the allowlist or exact-path match. */
  test("server.js contains the strict allowlist regex", () => {
    const src = readFileSync("public/server.js", "utf8");
    expect(src).toContain("VALID_SHARE_KEY");
    expect(src).toContain("[A-Za-z0-9._-]+$");
    expect(src).toContain("isValidShareKey");
  });

  test("server.js contains the exact path match (no startsWith on /api/s)", () => {
    const src = readFileSync("public/server.js", "utf8");
    expect(src).toContain('pathOnly === "/api/s"');
    /* Negative assertion is the important one: ensure the broader
       startsWith() check is not silently re-introduced. */
    expect(src).not.toContain('req.url.startsWith("/api/s")');
  });

  test("server.js contains the path-containment defense-in-depth check", () => {
    const src = readFileSync("public/server.js", "utf8");
    expect(src).toContain("SHARE_FIXTURES_DIR");
    expect(src).toContain("path.resolve(SHARE_FIXTURES_DIR, key)");
    expect(src).toContain("candidate.startsWith(SHARE_FIXTURES_DIR + path.sep)");
  });

  test("server.js gates the stub off by default in production", () => {
    const src = readFileSync("public/server.js", "utf8");
    expect(src).toContain("NODE_ENV");
    expect(src).toContain('"production"');
    /* The gates are expressed via the cached stubEnv local, not the
       env var directly. */
    expect(src).toContain('stubEnv === "1"');
    expect(src).toContain('stubEnv !== "0"');
  });

  test("server.js rejects bad keys with HTTP 400 invalid_key", () => {
    const src = readFileSync("public/server.js", "utf8");
    expect(src).toContain('"invalid_key"');
  });
});
