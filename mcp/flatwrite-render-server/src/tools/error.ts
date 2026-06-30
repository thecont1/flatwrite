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
 * Shared error-shape helper for MCP tool handlers.
 *
 * The MCP `tools/call` result allows `isError: true` plus a `content` array;
 * we use that to surface the structured `{ error, code, retryAfter? }` shape
 * from the upstream render API.
 */

import { RenderApiError } from '../renderClient.js';
import { sanitizeDetail } from '../shared/mcpShared.js';

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
  // Defensive fallback for non-RenderApiError exceptions (shouldn't normally
  // surface, but if it does we still scrub before returning to the LLM).
  const safeDetail = sanitizeDetail((e as Error)?.message ?? e);
  return {
    isError: true,
    content: [{ type: 'text', text: `Render failed: ${safeDetail}` }],
  };
}
