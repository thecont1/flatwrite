const { test, expect } = require('@playwright/test');
const { loadFixture } = require('./helpers');

// Visual baselines for page one and the last page of each engine, footer on/off.
// Regenerate with: bun run test:e2e -- test/e2e/visual.spec.js --update-snapshots
for (const engine of ['pagedjs', 'vivliostyle']) {
  for (const footer of [false, true]) {
    test(`${engine}: first/last page visual snapshot, footer=${footer ? 'on' : 'off'}`, async ({ page }) => {
      await loadFixture(page, { engine, footer, columns: 1 });
      const frame = page.locator('#preview-frame').contentFrame();
      const pages = engine === 'pagedjs'
        ? frame.locator('.pagedjs_pages > .pagedjs_page')
        : frame.locator('[data-vivliostyle-spread-container] > [data-vivliostyle-page-container]');
      const suffix = `${engine}-footer-${footer ? 'on' : 'off'}`;
      await expect(pages.first()).toHaveScreenshot(`${suffix}-first.png`, { animations: 'disabled', maxDiffPixelRatio: 0.02 });
      await expect(pages.last()).toHaveScreenshot(`${suffix}-last.png`, { animations: 'disabled', maxDiffPixelRatio: 0.02 });
    });
  }
}
