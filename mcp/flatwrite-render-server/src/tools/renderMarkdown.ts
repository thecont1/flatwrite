/**
 * MCP tool: render_markdown
 *
 * Renders raw markdown into FlatWrite-styled HTML <head> and <body>
 * fragments by POSTing to the public `https://render.flatwrite.md/render`
 * endpoint.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  RenderStyle,
  buildRawMarkdownBody,
  callRender,
} from '../renderClient.js';
import { renderErrorResult } from './error.js';

const InputSchema = z
  .object({
    markdown: z.string().min(1).describe('Raw markdown content to render'),
    framework: z.string().optional().describe('Optional UI framework (e.g. spectre, pico, oat, poshui)'),
    fontFamily: z.string().optional().describe('Optional font family (e.g. Inter, Merriweather, Lora)'),
    theme: z.string().optional().describe('Optional theme identifier (e.g. light, dark)'),
    fontSize: z.string().optional().describe('Optional font size token'),
    lineHeight: z.string().optional().describe('Optional line height token'),
    uiZoom: z.number().optional().describe('Optional UI zoom level (1.0 = default)'),
  })
  .strict();

export function registerRenderMarkdownTool(
  server: McpServer,
  apiKey: string,
  baseUrl?: string,
) {
  server.registerTool(
    'render_markdown',
    {
      title: 'Render Markdown',
      description:
        'Render raw markdown into FlatWrite-styled HTML <head> and <body> fragments.',
      inputSchema: InputSchema,
      outputSchema: {
        head: z.string().describe('HTML to inject in <head>'),
        body: z.string().describe('HTML to inject in <body>'),
      },
    },
    async ({ markdown, ...style }) => {
      const body = buildRawMarkdownBody(markdown, style as RenderStyle);
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

