/**
 * Shared HTTP client + helpers for the FlatWrite render MCP server.
 *
 * Talks to the public Cloudflare Worker at `https://render.flatwrite.md/render`
 * using the JSON contract described in `openapi.yaml`. Authentication is
 * carried in the `X-Api-Key` header, sourced from the
 * `FLATWRITE_RENDER_API_KEY` environment variable.
 *
 * The MCP tools expose a friendly public schema (RenderStyle). The
 * canonical FlatWrite renderer — and the YAML frontmatter the editor
 * writes into shared links — uses compact codenames (`font`, `size`,
 * `weight`, `line`, `appFramework`, ...). `toCanonicalStyle()` translates
 * one to the other, so the public microservice API stays clean while the
 * render path remains a thin pass-through to the canonical renderer.
 */

import {
  toCanonicalStyle as sharedToCanonicalStyle,
  ALLOWED_FONT_FAMILIES as SHARED_ALLOWED_FONTS,
  buildRawMarkdownBody as sharedBuildRawMarkdownBody,
  buildRemoteMarkdownBody as sharedBuildRemoteMarkdownBody,
  sanitizeDetail,
  sanitizeRenderErrorPayload,
} from './shared/mcpShared.js';

export const DEFAULT_RENDER_URL = 'https://render.flatwrite.md/render';

/**
 * Public, MCP-friendly render style. These names match the wording in the
 * FlatWrite editor UI ("Font family", "UI framework", "Page size") so
 * agents picking options can map intent to field directly.
 */
export type RenderStyle = {
  framework?: string;
  fontFamily?: string;
  fontSize?: string | number;
  fontWeight?: string | number;
  lineHeight?: string | number;
  uiZoom?: number;
  pageSize?: string;
  orientation?: string;
  marginsLR?: string;
  marginsTB?: string;
  footer?: boolean | string;
  width?: number;
  docEngine?: string;
  surfaceMode?: string;
  theme?: string;
};

/**
 * Canonical FlatWrite render style — the keys the editor's
 * buildShareYaml() writes and the renderer's resolveRenderOptions()
 * reads. Public MCP clients don't see these names.
 */
export type CanonicalRenderStyle = {
  font?: string;
  size?: string | number;
  weight?: string | number;
  line?: string | number;
  appFramework?: string;
  pageSize?: string;
  orientation?: string;
  marginsLR?: string;
  marginsTB?: string;
  footer?: boolean | string;
  width?: number;
  docEngine?: string;
  surfaceMode?: string;
  theme?: string;
  fontSize?: string | number;
  fontWeight?: string | number;
  lineHeight?: string | number;
  uiZoom?: number;
  framework?: string;
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
  apiKey: string;  baseUrl?: string;
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

/**
 * Translate the public MCP-facing style into the canonical FlatWrite
 * renderer style. Delegates to the shared translator so the page-side
 * WebMCP tool and the server transports cannot drift.
 *
 * This wrapper re-asserts the typed public/canonical shapes for callers
 * inside the TypeScript server.
 */
export function toCanonicalStyle(publicStyle: RenderStyle = {}): CanonicalRenderStyle {
  return sharedToCanonicalStyle(publicStyle) as CanonicalRenderStyle;
}

/**
 * Names of the fonts that have a woff2 file bundled. Mirrors
 * `core/font-inventory.js` and `core/document-css.js`'s COMFORT_FONTS.
 * Used by the MCP tool handlers to validate `fontFamily` before
 * forwarding — so the agent gets an immediate structured error
 * instead of an upstream render that silently picks the system fallback.
 *
 * The list is the single source of truth in `shared/mcpShared.ts`; we
 * expose it as a Set here for backward compatibility with existing
 * callers.
 */
export const ALLOWED_FONT_FAMILIES: ReadonlySet<string> = new Set(SHARED_ALLOWED_FONTS);

/**
 * Build the JSON body for a raw-markdown render, translating the
 * public style to canonical names and stripping undefined fields.
 * Thin wrapper around the shared builder that re-asserts the public
 * RenderStyle type.
 */
export function buildRawMarkdownBody(
  markdown: string,
  style: RenderStyle = {},
): Record<string, unknown> {
  return sharedBuildRawMarkdownBody(markdown, style);
}

/**
 * Build the JSON body for a remote-markdown render, translating the
 * public style to canonical names and stripping undefined fields.
 * Thin wrapper around the shared builder that re-asserts the public
 * RenderStyle type.
 */
export function buildRemoteMarkdownBody(
  url: string,
  style: RenderStyle = {},
): Record<string, unknown> {
  return sharedBuildRemoteMarkdownBody(url, style);
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
