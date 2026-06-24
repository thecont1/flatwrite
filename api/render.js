// api/render.js — canonical /api/render handler
// Uses only standard Node.js http.ServerResponse methods so it works
// both in Vercel's runtime and the custom server (index.js).
'use strict';
const { renderToDocument } = require('../core/render');
const { verify } = require('../core/auth');

const MAX_BYTES = 512 * 1024;

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

module.exports = async function handleRender(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'POST only' });
  }

  /* HMAC auth: constant-time verify + 5-min replay window */
  const secret = process.env.INTERNAL_RENDER_KEY;
  if (!secret) return json(res, 500, { error: 'Server misconfigured' });

  const ts   = req.headers['x-render-timestamp'];
  const sig  = req.headers['x-render-signature'];
  const auth = verify(secret, 'POST', '/api/render', ts, sig);
  if (!auth.ok) return json(res, 401, { error: 'Unauthorized' });

  /* Read body with size limit */
  let body;
  try {
    body = await new Promise((resolve, reject) => {
      let data = '';
      let total = 0;
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_BYTES) { reject(new Error('Payload too large')); req.destroy(); return; }
        data += chunk;
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  } catch (e) {
    const status = e.message === 'Payload too large' ? 413 : 400;
    const error  = e.message === 'Payload too large' ? 'Payload too large' : 'Failed to read request body';
    return json(res, status, { error });
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  const { markdown = '', ...frontmatter } = parsed;
  if (!markdown) {
    return json(res, 400, { error: 'markdown field is required' });
  }

  try {
    const html = renderToDocument(markdown, frontmatter);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.statusCode = 200;
    res.end(html);
  } catch (err) {
    return json(res, 500, { error: 'Render failed: ' + err.message });
  }
};
