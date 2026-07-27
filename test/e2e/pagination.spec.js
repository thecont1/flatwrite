const { test, expect } = require('@playwright/test');
const {
  loadFixture,
  paginatedPageCount,
  printedPageCount,
  footerProbe,
} = require('./helpers');

function assertNoEmptyPages(page, engine) {
  return page.evaluate(key => {
    const doc = document.querySelector('#preview-frame').contentDocument;
    const selector = key === 'pagedjs'
      ? '.pagedjs_pages > .pagedjs_page'
      : '[data-vivliostyle-spread-container] > [data-vivliostyle-page-container]';
    return [...doc.querySelectorAll(selector)].every(box => {
      const body = key === 'pagedjs'
        ? box.querySelector('.pagedjs_area')
        : box.querySelector('[data-vivliostyle-page-area]');
      return Boolean(body && body.textContent.trim());
    });
  }, engine);
}

function assertContentContained(page, engine) {
  return page.evaluate(key => {
    const doc = document.querySelector('#preview-frame').contentDocument;
    const selector = key === 'pagedjs'
      ? '.pagedjs_pages > .pagedjs_page'
      : '[data-vivliostyle-spread-container] > [data-vivliostyle-page-container]';
    return [...doc.querySelectorAll(selector)].every(box => {
      const area = key === 'pagedjs'
        ? box.querySelector('.pagedjs_area')
        : box.querySelector('[data-vivliostyle-page-area]');
      if (!area) return false;
      const bounds = area.getBoundingClientRect();
      return [...area.querySelectorAll('img, pre, table, h1, h2, h3, h4, p, blockquote')]
        .filter(el => el.textContent.trim() || el.tagName === 'IMG')
        .every(el => {
          const rect = el.getBoundingClientRect();
          return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
        });
    });
  }, engine);
}

function assertFooterRows(rows, pageCount, footerOn, expectedChapter = null) {
  expect(rows).toHaveLength(pageCount);
  for (let i = 0; i < rows.length; i++) {
    if (!footerOn) {
      expect(rows[i].left && rows[i].left.text || '').toBe('');
      expect(rows[i].right && rows[i].right.text || '').toBe('');
      continue;
    }
    expect(rows[i].right && rows[i].right.text).toMatch(new RegExp(`^Page ${i + 1} of ${pageCount}$`));
    expect(rows[i].right.renderedLineCount).toBe(1);
    expect(rows[i].right.insideSheet).toBe(true);
    // Bottom-left carries the document h1. Documents without an h1 (e.g. the
    // markdown.new import whose title lives only in frontmatter) leave it empty.
    expect(rows[i].left.renderedLineCount).toBeLessThanOrEqual(1);
    if (expectedChapter) expect(rows[i].left.text).toBe(expectedChapter);
    if (rows[i].left.text) expect(rows[i].left.insideSheet).toBe(true);
  }
}

test.describe('real-browser pagination matrix', () => {
  for (const engine of ['pagedjs', 'vivliostyle']) {
    for (const footer of [false, true]) {
      for (const columns of [1, 2, 3]) {
        test(`${engine}: footer=${footer ? 'on' : 'off'}, columns=${columns}`, async ({ page }) => {
          await loadFixture(page, { engine, footer, columns });
          const previewPages = await paginatedPageCount(page, engine);
          const footerRows = await footerProbe(page, engine);
          const pdfPages = await printedPageCount(page);

          expect(previewPages).toBeGreaterThan(0);
          expect(pdfPages).toBe(previewPages);
          assertFooterRows(footerRows, previewPages, footer);
          expect(await assertNoEmptyPages(page, engine)).toBe(true);
          expect(await assertContentContained(page, engine)).toBe(true);
        });
      }
    }
  }

  for (const engine of ['pagedjs', 'vivliostyle']) {
    for (const pageSize of ['A4', 'Letter']) {
      for (const orientation of ['portrait', 'landscape']) {
        test(`${engine}: ${pageSize} ${orientation} footer on`, async ({ page }) => {
          await loadFixture(page, { engine, footer: true, columns: 1, pageSize, orientation });
          const previewPages = await paginatedPageCount(page, engine);
          expect(await printedPageCount(page)).toBe(previewPages);
          assertFooterRows(await footerProbe(page, engine), previewPages, true);
          expect(await assertNoEmptyPages(page, engine)).toBe(true);
          expect(await assertContentContained(page, engine)).toBe(true);
        });
      }
    }
  }

  for (const ingestion of ['synthetic', 'shared', 'import']) {
    test(`Paged.js high-signal ingestion: ${ingestion}`, async ({ page }) => {
      const options = ingestion === 'shared'
        ? { ingestion, engine: 'pagedjs', footer: true, columns: 2, pageSize: 'A3', orientation: 'landscape' }
        : { ingestion, engine: 'pagedjs', footer: true, columns: 2, pageSize: 'A4', orientation: 'portrait' };
      await loadFixture(page, options);
      const previewPages = await paginatedPageCount(page, 'pagedjs');
      expect(await printedPageCount(page)).toBe(previewPages);
      assertFooterRows(await footerProbe(page, 'pagedjs'), previewPages, true);
    });
  }

  for (const engine of ['pagedjs', 'vivliostyle']) {
    test(`${engine}: footer toggle does not change logical page count`, async ({ page }) => {
      await loadFixture(page, { engine, footer: false, columns: 1 });
      const footerOffPages = await paginatedPageCount(page, engine);
      await loadFixture(page, { engine, footer: true, columns: 1 });
      expect(await paginatedPageCount(page, engine)).toBe(footerOffPages);
    });
  }
});
