/**
 * MCP tool: render_markdown
 *
 * Renders raw markdown into FlatWrite-styled HTML <head> and <body>
 * fragments by POSTing to the public `https://render.flatwrite.md/render`
 * endpoint.
 *
 * The input schema mirrors the editor's design controls — same field
 * names, same semantics. Internally the public names are translated to
 * the canonical FlatWrite render frontmatter (which is what the editor
 * writes into shared-URL YAML) before being forwarded to the renderer.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ALLOWED_APP_FRAMEWORKS,
  ALLOWED_DOC_ENGINES,
  ALLOWED_FONT_FAMILIES as ALLOWED_FONT_FAMILIES_ARRAY,
  ALLOWED_MARGINS,
  ALLOWED_ORIENTATIONS,
  ALLOWED_PAGE_SIZES,
  ALLOWED_SURFACE_MODES,
} from '../shared/mcpShared.js';
import {
  ALLOWED_FONT_FAMILIES,
  RenderStyle,
  buildRawMarkdownBody,
  callRender,
} from '../renderClient.js';
import { renderErrorResult } from './error.js';

const InputSchema = z
  .object({
    markdown: z.string().min(1).describe('Raw markdown content to render'),
    framework: z
      .enum(ALLOWED_APP_FRAMEWORKS)
      .optional()
      .describe('Optional UI framework applied when surfaceMode="app".'),
    fontFamily: z
      .enum(ALLOWED_FONT_FAMILIES_ARRAY)
      .optional()
      .describe('Optional font family — must be a bundled family. Defaults to Inter.'),
    fontSize: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Optional font size — absolute px (number) or scale token (string like "sm", "lg")'),
    fontWeight: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Optional font weight — absolute (100..900) or scale token'),
    lineHeight: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Optional line height — absolute multiplier or scale token'),
    uiZoom: z
      .number()
      .optional()
      .describe('Optional UI zoom level (1.0 = default; >1 zooms in, <1 zooms out)'),
    pageSize: z
      .enum(ALLOWED_PAGE_SIZES)
      .optional()
      .describe('Optional page size for paged output.'),
    orientation: z
      .enum(ALLOWED_ORIENTATIONS)
      .optional()
      .describe('Optional page orientation'),
    marginsLR: z
      .enum(ALLOWED_MARGINS)
      .optional()
      .describe('Optional left/right page margin preset.'),
    marginsTB: z
      .enum(ALLOWED_MARGINS)
      .optional()
      .describe('Optional top/bottom page margin preset.'),
    footer: z
      .boolean()
      .optional()
      .describe('Optional: include a page-number footer in paged output'),
    width: z
      .number()
      .optional()
      .describe('Optional content width in pixels (400..1400)'),
    docEngine: z
      .enum(ALLOWED_DOC_ENGINES)
      .optional()
      .describe('Optional document engine — "none" emits plain CSS; "pagedjs"/"vivliostyle" wrap the output in @page rules.'),
    surfaceMode: z
      .enum(ALLOWED_SURFACE_MODES)
      .optional()
      .describe('Optional surface mode — "doc" or "app". "app" unlocks the framework picker.'),
    theme: z
      .string()
      .optional()
      .describe('Optional theme identifier (e.g. "light" or "dark") rendered as body[data-theme="..."].'),
  })
  .strict();

export function registerRenderMarkdownTool(
  server: McpServer,
  apiKey: string,  baseUrl?: string,
) {
  server.registerTool(
    'render_markdown',
    {
      title: 'Render Markdown',
      description:
        'Render raw markdown into FlatWrite-styled HTML <head> and <body> fragments, with optional typography and page-layout controls.',
      inputSchema: InputSchema,
      outputSchema: {
        head: z.string().describe('HTML to inject in <head>'),
        body: z.string().describe('HTML to inject in <body>'),
      },
    },
    async ({ markdown, fontFamily, ...style }) => {
      // Pre-flight validate fontFamily so the caller gets a structured
      // error immediately rather than a render that silently picks a
      // fallback because the woff2 doesn't exist.
      if (fontFamily !== undefined && !ALLOWED_FONT_FAMILIES.has(fontFamily)) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `fontFamily '${fontFamily}' is not one of the bundled fonts (${[...ALLOWED_FONT_FAMILIES].join(', ')}) [INVALID_FONT_FAMILY]`,
            },
          ],
        };
      }

      const body = buildRawMarkdownBody(markdown, {
        fontFamily,
        ...(style as Omit<RenderStyle, 'fontFamily'>),
      });
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
