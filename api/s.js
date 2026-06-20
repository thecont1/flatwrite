/* GET /api/s?key=<key> — fetch raw text from a Hastebin paste */

const HASTEBIN_URL = process.env.HASTEBIN_SERVER_URL;
const HASTEBIN_KEY = process.env.HASTEBIN_API_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { key } = req.query;
  if (!key || typeof key !== "string") {
    return res.status(400).json({ error: "missing_key" });
  }

  if (!HASTEBIN_URL || !HASTEBIN_KEY) {
    return res.status(500).json({ error: "Server configuration error" });
  }

  try {
    const upstream = await fetch(HASTEBIN_URL + "/raw/" + encodeURIComponent(key), {
      headers: {
        Authorization: "Bearer " + HASTEBIN_KEY,
      },
    });

    if (upstream.status === 404) {
      return res.status(404).json({ error: "not_found" });
    }

    if (!upstream.ok) {
      return res.status(502).json({ error: "upstream_error" });
    }

    const content = await upstream.text();

    /* Basic plain-text validation: reject binary content */
    const sample = content.substring(0, 1000);
    if (sample.includes("\0")) {
      return res.status(422).json({ error: "invalid_content" });
    }

    return res.status(200).json({ content });
  } catch (err) {
    return res.status(502).json({ error: "upstream_error" });
  }
};
