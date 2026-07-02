# flatwrite-extract

MarkItDown-backed file extraction service for FlatWrite.

## What it does

Accepts a multipart upload (PDF, PPTX, DOCX, XLSX, XLS, CSV, JSON, XML, ZIP,
EPUB, HTML, PNG/JPG/GIF/WEBP/TIFF, MP3/WAV/M4A/OGG/FLAC) and returns
deterministic Markdown. No LLM calls, no disk writes, no URL-based
conversion — all work happens in-memory in a single `BytesIO`.

## API

### `POST /extract`

`multipart/form-data` with field `file`.

- 25 MB hard cap → `413`
- Empty file → `400`
- Unknown extension → `415`
- Conversion error → `500`

Success:

```json
{
  "markdown": "...",
  "metadata": {
    "extractionType": "powerpoint-notes | word-body | pdf-body | excel-tables | structured-data | html-body | zip-contents | epub-body | image-metadata | audio-metadata | raw",
    "filename": "deck.pptx",
    "fileType": "powerpoint",
    "sizeBytes": 12345
  }
}
```

### `GET /health`

Liveness probe for Fly.io / Docker. Returns `{ ok: true, service, maxBytes }`.

## Post-processing rules

| fileType    | rule                                             |
|-------------|--------------------------------------------------|
| `powerpoint`| Extract speaker `Notes:` only; fall back to full body if none. |
| `word`      | Passthrough.                                     |
| `pdf`       | Strip lines that repeat ≥4 times (header/footer).|
| `excel`     | Passthrough.                                     |
| `csv`       | Passthrough (extractionType: `structured-data`). |
| `json`      | Passthrough (extractionType: `structured-data`). |
| `xml`       | Passthrough (extractionType: `structured-data`). |
| `zip`       | Passthrough.                                     |
| `epub`      | Passthrough.                                     |
| `html`      | Passthrough.                                     |
| `image`     | Metadata stub only — no OCR (v1).                |
| `audio`     | Metadata stub only — no transcription (v1).      |

## Local dev

```sh
uv sync
uv run uvicorn flatwrite_extract.main:app --reload --port 8000
```

In another shell:

```sh
curl -s -F "file=@test/extract/fixtures/sample.pptx" \
  http://localhost:8000/extract | jq .
```

## Tests

```sh
uv run --directory ../.. bun run test:py
# or directly
uv run pytest ../../test/extract
```

## Deploy (Fly.io)

```sh
flyctl deploy --remote-only
```

The Cloudflare Worker at `extract.flatwrite.md` is the only public caller.
It re-signs each request with `INTERNAL_EXTRACT_KEY` before forwarding —
this service never sees a browser-origin key.
