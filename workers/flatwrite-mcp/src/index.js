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
//
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

// === Translator: public friendly style → canonical FlatWrite frontmatter ===
// Strings are scale tokens, numbers are absolute pixel/weight/height values.
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

// Sanitize error details before they leave the server so bearer tokens,
// API keys, hostnames, and stack frames don't leak through MCP errors.
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

// Per-request env: Workers env binding is only valid inside fetch().
// We capture it on the request and the tool handlers read from the
// request-scoped context.
let currentEnv = null;
function UPSTREAM_RENDER_URL() { return currentEnv?.UPSTREAM_RENDER_URL || "https://render.flatwrite.md/render"; }
function API_KEY() { return currentEnv?.API_KEY || ""; }

// === Worker fetch handler ===
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, Accept, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

export default {
  async fetch(req, env, ctx) {
    // Cache env into module globals so tool handlers can read it.
    globalThis.__FLATWRITE_API_KEY__ = env.API_KEY;
    globalThis.__FLATWRITE_UPSTREAM__ = env.UPSTREAM_RENDER_URL || "https://render.flatwrite.md/render";

    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Only handle /mcp
    if (url.pathname !== "/mcp") {
      return new Response(
        JSON.stringify({
          error: "Not Found — use POST/GET /mcp",
          code: "NOT_FOUND",
        }),
        { status: 404, headers: { "Content-Type": "application/json", ...CORS } },
      );
    }

    // Public auth: X-Api-Key
    if (!env.API_KEY || req.headers.get("X-Api-Key") !== env.API_KEY) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", code: "UNAUTHORIZED" }),
        { status: 401, headers: { "Content-Type": "application/json", ...CORS } },
      );
    }

    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      return new Response(
        JSON.stringify({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }),
        { status: 405, headers: { "Content-Type": "application/json", ...CORS } },
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
      // Merge CORS headers into the response
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
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
        { status: 500, headers: { "Content-Type": "application/json", ...CORS } },
      );
    }
  },
};
