const { test, expect } = require('@playwright/test');
const { IMPORT_FIXTURE } = require('./helpers');

const AYODHYA = IMPORT_FIXTURE.document.sourceUrl;
const ABSOLUTE_IMAGE = 'https://www.thecontrarian.in/library/originals/Ayodhya-TIME/MS202401-Ayodhya0658.jpg';

async function importUrl(page, url) {
  await page.click('#btn-load-url');
  await page.fill('#load-url-input', url);
  await page.click('#load-modal-insert');
  await page.waitForSelector('#load-modal-overlay', { state: 'hidden' });
}

test('extensionless webpage auto-routes to one markdown.new request and rewrites markdown source', async ({ page }) => {
  let directProbeCount = 0;
  let importCount = 0;
  let importBody = null;
  await page.route(AYODHYA, route => {
    directProbeCount++;
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html></html>' });
  });
  await page.route('**/api/import-url', async route => {
    importCount++;
    importBody = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(IMPORT_FIXTURE) });
  });

  await page.goto('/', { waitUntil: 'networkidle' });
  await importUrl(page, AYODHYA);

  expect(directProbeCount).toBe(1);
  expect(importCount).toBe(1);
  expect(importBody).toEqual({ url: AYODHYA, method: 'auto', retain_images: true });
  expect(await page.inputValue('#editor')).toContain(ABSOLUTE_IMAGE);
  expect(await page.inputValue('#editor')).not.toContain('](/library/originals/Ayodhya-TIME/MS202401-Ayodhya0658.jpg)');
  expect(await page.locator('#load-url-webpage-toggle').count()).toBe(0);
});

test('markdown URL stays direct and never calls markdown.new', async ({ page }) => {
  const url = 'https://example.com/document.md';
  let directCount = 0;
  let importCount = 0;
  await page.route(url, route => {
    directCount++;
    return route.fulfill({ status: 200, contentType: 'text/markdown', body: '# Direct markdown\n\nNo importer.' });
  });
  await page.route('**/api/import-url', route => {
    importCount++;
    return route.abort();
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  await importUrl(page, url);
  expect(directCount).toBe(1);
  expect(importCount).toBe(0);
  expect(await page.inputValue('#editor')).toContain('# Direct markdown');
});

test('failed auto import exposes browser mode but does not retry automatically', async ({ page }) => {
  let requests = [];
  await page.route(AYODHYA, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }));
  await page.route('**/api/import-url', async route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Conversion failed' }) });
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.click('#btn-load-url');
  await page.fill('#load-url-input', AYODHYA);
  await page.click('#load-modal-insert');
  await expect(page.locator('.load-url-try-browser')).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('auto');
  await page.click('.load-url-try-browser');
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].method).toBe('browser');
});

test('optional live markdown.new import', async ({ page }) => {
  test.skip(!process.env.FW_E2E_LIVE_IMPORT, 'set FW_E2E_LIVE_IMPORT=1');
  await page.goto('/', { waitUntil: 'networkidle' });
  await importUrl(page, AYODHYA);
  expect(await page.inputValue('#editor')).toContain('Ayodhya');
  expect(await page.inputValue('#editor')).toContain(ABSOLUTE_IMAGE);
});
