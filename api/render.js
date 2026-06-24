// api/render.js
'use strict';
const { renderToDocument } = require('../core/render');

module.exports = async (req, res) => {
  // Internal-only guard
  const internalKey = req.headers['x-internal-key'];
  if (internalKey !== process.env.INTERNAL_RENDER_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

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
