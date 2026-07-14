// @ts-check
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  forbidOnly: !!process.env.CI,
  // Python's stdlib http.server is single-threaded — parallel Playwright
  // workers hitting it in parallel cause flaky test failures (multiple
  // page loads racing on the same handler). Running serially is fast
  // enough (~7s for the full suite) and eliminates the flakiness.
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
