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

import { sanitizeDetail, sanitizeRenderErrorPayload } from './tools/sanitize.js';
import { FONT_INVENTORY } from '../../../core/font-inventory.js';

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

/** Strip undefined fields so the wire payload stays clean. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function isDefined<T>(v: T | undefined | null): v is T {
  return v !== undefined && v !== null;
}

/**
 * Translate the public MCP-facing style into the canonical FlatWrite
 * renderer style. Each public field maps 1:1 to a canonical key. When
 * both the public and canonical form of a key are present (e.g. both
 * `fontFamily` and `font`), the public form wins — it's what the caller
 * just specified.
 *
 * This function is intentionally a pure data transformer with no side
 * effects, so it can be unit-tested without HTTP.
 */
export function toCanonicalStyle(publicStyle: RenderStyle = {}): CanonicalRenderStyle {
  const out: CanonicalRenderStyle = {};

  // fontFamily is the friendly name; the renderer reads `font`.
  if (isDefined(publicStyle.fontFamily)) out.font = String(publicStyle.fontFamily);

  // framework → appFramework
  if (isDefined(publicStyle.framework)) out.appFramework = String(publicStyle.framework);

  // fontSize / fontWeight / lineHeight are the friendly absolute-value
  // aliases. The canonical renderer has two parallel fields: `size` /
  // `weight` / `line` accept SCALE INDICES (looked up in a token table)
  // and `fontSize` / `fontWeight` / `lineHeight` accept ABSOLUTE PIXEL
  // VALUES. We pick the right one based on the friendly input's type:
  //   - string → scale index (matches the editor's buildShareYaml)
  //   - number → absolute pixel value
  // This way the same MCP tool call produces the same rendered output
  // as the editor's equivalent YAML frontmatter.
  if (isDefined(publicStyle.fontSize)) {
    if (typeof publicStyle.fontSize === 'string') {
      out.size = publicStyle.fontSize;
    } else {
      out.fontSize = publicStyle.fontSize;
    }
  }
  if (isDefined(publicStyle.fontWeight)) {
    if (typeof publicStyle.fontWeight === 'string') {
      out.weight = publicStyle.fontWeight;
    } else {
      out.fontWeight = publicStyle.fontWeight;
    }
  }
  if (isDefined(publicStyle.lineHeight)) {
    if (typeof publicStyle.lineHeight === 'string') {
      out.line = publicStyle.lineHeight;
    } else {
      out.lineHeight = publicStyle.lineHeight;
    }
  }

  // Paged-media controls — same name on both sides.
  for (const k of [
    'pageSize',
    'orientation',
    'marginsLR',
    'marginsTB',
    'footer',
    'width',
    'docEngine',
    'surfaceMode',
  ] as const) {
    if (isDefined(publicStyle[k])) out[k] = publicStyle[k] as never;
  }

  // uiZoom is editor-only for now (not read by resolveRenderOptions);
  // keep it on the public MCP shape for forward-compat but don't forward.
  return out;
}

/**
 * Names of the fonts that have a woff2 file bundled. Mirrors
 * `core/font-inventory.js` and `core/document-css.js`'s COMFORT_FONTS.
 * Used by the MCP tool handlers to validate `fontFamily` before
 * forwarding — so the agent gets an immediate structured error
 * instead of an upstream render that silently picks the system fallback.
 */
export const ALLOWED_FONT_FAMILIES: ReadonlySet<string> = new Set(
  Object.keys(FONT_INVENTORY),
);

/**
 * Build the JSON body for a raw-markdown render, translating the
 * public style to canonical names and stripping undefined fields.
 */
export function buildRawMarkdownBody(
  markdown: string,
  style: RenderStyle = {},
): Record<string, unknown> {
  const canonical = toCanonicalStyle(style);
  return compact({ markdown, ...canonical });
}

/**
 * Build the JSON body for a remote-markdown render, translating the
 * public style to canonical names and stripping undefined fields.
 */
export function buildRemoteMarkdownBody(
  url: string,
  style: RenderStyle = {},
): Record<string, unknown> {
  const canonical = toCanonicalStyle(style);
  return compact({ markdownUrl: url, ...canonical });
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
