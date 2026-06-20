/* POST /api/share — create a new Pastebin paste and return its key */

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const BASE = process.env.PASTEBIN_BASE_URL;
  const KEY  = process.env.PASTEBIN_API_KEY;

  if (!BASE || !KEY) {
    return res.status(500).json({ error: "Server configuration error" });
  }

  /* Read the raw text body (markdown from the client) */
  var body = "";
  try {
    body = await new Promise(function (resolve, reject) {
      var data = "";
      req.on("data", function (chunk) { data += chunk; });
      req.on("end", function () { resolve(data); });
      req.on("error", function (err) { reject(err); });
    });
  } catch (e) {
    return res.status(400).json({ error: "Failed to read request body" });
  }

  if (!body) {
    return res.status(400).json({ error: "Empty content" });
  }

  try {
    /* Build form-encoded body for Pastebin API */
    var params = new URLSearchParams();
    params.append("api_dev_key", KEY);
    params.append("api_option", "paste");
    params.append("api_paste_code", body);
    params.append("api_paste_private", "2");   /* unlisted — not public */
    params.append("api_paste_expire_date", "N"); /* never expires */
    params.append("api_paste_name", "flatwrite");

    var upstream = await fetch(BASE + "/api/api_paste.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    var text = await upstream.text();

    /* Pastebin returns the paste URL on success, or an error message */
    if (text.indexOf("pastebin.com/") === -1 || !upstream.ok) {
      return res.status(502).json({ error: "upstream_error" });
    }

    /* Extract the paste key from the URL (last path segment) */
    var key = text.trim().split("/").pop();
    if (!key) {
      return res.status(502).json({ error: "upstream_error" });
    }

    return res.status(200).json({ key: key });
  } catch (err) {
    return res.status(502).json({ error: "upstream_error" });
  }
};
