// api/render.js
'use strict';
const { renderToDocument } = require('../core/render');
const { verify } = require('../core/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  /* HMAC auth: constant-time verify + 5-min replay window */
  const secret = process.env.INTERNAL_RENDER_KEY;
  if (!secret) return res.status(500).json({ error: 'Server misconfigured' });

  const ts   = req.headers['x-render-timestamp'];
  const sig  = req.headers['x-render-signature'];
  const auth = verify(secret, 'POST', '/api/render', ts, sig);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });

  // Read body with 512 KB limit
  const MAX_BYTES = 512 * 1024;
  let body = '';
  try {
    body = await new Promise((resolve, reject) => {
      let data = '';
      let total = 0;
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_BYTES) { reject(new Error('Payload too large')); req.destroy(); return; }
        data += chunk;
      });
      req.on('end', () => { resolve(data); });
      req.on('error', (err) => { reject(err); });
    });
  } catch (e) {
    const status = e.message === 'Payload too large' ? 413 : 400;
    const error  = e.message === 'Payload too large' ? 'Payload too large' : 'Failed to read request body';
    return res.status(status).json({ error });
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { markdown = '', ...frontmatter } = parsed;

  if (!markdown) {
    return res.status(400).json({ error: 'markdown field is required' });
  }

  const html = renderToDocument(markdown, frontmatter);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).send(html);
};
