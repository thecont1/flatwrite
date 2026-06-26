/**
 * MCP tool: render_markdown_from_url
 *
 * Fetches markdown from a URL and renders it into FlatWrite-styled HTML
 * <head> and <body> fragments.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  RenderStyle,
  buildRemoteMarkdownBody,
  callRender,
} from '../renderClient.js';
import { renderErrorResult } from './error.js';

const InputSchema = z
  .object({
    url: z.string().url().describe('URL pointing to raw markdown content'),
    framework: z.string().optional().describe('Optional UI framework (e.g. spectre, pico, oat, poshui)'),
    fontFamily: z.string().optional().describe('Optional font family (e.g. Inter, Merriweather, Lora)'),
    theme: z.string().optional().describe('Optional theme identifier (e.g. light, dark)'),
    fontSize: z.string().optional().describe('Optional font size token'),
    lineHeight: z.string().optional().describe('Optional line height token'),
    uiZoom: z.number().optional().describe('Optional UI zoom level (1.0 = default)'),
  })
  .strict();

/**
 * Hosts the upstream `/api/render` is willing to fetch markdown from.
 * Mirrors `ALLOWED_MARKDOWN_HOSTS` in api/render.js — keep in sync.
 */
export const ALLOWED_MARKDOWN_HOSTS: ReadonlySet<string> = new Set([
  'raw.githubusercontent.com',
  'raw.gitlab.com',
  'bitbucket.org',
]);

export type UrlValidationCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_SCHEME'
  | 'DISALLOWED_HOST';

export interface UrlValidationFailure {
  ok: false;
  code: UrlValidationCode;
  message: string;
  host?: string;
}

export interface UrlValidationSuccess {
  ok: true;
  url: string;
  host: string;
}

export type UrlValidationResult = UrlValidationSuccess | UrlValidationFailure;

/**
 * Validate that a markdown URL is fetchable by the upstream renderer.
 *
 * Pre-flight check before forwarding to `/api/render` so that callers get
 * a structured failure immediately rather than a 502 roundtrip. The
 * upstream also enforces these checks, so the worst case if this drifts
 * out of sync is that callers see a less specific error message.
 */
export function validateMarkdownUrl(rawUrl: string): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      code: 'INVALID_URL',
      message: 'url is not a valid URL',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'UNSUPPORTED_SCHEME',
      message: `url must use http or https (got ${parsed.protocol})`,
      host: parsed.hostname,
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_MARKDOWN_HOSTS.has(host)) {
    return {
      ok: false,
      code: 'DISALLOWED_HOST',
      message: `host '${host}' is not on the markdown URL allowlist`,
      host,
    };
  }

  return { ok: true, url: parsed.toString(), host };
}

export function registerRenderMarkdownFromUrlTool(
  server: McpServer,
  apiKey: string,   baseUrl?: string,
) {
  server.registerTool(
    'render_markdown_from_url',
    {
      title: 'Render Markdown From URL',
      description:
        'Fetch markdown from a URL and render it into FlatWrite-styled HTML <head> and <body> fragments.',
      inputSchema: InputSchema,
      outputSchema: {
        head: z.string().describe('HTML to inject in <head>'),
        body: z.string().describe('HTML to inject in <body>'),
      },
    },
    async ({ url, ...style }) => {
      const check = validateMarkdownUrl(url);
      if (!check.ok) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `${check.message} [${check.code}]`,
            },
          ],
        };
      }

      const body = buildRemoteMarkdownBody(check.url, style as RenderStyle);
      try {
        const result = await callRender(body, { apiKey, baseUrl });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: { ...result },
        };
      } catch (e) {
        return renderErrorResult(e);
      }
    },
  );
}