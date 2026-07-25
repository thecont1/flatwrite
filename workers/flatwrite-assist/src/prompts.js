/**
 * flatwrite.md - Minimalist Markdown Editor
 *
 * Copyright (C) 2026 Mahesh Shantaram
 * Sole Proprietary Owner. All Rights Reserved.
 *
 * This file is part of flatwrite.md under the GNU AGPL v3.0.
 */

const MODE_INSTRUCTIONS = {
  custom: 'Follow the user instruction carefully.',
  rewrite:
    'Rewrite the target markdown for clarity and flow. Preserve meaning, structure, and links. Do not invent facts.',
  shorten:
    'Shorten the target markdown. Keep the core thesis, key facts, headings when useful, and links. Drop filler.',
  fix_grammar:
    'Fix grammar, spelling, and punctuation only. Do not change meaning, tone, structure, or wording unless required for correctness.',
};

/**
 * Build chat messages for Morph Fast Models.
 */
export function buildMessages(req) {
  const { instruction, mode, markdown, selection, options, history } = req;
  const scope = selection ? 'selection' : 'document';
  const target = selection ? selection.text : markdown;

  const system = [
    'You are FlatWrite Assist, a careful markdown editor co-pilot.',
    'You edit markdown documents. Output ONLY the edited markdown for the requested scope.',
    'Do not wrap the answer in commentary. A single fenced ```markdown block is acceptable; bare markdown is preferred.',
    'Preserve existing link URLs, image paths, and code fences unless the instruction requires changing them.',
    options.preserveFrontmatter
      ? 'If YAML frontmatter is present in the target, preserve its keys unless instructed otherwise.'
      : '',
    options.tone ? `Preferred tone: ${options.tone}.` : '',
    MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.custom,
  ]
    .filter(Boolean)
    .join(' ');

  const userParts = [
    `Mode: ${mode}`,
    `Scope: ${scope}`,
    instruction ? `Instruction: ${instruction}` : null,
    '--- TARGET MARKDOWN ---',
    target,
    '--- END TARGET ---',
    scope === 'selection'
      ? 'Return ONLY the replacement text for the selection (not the full document).'
      : 'Return the full updated document markdown.',
  ].filter(Boolean);

  const messages = [{ role: 'system', content: system }];
  for (const turn of history || []) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: userParts.join('\n') });
  return messages;
}

/** Query string for Morph Compact. */
export function compactQuery(req) {
  const bits = [req.mode, req.instruction || ''].filter(Boolean);
  return bits.join(' — ').slice(0, 500) || 'markdown document editing';
}
