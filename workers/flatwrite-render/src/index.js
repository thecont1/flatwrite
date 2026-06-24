import yaml from 'js-yaml';

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

    // Delegate to Vercel render function
    const renderResp = await fetch('https://flatwrite.md/api/render', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': env.INTERNAL_RENDER_KEY,
      },
      body: JSON.stringify({ markdown, ...designParams }),
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
