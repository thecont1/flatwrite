/**
 * Shared error-shape helper for MCP tool handlers.
 *
 * The MCP `tools/call` result allows `isError: true` plus a `content` array;
 * we use that to surface the structured `{ error, code, retryAfter? }` shape
 * from the upstream render API.
 */

import { RenderApiError } from '../renderClient.js';

export interface ToolErrorResult extends Record<string, unknown> {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
}

export function renderErrorResult(e: unknown): ToolErrorResult {
  if (e instanceof RenderApiError) {
    const payload = e.payload;
    const summary =
      'error' in payload
        ? `${payload.error}${payload.detail ? ` — ${payload.detail}` : ''} [${payload.code}]`
        : `Render failed (raw): ${payload.raw.slice(0, 200)}`;
    return {
      isError: true,
      content: [{ type: 'text', text: summary }],
    };
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Render failed: ${String((e as Error)?.message ?? e)}`,
      },
    ],
  };
}