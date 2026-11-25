# FlatWrite

> **Write once, style many worlds.**

FlatWrite turns markdown and common documents into polished pages you can edit, read, export, and share.

## What you can do

- **Write markdown** in a clean editor with a formatting toolbar.
- **Convert documents to markdown** in your browser: PDF, Word, PowerPoint, Excel, CSV, OpenDocument, RTF, and EPUB files.
- **Extract text from images** with on-device OCR.
- **Import from a URL** when the document is already on the web.
- **Edit, View, and Read** — write in Edit, style and paginate in View, then focus on the finished document in Read.
- **Tidy tables** before printing: sort, hide, move, add, and edit rows or columns.
- **Style the document** with eight bundled fonts plus size, weight, line-spacing, page-size, orientation, margin, column, footer, and zoom controls.
- **Render equations** by enabling Math Mode for TeX-style notation.
- **Export** as Markdown, HTML, or PDF.
- **Share** a short link that preserves the document and its chosen style.

## Privacy

Local files are converted in your browser; their bytes do not leave your device. URL imports may be fetched through FlatWrite's server, but conversion still happens in your browser and the fetched document is not stored.

Sharing is the deliberate exception: the markdown and style settings are sent to the paste service FlatWrite uses so the link can be opened elsewhere. Shared links may expire, so do not treat them as private or permanent storage.

## Limits

- Text-based PDFs are supported; scanned or image-only PDFs are not converted.
- Encrypted or password-protected files are not converted.
- Audio files produce a metadata note, not a transcription.
- PDF export requires the Paged.js or Vivliostyle engine.

## Choosing a pagination engine

| Engine | Use it for | Notes |
|---|---|---|
| **Plain CSS** | Editing and quick preview | No pagination or PDF export |
| **Paged.js** | Fast, text-heavy pagination | Basic table support; Running headers can be unreliable |
| **Vivliostyle** | Books, complex layouts, tables | Best table/page support, including `string-set` headers; larger and slower to load |

Need controlled blank space in paged output? Insert `<fw-break lines="3" />`; the number is the number of line-heights, clamped to 0–24.

## Get started

1. Open [flatwrite.md](https://flatwrite.md).
2. Paste markdown, drop in a file, open one from disk, or load one from a URL.
3. Edit in **Edit**, style in **View**, and check the final reading experience in **Read**.
4. Export the file or use **Share** to copy a link.

## For developers

FlatWrite also exposes renderer, conversion, sharing, assist, and MCP interfaces:

- [TECH-SPEC.md](./TECH-SPEC.md) — architecture and engineering decisions
- [openapi.yaml](./openapi.yaml) — HTTP API specification
- [mcp/MCP.md](./mcp/MCP.md) — MCP tools and authentication
- [docs/MORPH-ASSIST.md](./docs/MORPH-ASSIST.md) — AI-assist service

```bash
curl -X POST https://render.flatwrite.md/render \
  -H 'Content-Type: application/json' \
  -H 'X-Api-Key: ***' \
  -d '{"markdown":"# Hello, FlatWrite"}'
```

## License

FlatWrite is available under the [GNU AGPL v3.0](./LICENSE) for open-source use. Commercial licensing is available for closed-source products and private SaaS deployments; contact [Mahesh Shantaram](https://thecontrarian.in/#contact).
