import yaml from 'js-yaml';

/**
 * Compute HMAC-SHA256 signature using Web Crypto API (CF Worker compatible).
 * Payload: timestamp.method.path
 */
async function sign(secret, timestamp, method, path) {
  const payload = timestamp + '.' + method + '.' + path;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req, env) {
    if (req.method !== 'POST') {
      return new Response('POST only', { status: 405 });
    }

    // Auth
    const apiKey = req.headers.get('X-Api-Key');
    if (apiKey !== env.API_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Parse YAML body
    let fm;
    try {
      const body = await req.text();
      fm = yaml.load(body);
    } catch (e) {
      return new Response('Invalid YAML: ' + e.message, { status: 400 });
    }

    const { url: markdownUrl, ...designParams } = fm;

    if (!markdownUrl) {
      return new Response('YAML must include a `url` field', { status: 400 });
    }

    // Fetch live markdown from source URL
    let markdown;
    try {
      const mdResp = await fetch(markdownUrl);
      if (!mdResp.ok) throw new Error(`HTTP ${mdResp.status}`);
      markdown = await mdResp.text();
    } catch (e) {
      return new Response('Failed to fetch markdown source: ' + e.message, { status: 502 });
    }

    // Sign request with HMAC
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await sign(env.INTERNAL_RENDER_KEY, timestamp, 'POST', '/api/render');

    // Delegate to Vercel render function
    const renderResp = await fetch('https://flatwrite.md/api/render', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Render-Timestamp': String(timestamp),
        'X-Render-Signature': signature,
      },
      body: JSON.stringify({ markdown, markdownUrl, ...designParams }),
    });

    if (!renderResp.ok) {
      const err = await renderResp.text();
      return new Response('Render failed: ' + err, { status: 502 });
    }

    const html = await renderResp.text();
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};
