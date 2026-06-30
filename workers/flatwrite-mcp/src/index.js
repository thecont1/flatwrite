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

// workers/flatwrite-mcp/src/index.js
//
// Cloudflare Worker that exposes the FlatWrite render tools over MCP's
// Streamable HTTP transport. Same set of tools as the stdio server
// (mcp/flatwrite-render-server): render_markdown and
// render_markdown_from_url. Fronts the public render.flatwrite.md
// Worker, so a tool call here produces byte-identical output to the
// stdio server, the public HTTP API, and the WebMCP page-side tool.
//
// Stateless: each request gets a fresh transport instance. Sessions
// are not preserved across Worker invocations. Tool definitions are
// shared via a single McpServer imported once at module scope.

// Client config:
//   {
//     "mcpServers": {
//       "flatwrite-render": {
//         "type": "streamable-http",
//         "url": "https://mcp.flatwrite.md/mcp"
//       }
//     }
//   }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  buildRawMarkdownBody,
  buildRemoteMarkdownBody,
  constantTimeEqual,
  sanitizeDetail,
  validateFontFamily,
  verifyToken,
  validateMarkdownUrl,
  ALLOWED_APP_FRAMEWORKS,
  ALLOWED_DOC_ENGINES,
  ALLOWED_FONT_FAMILIES,
  ALLOWED_MARGINS,
  ALLOWED_ORIENTATIONS,
  ALLOWED_PAGE_SIZES,
  ALLOWED_SURFACE_MODES,
} from "../../../public/webmcp-shared.js";

// Origins allowed to call this Worker over the browser-side path
// (Streamable HTTP from a browser tab, not a server-to-server MCP
// client). Server-to-server callers (MCP stdio clients, the Hermes
// stdio server, etc.) do not send an Origin header and are not
// affected by this allowlist. Add additional previews by extending
// here (e.g. https://*.vercel.app for Vercel preview deploys).
const TRUSTED_ORIGINS = new Set([
  "https://flatwrite.md",
  "https://www.flatwrite.md",
  // *.flatwrite.md via suffix match (Cloudflare Workers lack native
  // wildcard support; we check the suffix in corsFor()).
]);

// === Tool schemas (mirror of mcp/flatwrite-render-server/src/tools/*.ts) ===
const RenderStyleSchema = z
  .object({
    framework: z.enum(ALLOWED_APP_FRAMEWORKS).optional(),
    fontFamily: z.enum(ALLOWED_FONT_FAMILIES).optional(),
    fontSize: z.union([z.string(), z.number()]).optional(),
    fontWeight: z.union([z.string(), z.number()]).optional(),
    lineHeight: z.union([z.string(), z.number()]).optional(),
    uiZoom: z.number().optional(),
    pageSize: z.enum(ALLOWED_PAGE_SIZES).optional(),
    orientation: z.enum(ALLOWED_ORIENTATIONS).optional(),
    marginsLR: z.enum(ALLOWED_MARGINS).optional(),
    marginsTB: z.enum(ALLOWED_MARGINS).optional(),
    footer: z.boolean().optional(),
    width: z.number().optional(),
    docEngine: z.enum(ALLOWED_DOC_ENGINES).optional(),
    surfaceMode: z.enum(ALLOWED_SURFACE_MODES).optional(),
    theme: z.string().optional(),
  })
  .strict();

const RenderMarkdownInput = z
  .object({
    markdown: z.string().min(1),
    ...RenderStyleSchema.shape,
  })
  .strict();

const RenderMarkdownFromUrlInput = z
  .object({
    url: z.string().url(),
    ...RenderStyleSchema.shape,
  })
  .strict();

/**
 * True if the request's Origin is in the trusted-origin allowlist
 * (exact match or suffix match for `*.flatwrite.md` subdomains).
 */
function isTrustedOrigin(origin) {
  if (!origin) return false;
  if (TRUSTED_ORIGINS.has(origin)) return true;
  // Suffix match: https://anything.flatwrite.md
  if (/^https:\/\/[a-z0-9-]+\.flatwrite\.md$/i.test(origin)) return true;
  return false;
}

/**
 * CORS headers for the request. Returns the CORS object to merge in
 * if the request's Origin is trusted, or `{}` (no CORS headers)
 * otherwise. Untrusted origins get no ACAO header — the browser
 * blocks the response from being read by JS.
 */
function corsFor(req) {
  const origin = req.headers.get("Origin");
  if (!origin) return {};
  if (!isTrustedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
  };
}

/**
 * Preflight headers. The Allow-Headers list is restricted to
 * browser-safe headers — X-Api-Key is intentionally absent since
 * the long-lived key is server-to-server only. Browser callers use
 * X-Mcp-Token (the public Worker at render.flatwrite.md mints those
 * via /mcp-token; the token is bound to a short TTL and an Origin
 * check, then verified by HMAC).
 */
function preflightHeaders(cors, requested) {
  const allowed = ["Content-Type", "X-Mcp-Token", "Accept", "Mcp-Session-Id", "Last-Event-Id"];
  let allowHeaders = allowed.join(", ");
  if (requested) {
    const filtered = requested
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .map((h) => allowed.find((a) => a.toLowerCase() === h))
      .filter((h) => Boolean(h));
    if (filtered.length > 0) allowHeaders = filtered.join(", ");
  }
  return {
    ...cors,
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": allowHeaders,
    "Access-Control-Max-Age": "600",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

function isBrowserRequest(req) {
  return Boolean(req.headers.get("Origin"));
}

// Outbound call to render.flatwrite.md — Workers fetch supports this.
async function callUpstream(upstreamUrl, apiKey, body) {
  const resp = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (_) { parsed = null; }
  if (!resp.ok) {
    const err = parsed || { error: "HTTP " + resp.status, code: "RENDER_FAILED" };
    throw new Error(err.error + " [" + err.code + "]");
  }
  if (!parsed || typeof parsed.head !== "string" || typeof parsed.body !== "string") {
    throw new Error("Malformed render response [RENDER_FAILED]");
  }
  return parsed;
}

function isErrorResult(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Create a fresh McpServer for each request. The SDK's underlying
 * Protocol object owns exactly one Transport, so reusing a single
 * module-scoped server and reconnecting it on every request is unsafe.
 * This mirrors the Node streamable server's pattern of one McpServer per
 * session. Tool handlers read the per-request env via the currentEnv
 * globals set before the transport handles the request.
 */
function createMcpServer() {
  const server = new McpServer({ name: "flatwrite-render", version: "0.2.0" });

  server.registerTool(
    "render_markdown",
    {
      title: "Render Markdown",
      description:
        "Render raw markdown into FlatWrite-styled HTML <head> and <body> fragments.",
      inputSchema: RenderMarkdownInput,
    },
    async ({ markdown, fontFamily, ...style }) => {
      const fontCheck = validateFontFamily(fontFamily);
      if (!fontCheck.ok) {
        return isErrorResult(fontCheck.message + " [" + fontCheck.code + "]");
      }
      const body = buildRawMarkdownBody(markdown, { fontFamily, ...style });
      try {
        const result = await callUpstream(UPSTREAM_RENDER_URL(), API_KEY(), body);
        return { structuredContent: result };
      } catch (e) {
        return isErrorResult(sanitizeDetail(e.message || e));
      }
    },
  );

  server.registerTool(
    "render_markdown_from_url",
    {
      title: "Render Markdown From URL",
      description:
        "Fetch markdown from a URL and render it into FlatWrite-styled HTML <head> and <body> fragments.",
      inputSchema: RenderMarkdownFromUrlInput,
    },
    async ({ url, fontFamily, ...style }) => {
      const urlCheck = validateMarkdownUrl(url);
      if (!urlCheck.ok) {
        return isErrorResult(urlCheck.message + " [" + urlCheck.code + "]");
      }
      const fontCheck = validateFontFamily(fontFamily);
      if (!fontCheck.ok) {
        return isErrorResult(fontCheck.message + " [" + fontCheck.code + "]");
      }
      const body = buildRemoteMarkdownBody(urlCheck.url, { fontFamily, ...style });
      try {
        const result = await callUpstream(UPSTREAM_RENDER_URL(), API_KEY(), body);
        return { structuredContent: result };
      } catch (e) {
        return isErrorResult(sanitizeDetail(e.message || e));
      }
    },
  );

  return server;
}

// Per-request env. Captured at fetch time and read by tool handlers
// (which can't take env as an argument).
let currentEnv = null;
function UPSTREAM_RENDER_URL() { return currentEnv?.UPSTREAM_RENDER_URL || "https://render.flatwrite.md/render"; }
function API_KEY() { return currentEnv?.API_KEY || ""; }

/**
 * Authenticate. Two paths:
 *   - X-Mcp-Token — short-lived HMAC, browser-safe. The token
 *     encodes `{ exp, sig }` where `sig = HMAC(env.API_KEY, exp + ".mcp")`.
 *     The Worker verifies the signature itself rather than trusting
 *     the upstream render Worker, so this Worker is the gate even
 *     though the token format is the same as the render Worker.
 *     (Both Workers share env.API_KEY; either can mint, either can
 *     verify. The token is bound to scope "mcp" so a token minted
 *     for a different scope — if we add one later — won't work here.)
 *   - X-Api-Key — long-lived key, server-to-server only. Rejected
 *     from any caller that carries an Origin header.
 *
 * Browser callers (those with an Origin header) MUST use X-Mcp-Token.
 * The page-side script (public/webmcp.js) gets a fresh token by
 * calling the public render Worker's /mcp-token endpoint.
 */
async function authenticateRequest(req, env) {
  if (!env.API_KEY) {
    return { ok: false, status: 500, body: { error: "Worker misconfigured", code: "MISCONFIGURED" } };
  }
  // Short-lived token — accepted from any caller.
  const token = req.headers.get("X-Mcp-Token");
  if (token) {
    const v = await verifyToken(env.API_KEY, token, "mcp");
    if (v.ok) return { ok: true, kind: "token" };
    return {
      ok: false,
      status: 401,
      body: { error: "Invalid or expired token", code: "INVALID_TOKEN", detail: v.reason },
    };
  }
  // Long-lived key — server-to-server only.
  if (isBrowserRequest(req)) {
    return {
      ok: false,
      status: 401,
      body: {
        error: "X-Api-Key cannot be used from a browser. Use X-Mcp-Token instead.",
        code: "API_KEY_NOT_ALLOWED_FROM_BROWSER",
      },
    };
  }
  const apiKey = req.headers.get("X-Api-Key");
  if (constantTimeEqual(apiKey || "", env.API_KEY || "")) return { ok: true, kind: "key" };
  return { ok: false, status: 401, body: { error: "Unauthorized", code: "UNAUTHORIZED" } };
}

export default {
  async fetch(req, env, ctx) {
    currentEnv = env;

    const url = new URL(req.url);

    // CORS preflight — only emit headers for trusted origins, and
    // never advertise X-Api-Key to browsers.
    if (req.method === "OPTIONS") {
      const cors = corsFor(req);
      const requested = req.headers.get("Access-Control-Request-Headers");
      return new Response(null, { status: 204, headers: preflightHeaders(cors, requested) });
    }

    // Only handle /mcp
    if (url.pathname !== "/mcp") {
      const cors = corsFor(req);
      return new Response(
        JSON.stringify({ error: "Not Found — use POST/GET /mcp", code: "NOT_FOUND" }),
        { status: 404, headers: { "Content-Type": "application/json", ...cors } },
      );
    }

    // Auth — rejects X-Api-Key from browser callers.
    const cors = corsFor(req);
    const auth = await authenticateRequest(req, env);
    if (!auth.ok) {
      return new Response(
        JSON.stringify(auth.body),
        { status: auth.status, headers: { "Content-Type": "application/json", ...cors } },
      );
    }

    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      return new Response(
        JSON.stringify({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }),
        { status: 405, headers: { "Content-Type": "application/json", ...cors } },
      );
    }

    // Stateless transport per request. enableJsonResponse=true keeps
    // the response shape predictable (single JSON object instead of an
    // SSE stream) for tool-call style usage.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcp = createMcpServer();

    try {
      await mcp.connect(transport);
      const response = await transport.handleRequest(req, ctx);
      // Merge CORS headers into the response.
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (e) {
      return new Response(
        JSON.stringify({
          error: "Worker failed",
          code: "WORKER_ERROR",
          detail: sanitizeDetail(e.message || e),
        }),
        { status: 500, headers: { "Content-Type": "application/json", ...cors } },
      );
    }
  },
};
