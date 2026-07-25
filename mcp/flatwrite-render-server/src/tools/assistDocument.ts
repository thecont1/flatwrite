/**
 * flatwrite.md - Minimalist Markdown Editor
 *
 * Copyright (C) 2026 Mahesh Shantaram
 * Sole Proprietary Owner. All Rights Reserved.
 *
 * This file is part of flatwrite.md under the GNU AGPL v3.0.
 *
 * MCP tool: assist_document — Morph-powered rewrite/shorten/fix/custom.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sanitizeDetail } from '../shared/mcpShared.js';

const ASSIST_URL_DEFAULT = 'https://assist.flatwrite.md/assist';

const AssistModeSchema = z.enum(['custom', 'rewrite', 'shorten', 'fix_grammar']);

const SelectionSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    text: z.string().optional(),
  })
  .strict();

export function registerAssistDocumentTool(
  server: McpServer,
  apiKey: string,
  assistUrl: string = ASSIST_URL_DEFAULT,
): void {
  server.tool(
    'assist_document',
    'Rewrite, shorten, fix grammar, or apply a custom instruction to markdown via FlatWrite Assist (Morph: Reflex + Router + Compact + Fast Models). Returns full markdown plus the edited piece. Does not modify the editor — apply with update_document_content if desired.',
    {
      markdown: z.string().describe('Full markdown document to edit.'),
      mode: AssistModeSchema
        .default('rewrite')
        .describe('Assist mode: rewrite | shorten | fix_grammar | custom.'),
      instruction: z
        .string()
        .optional()
        .describe('Freeform instruction. Required when mode is custom.'),
      selection: SelectionSchema.optional().describe(
        'Optional character range within markdown. When set, only that span is rewritten.',
      ),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {
          markdown: args.markdown,
          mode: args.mode ?? 'rewrite',
        };
        if (args.instruction) body.instruction = args.instruction;
        if (args.selection) body.selection = args.selection;

        const resp = await fetch(assistUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': apiKey,
          },
          body: JSON.stringify(body),
        });
        const text = await resp.text();
        let data: Record<string, unknown>;
        try {
          data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Assist returned non-JSON (${resp.status}): ${sanitizeDetail(text.slice(0, 200))}`,
              },
            ],
          };
        }

        if (!resp.ok || data.ok === false) {
          const err = (data.error as { code?: string; message?: string }) || {};
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `${err.message || 'Assist failed'} [${err.code || resp.status}]`,
              },
            ],
            structuredContent: data,
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: typeof data.markdown === 'string' ? data.markdown : JSON.stringify(data),
            },
          ],
          structuredContent: data,
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Assist failed: ${sanitizeDetail((e as Error)?.message ?? e)}`,
            },
          ],
        };
      }
    },
  );
}
