(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FlatwriteUrlRouting = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var DIRECT_EXTENSIONS = /\.(?:md|markdown|txt|pdf|docx?|pptx?|xlsx?|csv|json|xml|zip|epub|png|jpe?g|gif|webp|tiff?|svg|mp3|wav|m4a|ogg|flac)$/i;
  var DIRECT_CONTENT_TYPES = /^(?:text\/(?:markdown|plain)|application\/(?:pdf|json|xml|zip|epub\+zip|msword|vnd\.|octet-stream)|image\/|audio\/)/i;

  function isKnownRawUrl(url) {
    try {
      var parsed = new URL(url);
      if (/^raw\.githubusercontent\.com$/i.test(parsed.hostname)) return true;
      if (/^github\.com$/i.test(parsed.hostname) && /\/blob\//.test(parsed.pathname)) return true;
      return DIRECT_EXTENSIONS.test(parsed.pathname);
    } catch (_) {
      return false;
    }
  }

  function decideUrlRoute(url, contentType) {
    if (isKnownRawUrl(url)) return "direct";
    var type = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
    if (!type) return "probe";
    if (type === "text/html" || type === "application/xhtml+xml") return "import";
    if (DIRECT_CONTENT_TYPES.test(type)) return "direct";
    return "import";
  }

  function resolveUrlTarget(target, baseUrl) {
    if (!target || !baseUrl) return target;
    if (/^(?:https?:|data:|mailto:|#)/i.test(target) || /^\/\//.test(target)) return target;
    try {
      return new URL(target, baseUrl).href;
    } catch (_) {
      return target;
    }
  }

  function rewriteMarkdownUrls(markdown, baseUrl) {
    if (!markdown || !baseUrl) return markdown;
    return String(markdown).replace(
      /(!?\[[^\]]*\]\()([^\s)]+)(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?(\))/g,
      function (match, open, target, title, close) {
        var resolved = resolveUrlTarget(target, baseUrl);
        if (resolved === target) return match;
        return open + resolved + (title || "") + close;
      }
    );
  }

  function ensureMarkdownH1(markdown, title) {
    var source = String(markdown || "");
    if (/^\s*#\s+\S/m.test(source) || !String(title || "").trim()) return source;
    var heading = "# " + String(title).replace(/[\r\n]+/g, " ").trim();
    var frontmatter = source.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/);
    if (!frontmatter) return heading + "\n\n" + source.replace(/^\s+/, "");
    var rest = source.slice(frontmatter[0].length).replace(/^\s+/, "");
    return frontmatter[0].replace(/\s*$/, "\n\n") + heading + "\n\n" + rest;
  }

  return {
    decideUrlRoute: decideUrlRoute,
    ensureMarkdownH1: ensureMarkdownH1,
    isKnownRawUrl: isKnownRawUrl,
    resolveUrlTarget: resolveUrlTarget,
    rewriteMarkdownUrls: rewriteMarkdownUrls,
  };
});
