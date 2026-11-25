const { test, expect } = require('@playwright/test');
const {
  IMPORT_CSV,
  IMPORT_SOURCE_URL,
  fulfillFetchDocument,
} = require('./helpers');

async function importUrl(page, url) {
  await page.click('#btn-load-url');
  await page.fill('#load-url-input', url);
  await page.click('#load-modal-insert');
  await page.waitForSelector('#load-modal-overlay', { state: 'hidden' });
}

test('extensionless document URL falls back to fetch-document and converts in the browser', async ({ page }) => {
  let directProbeCount = 0;
  let fetchDocumentCount = 0;
  let fetchDocumentBody = null;
  const forbiddenRequests = [];
  page.on('request', request => {
    const url = request.url();
    if (url.includes('extract.flatwrite.md') || url.includes('fly.dev')) forbiddenRequests.push(url);
  });

  await page.route(IMPORT_SOURCE_URL, route => {
    directProbeCount++;
    return route.abort();
  });
  await page.route('**/api/fetch-document', async route => {
    fetchDocumentCount++;
    fetchDocumentBody = route.request().postDataJSON();
    return fulfillFetchDocument(route);
  });

  await page.goto('/', { waitUntil: 'networkidle' });
  await importUrl(page, IMPORT_SOURCE_URL);

  expect(directProbeCount).toBe(1);
  expect(fetchDocumentCount).toBe(1);
  expect(fetchDocumentBody).toEqual({ url: IMPORT_SOURCE_URL });

  const editor = await page.inputValue('#editor');
  expect(editor).toContain('# example.com');
  expect(editor).toContain('| Kind | Value | Note |');
  expect(editor).toContain('fifteen and a half');
  expect(editor).not.toContain(IMPORT_CSV.toString('utf8'));
  expect(await page.locator('#load-url-webpage-toggle').count()).toBe(0);
  expect(forbiddenRequests).toEqual([]);
});

test('markdown URL stays direct and never calls fetch-document', async ({ page }) => {
  const url = 'https://example.com/document.md';
  let directCount = 0;
  let fetchDocumentCount = 0;
  await page.route(url, route => {
    directCount++;
    return route.fulfill({ status: 200, contentType: 'text/markdown', body: '# Direct markdown\n\nNo importer.' });
  });
  await page.route('**/api/fetch-document', route => {
    fetchDocumentCount++;
    return route.abort();
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  await importUrl(page, url);
  expect(directCount).toBe(1);
  expect(fetchDocumentCount).toBe(0);
  expect(await page.inputValue('#editor')).toContain('# Direct markdown');
});

test('failed auto import exposes browser retry but does not retry automatically', async ({ page }) => {
  const requests = [];
  await page.route(IMPORT_SOURCE_URL, route => route.abort());
  await page.route('**/api/fetch-document', async route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'Conversion failed' }),
    });
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.click('#btn-load-url');
  await page.fill('#load-url-input', IMPORT_SOURCE_URL);
  await page.click('#load-modal-insert');
  await expect(page.locator('.load-url-try-browser')).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toEqual({ url: IMPORT_SOURCE_URL });
  await page.click('.load-url-try-browser');
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual({ url: IMPORT_SOURCE_URL });
});

test('fetch-document filename header drives local conversion routing', async ({ page }) => {
  // The URL itself has no useful basename. The mocked server response simulates
  // an upstream text/csv document for which fetch-document synthesized csv.csv;
  // without that header the browser could not choose the CSV converter.
  await page.route(IMPORT_SOURCE_URL, route => route.abort());
  await page.route('**/api/fetch-document', route => fulfillFetchDocument(route));
  await page.goto('/', { waitUntil: 'networkidle' });
  await importUrl(page, IMPORT_SOURCE_URL);
  expect(await page.inputValue('#editor')).toContain('| Boolean | TRUE | yes |');
});
