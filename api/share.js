/* POST /api/share — create a new Hastebin paste and return its key */

const HASTEBIN_URL = process.env.HASTEBIN_SERVER_URL;
const HASTEBIN_KEY = process.env.HASTEBIN_API_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!HASTEBIN_URL || !HASTEBIN_KEY) {
    return res.status(500).json({ error: "Server configuration error" });
  }

  /* Read the raw text body */
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
    const upstream = await fetch(HASTEBIN_URL + "/documents", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Authorization: "Bearer " + HASTEBIN_KEY,
      },
      body: body,
    });

    if (upstream.status === 413) {
      return res.status(413).json({ error: "too_large" });
    }

    if (!upstream.ok) {
      return res.status(502).json({ error: "upstream_error" });
    }

    const data = await upstream.json();
    return res.status(200).json({ key: data.key });
  } catch (err) {
    return res.status(502).json({ error: "upstream_error" });
  }
};
