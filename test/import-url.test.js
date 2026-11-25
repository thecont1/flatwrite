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

import { describe, test, expect } from "bun:test";

const handler = require("../api/import-url.js");

function mockReq(method = "POST") {
  return { method, headers: {}, socket: { remoteAddress: "203.0.113.1" }, on() {} };
}

function mockRes() {
  const res = { _status: 200, _headers: {}, _body: null };
  res.setHeader = (k, v) => { res._headers[k] = v; };
  res.end = (d) => {
    try { res._body = JSON.parse(d); } catch { res._body = d; }
    return res;
  };
  Object.defineProperty(res, "statusCode", {
    set(v) { res._status = v; },
    get() { return res._status; },
  });
  return res;
}

describe("api/import-url.js retired endpoint", () => {
  test("POST → 410 ENDPOINT_RETIRED stub", async () => {
    const res = mockRes();
    await handler(mockReq("POST"), res);
    expect(res._status).toBe(410);
    expect(res._headers["Content-Type"]).toBe("application/json");
    expect(res._body).toEqual({
      ok: false,
      code: "ENDPOINT_RETIRED",
      error: "Use /api/fetch-document — conversion now runs in the browser",
    });
  });

  test("the stub is method-independent when invoked directly", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = mockRes();
      await handler(mockReq(method), res);
      expect(res._status).toBe(410);
      expect(res._body.code).toBe("ENDPOINT_RETIRED");
    }
  });

  test("no extract-service environment configuration is needed", () => {
    const source = require("fs").readFileSync(require("path").join(__dirname, "../api/import-url.js"), "utf8");
    expect(source).not.toContain("EXTRACT_SERVICE_URL");
    expect(source).not.toContain("INTERNAL_EXTRACT_KEY");
  });
});
