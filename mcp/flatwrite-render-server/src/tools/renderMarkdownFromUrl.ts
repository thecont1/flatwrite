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

export function registerRenderMarkdownFromUrlTool(
  server: McpServer,
  apiKey: string, baseUrl?: string,
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
      const body = buildRemoteMarkdownBody(url, style as RenderStyle);
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