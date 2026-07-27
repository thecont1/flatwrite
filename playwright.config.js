const { defineConfig } = require('@playwright/test');

const port = Number(process.env.FW_E2E_PORT || 417);
const baseURL = process.env.FW_E2E_BASE_URL || `http://127.0.0.1:${port}`;

module.exports = defineConfig({
  testDir: './test/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: process.env.FW_E2E_BASE_URL ? undefined : {
    command: `PORT=${port} FW_STUB_SHARES=1 node public/server.js`,
    url: `${baseURL}/health`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
