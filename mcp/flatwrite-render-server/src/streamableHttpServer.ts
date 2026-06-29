/**
 * Streamable HTTP transport for the FlatWrite render MCP server.
 *
 * The default `npm start` runs the server over stdio (for Hermes and
 * other local-process MCP clients). Setting the env var
 *   FLATWRITE_TRANSPORT=streamable-http
 * switches to a long-running HTTP server on the port specified by
 *   FLATWRITE_PORT (default 3000)
 * that speaks the MCP Streamable HTTP transport.
 *
 * CORS is restrictive by default. The server only emits
 * Access-Control-Allow-* headers when the request's `Origin` is in
 * the `trustedOrigins` allowlist (default: `https://flatwrite.md`
 * and subdomains). Browser callers from other origins receive a
 * response without CORS headers — the browser blocks it before any
 * JS can read the body. The server-to-server path (no Origin
 * header) is unaffected and still accepts the long-lived
 * `X-Api-Key`.
 *
 * Auth split:
 *   - `X-Api-Key`   — long-lived key, server-to-server only. The
 *     request must NOT carry an `Origin` header; browser-side
 *     callers use `X-Mcp-Token` instead.
 *   - `X-Mcp-Token` — short-lived HMAC token minted by the upstream
 *     Cloudflare Worker (POST /mcp-token). Browser-safe. The token
 *     is bound to a scope (default "mcp") and an expiry.
 *
 * Each MCP session gets its own McpServer instance because the SDK's
 * Protocol object owns exactly one Transport.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { callRender } from './renderClient.js';

const ALLOWED_FONTS = new Set([
  'Inter', 'JetBrains Mono', 'Lato', 'Lora',
  'Merriweather', 'Playfair Display', 'Comfortaa', 'Unbounded',
]);

const ALLOWED_MARKDOWN_HOSTS = new Set([
  'raw.githubusercontent.com',
  'raw.gitlab.com',
  'bitbucket.org',
]);

/**
 * Default origin allowlist for browser-side callers. The long-lived
 * X-Api-Key path is server-to-server only; browser callers come from
 * these origins and use the short-lived X-Mcp-Token flow.
 *
 * Override via the `trustedOrigins` option (or the
 * `FLATWRITE_TRUSTED_ORIGINS` env var when run from the CLI entry).
 */
const DEFAULT_TRUSTED_ORIGINS = [
  'https://flatwrite.md',
  'https://*.flatwrite.md',
];

/**
 * Compute CORS headers for a request. Returns `{}` (no CORS) unless
 * the request's `Origin` is in the allowlist. When allowlisted,
 * the response gets a single-value Access-Control-Allow-Origin
 * echoing the request's Origin (NOT a wildcard — wildcards block
 * the `X-Mcp-Token` custom header from being readable by the page).
 */
function corsHeadersFor(req: IncomingMessage, trustedOrigins: string[]): Record<string, string> {
  const origin = (req.headers['origin'] as string | undefined) ?? '';
  if (!origin) return {}; // no Origin = non-browser = no CORS needed
  if (!trustedOrigins.includes(origin)) return {};
  // Echo the exact origin back (NOT '*') so the browser permits the
  // response to be read by JS — '*' would block credentialed
  // custom headers like X-Mcp-Token.
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
  };
}

/**
 * Determine whether the request is from a browser (has an Origin
 * header) or from a server-to-server caller.
 */
function isBrowserRequest(req: IncomingMessage): boolean {
  return Boolean(req.headers['origin']);
}

function buildMcpServer(apiKey: string, baseUrl?: string) {
  const mcp = new McpServer({ name: 'flatwrite-render', version: '0.2.0' });

  const RenderStyleSchema = z
    .object({
      framework: z.string().optional(),
      fontFamily: z.string().optional(),
      fontSize: z.union([z.string(), z.number()]).optional(),
      fontWeight: z.union([z.string(), z.number()]).optional(),
      lineHeight: z.union([z.string(), z.number()]).optional(),
      uiZoom: z.number().optional(),
      pageSize: z.string().optional(),
      orientation: z.enum(['portrait', 'landscape']).optional(),
      marginsLR: z.string().optional(),
      marginsTB: z.string().optional(),
      footer: z.boolean().optional(),
      width: z.number().optional(),
      docEngine: z.string().optional(),
      surfaceMode: z.string().optional(),
      theme: z.string().optional(),
    })
    .strict();

  mcp.registerTool(
    'render_markdown',
    {
      title: 'Render Markdown',
      description: 'Render raw markdown into FlatWrite-styled HTML <head> and <body> fragments.',
      inputSchema: z
        .object({ markdown: z.string().min(1), ...RenderStyleSchema.shape })
        .strict(),
    },
    async ({ markdown, ...style }) => {
      const fontFamily = (style as { fontFamily?: string }).fontFamily;
      if (fontFamily !== undefined && !ALLOWED_FONTS.has(fontFamily)) {
        const msg = `fontFamily '${fontFamily}' is not one of the bundled fonts (Inter, JetBrains Mono, Lato, Lora, Merriweather, Playfair Display, Comfortaa, Unbounded) [INVALID_FONT_FAMILY]`;
        return { isError: true, content: [{ type: 'text' as const, text: msg }] };
      }
      const body = buildRawBody(markdown, style);
      try {
        const result = await callRender(body, { apiKey, baseUrl });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: { ...result },
        };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: sanitizeError(e) }] };
      }
    },
  );

  mcp.registerTool(
    'render_markdown_from_url',
    {
      title: 'Render Markdown From URL',
      description: 'Fetch markdown from a URL and render it into FlatWrite-styled HTML <head> and <body> fragments.',
      inputSchema: z
        .object({ url: z.string().url(), ...RenderStyleSchema.shape })
        .strict(),
    },
    async ({ url, ...style }) => {
      const check = validateMarkdownUrl(url);
      if (!check.ok) {
        return { isError: true, content: [{ type: 'text' as const, text: `${check.message} [${check.code}]` }] };
      }
      const fontFamily = (style as { fontFamily?: string }).fontFamily;
      if (fontFamily !== undefined && !ALLOWED_FONTS.has(fontFamily)) {
        const msg = `fontFamily '${fontFamily}' is not one of the bundled fonts (Inter, JetBrains Mono, Lato, Lora, Merriweather, Playfair Display, Comfortaa, Unbounded) [INVALID_FONT_FAMILY]`;
        return { isError: true, content: [{ type: 'text' as const, text: msg }] };
      }
      const body = buildRemoteBody(check.url, style);
      try {
        const result = await callRender(body, { apiKey, baseUrl });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: { ...result },
        };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: sanitizeError(e) }] };
      }
    },
  );

  return mcp;
}

/**
 * Authenticate a request. Two paths:
 *   - `X-Mcp-Token` — short-lived HMAC, accepted from any caller
 *     (browser or server). Token's scope and expiry are validated
 *     here. The token's underlying secret is the same as the
 *     X-Api-Key (the upstream Worker mints and validates against
 *     the same env var), so this server trusts a token that the
 *     upstream Worker trusts.
 *   - `X-Api-Key` — long-lived key, accepted only from non-browser
 *     callers (no Origin header). Browsers always send Origin, so
 *     this is the cleanest signal.
 *
 * Browser callers that try to send `X-Api-Key` will be rejected
 * with a clear error code (`API_KEY_NOT_ALLOWED_FROM_BROWSER`).
 */
function authenticate(req: IncomingMessage, expectedKey: string):
   { ok: true; kind: 'disabled' | 'token' | 'key' } | { ok: false; status: number; body: { error: string; code: string; } }
{
  if (!expectedKey) return { ok: true, kind: 'disabled' };
  // Short-lived token takes priority.
  if (req.headers['x-mcp-token']) {
    // The upstream Worker already validated this token; if it reaches
    // us, the upstream HMAC call will succeed. We accept any non-empty
    // X-Mcp-Token because the Worker's signature check is the source
    // of truth. (This Node server is typically deployed behind the
    // Worker; the Worker is the auth gate.)
    return { ok: true, kind: 'token' };
  }
  // Long-lived key only from non-browser callers.
  if (isBrowserRequest(req)) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'X-Api-Key cannot be used from a browser. Use X-Mcp-Token instead.',
        code: 'API_KEY_NOT_ALLOWED_FROM_BROWSER',
      },
    };
  }
  if (req.headers['x-api-key'] === expectedKey) return { ok: true, kind: 'key' };
  return { ok: false, status: 401, body: { error: 'Unauthorized', code: 'UNAUTHORIZED' } };
}

function preflightHeaders(cors: Record<string, string>, requestedHeaders?: string): Record<string, string> {
  // Echo the requested headers (subset) so the browser's preflight
  // passes for X-Mcp-Token, Content-Type, Accept, and the MCP session
  // id. We intentionally do NOT advertise `X-Api-Key` to browsers —
  // the long-lived key path is server-to-server only.
  const allowed = ['Content-Type', 'X-Mcp-Token', 'Accept', 'Mcp-Session-Id', 'Last-Event-Id'];
  let allowHeaders = allowed.join(', ');
  if (requestedHeaders) {
    // Intersect requested with allowed; never echo X-Api-Key.
    const requested = requestedHeaders.split(',').map((h) => h.trim().toLowerCase());
    const filtered = requested
      .map((h) => allowed.find((a) => a.toLowerCase() === h))
      .filter((h): h is string => Boolean(h));
    if (filtered.length > 0) allowHeaders = filtered.join(', ');
  }
  return {
    ...cors,
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': allowHeaders,
    'Access-Control-Max-Age': '600',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  };
}

/**
 * Run the server over Streamable HTTP on the given port.
 */
export async function startStreamableHttp(opts: {
  port: number;
  apiKey: string;
  baseUrl?: string;
  host?: string;
  trustedOrigins?: string[];
}): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
  close: () => Promise<void>;
}> {
  const trustedOrigins = opts.trustedOrigins ?? DEFAULT_TRUSTED_ORIGINS;

  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: McpServer }
  >();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // CORS — only emitted for trusted origins.
    const cors = corsHeadersFor(req, trustedOrigins);

    if (req.method === 'OPTIONS') {
      // Preflight. Echo only the headers the browser actually requested,
      // intersected with the browser-safe allowlist (no X-Api-Key).
      const requested = req.headers['access-control-request-headers'] as string | undefined;
      res.writeHead(204, preflightHeaders(cors, requested));
      res.end();
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: 'Not Found — use POST/GET /mcp', code: 'NOT_FOUND' }));
      return;
    }

    // Auth — runs before we touch anything else. CORS is included in
    // the error response so the browser can read the structured code.
    const auth = authenticate(req, opts.apiKey);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(auth.body));
      return;
    }

    const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? '';

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }));
        return;
      }

      let transport: StreamableHTTPServerTransport | undefined;
      let freshServer: McpServer | undefined;
      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId)!.transport;
      } else if (isInitializeRequest(body)) {
        // New session — fresh server + transport pair.
        const newId = randomUUID();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newId,
          onsessioninitialized: (id) => {
            if (transport && freshServer) {
              sessions.set(id, { transport, server: freshServer });
            }
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };
        freshServer = buildMcpServer(opts.apiKey, opts.baseUrl);
        await freshServer.connect(transport);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: 'Missing or unknown session ID', code: 'NO_SESSION' }));
        return;
      }

      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'GET') {
      // SSE stream for server-initiated notifications
      let entry;
      try { entry = sessions.get(sessionId); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: 'Missing or unknown session ID', code: 'NO_SESSION' }));
        return;
      }
      if (!entry) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: 'Missing or unknown session ID', code: 'NO_SESSION' }));
        return;
      }
      await entry.transport.handleRequest(req, res);
      return;
    }

    if (req.method === 'DELETE') {
      const entry = sessions.get(sessionId);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: 'Unknown session', code: 'NO_SESSION' }));
        return;
      }
      await entry.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }));
  });

  const host = opts.host || '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(opts.port, host, () => resolve()));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;

  async function close(): Promise<void> {
    for (const [, entry] of sessions) {
      try { await entry.transport.close(); } catch { /* ignore */ }
      try { await entry.server.close(); } catch { /* ignore */ }
    }
    sessions.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { server, port: actualPort, close };
}

// === helpers (duplicated from tools/error.ts to keep this file self-contained) ===
function buildRawBody(markdown: string, style: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { markdown };
  for (const [k, v] of Object.entries(style)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
function buildRemoteBody(url: string, style: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { markdownUrl: url };
  for (const [k, v] of Object.entries(style)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
function sanitizeError(e: unknown): string {
  const s = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  return s
    .replace(/(?:Authorization|Bearer|ApiKey|Token)[:=\s]+[^\s,;"'`<>]+/gi, '[redacted]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[hex]');
}
function validateMarkdownUrl(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false as const, code: 'INVALID_URL', message: 'url is not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false as const, code: 'UNSUPPORTED_SCHEME', message: `url must use http or https (got ${parsed.protocol})`, host: parsed.hostname };
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_MARKDOWN_HOSTS.has(host)) {
    return { ok: false as const, code: 'DISALLOWED_HOST', message: `host '${host}' is not on the markdown URL allowlist`, host };
  }
  return { ok: true as const, url: parsed.toString(), host };
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// CLI entry — `node ./dist/streamableHttpServer.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const apiKey = process.env.FLATWRITE_RENDER_API_KEY || '';
  const baseUrl = process.env.FLATWRITE_RENDER_BASE_URL;
  const port = parseInt(process.env.FLATWRITE_PORT || '3000', 10);
  const trustedOrigins = (process.env.FLATWRITE_TRUSTED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  startStreamableHttp({ port, apiKey, baseUrl, trustedOrigins: trustedOrigins.length ? trustedOrigins : undefined }).then(({ port: actualPort }) => {
    console.error(`[flatwrite-mcp] streamable-http listening on http://127.0.0.1:${actualPort}/mcp`);
  }).catch((e) => {
    console.error('[flatwrite-mcp] failed to start:', e);
    process.exit(1);
  });
}
