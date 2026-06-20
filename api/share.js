/* POST /api/share — create a new Dustebin paste and return its key */

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  var BASE = process.env.DUSTEBIN_BASE_URL;

  if (!BASE) {
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
    var upstream = await fetch(BASE + "/api/pastes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: body,
        language: "markdown",
        expiration: "30d",
      }),
    });

    if (!upstream.ok) {
      var errText = await upstream.text().catch(function () { return ""; });
      return res.status(502).json({ error: "upstream_error" });
    }

    var data = await upstream.json();

    if (!data || !data.id) {
      return res.status(502).json({ error: "upstream_error" });
    }

    return res.status(200).json({ key: data.id });
  } catch (err) {
    return res.status(502).json({ error: "upstream_error" });
  }
};
