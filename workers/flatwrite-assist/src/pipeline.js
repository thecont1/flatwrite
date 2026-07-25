/**
 * flatwrite.md - Minimalist Markdown Editor
 *
 * Copyright (C) 2026 Mahesh Shantaram
 * Sole Proprietary Owner. All Rights Reserved.
 *
 * This file is part of flatwrite.md under the GNU AGPL v3.0.
 *
 * Assist pipeline: Reflex → Router → Compact → Fast Models → (Reflex out).
 */

import { buildMessages, compactQuery } from './prompts.js';
import {
  COMPACT_THRESHOLD_CHARS,
  applyScope,
  extractMarkdownOutput,
} from './schema.js';

/**
 * @param {object} req - parsed assist request (parseAssistRequest value)
 * @param {ReturnType<import('./morph.js').createMorphClient>} morph
 * @param {{ skipOutputReflex?: boolean }} [opts]
 */
export async function runAssistPipeline(req, morph, opts = {}) {
  const target = req.selection ? req.selection.text : req.markdown;
  const userProbe = [req.instruction, req.mode, target.slice(0, 2000)].filter(Boolean).join('\n');

  // ── 1. Reflex on user input ──────────────────────────────────────────
  const reflexUser = {
    jailbreak: null,
    guardrail: null,
    incomplete: null,
  };

  const [jb, gr, inc] = await Promise.all([
    morph.reflexPredict('jailbreak', userProbe),
    morph.reflexPredict('guardrail', userProbe),
    req.instruction
      ? morph.reflexPredict('incomplete-thought', req.instruction)
      : Promise.resolve(null),
  ]);
  reflexUser.jailbreak = jb;
  reflexUser.guardrail = gr;
  reflexUser.incomplete = inc;

  if (selectedIncludes(jb, 'jailbreak')) {
    return blocked('REFLEX_JAILBREAK', 'Request blocked by safety classifier (jailbreak).', {
      reflex: { user: pickLabels(reflexUser) },
    });
  }
  // guardrail: true = harassment/NSFW in Morph defaults
  if (selectedIncludes(gr, 'true') || selectedIncludes(gr, 'unsafe') || selectedIncludes(gr, 'violation')) {
    return blocked('REFLEX_GUARDRAIL', 'Request blocked by safety classifier (guardrail).', {
      reflex: { user: pickLabels(reflexUser) },
    });
  }
  if (inc && selectedIncludes(inc, 'incomplete') && req.mode === 'custom') {
    return blocked(
      'INCOMPLETE_INSTRUCTION',
      'Instruction looks incomplete. Finish your request and try again.',
      { reflex: { user: pickLabels(reflexUser) }, retryable: true },
      400,
    );
  }

  // ── 2. Router ────────────────────────────────────────────────────────
  const routeInput = [req.mode, req.instruction, target.slice(0, 4000)].filter(Boolean).join('\n');
  let classifications;
  try {
    classifications = await morph.routerClassify(routeInput, ['difficulty', 'domain']);
  } catch {
    classifications = {
      difficulty: { label: 'medium', confidence: 0 },
      domain: { label: 'general', confidence: 0 },
    };
  }
  const difficultyLabel = classifications?.difficulty?.label || 'medium';
  const { tier, model } = morph.modelForDifficulty(difficultyLabel);

  // ── 3. Compact (optional) ────────────────────────────────────────────
  let workingMarkdown = req.markdown;
  let workingSelection = req.selection;
  let compacted = false;

  // Only compact non-selection full docs (or history) over threshold.
  // Never compact the active selection itself.
  if (!req.selection && req.markdown.length > COMPACT_THRESHOLD_CHARS) {
    const c = await morph.compact({
      input: splitLongLines(req.markdown),
      query: compactQuery(req),
      compressionRatio: 0.55,
    });
    // Compact is lossy for generation context only — we still apply onto original.
    // Feed compacted text to the model as context while asking for full doc out.
    workingMarkdown = c.output;
    compacted = c.compacted;
  }

  const modelReq = {
    ...req,
    markdown: workingMarkdown,
    selection: workingSelection,
  };

  // If selection path and surrounding doc is huge, attach a compacted doc sketch
  // as extra history context (optional enhancement — skip if selection-only is enough).
  const messages = buildMessages(modelReq);

  // ── 4. Fast Models ───────────────────────────────────────────────────
  let chat;
  try {
    chat = await morph.chat({
      model,
      messages,
      max_tokens: req.options.maxOutputTokens,
      temperature: req.mode === 'fix_grammar' ? 0.1 : 0.35,
    });
  } catch (e) {
    return {
      ok: false,
      status: e.status && e.status < 500 ? e.status : 502,
      body: {
        ok: false,
        error: {
          code: 'MORPH_CHAT_FAILED',
          message: e.message || 'Model call failed',
          retryable: true,
        },
      },
    };
  }

  const piece = extractMarkdownOutput(chat.content);
  if (!piece) {
    return {
      ok: false,
      status: 502,
      body: {
        ok: false,
        error: {
          code: 'EMPTY_MODEL_OUTPUT',
          message: 'Model returned empty content',
          retryable: true,
        },
      },
    };
  }

  // ── 5. Optional output Reflex ────────────────────────────────────────
  let reflexAssistant = null;
  if (!opts.skipOutputReflex) {
    try {
      reflexAssistant = await morph.reflexPredict('leaked-thinking', piece.slice(0, 8000));
      if (selectedIncludes(reflexAssistant, 'leaked')) {
        // Strip common thinking markers rather than hard-fail.
        const cleaned = piece
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .replace(/^thinking:.*$/gim, '')
          .trim();
        if (cleaned) {
          return success({
            req,
            piece: cleaned,
            model: chat.model || model,
            tier,
            difficultyLabel,
            classifications,
            compacted,
            usage: chat.usage,
            reflexUser,
            reflexAssistant,
            explanation: 'Removed leaked internal reasoning from model output.',
          });
        }
      }
    } catch {
      reflexAssistant = null;
    }
  }

  return success({
    req,
    piece,
    model: chat.model || model,
    tier,
    difficultyLabel,
    classifications,
    compacted,
    usage: chat.usage,
    reflexUser,
    reflexAssistant,
    explanation: defaultExplanation(req.mode),
  });
}

function success({
  req,
  piece,
  model,
  tier,
  difficultyLabel,
  classifications,
  compacted,
  usage,
  reflexUser,
  reflexAssistant,
  explanation,
}) {
  const scope = req.selection ? 'selection' : 'document';
  const markdown =
    scope === 'selection' ? applyScope(req.markdown, req.selection, piece) : piece;

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      markdown,
      piece,
      scope,
      explanation,
      model,
      routing: {
        tier,
        difficulty: difficultyLabel,
        confidence: classifications?.difficulty?.confidence ?? null,
        domain: classifications?.domain?.label ?? null,
      },
      compacted,
      usage: usage
        ? {
            inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
            outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
            totalTokens: usage.total_tokens ?? null,
          }
        : null,
      reflex: {
        user: pickLabels(reflexUser),
        assistant: reflexAssistant ? reflexAssistant.selected || [reflexAssistant.label].filter(Boolean) : [],
      },
      selection: req.selection
        ? { start: req.selection.start, end: req.selection.end }
        : null,
    },
  };
}

function blocked(code, message, extra = {}, status = 400) {
  return {
    ok: false,
    status,
    body: {
      ok: false,
      error: {
        code,
        message,
        retryable: Boolean(extra.retryable),
      },
      ...extra,
    },
  };
}

function selectedIncludes(result, label) {
  if (!result) return false;
  const want = String(label).toLowerCase();
  if (Array.isArray(result.selected) && result.selected.some((s) => String(s).toLowerCase() === want)) {
    return true;
  }
  if (result.label && String(result.label).toLowerCase() === want) return true;
  return false;
}

function pickLabels(reflexUser) {
  const out = [];
  for (const k of Object.keys(reflexUser || {})) {
    const r = reflexUser[k];
    if (!r) continue;
    if (r.label) out.push(`${k}:${r.label}`);
    else if (r.selected?.length) out.push(`${k}:${r.selected.join('|')}`);
  }
  return out;
}

function defaultExplanation(mode) {
  switch (mode) {
    case 'rewrite':
      return 'Rewrote for clarity.';
    case 'shorten':
      return 'Shortened while keeping key points.';
    case 'fix_grammar':
      return 'Fixed grammar and spelling.';
    default:
      return 'Applied your instruction.';
  }
}

/** Morph Compact prefers multi-line input; split giant single lines. */
export function splitLongLines(text, maxLen = 500) {
  return String(text)
    .split('\n')
    .flatMap((line) => {
      if (line.length <= maxLen) return [line];
      const chunks = [];
      for (let i = 0; i < line.length; i += maxLen) chunks.push(line.slice(i, i + maxLen));
      return chunks;
    })
    .join('\n');
}
