/**
 * flatwrite.md - Minimalist Markdown Editor
 *
 * Copyright (C) 2026 Mahesh Shantaram
 * Sole Proprietary Owner. All Rights Reserved.
 *
 * This file is part of flatwrite.md under the GNU AGPL v3.0.
 */

export const ASSIST_MODES = ['custom', 'rewrite', 'shorten', 'fix_grammar'];

export const MAX_INSTRUCTION_CHARS = 4_000;
export const MAX_MARKDOWN_CHARS = 200_000;
export const MAX_SELECTION_CHARS = 100_000;
export const MAX_HISTORY_TURNS = 8;
export const MAX_HISTORY_TURN_CHARS = 8_000;
/** Compact when target text exceeds this many characters. */
export const COMPACT_THRESHOLD_CHARS = 12_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
export const HARD_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Validate and normalize a /assist request body.
 * @returns {{ ok: true, value: object } | { ok: false, status: number, body: object }}
 */
export function parseAssistRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return err(400, 'INVALID_JSON', 'Request body must be a JSON object');
  }

  const instruction = typeof raw.instruction === 'string' ? raw.instruction.trim() : '';
  const mode = typeof raw.mode === 'string' && raw.mode ? raw.mode : 'custom';
  const markdown = typeof raw.markdown === 'string' ? raw.markdown : '';

  if (!ASSIST_MODES.includes(mode)) {
    return err(400, 'INVALID_MODE', `mode must be one of: ${ASSIST_MODES.join(', ')}`);
  }
  if (mode === 'custom' && !instruction) {
    return err(400, 'MISSING_INSTRUCTION', 'instruction is required when mode is "custom"');
  }
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    return err(400, 'INSTRUCTION_TOO_LONG', `instruction exceeds ${MAX_INSTRUCTION_CHARS} characters`);
  }
  if (!markdown) {
    return err(400, 'MISSING_MARKDOWN', 'markdown is required');
  }
  if (markdown.length > MAX_MARKDOWN_CHARS) {
    return err(400, 'MARKDOWN_TOO_LARGE', `markdown exceeds ${MAX_MARKDOWN_CHARS} characters`);
  }

  let selection = null;
  if (raw.selection != null) {
    if (typeof raw.selection !== 'object' || Array.isArray(raw.selection)) {
      return err(400, 'INVALID_SELECTION', 'selection must be an object');
    }
    const start = Number(raw.selection.start);
    const end = Number(raw.selection.end);
    const text =
      typeof raw.selection.text === 'string'
        ? raw.selection.text
        : Number.isFinite(start) && Number.isFinite(end)
          ? markdown.slice(start, end)
          : '';
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      return err(400, 'INVALID_SELECTION', 'selection.start/end must be valid indices');
    }
    if (end > markdown.length) {
      return err(400, 'INVALID_SELECTION', 'selection.end exceeds markdown length');
    }
    if (text.length > MAX_SELECTION_CHARS) {
      return err(400, 'SELECTION_TOO_LARGE', `selection exceeds ${MAX_SELECTION_CHARS} characters`);
    }
    // Prefer client-provided text if it matches; otherwise use slice for consistency.
    const sliced = markdown.slice(start, end);
    selection = {
      start,
      end,
      text: text === sliced || !raw.selection.text ? sliced : text,
    };
  }

  const options = raw.options && typeof raw.options === 'object' ? raw.options : {};
  const tone = typeof options.tone === 'string' ? options.tone.slice(0, 64) : undefined;
  const preserveFrontmatter = options.preserveFrontmatter !== false;
  let maxOutputTokens = Number(options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens < 64) {
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  }
  maxOutputTokens = Math.min(Math.floor(maxOutputTokens), HARD_MAX_OUTPUT_TOKENS);

  const history = normalizeHistory(raw.history);

  return {
    ok: true,
    value: {
      instruction,
      mode,
      markdown,
      selection,
      options: { tone, preserveFrontmatter, maxOutputTokens },
      conversationId:
        typeof raw.conversationId === 'string' ? raw.conversationId.slice(0, 128) : undefined,
      history,
    },
  };
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const turn of history.slice(-MAX_HISTORY_TURNS)) {
    if (!turn || typeof turn !== 'object') continue;
    const role = turn.role === 'assistant' ? 'assistant' : turn.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content = typeof turn.content === 'string' ? turn.content.slice(0, MAX_HISTORY_TURN_CHARS) : '';
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

function err(status, code, message, retryable = false) {
  return {
    ok: false,
    status,
    body: {
      ok: false,
      error: { code, message, retryable },
    },
  };
}

/**
 * Splice a replacement into markdown at selection, or replace whole doc.
 */
export function applyScope(markdown, selection, replacement) {
  if (!selection) return replacement;
  return markdown.slice(0, selection.start) + replacement + markdown.slice(selection.end);
}

/**
 * Strip common model wrappers (fences, leading chatter).
 */
export function extractMarkdownOutput(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();
  // Prefer a fenced block if present.
  const fence = text.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/i);
  if (fence) return fence[1].replace(/\s+$/, '');
  // Drop a single leading "Here's the rewritten..." line.
  text = text.replace(/^(here('s| is)|sure[,.]?|updated|rewritten)[^\n]*\n+/i, '');
  return text.replace(/\s+$/, '');
}
