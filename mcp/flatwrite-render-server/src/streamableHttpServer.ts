/**
 * Streamable HTTP transport for the FlatWrite render MCP server.
 *
 * The default `npm start` runs the server over stdio (for Hermes and
 * other local-process MCP clients). Setting the env var
 *   FLATWRITE_TRANSPORT=streamable-http
 * switches to a long-running HTTP server on the port specified by
 *   FLATWRITE_PORT (default 3000)
 * that speaks the MCP Streamable HTTP transport. Clients connect with:
 *
 *   {
 *     "mcpServers": {
 *       "flatwrite-render": {
 *         "type": "streamable-http",
 *         "url": "http://localhost:3000/mcp"
 *       }
 *     }
 *   }
 *
 * Or, against the deployed Cloudflare Worker:
 *
 *   {
 *     "mcpServers": {
 *       "flatwrite-render": {
 *         "type": "streamable-http",
 *         "url": "https://mcp.flatwrite.md/mcp"
 *       }
 *     }
 *   }
 *
 * Each session gets its own McpServer instance because the SDK's
 * Protocol object owns exactly one Transport. The route to /mcp
 * dispatches by session ID.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { callRender } from './renderClient.js';

// Bundled font inventory — must match core/font-inventory.js and
// core/document-css.js's COMFORT_FONTS exactly.
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
 * Build a fresh MCP server with the FlatWrite render tools registered.
 * Each session needs its own because the SDK's Protocol object
 * owns exactly one Transport.
 */
function createMcpServer(apiKey: string, baseUrl?: string) {
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
 * Run the server over Streamable HTTP on the given port.
 * Returns the http.Server instance so tests can close it.
 */
export async function startStreamableHttp(opts: {
  port: number;
  apiKey: string, baseUrl?: string;
  host?: string;
}): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
  close: () => Promise<void>;
}> {
  // Per-session map. Key is session ID, value is { transport, server }.
  // Each session gets its own McpServer so SDK Protocol ownership works.
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: McpServer }
  >();

  async function getOrCreateSession(sessionId: string) {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    throw new Error('NO_SESSION');
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, Accept, Mcp-Session-Id',
        'Access-Control-Expose-Headers': 'Mcp-Session-Id',
      });
      res.end();
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Not Found — use POST/GET /mcp', code: 'NOT_FOUND' }));
      return;
    }

    // Auth: X-Api-Key header (skip when apiKey is empty, e.g. local dev)
    if (opts.apiKey) {
      const provided = req.headers['x-api-key'];
      if (provided !== opts.apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }));
        return;
      }
    }

    const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? '';

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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
        freshServer = createMcpServer(opts.apiKey, opts.baseUrl);
        await freshServer.connect(transport);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Missing or unknown session ID', code: 'NO_SESSION' }));
        return;
      }

      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'GET') {
      // SSE stream for server-initiated notifications
      let entry;
      try { entry = await getOrCreateSession(sessionId); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Missing or unknown session ID', code: 'NO_SESSION' }));
        return;
      }
      await entry.transport.handleRequest(req, res);
      return;
    }

    if (req.method === 'DELETE') {
      const entry = sessions.get(sessionId);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Unknown session', code: 'NO_SESSION' }));
        return;
      }
      await entry.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }));
  });

  const host = opts.host || '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(opts.port, host, () => resolve()));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;

  async function close(): Promise<void> {
    // Close all sessions first
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
  startStreamableHttp({ port, apiKey, baseUrl }).then(({ port: actualPort }) => {
    console.error(`[flatwrite-mcp] streamable-http listening on http://127.0.0.1:${actualPort}/mcp`);
  }).catch((e) => {
    console.error('[flatwrite-mcp] failed to start:', e);
    process.exit(1);
  });
}
