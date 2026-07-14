// @ts-check
// tests/scanner-mobile-collapse.spec.js
// -----------------------------------------------------------------------------
// End-to-end tests for the mobile scan-result collapse:
//   app.js       (renderResult wraps groups in <details>, closes on <=480px)
//   style.css    (@media <=480px reveals the summary chip and hides the
//                 disclosure marker on wide viewports)
//
// The vetlock scan backend is a Cloudflare Worker. To avoid a network dep in
// tests we intercept both endpoints via page.route(): POST /scan returns a
// scanId, GET /scan/:id returns a canned result payload with findings.
// Then we click "Try malicious", Run, wait for the result panel, and verify:
//   1) On 375x812 mobile the <details> panel is CLOSED — only the summary
//      chip is visible; the finding groups are not.
//   2) Clicking the summary opens it — the finding groups become visible.
//   3) On a wide viewport (1280x800) the <details> is open by default and
//      the summary chip is hidden.
// -----------------------------------------------------------------------------

import { test, expect } from '@playwright/test';

// Fixture: two findings, one BLOCK + one WARN, referencing believable packages.
// Shape matches what renderResult() consumes: verdict / findings[]
// (severity / package / from / to / detector / category / message / evidence[]).
const MOCK_RESULT = {
  verdict: 'BLOCK',
  durationMs: 1234,
  findings: [
    {
      severity: 'BLOCK',
      package: 'test-shai-hulud',
      from: '1.0.0',
      to: '1.0.1',
      detector: 'postinstall.exec',
      category: 'INSTALL',
      message: 'Postinstall script executes a child process reaching an unfamiliar host.',
      provenance: [['root-app', 'test-shai-hulud']],
      evidence: [
        { file: 'package.json', line: 12, snippet: '"postinstall": "node ./bootstrap.js"' },
      ],
    },
    {
      severity: 'WARN',
      package: 'test-shai-hulud',
      from: '1.0.0',
      to: '1.0.1',
      detector: 'net.new-host',
      category: 'NET',
      message: 'New network destination introduced in this version.',
      provenance: [['root-app', 'test-shai-hulud']],
      evidence: [
        { file: 'lib/report.js', line: 47, snippet: 'fetch("https://collector.example/report")' },
      ],
    },
  ],
};

/**
 * Install route handlers that fake the vetlock Worker. Every POST /scan gets a
 * fixed scanId; the first GET /scan/:id returns 200 with MOCK_RESULT.
 * @param {import('@playwright/test').Page} page
 */
async function mockScanBackend(page) {
  await page.route('**/vetlock-scan.oj-uday.workers.dev/scan', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ scanId: 'test-scan-001' }),
      });
      return;
    }
    await route.continue();
  });
  await page.route('**/vetlock-scan.oj-uday.workers.dev/scan/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ result: MOCK_RESULT }),
    });
  });
}

test.describe('scanner mobile collapse', () => {
  test('on <=480px viewport, result panel collapses to a tap-to-expand chip', async ({ browser }) => {
    const ctx = await browser.newContext({
      colorScheme: 'dark',
      viewport: { width: 375, height: 812 },
    });
    const page = await ctx.newPage();
    await mockScanBackend(page);
    await page.goto('/');

    // Seed the scanner with the malicious corpus example — that path goes
    // through dispatchScan()/pollUntilReady() so we exercise the real flow.
    // "Try malicious (Shai-Hulud fixture)" is the visible label.
    await page.locator('#scan-example').click();

    // Both dropzones should now be marked filled + Run enabled.
    await expect(page.locator('#scan-run')).toBeEnabled();
    await page.locator('#scan-run').click();

    // Result panel appears once the mocked poll returns 200.
    const resultPanel = page.locator('#scan-result');
    await expect(resultPanel).toBeVisible({ timeout: 15_000 });

    // The verdict pill + meta line stay visible (they're the "summary" for
    // the whole panel, above the <details> wrapper).
    await expect(page.locator('#sr-verdict')).toHaveText('BLOCK');
    await expect(page.locator('#sr-meta')).toContainText('2 findings');

    // The <details> wrapper must be present AND closed on this viewport.
    const details = page.locator('.sr-details');
    await expect(details).toBeAttached();
    const isOpen = await details.evaluate((el) => /** @type {HTMLDetailsElement} */(el).open);
    expect(isOpen).toBe(false);

    // The summary chip is visible; the severity groups are NOT (because they
    // live inside a closed <details>).
    const summary = page.locator('.sr-details > summary.sr-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(/2 findings/);
    await expect(summary).toContainText(/tap to expand/i);

    // A .sr-group child of a closed <details> should not be visible.
    const groups = page.locator('.sr-details > .sr-group');
    expect(await groups.count()).toBeGreaterThan(0);
    await expect(groups.first()).toBeHidden();

    // Tap-to-expand: click the summary and verify the details opens and the
    // groups become visible.
    await summary.click();
    const isOpenAfter = await details.evaluate((el) => /** @type {HTMLDetailsElement} */(el).open);
    expect(isOpenAfter).toBe(true);
    await expect(groups.first()).toBeVisible();

    // Keyboard-a11y check: close the details, then focus the summary and
    // press Enter. Native <details>/<summary> should re-open it — this is
    // the whole reason we picked <details> over a custom aria-expanded button.
    await details.evaluate((el) => { /** @type {HTMLDetailsElement} */(el).open = false; });
    await summary.focus();
    await page.keyboard.press('Enter');
    const isOpenAfterEnter = await details.evaluate((el) => /** @type {HTMLDetailsElement} */(el).open);
    expect(isOpenAfterEnter).toBe(true);

    await ctx.close();
  });

  test('on wide viewport, <details> is open by default and the summary chip is hidden', async ({ browser }) => {
    const ctx = await browser.newContext({
      colorScheme: 'dark',
      viewport: { width: 1280, height: 800 },
    });
    const page = await ctx.newPage();
    await mockScanBackend(page);
    await page.goto('/');

    await page.locator('#scan-example').click();
    await expect(page.locator('#scan-run')).toBeEnabled();
    await page.locator('#scan-run').click();

    const resultPanel = page.locator('#scan-result');
    await expect(resultPanel).toBeVisible({ timeout: 15_000 });

    const details = page.locator('.sr-details');
    await expect(details).toBeAttached();
    const isOpen = await details.evaluate((el) => /** @type {HTMLDetailsElement} */(el).open);
    expect(isOpen).toBe(true);

    // The summary chip is hidden by CSS on wide viewports (display: none).
    const summary = page.locator('.sr-details > summary.sr-summary');
    await expect(summary).toBeHidden();

    // Severity groups render normally.
    const groups = page.locator('.sr-details > .sr-group');
    expect(await groups.count()).toBeGreaterThan(0);
    await expect(groups.first()).toBeVisible();

    await ctx.close();
  });
});
