/* GET /api/s?key=<key> — fetch raw text from a Pastebin paste */

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { key } = req.query;
  if (!key || typeof key !== "string") {
    return res.status(400).json({ error: "missing_key" });
  }

  const BASE = process.env.PASTEBIN_BASE_URL;
  const KEY  = process.env.PASTEBIN_API_KEY;

  if (!BASE || !KEY) {
    return res.status(500).json({ error: "Server configuration error" });
  }

  try {
    var params = new URLSearchParams();
    params.append("api_dev_key", KEY);
    params.append("api_option", "show_paste");
    params.append("api_paste_key", key);

    var upstream = await fetch(BASE + "/api/api_raw.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!upstream.ok) {
      return res.status(404).json({ error: "not_found" });
    }

    var content = await upstream.text();

    /* Pastebin returns an error message for invalid/missing pastes */
    if (content.indexOf("Bad API request") !== -1 ||
        content.indexOf("invalid or expired") !== -1 ||
        content.indexOf("not found") !== -1) {
      return res.status(404).json({ error: "not_found" });
    }

    /* Basic plain-text validation: reject binary content */
    var sample = content.substring(0, 1000);
    if (sample.indexOf("\0") !== -1) {
      return res.status(422).json({ error: "invalid_content" });
    }

    return res.status(200).json({ content: content });
  } catch (err) {
    return res.status(502).json({ error: "upstream_error" });
  }
};
