## Design Context

### Users

FlatWrite serves a broad but overlapping audience:

- **Writers and publishers** shaping notes, essays, drafts, and manuscripts into polished reading, export, or sharing artifacts.
- **Markdown and technical users** who want direct control over source text without the interface feeling like a code playground.
- **Knowledge workers** converting PDFs, Office documents, spreadsheets, images, and web content into clean, editable markdown.
- **Developers and AI agents** using the render, extract, share, API, and MCP surfaces programmatically.

Their context often begins with existing content or rough text rather than a blank page. The core job is to import or convert content privately, edit the markdown, tune typography and document layout, move fluidly between Edit / View / Read modes, and export or share the result as Markdown, HTML, PDF, or a short URL. The human interface should prioritize writers and readers; developer and agent surfaces should remain predictable, precise, and automation-friendly without dominating the product experience.

### Brand Personality

**Three words:** calm, polished, delightful.

FlatWrite should feel confident, focused, and quietly magical: a tool people trust with their words and enjoy returning to. The voice can be lightly irreverent — as in “pretty damn good markdown” — but should never become noisy, cute at the expense of clarity, or gimmicky. Delight should come from craft, fluidity, typography, and small moments of polish. Privacy and local-first behavior are part of the emotional contract: the interface should feel trustworthy, immediate, and free of unnecessary friction.

### Aesthetic Direction

The canonical visual direction is **dreamy pastel glass**. Preserve the signature multi-color pastel gradient, translucent blurred panels, soft rounded geometry, delicate borders, gentle shadows, and generous negative space. The white document canvas is the visual anchor; surrounding chrome should frame and support it rather than compete with it.

Existing visual language worth preserving:

- Dreamy pastel background gradient: `#eab8e4`, `#f5c2da`, `#f7e9a1`, `#a2d8c2`, `#7eb8d4`, `#5d7a8e`.
- Brand/action gradient: `#b06ab3` to `#4568dc`, with `#b06ab3` as the primary accent.
- Text colors around `#2d2a3e`, `#5d5878`, and accessible muted variants.
- Rounded outer/inner surfaces, approximately 24px and 18px.
- Translucent glass surfaces with soft blur and restrained shadows.
- Unbounded for display/brand moments, Lato for UI, JetBrains Mono for editing and code.
- User-controlled document typography, size, weight, line spacing, page geometry, and pagination.

The current light theme is canonical; dark mode is not presently a requirement. Avoid directions that make FlatWrite feel like a developer IDE, a generic admin dashboard, a heavy publishing pipeline/CMS, or a visually loud novelty app. The appropriate tension is between editorial calm and soft, magical delight.

### Design Principles

1. **Document first, chrome second.** The content canvas and reading experience dominate every layout. Controls should frame, recede, or progressively disappear when focus is needed.
2. **Make power feel simple.** Use sensible defaults, clear labels, progressive disclosure, and spatial hierarchy so advanced typography, pagination, conversion, and export controls never overwhelm the writing surface.
3. **Preserve the signature magic — with restraint.** Keep the pastel gradient, glass, softness, and moments of delight, but subordinate them to legibility, hierarchy, and the document itself.
4. **Respect the writer’s control.** Markdown remains visible, editable, and portable. Preview, pagination, export, and sharing should feel faithful and predictable rather than like hidden transformations.
5. **Accessibility is part of polish.** Treat WCAG 2.2 AA as the minimum, with keyboard and screen-reader parity, color-blind-safe cues, reduced-motion support, touch-friendly targets, and responsive behavior as non-negotiable quality criteria.
