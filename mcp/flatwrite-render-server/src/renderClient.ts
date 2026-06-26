/**
 * Shared HTTP client + helpers for the FlatWrite render MCP server.
 *
 * Talks to the public Cloudflare Worker at `https://render.flatwrite.md/render`
 * using the JSON contract described in `openapi.yaml`. Authentication is
 * carried in the `X-Api-Key` header, sourced from the
 * `FLATWRITE_RENDER_API_KEY` environment variable.
 */

import { sanitizeDetail, sanitizeRenderErrorPayload } from './tools/sanitize.js';

export const DEFAULT_RENDER_URL = 'https://render.flatwrite.md/render';

export type RenderStyle = {
  framework?: string;
  fontFamily?: string;
  theme?: string;
  fontSize?: string;
  lineHeight?: string;
  uiZoom?: number;
};

export type RenderResponse = {
  head: string;
  body: string;
};

export type RenderError = {
  error: string;
  code: string;
  detail?: string;
  retryAfter?: number;
};

export type RenderErrorPayload = RenderError | { raw: string };

export type RenderClientConfig = {
  apiKey: string,
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class RenderApiError extends Error {
  readonly status: number;
  readonly payload: RenderErrorPayload;

  constructor(status: number, payload: RenderErrorPayload, message?: string) {
    super(message ?? payloadErrorMessage(payload));
    this.name = 'RenderApiError';
    this.status = status;
    this.payload = payload;
  }
}

function payloadErrorMessage(payload: RenderErrorPayload): string {
  if ('raw' in payload) return `Render failed (raw): ${payload.raw.slice(0, 200)}`;
  const detail = payload.detail ? ` — ${payload.detail}` : '';
  return `${payload.error}${detail} [${payload.code}]`;
}

/** Strip undefined fields so the wire payload stays clean. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/** Build the JSON body for a raw-markdown render. */
export function buildRawMarkdownBody(
  markdown: string,
  style: RenderStyle = {},
): Record<string, unknown> {
  return compact({ markdown, ...style });
}

/** Build the JSON body for a remote-markdown render. */
export function buildRemoteMarkdownBody(
  url: string,
  style: RenderStyle = {},
): Record<string, unknown> {
  return compact({ markdownUrl: url, ...style });
}

/**
 * Call the public render endpoint. Throws `RenderApiError` on non-2xx responses
 * or transport failures so MCP tool handlers can surface a structured failure.
 */
export async function callRender(
  body: Record<string, unknown>,
  config: RenderClientConfig,
): Promise<RenderResponse> {
  const baseUrl = config.baseUrl ?? DEFAULT_RENDER_URL;
  const f = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 30_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await f(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': config.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new RenderApiError(
      0,
      {
        error: 'Failed to reach render service',
        code: 'UPSTREAM_UNREACHABLE',
        detail: sanitizeDetail(e),
      },
      `Failed to reach render service: ${sanitizeDetail(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RenderApiError(resp.status, { raw: sanitizeDetail(text) });
  }

  if (!resp.ok) {
    const err = sanitizeRenderErrorPayload(parsed as RenderError);
    throw new RenderApiError(resp.status, err);
  }

  const ok = parsed as RenderResponse;
  if (typeof ok?.head !== 'string' || typeof ok?.body !== 'string') {
    throw new RenderApiError(
      resp.status,
      {
        error: 'Malformed render response',
        code: 'RENDER_FAILED',
        detail: sanitizeDetail(text),
      },
    );
  }

  return ok;
}