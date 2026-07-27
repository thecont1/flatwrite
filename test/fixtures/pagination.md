---
docEngine: pagedjs
surfaceMode: doc
pageSize: A4
orientation: portrait
marginsLR: normal
marginsTB: normal
columns: 1
footer: true
font: Inter
size: 0
weight: 0
line: 0
---
# Deterministic Pagination Fixture

This offline fixture exercises headings, explicit FlatWrite breaks, tables, preformatted text, and inline images without network assets.

![Inline pixel](data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='180' viewBox='0 0 640 180'%3E%3Crect width='640' height='180' fill='%23ddd'/%3E%3Ctext x='24' y='96' font-size='32'%3EFlatWrite offline fixture%3C/text%3E%3C/svg%3E)

## Section One

FlatWrite paginates civic documents, visual essays, and long-form reporting. This paragraph is repeated to provide deterministic page pressure while preserving legible source text. The rendering harness checks that no content box escapes the page area and that no page is empty.

FlatWrite paginates civic documents, visual essays, and long-form reporting. This paragraph is repeated to provide deterministic page pressure while preserving legible source text. The rendering harness checks that no content box escapes the page area and that no page is empty.

| District | Turnout | Status |
| --- | ---: | --- |
| Bengaluru Central | 54.2% | Reported |
| Bengaluru North | 57.8% | Reported |
| Bengaluru South | 53.1% | Reported |

<fw-break lines="2" />

## Section Two

FlatWrite paginates civic documents, visual essays, and long-form reporting. This paragraph is repeated to provide deterministic page pressure while preserving legible source text. The rendering harness checks that no content box escapes the page area and that no page is empty.

FlatWrite paginates civic documents, visual essays, and long-form reporting. This paragraph is repeated to provide deterministic page pressure while preserving legible source text. The rendering harness checks that no content box escapes the page area and that no page is empty.

```text
A deliberately wide preformatted line: constituency-001 | candidate-alpha | votes-123456 | margin-012345 | source-form-20 | verification-complete
```

<fw-break lines="3" />

## Section Three

FlatWrite paginates civic documents, visual essays, and long-form reporting. This paragraph is repeated to provide deterministic page pressure while preserving legible source text. The rendering harness checks that no content box escapes the page area and that no page is empty.

FlatWrite paginates civic documents, visual essays, and long-form reporting. This paragraph is repeated to provide deterministic page pressure while preserving legible source text. The rendering harness checks that no content box escapes the page area and that no page is empty.

### Closing notes

The final page must contain visible body text and, when enabled, exactly one footer line on each side.
