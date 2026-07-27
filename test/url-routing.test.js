import { describe, expect, test } from 'bun:test';
const {
  decideUrlRoute,
  resolveUrlTarget,
  rewriteMarkdownUrls,
} = require('../public/url-routing.js');

describe('smart URL routing', () => {
  const cases = [
    ['https://example.com/doc.md', '', 'direct'],
    ['https://example.com/report.PDF?download=1', '', 'direct'],
    ['https://raw.githubusercontent.com/org/repo/main/README', '', 'direct'],
    ['https://github.com/org/repo/blob/main/README.md', '', 'direct'],
    ['https://example.com/essay', 'text/html; charset=utf-8', 'import'],
    ['https://example.com/essay', 'text/markdown', 'direct'],
    ['https://example.com/download', 'application/pdf', 'direct'],
    ['https://example.com/essay', '', 'probe'],
  ];

  for (const [url, contentType, expected] of cases) {
    test(`${url} + ${contentType || '(unknown)'} -> ${expected}`, () => {
      expect(decideUrlRoute(url, contentType)).toBe(expected);
    });
  }
});

describe('RFC 3986 URL resolution', () => {
  const base = 'https://www.thecontrarian.in/essay/ayodhya/';

  test('resolves root-relative URL against origin (Ayodhya named case)', () => {
    expect(resolveUrlTarget('/library/originals/Ayodhya-TIME/MS202401-Ayodhya0658.jpg', base))
      .toBe('https://www.thecontrarian.in/library/originals/Ayodhya-TIME/MS202401-Ayodhya0658.jpg');
  });

  test('resolves document-relative URL against page directory', () => {
    expect(resolveUrlTarget('images/photo.jpg', base))
      .toBe('https://www.thecontrarian.in/essay/ayodhya/images/photo.jpg');
  });

  for (const target of [
    'https://cdn.example.com/x.jpg',
    '//cdn.example.com/x.jpg',
    'data:image/png;base64,ABC',
    'mailto:hello@example.com',
    '#section',
  ]) {
    test(`preserves ${target}`, () => {
      expect(resolveUrlTarget(target, base)).toBe(target);
    });
  }
});

describe('imported Markdown title normalization', () => {
  const { ensureMarkdownH1 } = require('../public/url-routing.js');

  test('adds an h1 after frontmatter when markdown.new only supplies title metadata', () => {
    const markdown = '---\ntitle: Metadata title\n---\n\nBody';
    expect(ensureMarkdownH1(markdown, 'Ayodhya: Myth Under Construction'))
      .toBe('---\ntitle: Metadata title\n---\n\n# Ayodhya: Myth Under Construction\n\nBody');
  });

  test('does not duplicate an existing h1', () => {
    const markdown = '# Existing title\n\nBody';
    expect(ensureMarkdownH1(markdown, 'Fallback title')).toBe(markdown);
  });
});

describe('markdown source URL rewriting', () => {
  const base = 'https://www.thecontrarian.in/essay/ayodhya/';

  test('rewrites image and link targets while preserving titles', () => {
    const markdown = [
      '![Ayodhya](/library/originals/Ayodhya-TIME/MS202401-Ayodhya0658.jpg "Photo")',
      '[Notes](notes/report.md)',
    ].join('\n');
    const rewritten = rewriteMarkdownUrls(markdown, base);
    expect(rewritten).toContain('](https://www.thecontrarian.in/library/originals/Ayodhya-TIME/MS202401-Ayodhya0658.jpg "Photo")');
    expect(rewritten).toContain('](https://www.thecontrarian.in/essay/ayodhya/notes/report.md)');
  });

  test('preserves protocol-relative, data, mailto, fragment, and absolute targets', () => {
    const targets = [
      '//cdn.example.com/a.jpg',
      'data:image/png;base64,ABC',
      'mailto:hello@example.com',
      '#section',
      'https://cdn.example.com/a.jpg',
    ];
    const markdown = targets.map((target, index) => `[L${index}](${target})`).join('\n');
    expect(rewriteMarkdownUrls(markdown, base)).toBe(markdown);
  });
});
