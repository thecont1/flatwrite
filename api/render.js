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

  // Read body manually (consistent with api/share.js pattern)
  let body = '';
  try {
    body = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => { resolve(data); });
      req.on('error', (err) => { reject(err); });
    });
  } catch (e) {
    return res.status(400).json({ error: 'Failed to read request body' });
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
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).send(html);
};
