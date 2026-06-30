/// <reference lib="dom" />

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
 * Hosts from which the consolidated render_markdown tool may fetch raw markdown.
 */
export const ALLOWED_MARKDOWN_HOSTS = [
  'raw.githubusercontent.com',
  'raw.gitlab.com',
  'bitbucket.org',
] as const;

export type AllowedMarkdownHost = (typeof ALLOWED_MARKDOWN_HOSTS)[number];

/**
 * UI frameworks offered by the editor's "App surface" mode. Mirrors
 * the APP_FRAMEWORKS registry in public/app.js. When you add or
 * remove a framework there, mirror it here so the tool schema stays
 * accurate — callers see a hard validation error for unknown values
 * instead of a silent fallback.
 */
export const ALLOWED_APP_FRAMEWORKS = [
  'spectre',
  'poshui',
  'pico',
  'milligram',
  'chota',
] as const;

export type AllowedAppFramework = (typeof ALLOWED_APP_FRAMEWORKS)[number];

/**
 * Document engines. Mirrors the DOC_ENGINES registry in public/app.js
 * (none / pagedjs / vivliostyle). The Worker / MCP layer historically
 * collapsed pagedjs+vivliostyle into a single "paged" bucket; today
 * callers can pick any of the three explicitly.
 */
export const ALLOWED_DOC_ENGINES = ['none', 'pagedjs', 'vivliostyle'] as const;
export type AllowedDocEngine = (typeof ALLOWED_DOC_ENGINES)[number];

/**
 * Surface modes. Today the render pipeline is identical between doc
 * and app; the difference is which downstream tooling consumes the
 * output. The "app" surfaceMode unlocks the appFramework picker.
 */
export const ALLOWED_SURFACE_MODES = ['doc', 'app'] as const;
export type AllowedSurfaceMode = (typeof ALLOWED_SURFACE_MODES)[number];

/**
 * Page sizes exposed by the editor's Page Size selector. Some of
 * these (A0/A1/A2) are rendered as letterboxed canvases in the
 * editor preview but still emit valid CSS @page rules.
 */
export const ALLOWED_PAGE_SIZES = [
  'A0',
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'Letter',
  'Legal',
] as const;
export type AllowedPageSize = (typeof ALLOWED_PAGE_SIZES)[number];

/** Page orientations. */
export const ALLOWED_ORIENTATIONS = ['portrait', 'landscape'] as const;
export type AllowedOrientation = (typeof ALLOWED_ORIENTATIONS)[number];

/** Page-margin presets. Mirrors the MARGIN_MAP in core/doc-engines.js. */
export const ALLOWED_MARGINS = ['narrow', 'normal', 'wide'] as const;
export type AllowedMargin = (typeof ALLOWED_MARGINS)[number];

/**
 * Shared error envelope. Every tool that can fail returns this shape
 * with `ok: false` instead of a success payload. Agents and graders
 * can branch on `ok` to determine whether to read `error` or the
 * tool-specific success fields.
 */
export const ERROR_SCHEMA = {
  type: 'object',
  title: 'ToolError',
  description: 'Typed error response returned when a tool fails.',
  required: ['ok', 'error'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', enum: [false], description: 'Always false for error responses.' },
    error: {
      type: 'object',
      description: 'Structured error details.',
      required: ['code', 'message'],
      additionalProperties: false,
      properties: {
        code: { type: 'string', description: 'Machine-readable error code (e.g. INVALID_MARKDOWN, DISALLOWED_HOST).' },
        message: { type: 'string', description: 'Human-readable error message.' },
        retryable: { type: 'boolean', description: 'Whether the agent should retry the call.' },
      },
    },
  },
} as const;

/**
 * Output shape every render tool returns. Uses a discriminated pattern
 * with `ok`, `kind`, `document` metadata, `artifacts` containing the
 * concrete HTML fragments, and a `warnings` array. Agents branch on
 * `ok` first, then `kind` to determine which artifact fields are present.
 */
export const RENDER_OUTPUT_SCHEMA = {
  type: 'object',
  title: 'RenderOutput',
  description: 'Rendered markdown as self-contained HTML fragments with document metadata.',
  required: ['ok', 'kind', 'artifacts'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'True on successful render.' },
    kind: { type: 'string', enum: ['html'], description: 'Result modality — always "html" for render_markdown.' },
    document: {
      type: 'object',
      description: 'Metadata about the rendered document.',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Best-effort title extracted from the first H1 or filename.' },
        wordCount: { type: 'number', description: 'Approximate word count of the source markdown.' },
        charCount: { type: 'number', description: 'Character count of the source markdown.' },
      },
    },
    artifacts: {
      type: 'object',
      description: 'Concrete render artifacts.',
      required: ['head', 'body'],
      additionalProperties: false,
      properties: {
        head: {
          type: 'string',
          description:
            'Self-contained <head> fragment: inlined @font-face declarations, document CSS, ' +
            'and an optional <script defer> tag for the chosen docEngine. Inject verbatim ' +
            'into the consumer page\'s <head>.',
        },
        body: {
          type: 'string',
          description:
            'Self-contained <body> fragment: the rendered markdown wrapped in ' +
            '<body class="fw-render" data-theme="..."><main>...</main></body>. Inject ' +
            'verbatim into the consumer page\'s <body>.',
        },
      },
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Non-fatal warnings (e.g. unknown options ignored, URL size cap approached).',
    },
  },
} as const;

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
 * Pre-flight check for markdownUrl values used by the consolidated
 * render_markdown tool. Only allowlisted hosts and http(s) schemes are accepted.
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

/** Strip undefined fields so the wire payload stays clean. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/**
 * Build the JSON body for a raw-markdown render, translating the
 * public style to canonical names and stripping undefined fields.
 */
export function buildRawMarkdownBody(
  markdown: string,
  publicStyle: Record<string, unknown> = {},
): Record<string, unknown> {
  return compact({ markdown, ...toCanonicalStyle(publicStyle) });
}

/**
 * Build the JSON body for a remote-markdown render, translating the
 * public style to canonical names and stripping undefined fields.
 */
export function buildRemoteMarkdownBody(
  markdownUrl: string,
  publicStyle: Record<string, unknown> = {},
): Record<string, unknown> {
  return compact({ markdownUrl, ...toCanonicalStyle(publicStyle) });
}

const MAX_DETAIL_CHARS = 160;

const REDACTED = '[redacted]';

/** Run a single regex replacement and return the result. */
function redact(input: string, re: RegExp, replacement: string): string {
  return input.replace(re, replacement);
}

/**
 * Scrub a string so it can safely be returned to an MCP client.
 * Returns a sanitized summary; never throws.
 */
export function sanitizeDetail(input: unknown): string {
  if (input == null) return '';
  const raw = typeof input === 'string' ? input : String(input);
  if (!raw) return '';

  let s = raw;

  // 1. Authorization-style headers and inline secrets.
  s = redact(
    s,
    /\b(Bearer|Basic|ApiKey|X-Api-Key|Authorization|Token)\s+[A-Za-z0-9._\-+/=]+/gi,
    `$1 ${REDACTED}`,
  );

  // 2. Long hex blobs (>=32 hex chars) — covers API keys, HMAC sigs, IDs.
  s = redact(s, /\b[0-9a-f]{32,}\b/gi, REDACTED);

  // 3. Long base64-looking blobs (>=40 chars of base64 alphabet).
  s = redact(s, /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, REDACTED);

  // 4. URLs with query strings or fragments — often carry tokens/ids.
  s = redact(s, /\bhttps?:\/\/[^\s)>'"]+[?#][^\s)>'"]+/gi, '[url]');

  // 5. Bare IPv4 addresses.
  s = redact(
    s,
    /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    '[ip]',
  );

  // 6. Node-style stack frames.
  s = redact(s, /\s+at\s+[^\n]+:\d+:\d+/g, '');
  s = redact(s, /\s+at\s+[^\n]+\.(?:js|ts|mjs|cjs):\d+:\d+/g, '');

  // 7. "Error:" prefix lines.
  s = redact(s, /^[A-Za-z_][A-Za-z0-9_]*Error:\s*/gm, '');

  // 8. Local filesystem path segments.
  s = redact(s, /(?:\/Users\/|\/home\/|C:\\\\)[^\s'")\]]+/g, '[path]');
  s = redact(s, /(?:\.\/|\.\.\/)[^\s'"\)\]]+\.(?:js|ts|mjs|cjs|json)\b/g, '[path]');

  // 9. Collapse whitespace introduced by removals.
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // 10. Cap the final length.
  if (s.length > MAX_DETAIL_CHARS) {
    s = s.slice(0, MAX_DETAIL_CHARS).trimEnd() + '…';
  }

  return s;
}

/**
 * Sanitize a JSON error payload coming back from the upstream renderer.
 * Preserves `error`, `code`, and `retryAfter` (the public contract) but
 * scrubs `detail` (which can carry upstream noise).
 */
export function sanitizeRenderErrorPayload<T extends object>(payload: T): T {
  if (payload && typeof payload === 'object' && 'detail' in payload) {
    const rawDetail = (payload as { detail: unknown }).detail;
    const cleanDetail = sanitizeDetail(rawDetail);
    return { ...payload, detail: cleanDetail || undefined };
  }
  return payload;
}

/* ── Tool manifest schema source ───────────────────────────────────────── */

/**
 * JSON-Schema fragment for one canonical input field. These are
 * composed into per-tool `inputSchema.properties` blocks by
 * `generateManifest()`. Keeping each field as a single record means
 * adding a new tool is one entry in `RENDER_TOOLS` rather than a
 * schema edit per field.
 *
 * Fields live under their CANONICAL name (what the renderer reads),
 * not their friendly alias — that mapping lives in each tool's
 * `displayHints.inputFieldAliases`.
 */
export interface InputFieldSpec {
  /** Canonical field name. */
  readonly name: string;
  /** JSON-Schema type for this field. */
  readonly type: 'string' | 'number' | 'boolean';
  /** Human-readable description for agents reading the manifest. */
  readonly description: string;
  /** Restrict to a set of values (strict enum). */
  readonly enum?: readonly string[];
  /** Suggested values for free-form string fields. Less strict than enum. */
  readonly examples?: readonly string[];
  /**
   * Allow either a scale-token string OR an absolute numeric value.
   * Mirrors how the renderer disambiguates size/weight/line vs
   * fontSize/fontWeight/lineHeight (see toCanonicalStyle).
   */
  readonly oneOf?: ReadonlyArray<{ type: 'string' | 'number'; description: string }>;
  /** Numeric range (inclusive) — wire into JSON-Schema minimum/maximum. */
  readonly minimum?: number;
  readonly maximum?: number;
}

/**
 * Canonical input fields shared across Docs render tools. Order here
 * is the order the manifest will emit them in (some agents are
 * order-sensitive in their UI).
 *
 * Enum/range hints mirror the runtime allowlists (see the
 * ALLOWED_* constants above) so callers see a structured validation
 * error before round-tripping to the server. Keep these in sync with
 * public/app.js and core/* when those registries change.
 */
export const RENDER_INPUT_FIELDS: readonly InputFieldSpec[] = [
  {
    name: 'font',
    type: 'string',
    description: 'Font family — must be a bundled family.',
    enum: ALLOWED_FONT_FAMILIES,
  },
  {
    name: 'appFramework',
    type: 'string',
    description: 'UI framework applied when surfaceMode="app".',
    enum: ALLOWED_APP_FRAMEWORKS,
  },
  {
    name: 'size',
    type: 'string',
    description: 'Font size as a scale token (e.g. "-1", "0", "1").',
    oneOf: [
      { type: 'string', description: 'Scale token (e.g. "-1", "0", "1")' },
      { type: 'number', description: 'Absolute pixel value (8..72)' },
    ],
    minimum: 8,
    maximum: 72,
  },
  {
    name: 'weight',
    type: 'string',
    description: 'Font weight as a scale token (e.g. "-1", "0").',
    oneOf: [
      { type: 'string', description: 'Scale token (e.g. "-1", "0")' },
      { type: 'number', description: 'Absolute weight (100..900, multiples of 100)' },
    ],
    minimum: 100,
    maximum: 900,
  },
  {
    name: 'line',
    type: 'string',
    description: 'Line height as a scale token (e.g. "-1", "0", "1").',
    oneOf: [
      { type: 'string', description: 'Scale token (e.g. "-1", "0", "1")' },
      { type: 'number', description: 'Absolute multiplier (0.8..4.0)' },
    ],
    minimum: 0.8,
    maximum: 4.0,
  },
  {
    name: 'uiZoom',
    type: 'number',
    description: 'UI zoom level (1.0 = default; >1 zooms in, <1 zooms out).',
    minimum: 0.25,
    maximum: 4.0,
  },
  {
    name: 'pageSize',
    type: 'string',
    description: 'Page size for paged output. Only effective when docEngine is pagedjs or vivliostyle.',
    enum: ALLOWED_PAGE_SIZES,
  },
  {
    name: 'orientation',
    type: 'string',
    description: 'Page orientation.',
    enum: ALLOWED_ORIENTATIONS,
  },
  {
    name: 'marginsLR',
    type: 'string',
    description: 'Left/right page margin preset. Only effective when docEngine is pagedjs or vivliostyle.',
    enum: ALLOWED_MARGINS,
  },
  {
    name: 'marginsTB',
    type: 'string',
    description: 'Top/bottom page margin preset. Only effective when docEngine is pagedjs or vivliostyle.',
    enum: ALLOWED_MARGINS,
  },
  {
    name: 'footer',
    type: 'boolean',
    description: 'Include a page-number footer in paged output.',
  },
  {
    name: 'width',
    type: 'number',
    description: 'Content width in pixels (400..1400). Only effective when docEngine="none".',
    minimum: 400,
    maximum: 1400,
  },
  {
    name: 'docEngine',
    type: 'string',
    description: 'Document engine — "none" emits plain CSS; "pagedjs"/"vivliostyle" wrap the output in @page rules.',
    enum: ALLOWED_DOC_ENGINES,
  },
  {
    name: 'surfaceMode',
    type: 'string',
    description: 'Surface mode hint. "app" unlocks the appFramework picker; otherwise this is metadata only.',
    enum: ALLOWED_SURFACE_MODES,
  },
  {
    name: 'theme',
    type: 'string',
    description:
      'Theme identifier rendered as body[data-theme="..."] so consumer CSS can theme via attribute selectors. ' +
      'Free-form (alphanumeric, dash, underscore) — common values are "light" and "dark".',
  },
] as const;

/**
 * Tool surface. Adding a new surface means a new value here, a new
 * `RENDER_TOOLS_<SURFACE>` array, and a new `generateManifestFor*()`
 * config (or extend `generateManifest()` to take a surface argument).
 * Today only "doc" has tools; "app" is reserved.
 */
export type SurfaceMode = 'doc' | 'app';

/**
 * Tool descriptor. Each entry maps to one MCP tool that an agent can
 * call. The `inputFields` list contains canonical names from
 * `RENDER_INPUT_FIELDS` (style options shared across tools) OR
 * inline `InputFieldSpec` records for tool-local fields (e.g. the
 * primary payload like `markdown` or `markdownUrl`). The generator
 * composes the JSON-Schema `properties` block from both kinds.
 */
export type ToolCategory = 'render' | 'discovery' | 'lifecycle' | 'export' | 'share';

export interface ToolSpec {
  /** Tool name (used in MCP `tools/call` and WebMCP `registerTool`). */
  readonly name: string;
  /** Human-readable description; shown to agents at discovery time. */
  readonly description: string;
  /** Which surface this tool belongs to. */
  readonly surfaceMode: SurfaceMode;
  /** Functional category — used for route-aware tool exposure and test assertions. */
  readonly category: ToolCategory;
  /**
   * Input field descriptors. Each entry is either a string (canonical
   * field name looked up in `RENDER_INPUT_FIELDS`) or an inline
   * `InputFieldSpec` for tool-local fields.
   */
  readonly inputFields: ReadonlyArray<string | InputFieldSpec>;
  /** Canonical field names that are required. */
  readonly requiredFields: readonly string[];
  /**
   * Mutually-exclusive required groups. Use this when the tool accepts
   * one of several alternative inputs (e.g. markdown OR markdownUrl).
   * Emitted as JSON-Schema `oneOf: [{ required: [...] }, ...]`.
   */
  readonly requiredOneOf?: readonly (readonly string[])[];
  /**
   * JSON-Schema describing the tool's success response shape. When
   * omitted the manifest leaves `outputSchema` absent (legacy
   * behaviour). Tools without a declared output shape still work,
   * but agents reading the manifest can't pre-validate returned data.
   */
  readonly outputSchema?: Record<string, unknown>;
  /** Behavioural annotations (MCP standard). */
  readonly annotations: { readonly readOnlyHint?: boolean };
  /**
   * Friendly-name → canonical-name map for this tool's inputs.
   * Tells a UI layer how to label fields when displaying the tool.
   */
  readonly displayHints: {
    readonly inputFieldAliases: Readonly<Record<string, string>>;
  };
}

export const RENDER_OPTIONS_OUTPUT_SCHEMA = {
  type: 'object',
  title: 'RenderOptionsOutput',
  description: 'Supported values for the render_markdown tool, wrapped in a discriminated envelope.',
  required: ['ok', 'options'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Always true for successful options listing.' },
    options: {
      type: 'object',
      description: 'Supported enum values for each render option category.',
      required: ['fonts', 'frameworks', 'docEngines', 'pageSizes', 'orientations', 'margins', 'surfaceModes'],
      additionalProperties: false,
      properties: {
        fonts: { type: 'array', items: { type: 'string' }, description: 'Bundled font families that can be passed as fontFamily.' },
        frameworks: { type: 'array', items: { type: 'string' }, description: 'UI frameworks that can be passed as framework when surfaceMode is "app".' },
        docEngines: { type: 'array', items: { type: 'string' }, description: 'Document engines that can be passed as docEngine.' },
        pageSizes: { type: 'array', items: { type: 'string' }, description: 'Page size presets that can be passed as pageSize.' },
        orientations: { type: 'array', items: { type: 'string' }, description: 'Page orientations that can be passed as orientation.' },
        margins: { type: 'array', items: { type: 'string' }, description: 'Page margin presets that can be passed as marginsLR or marginsTB.' },
        surfaceModes: { type: 'array', items: { type: 'string' }, description: 'Surface mode hints that can be passed as surfaceMode.' },
      },
    },
    defaults: {
      type: 'object',
      description: 'Default values used when an option is omitted.',
      additionalProperties: false,
      properties: {
        font: { type: 'string', description: 'Default font family.' },
        docEngine: { type: 'string', description: 'Default document engine.' },
        surfaceMode: { type: 'string', description: 'Default surface mode.' },
        pageSize: { type: 'string', description: 'Default page size.' },
        orientation: { type: 'string', description: 'Default orientation.' },
      },
    },
  },
} as const;

/* ── Lifecycle / export / share output schemas ─────────────────────────── */

export const DOCUMENT_STATE_OUTPUT_SCHEMA = {
  type: 'object',
  title: 'DocumentStateOutput',
  description: 'Current state of the active document in the FlatWrite editor.',
  required: ['ok', 'documentId', 'title', 'wordCount', 'unsavedChanges', 'url'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Always true on success.' },
    documentId: { type: 'string', description: 'Stable identifier for the active document.' },
    title: { type: 'string', description: 'Best-effort title from the first H1 or document URL.' },
    wordCount: { type: 'number', description: 'Approximate word count of the current markdown.' },
    charCount: { type: 'number', description: 'Character count of the current markdown.' },
    unsavedChanges: { type: 'boolean', description: 'Whether the editor content differs from the last loaded/saved state.' },
    renderMode: { type: 'string', enum: ['edit', 'preview', 'read'], description: 'Current editor mode.' },
    docEngine: { type: 'string', enum: [...ALLOWED_DOC_ENGINES], description: 'Active document engine.' },
    surfaceMode: { type: 'string', enum: [...ALLOWED_SURFACE_MODES], description: 'Active surface mode.' },
    url: { type: 'string', description: 'Canonical URL of the current document (share URL or source URL, empty if new).' },
    availableExports: { type: 'array', items: { type: 'string', enum: ['html', 'pdf', 'markdown'] }, description: 'Export formats available for the current document.' },
    canShare: { type: 'boolean', description: 'Whether the document is small enough to share via URL.' },
  },
} as const;

export const CREATE_DOCUMENT_OUTPUT_SCHEMA = {
  type: 'object',
  title: 'CreateDocumentOutput',
  description: 'Result of creating a new document.',
  required: ['ok', 'documentId', 'title', 'url'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Always true on success.' },
    documentId: { type: 'string', description: 'Stable identifier for the new document.' },
    title: { type: 'string', description: 'Title of the new document.' },
    url: { type: 'string', description: 'URL of the new document (empty for a blank document).' },
    nextSuggestedTool: { type: 'string', description: 'Suggested next tool to call (e.g. update_document_content).' },
  },
} as const;

export const OPEN_DOCUMENT_OUTPUT_SCHEMA = {
  type: 'object',
  title: 'OpenDocumentOutput',
  description: 'Result of opening an existing document.',
  required: ['ok', 'documentId', 'title', 'url', 'active'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Always true on success.' },
    documentId: { type: 'string', description: 'Stable identifier for the opened document.' },
    title: { type: 'string', description: 'Title of the opened document.' },
    url: { type: 'string', description: 'URL of the opened document.' },
    active: { type: 'boolean', description: 'Whether the document is now the active document in the editor.' },
    nextSuggestedTool: { type: 'string', description: 'Suggested next tool to call (e.g. get_document_state).' },
  },
} as const;

export const UPDATE_DOCUMENT_OUTPUT_SCHEMA = {
  type: 'object',
  title: 'UpdateDocumentOutput',
  description: 'Result of updating document content.',
  required: ['ok', 'documentId', 'updatedAt', 'stateVersion'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Always true on success.' },
    documentId: { type: 'string', description: 'Stable identifier for the updated document.' },
    updatedAt: { type: 'string', description: 'ISO 8601 timestamp of the update.' },
    stateVersion: { type: 'number', description: 'Monotonic revision number for optimistic concurrency.' },
    nextSuggestedTool: { type: 'string', description: 'Suggested next tool to call (e.g. render_markdown_preview).' },
  },
} as const;

export const LIST_RECENT_OUTPUT_SCHEMA = {
  type: 'object',
  title: 'ListRecentDocumentsOutput',
  description: 'List of recently opened documents.',
  required: ['ok', 'documents'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Always true on success.' },
    documents: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          documentId: { type: 'string', description: 'Stable identifier for the document.' },
          title: { type: 'string', description: 'Best-effort title.' },
          url: { type: 'string', description: 'Source URL or share URL.' },
          updatedAt: { type: 'string', description: 'ISO 8601 timestamp of last modification.' },
        },
      },
      description: 'Recent documents, most recent first.',
    },
  },
} as const;

export const RENDER_PREVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  title: 'RenderPreviewOutput',
  description: 'Result of rendering markdown into the editor preview pane.',
  required: ['ok', 'kind'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Always true on success.' },
    kind: { type: 'string', enum: ['preview'], description: 'Result modality — always "preview".' },
    documentId: { type: 'string', description: 'Stable identifier for the previewed document.' },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Non-fatal warnings.' },
  },
} as const;

export const EXPORT_HTML_OUTPUT_SCHEMA = {
  type: 'object',
  title: 'ExportHtmlOutput',
  description: 'Result of exporting the document as HTML.',
  required: ['ok', 'documentId', 'format'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Always true on success.' },
    documentId: { type: 'string', description: 'Stable identifier for the exported document.' },
    format: { type: 'string', enum: ['html'], description: 'Export format — always "html".' },
    downloadUrl: { type: 'string', description: 'Blob URL of the exported HTML (temporary, valid for the session).' },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Non-fatal warnings.' },
  },
} as const;

export const EXPORT_PDF_OUTPUT_SCHEMA = {
  type: 'object',
  title: 'ExportPdfOutput',
  description: 'Result of exporting the document as PDF (via browser print dialog).',
  required: ['ok', 'documentId', 'format'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Always true on success.' },
    documentId: { type: 'string', description: 'Stable identifier for the exported document.' },
    format: { type: 'string', enum: ['pdf'], description: 'Export format — always "pdf".' },
    pageCount: { type: 'number', description: 'Number of pages in the rendered output, if known.' },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Non-fatal warnings.' },
  },
} as const;

export const SHARE_LINK_OUTPUT_SCHEMA = {
  type: 'object',
  title: 'ShareLinkOutput',
  description: 'Result of creating a shareable URL for the document.',
  required: ['ok', 'documentId', 'shareUrl'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Always true on success.' },
    documentId: { type: 'string', description: 'Stable identifier for the shared document.' },
    shareUrl: { type: 'string', description: 'Shareable URL that loads the document in the FlatWrite editor.' },
    expiresAt: { type: 'string', description: 'ISO 8601 timestamp when the share link expires.' },
  },
} as const;

export const EXPORT_STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  title: 'ExportStatusOutput',
  description: 'Status of an asynchronous export job. Today FlatWrite exports are synchronous, so status is always "completed" and downloadUrl is omitted.',
  required: ['ok', 'jobId', 'status'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Always true on success.' },
    jobId: { type: 'string', description: 'Identifier for the export job.' },
    status: { type: 'string', enum: ['pending', 'completed', 'failed'], description: 'Current job status.' },
    downloadUrl: { type: 'string', description: 'Download URL when status is "completed" and an async artifact exists. Omitted for synchronous exports.' },
  },
} as const;

export const RENDER_TOOLS_DOCS: readonly ToolSpec[] = [
  {
    name: 'render_markdown',
    description:
      'Render markdown into FlatWrite-styled HTML <head> and <body> fragments, with optional ' +
      'typography and page-layout controls. Provide either the raw markdown inline (`markdown`) ' +
      'or an allowlisted URL (`markdownUrl`) pointing to raw markdown content. Use this when you ' +
      'need the rendered HTML artifacts; use render_markdown_preview when you want to see the ' +
      'result in the editor preview pane.',
    surfaceMode: 'doc',
    category: 'render',
    inputFields: [
      { name: 'markdown', type: 'string', description: 'Raw markdown content to render.' },
      {
        name: 'markdownUrl',
        type: 'string',
        description:
          'URL pointing to raw markdown content. Must be on an allowlisted host ' +
          '(raw.githubusercontent.com, raw.gitlab.com, bitbucket.org), http(s) only, ' +
          'and <=1 MB. Host validation is enforced server-side.',
      },
      ...RENDER_INPUT_FIELDS.map((f) => f.name as string),
    ],
    requiredFields: [],
    requiredOneOf: [['markdown'], ['markdownUrl']],
    outputSchema: RENDER_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true },
    displayHints: {
      inputFieldAliases: {
        font: 'fontFamily',
        appFramework: 'framework',
        size: 'fontSize',
        weight: 'fontWeight',
        line: 'lineHeight',
      },
    },
  },
  {
    name: 'list_render_options',
    description:
      'Return the supported fonts, UI frameworks, document engines, page sizes, orientations, ' +
      'margins, and surface modes for the render_markdown tool. Call this before rendering if ' +
      'you need to know which enum values are valid; call render_markdown when you have the ' +
      'options and are ready to render.',
    surfaceMode: 'doc',
    category: 'discovery',
    inputFields: [],
    requiredFields: [],
    outputSchema: RENDER_OPTIONS_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true },
    displayHints: {
      inputFieldAliases: {},
    },
  },
  {
    name: 'get_document_state',
    description:
      'Return the current state of the active document in the FlatWrite editor: title, word count, ' +
      'render mode, unsaved changes flag, and available export formats. Use this before export or ' +
      'share tools to check readiness; use update_document_content to change the content.',
    surfaceMode: 'doc',
    category: 'lifecycle',
    inputFields: [],
    requiredFields: [],
    outputSchema: DOCUMENT_STATE_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true },
    displayHints: {
      inputFieldAliases: {},
    },
  },
  {
    name: 'create_document',
    description:
      'Create a new blank document in the FlatWrite editor, optionally with initial markdown content. ' +
      'Use this to start a new document; use open_document to load an existing one from a URL or ' +
      'share link.',
    surfaceMode: 'doc',
    category: 'lifecycle',
    inputFields: [
      { name: 'markdown', type: 'string', description: 'Optional initial markdown content for the new document.' },
      { name: 'title', type: 'string', description: 'Optional title for the new document.' },
    ],
    requiredFields: [],
    outputSchema: CREATE_DOCUMENT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false },
    displayHints: {
      inputFieldAliases: {},
    },
  },
  {
    name: 'open_document',
    description:
      'Open an existing document from a URL or share link in the FlatWrite editor. Use this to load ' +
      'a remote markdown file or a previously shared document; use create_document to start blank.',
    surfaceMode: 'doc',
    category: 'lifecycle',
    inputFields: [
      { name: 'url', type: 'string', description: 'URL of the markdown file or FlatWrite share link to open.' },
    ],
    requiredFields: ['url'],
    outputSchema: OPEN_DOCUMENT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false },
    displayHints: {
      inputFieldAliases: {},
    },
  },
  {
    name: 'update_document_content',
    description:
      'Update the markdown content of the active document in the FlatWrite editor. Use this to ' +
      'edit the document programmatically; use get_document_state to inspect the result.',
    surfaceMode: 'doc',
    category: 'lifecycle',
    inputFields: [
      { name: 'markdown', type: 'string', description: 'New markdown content for the document.' },
    ],
    requiredFields: ['markdown'],
    outputSchema: UPDATE_DOCUMENT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false },
    displayHints: {
      inputFieldAliases: {},
    },
  },
  {
    name: 'list_recent_documents',
    description:
      'Return a list of recently opened documents from the editor session. Use this to discover ' +
      'what the user has been working on; use open_document to load one.',
    surfaceMode: 'doc',
    category: 'lifecycle',
    inputFields: [],
    requiredFields: [],
    outputSchema: LIST_RECENT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true },
    displayHints: {
      inputFieldAliases: {},
    },
  },
  {
    name: 'render_markdown_preview',
    description:
      'Render markdown into the FlatWrite editor preview pane, applying current style and layout ' +
      'settings. Use this to see the rendered output in the editor; use render_markdown when you ' +
      'need the HTML artifacts without the preview.',
    surfaceMode: 'doc',
    category: 'render',
    inputFields: [
      { name: 'markdown', type: 'string', description: 'Optional markdown to preview. If omitted, previews the current editor content.' },
      ...RENDER_INPUT_FIELDS.map((f) => f.name as string),
    ],
    requiredFields: [],
    outputSchema: RENDER_PREVIEW_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false },
    displayHints: {
      inputFieldAliases: {
        font: 'fontFamily',
        appFramework: 'framework',
        size: 'fontSize',
        weight: 'fontWeight',
        line: 'lineHeight',
      },
    },
  },
  {
    name: 'export_document_html',
    description:
      'Export the active document as a self-contained HTML file and open it in a new tab. Use this ' +
      'when you need the full HTML document; use export_document_pdf for print-ready output.',
    surfaceMode: 'doc',
    category: 'export',
    inputFields: [],
    requiredFields: [],
    outputSchema: EXPORT_HTML_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false },
    displayHints: {
      inputFieldAliases: {},
    },
  },
  {
    name: 'export_document_pdf',
    description:
      'Export the active document as a PDF by triggering the browser print dialog with the rendered ' +
      'preview. Use this for print-ready output; use export_document_html for a downloadable HTML file.',
    surfaceMode: 'doc',
    category: 'export',
    inputFields: [],
    requiredFields: [],
    outputSchema: EXPORT_PDF_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false },
    displayHints: {
      inputFieldAliases: {},
    },
  },
  {
    name: 'create_share_link',
    description:
      'Create a shareable URL for the active document and copy it to the clipboard. Use this to ' +
      'share the document; the link expires after 30 days. Use get_document_state to check canShare ' +
      'before calling.',
    surfaceMode: 'doc',
    category: 'share',
    inputFields: [],
    requiredFields: [],
    outputSchema: SHARE_LINK_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false },
    displayHints: {
      inputFieldAliases: {},
    },
  },
  {
    name: 'get_export_status',
    description:
      'Return the status of an asynchronous export job. Use this after export_document_pdf or ' +
      'export_document_html if the export is queued or async; returns completed immediately for ' +
      'synchronous exports.',
    surfaceMode: 'doc',
    category: 'export',
    inputFields: [
      { name: 'jobId', type: 'string', description: 'Identifier of the export job to check.' },
    ],
    requiredFields: ['jobId'],
    outputSchema: EXPORT_STATUS_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true },
    displayHints: {
      inputFieldAliases: {},
    },
  },
];

export const RENDER_TOOLS_APPS: readonly ToolSpec[] = [
  {
    name: 'render_markdown',
    description:
      'Render markdown into FlatWrite-styled HTML <head> and <body> fragments for the app surface. ' +
      'Provide either the raw markdown inline (`markdown`) or an allowlisted URL (`markdownUrl`). ' +
      'Use this when you need the rendered HTML artifacts for the app surface.',
    surfaceMode: 'app',
    category: 'render',
    inputFields: [
      { name: 'markdown', type: 'string', description: 'Raw markdown content to render.' },
      {
        name: 'markdownUrl',
        type: 'string',
        description:
          'URL pointing to raw markdown content. Must be on an allowlisted host ' +
          '(raw.githubusercontent.com, raw.gitlab.com, bitbucket.org), http(s) only, ' +
          'and <=1 MB. Host validation is enforced server-side.',
      },
      ...RENDER_INPUT_FIELDS.map((f) => f.name as string),
    ],
    requiredFields: [],
    requiredOneOf: [['markdown'], ['markdownUrl']],
    outputSchema: RENDER_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true },
    displayHints: {
      inputFieldAliases: {
        font: 'fontFamily',
        appFramework: 'framework',
        size: 'fontSize',
        weight: 'fontWeight',
        line: 'lineHeight',
      },
    },
  },
  {
    name: 'list_render_options',
    description:
      'Return the supported fonts, UI frameworks, document engines, page sizes, orientations, ' +
      'margins, and surface modes for the render_markdown tool. Call this before rendering if ' +
      'you need to know which enum values are valid.',
    surfaceMode: 'app',
    category: 'discovery',
    inputFields: [],
    requiredFields: [],
    outputSchema: RENDER_OPTIONS_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true },
    displayHints: {
      inputFieldAliases: {},
    },
  },
];

/**
 * Surfaces this server knows about, with their readiness state. The
 * Apps surface is registered as "preview" so clients can render a
 * "coming soon" affordance before the actual tools ship.
 */
export interface SurfaceRegistration {
  readonly id: SurfaceMode;
  readonly status: 'ready' | 'preview' | 'disabled';
  readonly manifestFile: string;
}

export const REGISTERED_SURFACES: readonly SurfaceRegistration[] = [
  { id: 'doc', status: 'ready', manifestFile: '.well-known/model-context.docs.json' },
  // Apps surface is now ready and exposes the same consolidated render
  // tool, broadening the registered page coverage beyond the Docs page.
  { id: 'app', status: 'ready', manifestFile: '.well-known/model-context.apps.json' },
];

/**
 * Per-surface handler configuration. Each surface has its own URL +
 * auth notes. Today Docs fronts the JSON-first public Worker; Apps
 * would front a different endpoint when it ships.
 */
export interface HandlerConfig {
  readonly url: string;
  readonly transport: 'http' | 'streamable-http';
  readonly method: 'POST' | 'GET';
  readonly headers: Readonly<Record<string, string>>;
  readonly authNote: string;
}

export const HANDLER_DOCS: HandlerConfig = {
  url: 'https://render.flatwrite.md/render',
  transport: 'http',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Api-Key': '<server-to-server key — clients mint X-Mcp-Token instead>',
  },
  authNote:
    'Browser clients mint a short-lived X-Mcp-Token from ' +
    'https://render.flatwrite.md/mcp-token first. Server-to-server clients ' +
    'may use X-Api-Key directly.',
};

/**
 * Streamable HTTP MCP handler for the Docs surface. Exposed at
 * https://mcp.flatwrite.md/mcp and fronts the same render Worker
 * that the HTTP handler fronts, so a tool call here produces
 * byte-identical output to a call via the HTTP handler. Preferred
 * by MCP-aware clients (Claude, Hermes, MCP Inspector).
 */
export const HANDLER_DOCS_MCP: HandlerConfig = {
  url: 'https://mcp.flatwrite.md/mcp',
  transport: 'streamable-http',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  },
  authNote:
    'MCP Streamable HTTP transport. Server-to-server callers (no Origin ' +
    'header) can use X-Api-Key. Browser callers MUST mint a short-lived ' +
    'X-Mcp-Token from https://render.flatwrite.md/mcp-token first.',
};

export const HANDLER_APPS: HandlerConfig = {
  url: 'https://render.flatwrite.md/render?surface=app',
  transport: 'http',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  authNote: 'Browser clients mint a short-lived X-Mcp-Token from https://render.flatwrite.md/mcp-token first. Server-to-server clients may use X-Api-Key directly.',
};

/**
 * The shape of a generated manifest. Emitted by `generateManifest()`,
 * one file per surface, written to `public/.well-known/`.
 *
 * `handlers` is an array (not a single object) so a surface can be
 * reachable via multiple transports. The first entry is treated as
 * the preferred/default handler; consumers should iterate the array
 * to discover alternatives.
 */
export interface ModelContextManifest {
  readonly $schema: string;
  readonly name: string;
  readonly version: string;
  readonly surfaceMode: SurfaceMode;
  readonly status: 'ready' | 'preview' | 'disabled';
  readonly handlers: ReadonlyArray<HandlerConfig>;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly category: ToolCategory;
    readonly inputSchema: Record<string, unknown>;
    /**
     * JSON-Schema for the tool's success response. Absent for tools
     * that haven't declared an output shape yet — readers should
     * treat `outputSchema === undefined` as "unknown shape".
     */
    readonly outputSchema?: Record<string, unknown>;
    readonly annotations: { readonly readOnlyHint?: boolean };
    readonly displayHints: ToolSpec['displayHints'];
  }>
}

const MANIFEST_SCHEMA_URL = 'https://webmcp.org/schemas/model-context-v1.json';
const MANIFEST_VERSION = '1.0.0';

/** Look up an InputFieldSpec by canonical name. Throws on miss (catches typos at build time). */
function fieldByName(name: string): InputFieldSpec {
  const found = RENDER_INPUT_FIELDS.find((f) => f.name === name);
  if (!found) {
    throw new Error(
      `generateManifest: tool references unknown canonical field "${name}". ` +
        `Add it to RENDER_INPUT_FIELDS first.`,
    );
  }
  return found;
}

/**
 * Build the JSON-Schema `properties` block for a tool. Each input
 * entry is either a canonical field name (looked up in
 * RENDER_INPUT_FIELDS) or an inline InputFieldSpec (tool-local). The
 * tool's explicitly-listed fields come first in order, then any
 * unlisted canonical fields are appended defensively so drift surfaces
 * in tests rather than silently dropping fields.
 */
function buildProperties(inputFields: ReadonlyArray<string | InputFieldSpec>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const entry of inputFields) {
    const f = typeof entry === 'string' ? fieldByName(entry) : entry;
    out[f.name] = fieldToJsonSchema(f);
    seen.add(f.name);
  }
  for (const f of RENDER_INPUT_FIELDS) {
    if (!seen.has(f.name)) {
      out[f.name] = fieldToJsonSchema(f);
    }
  }
  return out;
}

function fieldToJsonSchema(f: InputFieldSpec): Record<string, unknown> {
  if (f.oneOf) {
    const out: Record<string, unknown> = {
      oneOf: f.oneOf.map((v) => ({ type: v.type, description: v.description })),
      description: f.description,
    };
    if (f.minimum !== undefined) out.minimum = f.minimum;
    if (f.maximum !== undefined) out.maximum = f.maximum;
    return out;
  }
  const out: Record<string, unknown> = { type: f.type, description: f.description };
  if (f.enum) out.enum = f.enum;
  if (f.examples) out.examples = f.examples;
  if (f.minimum !== undefined) out.minimum = f.minimum;
  if (f.maximum !== undefined) out.maximum = f.maximum;
  return out;
}

/**
 * Generate the manifest JSON for one surface. The output is a pure
 * data structure — the caller (build-manifest.mjs) writes it to disk.
 *
 * Throws if any tool references a canonical field that isn't in
 * RENDER_INPUT_FIELDS, or if a tool's requiredFields references a
 * field not in its inputFields. Both are build-time errors.
 *
 * `handlers` is an array; the first entry is treated as the
 * preferred/default by consumers. Pass at least one handler per
 * surface — empty handlers throws at build time.
 */
export function generateManifest(
  surface: SurfaceMode,
  tools: readonly ToolSpec[],
  handlers: ReadonlyArray<HandlerConfig>,
  options: { status?: SurfaceRegistration['status']; serverName?: string } = {},
): ModelContextManifest {
  if (handlers.length === 0) {
    throw new Error(
      `generateManifest: surface "${surface}" has zero handlers. ` +
        `At minimum, register one HANDLER_<SURFACE> in mcpShared.ts.`,
    );
  }
  const status = options.status ?? 'ready';
  const serverName = options.serverName ?? `FlatWrite Render — ${surface === 'doc' ? 'Docs' : 'Apps'}`;

  const manifestTools = tools.map((t) => {
    if (t.surfaceMode !== surface) {
      throw new Error(
        `generateManifest: tool "${t.name}" declares surfaceMode="${t.surfaceMode}" ` +
          `but is being included in the "${surface}" manifest. Fix the registration.`,
      );
    }
    const properties = buildProperties(t.inputFields);
    for (const req of t.requiredFields) {
      if (!(req in properties)) {
        throw new Error(
          `generateManifest: tool "${t.name}" requires "${req}" but it's not in inputFields.`,
        );
      }
    }
    if (t.requiredOneOf) {
      for (const group of t.requiredOneOf) {
        for (const req of group) {
          if (!(req in properties)) {
            throw new Error(
              `generateManifest: tool "${t.name}" requiredOneOf group references "${req}" but it's not in inputFields.`,
            );
          }
        }
      }
    }
    const inputSchema: Record<string, unknown> = {
      type: 'object' as const,
      properties,
      required: t.requiredFields,
    };
    if (t.requiredOneOf) {
      inputSchema.oneOf = t.requiredOneOf.map((group) => ({ required: group }));
    }
    return {
      name: t.name,
      description: t.description,
      category: t.category,
      inputSchema,
      ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
      annotations: t.annotations,
      displayHints: t.displayHints,
    };
  });

  return {
    $schema: MANIFEST_SCHEMA_URL,
    name: serverName,
    version: MANIFEST_VERSION,
    surfaceMode: surface,
    status,
    handlers,
    tools: manifestTools,
  };
}

/* ── Token helpers ─────────────────────────────────────────────────────── */

/**
 * Constant-time string comparison. Prevents timing attacks on signature
 * or secret comparisons by always scanning every byte.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Mint a short-lived token: base64url(exp).base64url(sig) where
 *   exp  = unix seconds at which the token expires
 *   sig  = hex(HMAC-SHA256(secret, exp + '.' + scope))
 */
export async function mintToken(
  secret: string,
  ttlSeconds: number,
  scope: string,
): Promise<{ token: string; exp: number }> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await sign(secret, exp + '.' + scope);
  const expB64 = b64url(exp.toString());
  const sigB64 = b64url(sig);
  return { token: expB64 + '.' + sigB64, exp };
}

export type TokenVerifyResult =
  | { ok: true; exp: number }
  | { ok: false; reason: string };

/**
 * Verify a token minted by mintToken(). Recomputes the expected HMAC and
 * compares it with constantTimeEqual() to avoid timing attacks.
 */
export async function verifyToken(
  secret: string,
  token: string,
  scope: string,
): Promise<TokenVerifyResult> {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [expB64, sigB64] = parts;
  let expStr: string;
  try {
    expStr = atob(expB64.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'malformed' };
  if (exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  let expectedSig: string;
  try {
    expectedSig = atob(sigB64.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const actualSig = await sign(secret, expStr + '.' + scope);
  if (!constantTimeEqual(expectedSig, actualSig)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, exp };
}
