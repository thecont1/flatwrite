const { test, expect } = require('@playwright/test');

test('Vivliostyle footer title cannot terminate the inline style element', async ({ page }) => {
  const payload = '# &lt;/style&gt;&lt;img id=&quot;fw-style-injection&quot; src=x&gt;';
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.fill('#editor', payload);
  await page.click('[data-engine="vivliostyle"]');
  const footer = page.locator('#toggle-footer');
  if ((await footer.getAttribute('data-state')) !== 'on') await footer.click();
  await page.click('#btn-preview');
  await page.waitForFunction(() => {
    const frame = document.querySelector('#preview-frame');
    return Boolean(frame && frame.contentDocument && frame.contentDocument.querySelector('[data-vivliostyle-page-container]'));
  }, null, { timeout: 120_000 });

  const result = await page.evaluate(() => {
    const frame = document.querySelector('#preview-frame');
    return {
      injectedElement: Boolean(frame.contentDocument.querySelector('#fw-style-injection')),
      rawTagTermination: (frame.getAttribute('srcdoc') || '').includes('</style><img id="fw-style-injection"'),
      documentStyle: frame.contentDocument.querySelector('#_fw_document_css')?.textContent || '',
    };
  });

  expect(result.injectedElement).toBe(false);
  expect(result.rawTagTermination).toBe(false);
  expect(result.documentStyle).toContain('\\26 lt;/style\\26 gt;');
  expect(result.documentStyle).not.toContain('</style>');
});
