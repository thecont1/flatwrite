#!/usr/bin/env node
/**
 * FlatWrite Render MCP Server.
 *
 * Exposes two tools — `render_markdown` and `render_markdown_from_url` —
 * that POST to the public `https://render.flatwrite.md/render` endpoint.
 *
 * Configuration via environment variables:
 *   FLATWRITE_RENDER_API_KEY  required, sent as `X-Api-Key`
 *   FLATWRITE_RENDER_BASE_URL optional, override the default render URL
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerRenderMarkdownTool } from './tools/renderMarkdown.js';
import { registerRenderMarkdownFromUrlTool } from './tools/renderMarkdownFromUrl.js';

const RENDER_URL_DEFAULT = 'https://render.flatwrite.md/render';

function main(): void {
  const apiKey = process.env.FLATWRITE_RENDER_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      'FATAL: FLATWRITE_RENDER_API_KEY environment variable is required.\n',
    );
    process.exit(1);
  }

  const baseUrl = process.env.FLATWRITE_RENDER_BASE_URL ?? RENDER_URL_DEFAULT;

  const server = new McpServer(
    {
      name: 'flatwrite-render',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        'Render markdown via the FlatWrite public render API. ' +
        'Use render_markdown for raw markdown and render_markdown_from_url ' +
        'when the markdown is hosted at a URL on an allowlisted host ' +
        '(raw.githubusercontent.com, raw.gitlab.com, bitbucket.org).',
    },
  );

  registerRenderMarkdownTool(server, apiKey, baseUrl);
  registerRenderMarkdownFromUrlTool(server, apiKey, baseUrl);

  const transport = new StdioServerTransport();
  server
    .connect(transport)
    .catch((e: unknown) => {
      process.stderr.write(`FATAL: ${String((e as Error)?.message ?? e)}\n`);
      process.exit(1);
    });

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`Received ${signal}, shutting down…\n`);
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
