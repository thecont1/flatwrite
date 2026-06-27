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
      .string()
      .optional()
      .describe('Optional UI framework — e.g. spectre, pico, oat, poshui, simple'),
    fontFamily: z
      .string()
      .optional()
      .describe(
        'Optional font family name. Must be one of the bundled families: ' +
          [...ALLOWED_FONT_FAMILIES].join(', ') +
          '. Defaults to Inter.',
      ),
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
      .string()
      .optional()
      .describe('Optional page size for paged output — e.g. A4, A3, Letter, Legal'),
    orientation: z
      .enum(['portrait', 'landscape'])
      .optional()
      .describe('Optional page orientation'),
    marginsLR: z
      .string()
      .optional()
      .describe('Optional left/right page margins — e.g. narrow, normal, wide'),
    marginsTB: z
      .string()
      .optional()
      .describe('Optional top/bottom page margins — e.g. narrow, normal, wide'),
    footer: z
      .boolean()
      .optional()
      .describe('Optional: include a page-number footer in paged output'),
    width: z
      .number()
      .optional()
      .describe('Optional content width in pixels (400..1400)'),
    docEngine: z
      .string()
      .optional()
      .describe('Optional document engine — "none" or "paged"'),
    surfaceMode: z
      .string()
      .optional()
      .describe('Optional surface mode — "doc" or "app"'),
    theme: z
      .string()
      .optional()
      .describe('Optional theme identifier — e.g. light, dark'),
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
