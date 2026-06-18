# FlatWrite

Markdown is one of the greatest cross-platform information formats ever invented. Ironically, while it is easy to read, it is also somehow difficult to read.

**FlatWrite** makes it easy — and actually pleasant — to work with markdown files. It renders your markdown in the most pleasing, customisable viewing format. From there, it is one quick step to becoming the markdown editor you reach for by default. And once the file looks and reads the way it should, you can export it as **HTML** or **PDF**.

One of the cooler features of FlatWrite is the ability to pick from a variety of small UI frameworks. It is a good way to try out some innovative frameworks you may never have heard of.

> **Write once, style many worlds.**

## What it does

- **Edit** markdown with a clean, minimal editor and a helpful formatting toolbar.
- **View** your rendered markdown with a choice of lightweight CSS frameworks.
- **Read** mode gives you a focused, distraction-free preview you can resize to taste.
- **Export** to `.md`, `.html`, or `.pdf` whenever you are ready.
- **Share** your document as a URL — the entire state is compressed into the hash.
- **Load** markdown from a URL or straight from your disk.

## UI frameworks

FlatWrite ships with a small but curated set of frameworks:

- **Spectre.css** — a lightweight, responsive framework with useful components.
- **PoshUI** — an elegant, modern class-light option.
- **Oat** — minimal and tasteful.
- **Pico CSS** — classless, semantic-first styling.
- **Milligram** — tiny, typography-focused.
- **Chota** — a micro framework with a simple grid.
- **Simple.css** — classless, sensible defaults.

Switching between them is instant, so you can see the same content in entirely different clothes.

## Typography and layout

The preview is not just skinned by the framework. You also get fine-grained controls:

- Choose from a handful of quality fonts: Inter, Merriweather, Playfair Display, Lora, Lato, Plus Jakarta Sans, and JetBrains Mono.
- Tweak size, weight, and line spacing until the reading rhythm feels right.
- Adjust UI zoom when the chrome needs to be a little larger or smaller.

## Components

Some frameworks expose small UI components — cards, forms, badges, alerts, avatars, grids, and so on. FlatWrite lets you insert them through a simple picker that writes the correct markup for you. This means your markdown can look like a polished document rather than a wall of text.

## How to run it

FlatWrite is a plain HTML/CSS/JS app. There is no build step.

```bash
bunx serve .
```

Or, if you prefer Node:

```bash
node server.js
```

Open the printed URL in a browser and start writing.

## The demo file

The repo includes `demo-kashmir.md`, a travel itinerary that shows off components, cards, grids, and badges. Load it from disk to see how a markdown document can look like a small web page.

## Tech stack

- [marked.js](https://marked.js.org/) for Markdown → HTML.
- [DOMPurify](https://github.com/cure53/DOMPurify) to keep the rendered output safe.
- [html2pdf.js](https://ekoopmans.github.io/html2pdf.js/) for PDF export.
- Browser-native `CompressionStream` for compact URL sharing.

## Why another markdown editor?

Because most editors either look like a code playground or a publishing pipeline. FlatWrite sits somewhere nicer: close enough to the raw text that you still control it, but polished enough that you actually want to read and share what you wrote.

---

© 2026 [Mahesh Shantaram](https://thecontrarian.in)
