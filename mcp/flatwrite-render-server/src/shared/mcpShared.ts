/**
 * Shared MCP constants and helpers used by all FlatWrite render MCP
 * surfaces: the stdio/streamable HTTP server, the Cloudflare Worker,
 * and the WebMCP page-side script.
 *
 * Keeping a single source of truth for `toCanonicalStyle`, the font
 * allowlist, and the markdown URL allowlist prevents the browser-side
 * WebMCP tool and the server-side transports from drifting apart as
 * new options are added.
 */

/**
 * Font families that have bundled woff2 files. Mirrors
 * core/font-inventory.js. A build-time/regression test verifies this
 * stays in sync with the canonical font inventory.
 */
export const ALLOWED_FONT_FAMILIES = [
  'Inter',
  'JetBrains Mono',
  'Lato',
  'Lora',
  'Merriweather',
  'Playfair Display',
  'Comfortaa',
  'Unbounded',
] as const;

export type AllowedFontFamily = (typeof ALLOWED_FONT_FAMILIES)[number];

/**
 * Hosts from which render_markdown_from_url may fetch raw markdown.
 */
export const ALLOWED_MARKDOWN_HOSTS = [
  'raw.githubusercontent.com',
  'raw.gitlab.com',
  'bitbucket.org',
] as const;

export type AllowedMarkdownHost = (typeof ALLOWED_MARKDOWN_HOSTS)[number];

/**
 * Translate the public RenderStyle (fontFamily / framework / fontSize / ...)
 * to the canonical FlatWrite render frontmatter (font / appFramework / size
 * / ...). Strings are scale tokens; numbers are absolute values.
 *
 * Mirrors the public-facing tool schemas in renderMarkdown.ts and
 * renderMarkdownFromUrl.ts, and the page-side WebMCP tool schema.
 */
export function toCanonicalStyle(publicStyle: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (publicStyle == null) return out;

  if (publicStyle.fontFamily != null) out.font = String(publicStyle.fontFamily);
  if (publicStyle.framework != null) out.appFramework = String(publicStyle.framework);

  if (publicStyle.fontSize != null) {
    if (typeof publicStyle.fontSize === 'string') out.size = publicStyle.fontSize;
    else out.fontSize = publicStyle.fontSize;
  }

  if (publicStyle.fontWeight != null) {
    if (typeof publicStyle.fontWeight === 'string') out.weight = publicStyle.fontWeight;
    else out.fontWeight = publicStyle.fontWeight;
  }

  if (publicStyle.lineHeight != null) {
    if (typeof publicStyle.lineHeight === 'string') out.line = publicStyle.lineHeight;
    else out.lineHeight = publicStyle.lineHeight;
  }

  for (const k of [
    'docEngine', 'surfaceMode', 'pageSize', 'orientation',
    'marginsLR', 'marginsTB', 'footer', 'width', 'theme',
  ]) {
    if (publicStyle[k] != null) out[k] = publicStyle[k];
  }

  // uiZoom is editor-only for now; not forwarded.
  return out;
}

export type MarkdownUrlValidation =
  | { ok: true; url: string }
  | { ok: false; code: string; message: string };

/**
 * Pre-flight check for render_markdown_from_url URLs. Only allowlisted
 * hosts and http(s) schemes are accepted.
 */
export function validateMarkdownUrl(rawUrl: string): MarkdownUrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, code: 'INVALID_URL', message: 'url is not a valid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'UNSUPPORTED_SCHEME',
      message: `url must use http or https (got ${parsed.protocol})`,
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_MARKDOWN_HOSTS.includes(host as AllowedMarkdownHost)) {
    return {
      ok: false,
      code: 'DISALLOWED_HOST',
      message: `host '${host}' is not on the markdown URL allowlist`,
    };
  }

  return { ok: true, url: parsed.toString() };
}

export type FontValidation =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Pre-flight check for fontFamily. Only bundled fonts are accepted so the
 * caller gets an immediate structured error instead of a downstream render
 * that silently falls back to the system font.
 */
export function validateFontFamily(fontFamily: unknown): FontValidation {
  if (fontFamily == null) return { ok: true };
  const name = String(fontFamily);
  if (ALLOWED_FONT_FAMILIES.includes(name as AllowedFontFamily)) return { ok: true };
  return {
    ok: false,
    code: 'INVALID_FONT_FAMILY',
    message: `fontFamily '${name}' is not one of the bundled fonts (${ALLOWED_FONT_FAMILIES.join(', ')})`,
  };
}
