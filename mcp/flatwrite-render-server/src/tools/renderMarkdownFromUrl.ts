/**
 * flatwrite.md - Minimalist Markdown Editor
 * 
 * Copyright (C) 2026 Mahesh Shantaram
 * Sole Proprietary Owner. All Rights Reserved.
 * 
 * This file is part of flatwrite.md.
 * flatwrite.md is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published 
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * For commercial, closed-source embedding, and SaaS deployment exemptions,
 * a valid Commercial License Agreement is required. Contact: sales@flatwrite.md
 */

/**
 * MCP tool: render_markdown_from_url
 *
 * Fetches markdown from a URL and renders it into FlatWrite-styled HTML
 * <head> and <body> fragments, with optional typography and page-layout
 * controls (same set as `render_markdown`).
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
  buildRemoteMarkdownBody,
  callRender,
} from '../renderClient.js';
import { renderErrorResult } from './error.js';
import { RenderOutputSchema } from '../shared/renderOutputSchema.js';

const InputSchema = z
  .object({
    url: z.string().url().describe('URL pointing to raw markdown content'),
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
      .describe('Optional font size — absolute px (number) or scale token (string)'),
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

/**
 * Hosts the upstream `/api/render` is willing to fetch markdown from.
 * Mirrors `ALLOWED_MARKDOWN_HOSTS` in api/render.js — keep in sync.
 */
export const ALLOWED_MARKDOWN_HOSTS: ReadonlySet<string> = new Set([
  'raw.githubusercontent.com',
  'raw.gitlab.com',
  'bitbucket.org',
]);

export type UrlValidationCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_SCHEME'
  | 'DISALLOWED_HOST';

export interface UrlValidationFailure {
  ok: false;
  code: UrlValidationCode;
  message: string;
  host?: string;
}

export interface UrlValidationSuccess {
  ok: true;
  url: string;
  host: string;
}

export type UrlValidationResult = UrlValidationSuccess | UrlValidationFailure;

/**
 * Validate that a markdown URL is fetchable by the upstream renderer.
 *
 * Pre-flight check before forwarding to `/api/render` so that callers get
 * a structured failure immediately rather than a 502 roundtrip. The
 * upstream also enforces these checks, so the worst case if this drifts
 * out of sync is that callers see a less specific error message.
 */
export function validateMarkdownUrl(rawUrl: string): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      code: 'INVALID_URL',
      message: 'url is not a valid URL',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'UNSUPPORTED_SCHEME',
      message: `url must use http or https (got ${parsed.protocol})`,
      host: parsed.hostname,
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_MARKDOWN_HOSTS.has(host)) {
    return {
      ok: false,
      code: 'DISALLOWED_HOST',
      message: `host '${host}' is not on the markdown URL allowlist`,
      host,
    };
  }

  return { ok: true, url: parsed.toString(), host };
}

export function registerRenderMarkdownFromUrlTool(
  server: McpServer,
  apiKey: string,  baseUrl?: string,
) {
  server.registerTool(
    'render_markdown_from_url',
    {
      title: 'Render Markdown From URL',
      description:
        'Fetch markdown from a URL and render it into FlatWrite-styled HTML <head> and <body> fragments, with optional typography and page-layout controls.',
      inputSchema: InputSchema,
      outputSchema: RenderOutputSchema,
    },
    async ({ url, fontFamily, ...style }) => {
      // URL allowlist pre-flight
      const check = validateMarkdownUrl(url);
      if (!check.ok) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `${check.message} [${check.code}]`,
            },
          ],
        };
      }

      // fontFamily pre-flight against bundled inventory
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

      const body = buildRemoteMarkdownBody(check.url, {
        fontFamily,
        ...(style as Omit<RenderStyle, 'fontFamily'>),
      });
      try {
        const result = await callRender(body, { apiKey, baseUrl });
        const envelope = {
          ok: true,
          kind: 'html' as const,
          document: { title: '', wordCount: 0, charCount: 0 },
          artifacts: { head: result.head, body: result.body },
          warnings: [] as string[],
        };
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(envelope, null, 2),
            },
          ],
          structuredContent: envelope,
        };
      } catch (e) {
        return renderErrorResult(e);
      }
    },
  );
}
