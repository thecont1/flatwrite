# FlatWrite

> **Write once, style many worlds.**

Markdown is one of the greatest cross-platform information formats ever invented. Ironically, while it is easy to read, it is also somehow difficult to read.

**FlatWrite** makes it easy — and actually pleasant — to work with markdown files. It renders your markdown in the most pleasing, customisable viewing format. From there, it is one quick step to becoming the markdown editor you reach for by default. And once the file looks and reads the way you love it, export it as **HTML** or **PDF**, or send it around as a **shareable URL**.

## What it does

- **Load** markdown from a URL or straight from your disk.
- **Edit** markdown with a clean, minimal editor and a helpful formatting toolbar.
- **View** your rendered markdown with a clean, document-first preview.
- **Read** mode gives you a focused, distraction-free preview you can resize to taste.
- **Export** to `.md`, `.html`, or `.pdf` whenever you are ready.
- **Share** your document as a real URL

## Share & publish

**The share button is the jewel in the crown.** Instead of stuffing a long document into a URL hash, FlatWrite saves the markdown to a paste bin backend and returns a short, readable link. The recipient can open the link and immediately see the document in the same preview style you chose.

- Links are short enough to paste into a chat, email, or a tweet.
- The document is stored server-side, so it works with large files and survives URL-length limits.
- Opening a shared link loads the exact content, ready to read, edit, or re-export.

## Typography and layout

The preview is built around a polished document experience with fine-grained controls:

- **Eight bundled fonts** to choose from:
  - **Inter** (variable, 100–900) — the workhorse
  - **JetBrains Mono** (variable, 100–800) — for code-heavy docs
  - **Lora** (variable, 400–700) — a contemporary serif
  - **Merriweather** (variable, 400–900) — a reading serif
  - **Playfair Display** (variable, 400–900) — a high-contrast display serif
  - **Comfortaa** (variable, 300–700) — a friendly geometric
  - **Lato** (300 / 400 / 700) — a humanist sans
  - **Unbounded** (variable, 200–900) — an expressive display sans

- Pick a font, then tune **size**, **weight**, and **line spacing** until the reading rhythm feels right. Adjust **UI zoom** when the chrome needs to be a little larger or smaller. All fonts are self-hosted and bundled, so the rendered output has no external font dependency.

## Get started

Open [flatwrite.md](https://flatwrite.md) in your browser.

Then either paste a markdown file into the text area, open a markdown file that's already on your hard disk, or open one from a URL. 

Make any edits to the raw markdown in **Edit** mode, then switch to **View** mode to apply style changes, then click on **Read** to see the final version in an uncluttered layout. When you click on the **Share** icon, the URL gets automatically copied to your clipboard.

## For developers

FlatWrite exposes the same renderer that powers the editor as a public HTTP API and an MCP server. The full specification — tool reference, authentication model, output schemas, and setup examples — is in [`mcp/MCP.md`](./mcp/MCP.md).

```bash
curl -X POST https://render.flatwrite.md/render \
  -H 'Content-Type: application/json' \
  -H 'X-Api-Key: YOUR_API_KEY' \
  -d '{"markdown":"# Hello, FlatWrite"}'
```

The OpenAPI spec is in [`openapi.yaml`](./openapi.yaml).

## Why another markdown editor?

Because most editors either look like a code playground or a publishing pipeline. FlatWrite sits somewhere sweeter: close enough to the raw text that you still control it, but polished enough that you actually enjoy reading and sharing what you create.

