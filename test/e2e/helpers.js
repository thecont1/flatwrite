const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SYNTHETIC = fs.readFileSync(path.join(ROOT, 'test/fixtures/pagination.md'), 'utf8');
const IMPORT_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'test/fixtures/import-url/thecontrarian-ayodhya.json'), 'utf8')
);

async function openLoadModal(page, url) {
  await page.click('#btn-load-url');
  await page.fill('#load-url-input', url);
}

async function loadFixture(page, options = {}) {
  const {
    ingestion = 'synthetic',
    engine = 'pagedjs',
    footer = true,
    columns = 1,
    pageSize = 'A4',
    orientation = 'portrait',
  } = options;

  if (ingestion === 'shared') {
    await page.goto('/?s=IUWxUVzE.md', { waitUntil: 'networkidle' });
  } else {
    await page.goto('/', { waitUntil: 'networkidle' });
    if (ingestion === 'synthetic') {
      const fixtureUrl = new URL('/test/fixtures/pagination.md', page.url()).href;
      await page.route(fixtureUrl, route => route.fulfill({
        status: 200,
        contentType: 'text/markdown; charset=utf-8',
        body: SYNTHETIC,
      }));
      await openLoadModal(page, fixtureUrl);
    } else if (ingestion === 'import') {
      await page.route('**/api/import-url', route => route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(IMPORT_FIXTURE),
      }));
      await page.route(IMPORT_FIXTURE.document.sourceUrl, route => route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>Recorded import route</title>',
      }));
      await openLoadModal(page, IMPORT_FIXTURE.document.sourceUrl);
    } else {
      throw new Error(`Unknown ingestion path: ${ingestion}`);
    }
    await page.click('#load-modal-insert');
    await page.waitForSelector('#load-modal-overlay', { state: 'hidden' });
    await page.waitForFunction(() => {
      const editor = document.querySelector('#editor');
      return editor && editor.value.trim().length > 0;
    });
  }

  await page.click(`[data-engine="${engine}"]`);
  await page.selectOption('#page-size', pageSize);
  await page.selectOption('#page-columns', String(columns));

  const orient = page.locator('#toggle-orient');
  if ((await orient.getAttribute('data-state')) !== orientation) await orient.click();
  const footerToggle = page.locator('#toggle-footer');
  const wantedFooterState = footer ? 'on' : 'off';
  if ((await footerToggle.getAttribute('data-state')) !== wantedFooterState) await footerToggle.click();

  await page.click('#btn-preview');
  const selector = engine === 'pagedjs'
    ? '.pagedjs_pages > .pagedjs_page'
    : '[data-vivliostyle-page-container]';
  await page.waitForFunction(sel => {
    const frame = document.querySelector('#preview-frame');
    return Boolean(frame && frame.contentDocument && frame.contentDocument.querySelector(sel));
  }, selector, { timeout: engine === 'vivliostyle' ? 120_000 : 60_000 });
  await page.waitForTimeout(250);
}

async function paginatedPageCount(page, engine) {
  return page.evaluate(key => {
    const doc = document.querySelector('#preview-frame').contentDocument;
    if (key === 'pagedjs') {
      return doc.querySelectorAll('.pagedjs_pages > .pagedjs_page').length;
    }
    const spread = doc.querySelector('[data-vivliostyle-spread-container]');
    return spread
      ? spread.querySelectorAll(':scope > [data-vivliostyle-page-container]').length
      : doc.querySelectorAll('[data-vivliostyle-page-container]').length;
  }, engine);
}

async function capturePrintSnapshot(page) {
  await page.evaluate(() => {
    window.__fwE2eSnapshot = null;
    const createObjectURL = URL.createObjectURL.bind(URL);
    const open = window.open;
    URL.createObjectURL = blob => {
      blob.text().then(text => { window.__fwE2eSnapshot = text; });
      return createObjectURL(blob);
    };
    window.open = () => null;
    window.__fwE2eRestore = () => {
      URL.createObjectURL = createObjectURL;
      window.open = open;
      delete window.__fwE2eRestore;
    };
  });
  await page.click('#btn-export-pdf');
  await page.waitForFunction(() => typeof window.__fwE2eSnapshot === 'string');
  return page.evaluate(() => {
    const html = window.__fwE2eSnapshot;
    window.__fwE2eRestore();
    delete window.__fwE2eSnapshot;
    return html;
  });
}

function pdfPageCount(buffer) {
  const source = Buffer.from(buffer).toString('latin1');
  const counts = [...source.matchAll(/\/Count\s+(\d+)/g)].map(match => Number(match[1]));
  if (counts.length) return Math.max(...counts);
  return [...source.matchAll(/\/Type\s*\/Page\b/g)].length;
}

async function printedPageCount(page) {
  const html = await capturePrintSnapshot(page);
  const printPage = await page.context().newPage();
  try {
    await printPage.setContent(html, { waitUntil: 'load' });
    await printPage.emulateMedia({ media: 'print' });
    const pdf = await printPage.pdf({ printBackground: true, preferCSSPageSize: true });
    return pdfPageCount(pdf);
  } finally {
    await printPage.close();
  }
}

async function footerProbe(page, engine) {
  return page.evaluate(key => {
    const doc = document.querySelector('#preview-frame').contentDocument;
    const win = doc.defaultView;

    function visiblePseudoLines(el) {
      if (!el) return 0;
      return ['::before', '::after'].reduce((count, pseudo) => {
        const value = win.getComputedStyle(el, pseudo).content;
        return count + (value && value !== 'none' && value !== 'normal' && value !== '""' ? 1 : 0);
      }, 0);
    }

    function inspect(box, content, sheet) {
      if (!box) return null;
      const text = (content ? content.textContent : box.textContent || '').trim();
      const pseudoLines = [box, content].filter(Boolean)
        .reduce((count, el) => count + visiblePseudoLines(el), 0);
      const rect = box.getBoundingClientRect();
      const sheetRect = sheet.getBoundingClientRect();
      return {
        text,
        childNodeCount: content ? content.childNodes.length : box.childNodes.length,
        childElementCount: content ? content.children.length : box.children.length,
        renderedLineCount: (text ? 1 : 0) + pseudoLines,
        position: win.getComputedStyle(box).position,
        overflow: win.getComputedStyle(box).overflow,
        rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
        sheetRect: { top: sheetRect.top, right: sheetRect.right, bottom: sheetRect.bottom, left: sheetRect.left },
        insideSheet: rect.top >= sheetRect.top - 0.5 && rect.left >= sheetRect.left - 0.5 &&
          rect.right <= sheetRect.right + 0.5 && rect.bottom <= sheetRect.bottom + 0.5,
      };
    }

    if (key === 'pagedjs') {
      return [...doc.querySelectorAll('.pagedjs_pages > .pagedjs_page')].map(pageBox => {
        const sheet = pageBox.querySelector(':scope > .pagedjs_sheet');
        const pagebox = sheet && sheet.querySelector(':scope > .pagedjs_pagebox');
        const bottom = pagebox && pagebox.querySelector(':scope > .pagedjs_margin-bottom');
        const leftBox = bottom && bottom.querySelector(':scope > .pagedjs_margin-bottom-left');
        const rightBox = bottom && bottom.querySelector(':scope > .pagedjs_margin-bottom-right');
        return {
          left: inspect(leftBox, leftBox && leftBox.querySelector(':scope > .pagedjs_margin-content'), sheet),
          right: inspect(rightBox, rightBox && rightBox.querySelector(':scope > .pagedjs_margin-content'), sheet),
        };
      });
    }

    return [...doc.querySelectorAll('[data-vivliostyle-page-container]')].map(pageBox => {
      const boxes = [...pageBox.querySelectorAll('[data-vivliostyle-page-margin-box]')];
      const find = side => boxes.find(box => (box.getAttribute('data-vivliostyle-page-margin-box') || '').includes(side));
      return {
        left: inspect(find('bottom-left'), find('bottom-left'), pageBox),
        right: inspect(find('bottom-right'), find('bottom-right'), pageBox),
      };
    });
  }, engine);
}

module.exports = {
  IMPORT_FIXTURE,
  loadFixture,
  paginatedPageCount,
  printedPageCount,
  footerProbe,
};
