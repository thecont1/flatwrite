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

// Bundled font inventory — must match core/font-inventory.js and
// core/document-css.js's COMFORT_FONTS exactly.
const ALLOWED_FONTS = new Set([
  "Inter", "JetBrains Mono", "Lato", "Lora",
  "Merriweather", "Playfair Display", "Comfortaa", "Unbounded",
]);

const ALLOWED_MARKDOWN_HOSTS = new Set([
  "raw.githubusercontent.com",
  "raw.gitlab.com",
  "bitbucket.org",
]);

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
    framework: z.string().optional(),
    fontFamily: z.string().optional(),
    fontSize: z.union([z.string(), z.number()]).optional(),
    fontWeight: z.union([z.string(), z.number()]).optional(),
    lineHeight: z.union([z.string(), z.number()]).optional(),
    uiZoom: z.number().optional(),
    pageSize: z.string().optional(),
    orientation: z.enum(["portrait", "landscape"]).optional(),
    marginsLR: z.string().optional(),
    marginsTB: z.string().optional(),
    footer: z.boolean().optional(),
    width: z.number().optional(),
    docEngine: z.string().optional(),
    surfaceMode: z.string().optional(),
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

function toCanonicalStyle(publicStyle) {
  const out = {};
  if (!publicStyle) return out;
  if (publicStyle.fontFamily != null) out.font = String(publicStyle.fontFamily);
  if (publicStyle.framework != null) out.appFramework = String(publicStyle.framework);
  if (publicStyle.fontSize != null) {
    if (typeof publicStyle.fontSize === "string") out.size = publicStyle.fontSize;
    else out.fontSize = publicStyle.fontSize;
  }
  if (publicStyle.fontWeight != null) {
    if (typeof publicStyle.fontWeight === "string") out.weight = publicStyle.fontWeight;
    else out.fontWeight = publicStyle.fontWeight;
  }
  if (publicStyle.lineHeight != null) {
    if (typeof publicStyle.lineHeight === "string") out.line = publicStyle.lineHeight;
    else out.lineHeight = publicStyle.lineHeight;
  }
  for (const k of [
    "docEngine", "surfaceMode", "pageSize", "orientation",
    "marginsLR", "marginsTB", "footer", "width",
    "theme",
  ]) {
    if (publicStyle[k] != null) out[k] = publicStyle[k];
  }
  return out;
}

function compact(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function buildRawBody(markdown, style) {
  return compact({ markdown, ...toCanonicalStyle(style) });
}

function buildRemoteBody(url, style) {
  return compact({ markdownUrl: url, ...toCanonicalStyle(style) });
}

function validateMarkdownUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    return { ok: false, code: "INVALID_URL", message: "url is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false, code: "UNSUPPORTED_SCHEME",
      message: "url must use http or https (got " + parsed.protocol + ")",
    };
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_MARKDOWN_HOSTS.has(host)) {
    return {
      ok: false, code: "DISALLOWED_HOST",
      message: "host '" + host + "' is not on the markdown URL allowlist",
    };
  }
  return { ok: true, url: parsed.toString() };
}

function sanitizeDetail(input) {
  if (input == null) return "";
  const s = String(input).slice(0, 160);
  return s
    .replace(/(?:Authorization|Bearer|ApiKey|Token)[:=\s]+[^\s,;"'`<>]+/gi, "[redacted]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[hex]")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[base64]")
    .replace(/https?:\/\/[^\s,;"'`<>]+/g, (m) => m.split("?")[0])
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
    .replace(/\/(?:Users|home)\/[^\s,;"'`<>]+/g, "[path]")
    .replace(/\.{0,2}\/[^\s,;"'`<>]+/g, "[path]")
    .replace(/\s+at\s+.+?(?=\s+at\s+|$)/g, "");
}

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

// === Single shared McpServer (tool definitions are module-scope) ===
const mcp = new McpServer({ name: "flatwrite-render", version: "0.2.0" });

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

mcp.registerTool(
  "render_markdown",
  {
    title: "Render Markdown",
    description:
      "Render raw markdown into FlatWrite-styled HTML <head> and <body> fragments.",
    inputSchema: RenderMarkdownInput,
  },
  async ({ markdown, fontFamily, ...style }) => {
    if (fontFamily !== undefined && !ALLOWED_FONTS.has(fontFamily)) {
      return isErrorResult(
        "fontFamily '" + fontFamily + "' is not one of the bundled fonts (Inter, JetBrains Mono, Lato, Lora, Merriweather, Playfair Display, Comfortaa, Unbounded) [INVALID_FONT_FAMILY]",
      );
    }
    const body = buildRawBody(markdown, { fontFamily, ...style });
    try {
      const result = await callUpstream(UPSTREAM_RENDER_URL(), API_KEY(), body);
      return { structuredContent: result };
    } catch (e) {
      return isErrorResult(sanitizeDetail(e.message || e));
    }
  },
);

mcp.registerTool(
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
    if (fontFamily !== undefined && !ALLOWED_FONTS.has(fontFamily)) {
      return isErrorResult(
        "fontFamily '" + fontFamily + "' is not one of the bundled fonts (Inter, JetBrains Mono, Lato, Lora, Merriweather, Playfair Display, Comfortaa, Unbounded) [INVALID_FONT_FAMILY]",
      );
    }
    const body = buildRemoteBody(urlCheck.url, { fontFamily, ...style });
    try {
      const result = await callUpstream(UPSTREAM_RENDER_URL(), API_KEY(), body);
      return { structuredContent: result };
    } catch (e) {
      return isErrorResult(sanitizeDetail(e.message || e));
    }
  },
);

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
  if (apiKey === env.API_KEY) return { ok: true, kind: "key" };
  return { ok: false, status: 401, body: { error: "Unauthorized", code: "UNAUTHORIZED" } };
}

async function verifyToken(secret, token, scope) {
  if (!token || typeof token !== "string") return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [expB64, sigB64] = parts;
  let expStr;
  try {
    expStr = atob(expB64.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return { ok: false, reason: "malformed" };
  if (exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };
  let expectedSig;
  try {
    expectedSig = atob(sigB64.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const actualSig = await sign(secret, expStr + "." + scope);
  if (expectedSig !== actualSig) return { ok: false, reason: "bad_signature" };
  return { ok: true, exp };
}

async function sign(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
