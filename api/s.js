/* GET /api/s?key=<key> — fetch raw text from a Dustebin paste */

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { key } = req.query;
  if (!key || typeof key !== "string") {
    return res.status(400).json({ error: "missing_key" });
  }

  const BASE = process.env.DUSTEBIN_BASE_URL;
  if (!BASE) {
    return res.status(500).json({ error: "Server configuration error" });
  }

  try {
    const upstream = await fetch(BASE + "/api/pastes/" + encodeURIComponent(key) + "/raw");

    if (upstream.status === 404 || upstream.status === 410) {
      return res.status(404).json({ error: "not_found" });
    }

    if (!upstream.ok) {
      return res.status(502).json({ error: "upstream_error" });
    }

    const content = await upstream.text();
    const sample = content.substring(0, 1000);
    if (sample.indexOf("\0") !== -1) {
      return res.status(422).json({ error: "invalid_content" });
    }

    return res.status(200).json({ content });
  } catch (err) {
    return res.status(502).json({ error: "upstream_error" });
  }
};
