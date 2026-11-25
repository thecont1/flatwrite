/**
 * Tests for public/extract-core.js: exact Python validator/rule/OCR ports,
 * conversion routing, safe error mapping, and golden parity against the
 * pre-migration extract service corpus.
 */

import { describe, test, expect } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import * as anydoc from '@firecrawl/anydoc-wasm';
import * as pdfInspector from '@firecrawl/pdf-inspector-wasm';
import {
  EXTENSIONS,
  MAX_BYTES,
  ExtractError,
  audioMetadataStub,
  convert,
  extractTitle,
  imageMetadataStub,
  inferType,
  ocrLinesToMarkdown,
  parseFrontmatter,
} from '../public/extract-core.js';

const EXPECTED_EXTENSIONS = {
  '.pdf': { fileType: 'pdf', extractionType: 'pdf-body' },
  '.doc': { fileType: 'word', extractionType: 'word-body' },
  '.docx': { fileType: 'word', extractionType: 'word-body' },
  '.docm': { fileType: 'word', extractionType: 'word-body' },
  '.odt': { fileType: 'word', extractionType: 'word-body' },
  '.rtf': { fileType: 'word', extractionType: 'word-body' },
  '.ppt': { fileType: 'powerpoint', extractionType: 'powerpoint-notes' },
  '.pps': { fileType: 'powerpoint', extractionType: 'powerpoint-notes' },
  '.pot': { fileType: 'powerpoint', extractionType: 'powerpoint-notes' },
  '.pptx': { fileType: 'powerpoint', extractionType: 'powerpoint-notes' },
  '.pptm': { fileType: 'powerpoint', extractionType: 'powerpoint-notes' },
  '.ppsx': { fileType: 'powerpoint', extractionType: 'powerpoint-notes' },
  '.ppsm': { fileType: 'powerpoint', extractionType: 'powerpoint-notes' },
  '.odp': { fileType: 'powerpoint', extractionType: 'powerpoint-notes' },
  '.xls': { fileType: 'excel', extractionType: 'excel-tables' },
  '.xlsx': { fileType: 'excel', extractionType: 'excel-tables' },
  '.xlsm': { fileType: 'excel', extractionType: 'excel-tables' },
  '.xlsb': { fileType: 'excel', extractionType: 'excel-tables' },
  '.ods': { fileType: 'excel', extractionType: 'excel-tables' },
  '.csv': { fileType: 'csv', extractionType: 'structured-data' },
  '.epub': { fileType: 'epub', extractionType: 'epub-body' },
  '.png': { fileType: 'image', extractionType: 'image-ocr' },
  '.jpg': { fileType: 'image', extractionType: 'image-ocr' },
  '.jpeg': { fileType: 'image', extractionType: 'image-ocr' },
  '.gif': { fileType: 'image', extractionType: 'image-ocr' },
  '.webp': { fileType: 'image', extractionType: 'image-ocr' },
  '.tiff': { fileType: 'image', extractionType: 'image-ocr' },
  '.tif': { fileType: 'image', extractionType: 'image-ocr' },
  '.mp3': { fileType: 'audio', extractionType: 'audio-metadata' },
  '.wav': { fileType: 'audio', extractionType: 'audio-metadata' },
  '.m4a': { fileType: 'audio', extractionType: 'audio-metadata' },
  '.ogg': { fileType: 'audio', extractionType: 'audio-metadata' },
  '.flac': { fileType: 'audio', extractionType: 'audio-metadata' },
};

function expectExtractError(error, status, code) {
  expect(error).toBeInstanceOf(ExtractError);
  expect(error.status).toBe(status);
  expect(error.code).toBe(code);
}

async function captureError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected promise to reject');
}

describe('EXTENSIONS and inferType', () => {
  test('extension table is an exact port of validators.py', () => {
    expect(Object.keys(EXTENSIONS)).toHaveLength(33);
    expect(EXTENSIONS).toEqual(EXPECTED_EXTENSIONS);
  });

  test('MAX_BYTES is 25 MiB', () => {
    expect(MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  test('inferType uses basename, last dot, lowercase semantics', () => {
    expect(inferType('folder/Report.DOCX')).toEqual({ fileType: 'word', extractionType: 'word-body' });
    expect(inferType('folder\\deck.PPSX')).toEqual({ fileType: 'powerpoint', extractionType: 'powerpoint-notes' });
    expect(inferType('archive.tar.pdf')).toEqual({ fileType: 'pdf', extractionType: 'pdf-body' });
  });

  test('inferType throws for empty, extensionless, and unsupported names', () => {
    expect(() => inferType('')).toThrow('filename is empty');
    expect(() => inferType('README')).toThrow('no extension');
    expect(() => inferType('notes.md')).toThrow("unsupported extension '.md'");
  });
});

describe('metadata stubs', () => {
  test('image stub is byte-equal to rules.py', () => {
    expect(imageMetadataStub('photo.png', 12345)).toBe(
      '## Image metadata\n\n' +
      '- **Filename:** `photo.png`\n' +
      '- **Size:** 12345 bytes\n' +
      '\n_No text was detected in this image (OCR found no readable text)._\n',
    );
  });

  test('audio stub is byte-equal to rules.py', () => {
    expect(audioMetadataStub('sound.wav', 54321)).toBe(
      '## Audio metadata\n\n' +
      '- **Filename:** `sound.wav`\n' +
      '- **Size:** 54321 bytes\n' +
      '\n_AnyDoc does not transcribe audio (transcription is not enabled in v1)._\n',
    );
  });
});

describe('ocrLinesToMarkdown', () => {
  // Expected strings generated once by running services/extract/.../ocr.py on
  // the same synthetic rows, then hardcoded here so tests never shell out.
  const cases = [
    [
      'single heading',
      [
        { x: 10, y: 10, w: 300, h: 60, text: 'QUARTERLY REPORT', conf: 95 },
        { x: 12, y: 100, w: 250, h: 20, text: 'Revenue overview', conf: 90 },
        { x: 12, y: 126, w: 240, h: 20, text: 'continues here', conf: 90 },
      ],
      '# QUARTERLY REPORT\n\nRevenue overview continues here\n',
    ],
    [
      'bullets and missed-bullet continuation',
      [
        { x: 50, y: 100, w: 180, h: 20, text: '· First item', conf: 95 },
        { x: 75, y: 124, w: 180, h: 20, text: 'continues cleanly', conf: 95 },
        { x: 50, y: 148, w: 180, h: 20, text: 'Second item', conf: 95 },
        { x: 50, y: 172, w: 180, h: 20, text: 'Another item', conf: 95 },
      ],
      '- First item continues cleanly\n\nSecond item Another item\n',
    ],
    [
      'two columns',
      [
        { x: 20, y: 100, w: 120, h: 20, text: 'Left top', conf: 95 },
        { x: 300, y: 100, w: 120, h: 20, text: 'Right top', conf: 95 },
        { x: 20, y: 124, w: 120, h: 20, text: 'Left bottom', conf: 95 },
        { x: 300, y: 124, w: 120, h: 20, text: 'Right bottom', conf: 95 },
      ],
      'Left top\n\nRight top\n\nLeft bottom\n\nRight bottom\n',
    ],
    [
      'single-line trailing-colon heading',
      [
        { x: 10, y: 10, w: 150, h: 20, text: 'Summary:', conf: 95 },
        { x: 10, y: 50, w: 180, h: 20, text: 'Body text', conf: 95 },
      ],
      '### Summary\n\nBody text\n',
    ],
    [
      'space fixes',
      [
        { x: 10, y: 10, w: 260, h: 20, text: 'Location:Delhi Coder&Data 3-6Years SUBMITYoUR', conf: 95 },
      ],
      'Location: Delhi Coder & Data 3-6 Years SUBMIT YOUR\n',
    ],
  ];

  for (const [name, rows, expected] of cases) {
    test(name, () => {
      expect(ocrLinesToMarkdown(rows)).toBe(expected);
    });
  }

  test('empty input returns empty string', () => {
    expect(ocrLinesToMarkdown([])).toBe('');
    expect(ocrLinesToMarkdown(null)).toBe('');
  });
});

describe('frontmatter helpers', () => {
  test('parseFrontmatter parses flat scalar key/value pairs', () => {
    expect(parseFrontmatter('---\ntitle: "Hello"\ndescription: World\n---\n# Body\n')).toEqual({
      frontmatter: { title: 'Hello', description: 'World' },
      body: '# Body\n',
    });
    expect(parseFrontmatter('# No frontmatter\n')).toEqual({ frontmatter: null, body: '# No frontmatter\n' });
  });

  test('extractTitle priority is frontmatter, H1, hostname, URL', () => {
    expect(extractTitle('# H1\n', { title: 'FM' }, 'https://example.com/x')).toBe('FM');
    expect(extractTitle('# H1\n', null, 'https://example.com/x')).toBe('H1');
    expect(extractTitle('body', null, 'https://example.com/x')).toBe('example.com');
    expect(extractTitle('body', null, 'not a url')).toBe('not a url');
  });
});

function fakeAnydoc({ format = 'docx', markdown = 'converted\n', throwCode = null } = {}) {
  return {
    calls: [],
    formatFromExtension(ext) {
      this.calls.push(['formatFromExtension', ext]);
      return format;
    },
    toMarkdownBytes(bytes, fmt) {
      this.calls.push(['toMarkdownBytes', fmt]);
      if (throwCode) {
        const error = new Error('internal fixture path /private/library detail');
        error.code = throwCode;
        throw error;
      }
      return markdown;
    },
  };
}

describe('convert validation and error mapping', () => {
  const bytes = new Uint8Array([1, 2, 3]);

  test('empty and oversized files are rejected before type detection', async () => {
    expectExtractError(await captureError(convert({ bytes: new Uint8Array(), filename: 'x.unknown', engines: {} })), 400, 'EMPTY_FILE');
    expectExtractError(await captureError(convert({ bytes: new Uint8Array(MAX_BYTES + 1), filename: 'x.unknown', engines: {} })), 413, 'PAYLOAD_TOO_LARGE');
  });

  test('unsupported filenames and allowTypes map to 415', async () => {
    expectExtractError(await captureError(convert({ bytes, filename: 'notes.md', engines: {} })), 415, 'UNSUPPORTED_FILE_TYPE');
    expectExtractError(await captureError(convert({
      bytes,
      filename: 'photo.png',
      engines: { ocr: async () => [] },
      allowTypes: ['pdf', 'word'],
    })), 415, 'UNSUPPORTED_FILE_TYPE');
  });

  test('image without an OCR engine maps to 415', async () => {
    expectExtractError(await captureError(convert({ bytes, filename: 'photo.png', engines: {} })), 415, 'UNSUPPORTED_FILE_TYPE');
  });

  test('anydoc encrypted and needsOcr errors map to dedicated 422 codes', async () => {
    for (const [engineCode, expectedCode] of [['encrypted', 'ENCRYPTED'], ['needsOcr', 'NEEDS_OCR']]) {
      const error = await captureError(convert({
        bytes,
        filename: 'file.docx',
        engines: { anydoc: fakeAnydoc({ throwCode: engineCode }) },
      }));
      expectExtractError(error, 422, expectedCode);
      expect(error.message).not.toContain('/private');
      expect(error.message).not.toContain('library detail');
    }
  });

  test('malformed, missingPart, resourceLimit, unsupported, and unknown errors map to safe 500s', async () => {
    for (const engineCode of ['malformed', 'missingPart', 'resourceLimit', 'unsupported', 'unknown']) {
      const error = await captureError(convert({
        bytes,
        filename: 'file.docx',
        engines: { anydoc: fakeAnydoc({ throwCode: engineCode }) },
      }));
      expectExtractError(error, 500, 'CONVERT_FAILED');
      expect(error.message).toBe('Conversion failed');
    }
  });
});

describe('PDF routing', () => {
  const bytes = new Uint8Array([37, 80, 68, 70]);

  test('non-empty pdf-inspector markdown is passed through without anydoc', async () => {
    let anydocCalled = false;
    const result = await convert({
      bytes,
      filename: 'file.pdf',
      engines: {
        pdf: { processPdf: () => ({ markdown: 'pdf inspector markdown\n' }) },
        anydoc: {
          formatFromExtension: () => 'pdf',
          toMarkdownBytes: () => { anydocCalled = true; return 'anydoc\n'; },
        },
      },
    });
    expect(result.markdown).toBe('pdf inspector markdown\n');
    expect(anydocCalled).toBe(false);
  });

  test('empty pdf-inspector markdown falls back to anydoc pdf', async () => {
    const anydocEngine = fakeAnydoc({ markdown: 'anydoc fallback\n' });
    const result = await convert({
      bytes,
      filename: 'file.pdf',
      engines: {
        pdf: { processPdf: () => ({ markdown: '   ' }) },
        anydoc: anydocEngine,
      },
    });
    expect(result.markdown).toBe('anydoc fallback\n');
    expect(anydocEngine.calls).toContainEqual(['toMarkdownBytes', 'pdf']);
  });

  test('pdf-inspector exceptions fall back to anydoc pdf', async () => {
    const anydocEngine = fakeAnydoc({ markdown: 'fallback after throw\n' });
    const result = await convert({
      bytes,
      filename: 'file.pdf',
      engines: {
        pdf: { processPdf: () => { throw new Error('inspector exploded'); } },
        anydoc: anydocEngine,
      },
    });
    expect(result.markdown).toBe('fallback after throw\n');
  });

  test('anydoc needsOcr during PDF fallback maps to NEEDS_OCR', async () => {
    const error = await captureError(convert({
      bytes,
      filename: 'file.pdf',
      engines: {
        pdf: { processPdf: () => ({ markdown: null }) },
        anydoc: fakeAnydoc({ throwCode: 'needsOcr' }),
      },
    }));
    expectExtractError(error, 422, 'NEEDS_OCR');
  });
});

describe('image and audio routing', () => {
  test('audio always returns the exact metadata stub', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = await convert({ bytes, filename: 'sound.wav', engines: {} });
    expect(result.markdown).toBe(audioMetadataStub('sound.wav', 4));
    expect(result.metadata).toEqual({
      extractionType: 'audio-metadata',
      filename: 'sound.wav',
      fileType: 'audio',
      sizeBytes: 4,
    });
  });

  test('image OCR rows become markdown', async () => {
    const result = await convert({
      bytes: new Uint8Array([1]),
      filename: 'photo.png',
      engines: {
        ocr: async () => [{ x: 10, y: 10, w: 100, h: 20, text: 'Hello OCR', conf: 90 }],
      },
    });
    expect(result.markdown).toBe('Hello OCR\n');
  });

  test('empty OCR rows and OCR failure become the exact image stub', async () => {
    for (const ocr of [async () => [], async () => { throw new Error('ocr internal'); }]) {
      const result = await convert({
        bytes: new Uint8Array([1, 2]),
        filename: 'photo.png',
        engines: { ocr },
      });
      expect(result.markdown).toBe(imageMetadataStub('photo.png', 2));
    }
  });
});

// Real WASM engines for golden parity. initSync accepts the wasm bytes read
// from node_modules in Bun; conversion itself is synchronous inside the glue,
// while extract-core awaits engine results so lazy browser adapters can share it.
anydoc.initSync({ module: await readFile('node_modules/@firecrawl/anydoc-wasm/anydoc_wasm_bg.wasm') });
pdfInspector.initSync({ module: await readFile('node_modules/@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm') });

const goldenEngines = {
  anydoc,
  pdf: pdfInspector,
  ocr: async () => [],
};

// Manually inspected output differences caused by intentionally newer engines.
// These are improvements (or, for PDF, the planned newer pdf-inspector output
// with better semantic markup), not unexplained drift.
const KNOWN_DIFFS = {
  'pdf-text.pdf': 'pdf-inspector 1.26.1 output: preserves strike/footnote markup and corrects RTL text ordering; layout text flow differs from the legacy service',
  'xlsx.xlsx': 'anydoc 0.2.4 renders spreadsheet display formatting (15.5%, $1,234.50, grouped thousands)',
  'xls.xls': 'anydoc 0.2.4 renders spreadsheet display formatting through the legacy-XLS compatibility path',
  'sheet.xlsm': 'anydoc 0.2.4 renders spreadsheet display formatting through the XLSM container-variant mapping',
};

// OCR output is not a WASM parity target: RapidOCR was deliberately replaced
// by Tesseract.js. image-text.png is therefore exercised through fake OCR rows
// above and browser OCR smoke coverage rather than compared byte-for-byte here.
const GOLDEN_ENGINE_EXEMPTIONS = {
  'image-text.png': 'OCR engine replacement is intentional; no like-for-like WASM oracle exists',
};

const EXPECTED_ERROR_BEHAVIOR = {
  'corrupt.docx': { status: 500, code: 'CONVERT_FAILED' },
  'empty.docx': { status: 400, code: 'EMPTY_FILE' },
  // Deliberate contract improvements over the old opaque 500s.
  'encrypted.odt': { status: 422, code: 'ENCRYPTED', improvement: 'encrypted files now get a dedicated 422 instead of opaque 500' },
  'pdf-mixed.pdf': { status: 422, code: 'NEEDS_OCR', improvement: 'scanned/image-only pages now get a dedicated 422 instead of opaque 500' },
  'pdf-scanned.pdf': { status: 422, code: 'NEEDS_OCR', improvement: 'scanned PDFs now get a dedicated 422 instead of opaque 500' },
};

describe('golden parity corpus', () => {
  test('all corpus files have golden captures', async () => {
    const corpusFiles = (await readdir('test/fixtures/extract-corpus')).filter((name) => !name.startsWith('.')).sort();
    const goldenFiles = (await readdir('test/fixtures/extract-golden')).filter((name) => name.endsWith('.json')).sort();
    expect(goldenFiles).toEqual(corpusFiles.map((name) => `${name}.json`));
  });

  test('successful document/audio goldens match exactly except manually inspected known diffs', async () => {
    const goldenFiles = (await readdir('test/fixtures/extract-golden')).filter((name) => name.endsWith('.json')).sort();
    const compared = [];
    const knownDiffs = [];
    for (const goldenFile of goldenFiles) {
      const golden = JSON.parse(await readFile(`test/fixtures/extract-golden/${goldenFile}`, 'utf8'));
      if (golden.status !== 200 || GOLDEN_ENGINE_EXEMPTIONS[golden.file]) continue;
      const bytes = new Uint8Array(await readFile(`test/fixtures/extract-corpus/${golden.file}`));
      const result = await convert({ bytes, filename: golden.file, engines: goldenEngines });
      expect(result.metadata).toEqual(golden.body.metadata);
      if (KNOWN_DIFFS[golden.file]) {
        expect(result.markdown.length).toBeGreaterThan(0);
        knownDiffs.push(golden.file);
      } else {
        expect(result.markdown).toBe(golden.body.markdown);
        compared.push(golden.file);
      }
    }
    expect(compared.length).toBeGreaterThan(15);
    expect(knownDiffs.sort()).toEqual(Object.keys(KNOWN_DIFFS).sort());
  });

  test('baseline error goldens map to the new structured errors', async () => {
    for (const [file, expected] of Object.entries(EXPECTED_ERROR_BEHAVIOR)) {
      const bytes = new Uint8Array(await readFile(`test/fixtures/extract-corpus/${file}`));
      const error = await captureError(convert({ bytes, filename: file, engines: goldenEngines }));
      expectExtractError(error, expected.status, expected.code);
    }
  });

  test('xlsb now converts successfully where the baseline returned opaque 500', async () => {
    const bytes = new Uint8Array(await readFile('test/fixtures/extract-corpus/xlsb.xlsb'));
    const result = await convert({ bytes, filename: 'xlsb.xlsb', engines: goldenEngines });
    expect(result.markdown).toContain('| Region |');
    expect(result.markdown).toContain('65.0%');
    expect(result.metadata.fileType).toBe('excel');
  });
});
