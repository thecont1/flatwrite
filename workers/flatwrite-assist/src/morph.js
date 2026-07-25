/**
 * flatwrite.md - Minimalist Markdown Editor
 *
 * Copyright (C) 2026 Mahesh Shantaram
 * Sole Proprietary Owner. All Rights Reserved.
 *
 * This file is part of flatwrite.md under the GNU AGPL v3.0.
 *
 * Thin Morph HTTP client (no SDK) for Cloudflare Workers.
 */

const DEFAULT_BASE = 'https://api.morphllm.com/v1';

export const DEFAULT_MODELS = {
  easy: 'morph-qwen36-27b',
  medium: 'morph-minimax27-230b',
  hard: 'morph-glm52-744b',
};

/**
 * @param {object} env
 * @param {{ fetch?: typeof fetch }} [deps]
 */
export function createMorphClient(env, deps = {}) {
  const apiKey = env.MORPH_API_KEY;
  const baseURL = (env.MORPH_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const doFetch = deps.fetch || globalThis.fetch.bind(globalThis);

  const models = {
    easy: env.MORPH_MODEL_EASY || DEFAULT_MODELS.easy,
    medium: env.MORPH_MODEL_MEDIUM || DEFAULT_MODELS.medium,
    hard: env.MORPH_MODEL_HARD || DEFAULT_MODELS.hard,
  };

  if (!apiKey) {
    throw new Error('MORPH_API_KEY is not configured');
  }

  async function morphFetch(path, body) {
    const resp = await doFetch(`${baseURL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* leave null */
    }
    if (!resp.ok) {
      const msg =
        (json && (json.error?.message || json.message || json.error)) ||
        text.slice(0, 300) ||
        `HTTP ${resp.status}`;
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      err.status = resp.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  /**
   * Run a Reflex classifier. Returns { label, confidence, selected, classes }.
   */
  async function reflexPredict(model, text) {
    const data = await morphFetch('/reflex/predict', {
      model,
      text: String(text).slice(0, 32_000),
    });
    const classes = Array.isArray(data.classes) ? data.classes : [];
    const selected = classes.filter((c) => c.selected).map((c) => c.label);
    const top = classes.find((c) => c.selected) || null;
    return {
      model,
      label: top?.label ?? data.label ?? null,
      confidence: top?.score ?? data.confidence ?? null,
      selected: selected.length ? selected : Array.isArray(data.selected) ? data.selected : [],
      classes,
      inference_time_ms: data.inference_time_ms,
    };
  }

  /**
   * Classify prompt difficulty / domain for routing.
   */
  async function routerClassify(input, classes = ['difficulty', 'domain']) {
    const data = await morphFetch('/router/classify', {
      input: String(input).slice(0, 65_000),
      classes,
    });
    return data.classifications || data;
  }

  /**
   * Map difficulty label → model id.
   */
  function modelForDifficulty(label) {
    const d = String(label || 'medium').toLowerCase();
    if (d === 'easy' || d === 'low') return { tier: 'easy', model: models.easy };
    if (d === 'hard' || d === 'high') return { tier: 'hard', model: models.hard };
    return { tier: 'medium', model: models.medium };
  }

  /**
   * Compact text; returns { output, compacted: boolean }.
   */
  async function compact({ input, query, compressionRatio = 0.5 }) {
    // Prefer dedicated compact endpoint; fall back to chat model morph-compactor.
    try {
      const data = await morphFetch('/compact', {
        input,
        query,
        compression_ratio: compressionRatio,
        preserve_recent: 0,
      });
      const output = data.output ?? data.choices?.[0]?.message?.content ?? input;
      return {
        output: typeof output === 'string' ? output : input,
        compacted: output !== input,
        raw: data,
      };
    } catch (e) {
      if (e.status === 404 || e.status === 405) {
        const data = await morphFetch('/chat/completions', {
          model: 'morph-compactor',
          messages: [
            {
              role: 'user',
              content: query
                ? `Query: ${query}\n\nCompress by dropping irrelevant lines. Keep surviving lines verbatim.\n\n${input}`
                : input,
            },
          ],
          temperature: 0,
        });
        const output = data.choices?.[0]?.message?.content ?? input;
        return { output, compacted: output !== input, raw: data };
      }
      throw e;
    }
  }

  /**
   * Chat completion (non-stream).
   */
  async function chat({ model, messages, max_tokens = 4096, temperature = 0.3 }) {
    const data = await morphFetch('/chat/completions', {
      model,
      messages,
      max_tokens,
      temperature,
    });
    const content = data.choices?.[0]?.message?.content ?? '';
    return {
      content,
      model: data.model || model,
      usage: data.usage || null,
      raw: data,
    };
  }

  return {
    models,
    reflexPredict,
    routerClassify,
    modelForDifficulty,
    compact,
    chat,
  };
}
