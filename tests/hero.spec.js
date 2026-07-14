// @ts-check
// tests/hero.spec.js
// -----------------------------------------------------------------------------
// End-to-end tests for the hero "watcher watching" scene:
//   index.html              (poster SVG + <canvas class="hero-canvas">)
//   design/hero.js          (bespoke canvas 2D scene, degradation triggers)
//   design/tokens.css       (--color-* palette read at boot + on theme toggle)
//
// Contract (from HERO SPEC + ADR 0003):
//   • Poster SVG ALWAYS ships and is the LCP element on first paint.
//   • Canvas is decorative → aria-hidden="true".
//   • hero.js writes data-hero-state on the .hero-bg element:
//       "poster"  → poster only, no rAF loop running (reduced-motion / low-power
//                    / init fail / mid-run degradation).
//       "running" → canvas is actively animating over the poster.
//   • hero.js pins a testability object on window.__hero once init resolves:
//       { state, frames, paletteReads, destroy }
//     Tests below rely ONLY on these documented hooks — do not reach into
//     private module state.
// -----------------------------------------------------------------------------

import { test, expect } from '@playwright/test';

// Common desktop viewport for LCP + capable-hardware paths.
const DESKTOP = { width: 1440, height: 900 };

/**
 * Wait for hero.js to publish its testability handle. Because app.js schedules
 * the hero via queueMicrotask / requestIdleCallback (LCP hygiene), the handle
 * is not synchronous with load — poll it. Returns whatever window.__hero
 * resolves to (or null on timeout).
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [timeoutMs]
 */
async function waitForHero(page, timeoutMs = 3000) {
  return await page.waitForFunction(
    () => (/** @type {any} */(window)).__hero ?? null,
    null,
    { timeout: timeoutMs, polling: 50 },
  ).then(h => h.jsonValue()).catch(() => null);
}

// ─── 1) prefers-reduced-motion → poster only, no rAF ─────────────────────────
test('hero renders poster by default with reduced-motion, canvas is not animating', async ({ browser }) => {
  const ctx = await browser.newContext({
    reducedMotion: 'reduce',
    colorScheme: 'dark',
    viewport: DESKTOP,
  });
  const page = await ctx.newPage();
  await page.goto('/');

  // Poster SVG must be present and visible from first paint. It ships inline
  // in index.html so it exists even if hero.js never runs.
  const poster = page.locator('.hero-poster');
  await expect(poster).toBeVisible();
  await expect(poster).toHaveAttribute('role', 'img');

  // Give hero.js the chance it needs to decide NOT to run. We wait for either
  // window.__hero to appear (with state="poster") or for a small grace window.
  await page.waitForTimeout(400);

  const state = await page.evaluate(() => {
    const bg = document.querySelector('.hero-bg');
    return bg && bg.getAttribute('data-hero-state');
  });
  expect(state).toBe('poster');

  // No rAF loop should be running: the frames counter (if hero.js exposed one)
  // must stay flat. Sample twice with a delay; if it moves, the loop is live.
  const frames1 = await page.evaluate(() => (/** @type {any} */(window)).__hero?.frames ?? 0);
  await page.waitForTimeout(300);
  const frames2 = await page.evaluate(() => (/** @type {any} */(window)).__hero?.frames ?? 0);
  expect(frames2).toBe(frames1); // no animation under reduced-motion

  await ctx.close();
});

// ─── 2) low-power heuristic → poster only ────────────────────────────────────
test('hero renders poster on low-power heuristic (deviceMemory=1)', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: DESKTOP });
  const page = await ctx.newPage();

  // Override the memory hint BEFORE any page script sees it. addInitScript
  // fires in every document, ahead of app.js, so hero.js reads the spoofed
  // value during its degradation-trigger checks.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 1, configurable: true });
  });
  await page.goto('/');

  const poster = page.locator('.hero-poster');
  await expect(poster).toBeVisible();

  await page.waitForTimeout(400);
  const state = await page.evaluate(() => {
    const bg = document.querySelector('.hero-bg');
    return bg && bg.getAttribute('data-hero-state');
  });
  expect(state).toBe('poster');

  await ctx.close();
});

// ─── 2b) low-power heuristic → poster only (hardwareConcurrency=2) ──────────
// ADR 0003 §5 lists `navigator.hardwareConcurrency <= 2` as a mandatory
// degradation trigger with its own regression guard. Pin deviceMemory to a
// comfortable value so we're strictly exercising the core-count branch —
// otherwise a runner reporting a small deviceMemory would tip the test into
// the (already-covered) memory path.
test('hero renders poster on low-power heuristic (hardwareConcurrency=2)', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: DESKTOP });
  const page = await ctx.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 2, configurable: true });
  });
  await page.goto('/');

  const poster = page.locator('.hero-poster');
  await expect(poster).toBeVisible();

  await page.waitForTimeout(400);
  const state = await page.evaluate(() => {
    const bg = document.querySelector('.hero-bg');
    return bg && bg.getAttribute('data-hero-state');
  });
  expect(state).toBe('poster');

  await ctx.close();
});

// ─── 2c) canvas.getContext throws → poster only, no rAF loop ────────────────
// ADR 0003 §5: "canvas.getContext('2d') is unavailable ... OR a first-frame
// draw throws → poster only." We simulate the init-time failure by making
// every canvas's getContext raise, which forces hero.js down the try/catch
// bail path in shouldRunCanvas(). Cores/memory pinned high so we're strictly
// on the init-failure branch — a runner with a small deviceMemory would
// otherwise reach the same poster state for the wrong reason.
test('hero renders poster when canvas.getContext throws (init failure)', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: DESKTOP });
  const page = await ctx.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
    // Blanket-stub getContext on the prototype so every canvas throws on init.
    // hero.js catches this inside shouldRunCanvas() and returns false, taking
    // the poster-only path. We deliberately stub on the prototype (not the
    // instance) because the canvas element is queried inside init() after
    // this init-script has already run.
    HTMLCanvasElement.prototype.getContext = function () {
      throw new Error('stub: getContext blocked for init-failure test');
    };
  });
  await page.goto('/');

  const poster = page.locator('.hero-poster');
  await expect(poster).toBeVisible();

  await page.waitForTimeout(400);
  const state = await page.evaluate(() => {
    const bg = document.querySelector('.hero-bg');
    return bg && bg.getAttribute('data-hero-state');
  });
  expect(state).toBe('poster');

  // No rAF loop must ever have started — the frames counter stays at 0.
  const frames = await page.evaluate(() => (/** @type {any} */(window)).__hero?.frames ?? 0);
  expect(frames).toBe(0);

  await ctx.close();
});

// ─── 2d) Save-Data hint → poster only ────────────────────────────────────────
test('hero renders poster when navigator.connection.saveData is true', async ({ browser }) => {
  const ctx = await browser.newContext({
    reducedMotion: 'no-preference',
    colorScheme: 'dark',
    viewport: DESKTOP,
  });
  const page = await ctx.newPage();

  // Spoof the Save-Data hint BEFORE any page script runs. Pin memory/cores to
  // comfortable values so the ONLY trigger that fires is Save-Data — otherwise
  // a green pass could be hiding a bug where hero.js is bailing for the wrong
  // reason on this runner. ADR 0003 §5: `navigator.connection?.saveData === true`
  // → poster only.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'connection', {
      get: () => ({ saveData: true }),
      configurable: true,
    });
  });
  await page.goto('/');

  const poster = page.locator('.hero-poster');
  await expect(poster).toBeVisible();

  await page.waitForTimeout(400);
  const state = await page.evaluate(() => {
    const bg = document.querySelector('.hero-bg');
    return bg && bg.getAttribute('data-hero-state');
  });
  expect(state).toBe('poster');

  // No rAF loop: frames counter (when present) stays at 0 across samples.
  const frames1 = await page.evaluate(() => (/** @type {any} */(window)).__hero?.frames ?? 0);
  await page.waitForTimeout(300);
  const frames2 = await page.evaluate(() => (/** @type {any} */(window)).__hero?.frames ?? 0);
  expect(frames1).toBe(0);
  expect(frames2).toBe(0);

  await ctx.close();
});

// ─── 3) capable hardware, no reduced-motion → canvas running & painting ─────
test('hero renders canvas on capable hardware with no reduced-motion', async ({ browser }) => {
  const ctx = await browser.newContext({
    reducedMotion: 'no-preference',
    colorScheme: 'dark',
    viewport: DESKTOP,
  });
  const page = await ctx.newPage();

  // Ensure the low-power heuristic can't accidentally trip: pin memory/cores
  // to comfortable values so we're not at the mercy of the runner's env.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  });
  await page.goto('/');

  // Wait for hero.js to hand us its handle.
  const hero = await waitForHero(page);
  expect(hero).not.toBeNull();

  const state = await page.evaluate(() => {
    const bg = document.querySelector('.hero-bg');
    return bg && bg.getAttribute('data-hero-state');
  });
  expect(state).toBe('running');

  // Verify actual painting: (a) the frames counter increments between two
  // samples spaced across several rAF ticks, and (b) at least one non-clear
  // pixel is written to the canvas backing store. The clear color is the
  // token --color-bg; a fully-cleared frame that never draws nodes/edges
  // would leave every pixel at the clear color, so we check that at least
  // some pixels differ.
  const frames1 = await page.evaluate(() => (/** @type {any} */(window)).__hero?.frames ?? 0);
  await page.waitForTimeout(250);
  const frames2 = await page.evaluate(() => (/** @type {any} */(window)).__hero?.frames ?? 0);
  expect(frames2).toBeGreaterThan(frames1);

  // Pixel-diversity probe. Sample a strip across the canvas and count unique
  // RGB values; a still-clear canvas would report 1. We expect > 1 because
  // edges + nodes have been drawn.
  const uniqueColors = await page.evaluate(() => {
    const c = /** @type {HTMLCanvasElement | null} */(document.querySelector('.hero-canvas'));
    if (!c) return 0;
    const g = c.getContext('2d');
    if (!g) return 0;
    // Sample 200 evenly-spaced pixels along a horizontal midline.
    const y = Math.floor(c.height / 2);
    const step = Math.max(1, Math.floor(c.width / 200));
    const seen = new Set();
    for (let x = 0; x < c.width; x += step) {
      const p = g.getImageData(x, y, 1, 1).data;
      seen.add(`${p[0]},${p[1]},${p[2]}`);
    }
    return seen.size;
  });
  expect(uniqueColors).toBeGreaterThan(1);

  await ctx.close();
});

// ─── 4) canvas is aria-hidden ────────────────────────────────────────────────
test('hero canvas has aria-hidden="true"', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: DESKTOP });
  const page = await ctx.newPage();
  await page.goto('/');

  // The canvas element ships in index.html regardless of whether hero.js later
  // decides to run — so we can assert its ARIA state without waiting.
  await expect(page.locator('.hero-canvas')).toHaveAttribute('aria-hidden', 'true');

  // Defense-in-depth per spec §G.1: the wrapping .hero-bg is also hidden.
  await expect(page.locator('.hero-bg')).toHaveAttribute('aria-hidden', 'true');

  await ctx.close();
});

// ─── 5) accessible text equivalent for the decorative scene ──────────────────
test('hero has a screen-reader text equivalent describing the scene', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: DESKTOP });
  const page = await ctx.newPage();
  await page.goto('/');

  // The spec accepts either an .sr-only clarifier inside .hero-copy or an
  // element carrying [data-hero-a11y]. Assert at least one exists and has
  // non-empty descriptive text.
  const equiv = page.locator('.hero .sr-only, .hero [data-hero-a11y]').first();
  await expect(equiv).toHaveCount(1);
  const text = (await equiv.textContent())?.trim() ?? '';
  expect(text.length).toBeGreaterThan(20); // meaningful description, not "hero"

  // The poster SVG must also carry role="img" + aria-label — this is the
  // AT-visible summary for readers that traverse inside aria-hidden regions.
  const poster = page.locator('.hero-poster');
  await expect(poster).toHaveAttribute('role', 'img');
  const label = await poster.getAttribute('aria-label');
  expect((label ?? '').trim().length).toBeGreaterThan(0);

  await ctx.close();
});

// ─── 6) theme toggle triggers a palette re-read in hero.js ───────────────────
test('theme change causes hero to re-read tokens and repaint', async ({ browser }) => {
  const ctx = await browser.newContext({
    reducedMotion: 'no-preference',
    colorScheme: 'dark',
    viewport: DESKTOP,
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  });
  await page.goto('/');

  // Hero must be in the running state so a MutationObserver on <html> is live.
  const hero = await waitForHero(page);
  expect(hero).not.toBeNull();
  const state = await page.evaluate(() => document.querySelector('.hero-bg')?.getAttribute('data-hero-state'));
  expect(state).toBe('running');

  // Capture the pre-toggle re-read count and frame count.
  const before = await page.evaluate(() => ({
    reads: (/** @type {any} */(window)).__hero?.paletteReads ?? 0,
    frames: (/** @type {any} */(window)).__hero?.frames ?? 0,
  }));

  // Flip the theme via the nav toggle — same mechanism a real user uses.
  await page.locator('[data-theme-toggle]').first().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // Give the MutationObserver up to 500ms per spec to notice and re-read.
  await expect
    .poll(
      async () => await page.evaluate(() => (/** @type {any} */(window)).__hero?.paletteReads ?? 0),
      { timeout: 500, intervals: [25, 50, 100, 150] },
    )
    .toBeGreaterThan(before.reads);

  // And the scene keeps drawing after the theme flip (no stall).
  const after = await page.evaluate(() => (/** @type {any} */(window)).__hero?.frames ?? 0);
  expect(after).toBeGreaterThan(before.frames);

  await ctx.close();
});

// ─── 7) poster SVG is the LCP candidate (big rendered box) ───────────────────
test('poster SVG is a large rendered element (LCP candidate) at 1440x900', async ({ browser }) => {
  const ctx = await browser.newContext({
    reducedMotion: 'no-preference',
    colorScheme: 'dark',
    viewport: DESKTOP,
  });
  const page = await ctx.newPage();
  await page.goto('/');

  // Measure the poster's rendered box BEFORE hero.js has a chance to fade it
  // out. Since the poster ships inline in <head>-parsed HTML and its container
  // uses `position: absolute; inset: 0`, it paints as soon as the hero
  // section lays out. We assert an area threshold, not exact pixels, because
  // the hero grid is fluid.
  const box = await page.locator('.hero-poster').boundingBox();
  expect(box).not.toBeNull();
  if (!box) return; // TS narrowing

  const area = box.width * box.height;

  // Threshold rationale: the hero's `.hero-bg` fills one column of the
  // 1.05fr / 0.95fr grid, gap 40px, at min-height 78vh. On a 1440x900
  // viewport that's roughly ~625×700 = ~437,500 px². We assert a floor well
  // below that (200,000 px²) so slight grid tuning doesn't false-fail this.
  expect(area).toBeGreaterThan(200_000);

  // Sanity: it must actually be within the viewport, not offscreen.
  expect(box.x + box.width).toBeGreaterThan(0);
  expect(box.y).toBeLessThan(DESKTOP.height);

  await ctx.close();
});

// ─── 8) mid-run perf watchdog → degrade to poster + telemetry ────────────────
// ADR 0003 §5 requires an automated test for every degradation trigger. The
// two boot-time triggers (reduced-motion, low-power) have coverage above;
// this one covers the RUNTIME triggers `p50` and `win500` inside frame():
// once WATCHDOG_GRACE_MS (3s) has elapsed, sustained frametimes above the
// budget must (a) flip .hero-bg to data-hero-state="poster", (b) dispatch a
// document-level 'telemetry' CustomEvent with kind="hero.degraded", and
// (c) stop the rAF loop. We simulate a janky device by wrapping rAF with a
// 60 ms busy-spin — well above P50_BUDGET_MS (22) and MEAN500_BUDGET_MS (33)
// — so the win500 window trips shortly after the grace period expires.
test('mid-run perf watchdog degrades canvas to poster and emits telemetry', async ({ browser }) => {
  const ctx = await browser.newContext({
    reducedMotion: 'no-preference',
    colorScheme: 'dark',
    viewport: DESKTOP,
  });
  const page = await ctx.newPage();

  await page.addInitScript(() => {
    // Take the capable-hardware boot path so the runtime watchdog can run;
    // otherwise the module would exit early at the shouldRunCanvas() gate.
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
    // rAF jank shim: every animation frame burns ~60 ms of main-thread time
    // before calling the module's frame callback. That makes each `dt` far
    // exceed both watchdog budgets, forcing the win500 mean-window branch
    // to trip within ~500 ms of the grace period ending (~3.5 s from boot).
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => orig(() => {
      const start = performance.now();
      while (performance.now() - start < 60) { /* jank */ }
      cb(performance.now());
    });
    // Capture the module's telemetry CustomEvent so we can assert on it after
    // navigation without racing the dispatch.
    (/** @type {any} */(window)).__telemetry = [];
    document.addEventListener('telemetry', (e) => {
      (/** @type {any} */(window)).__telemetry.push(
        /** @type {CustomEvent} */(e).detail,
      );
    });
  });

  await page.goto('/');

  // Sanity: the canvas must actually have booted into the running state,
  // otherwise the watchdog code path is not exercised and the test would
  // vacuously pass (the boot gate would have degraded us for a different
  // reason). rAF is delayed 60 ms per frame so allow a generous window.
  await page.waitForFunction(
    () => document.querySelector('.hero-bg')?.getAttribute('data-hero-state') === 'running',
    null,
    { timeout: 5000, polling: 100 },
  );

  // Grace is 3 s; win500 needs ~500 ms of samples above the mean budget after
  // that. In wall-clock terms with the shim active that lands around 3.5–4 s
  // after boot. Allow 10 s for the mid-run watchdog to converge.
  await page.waitForFunction(
    () => document.querySelector('.hero-bg')?.getAttribute('data-hero-state') === 'poster',
    null,
    { timeout: 10_000, polling: 100 },
  );

  // The degrade path must have emitted exactly one hero.degraded telemetry
  // event, and the reason must name a runtime watchdog branch (win500 in
  // practice for this shim, but accept p50 too — both code paths degrade
  // mid-run and both are legitimate for this trigger).
  const degraded = await page.evaluate(() => {
    const t = (/** @type {any} */(window)).__telemetry ?? [];
    return t.find((d) => d && d.kind === 'hero.degraded') ?? null;
  });
  expect(degraded).not.toBeNull();
  expect(['win500', 'p50']).toContain(degraded.reason);

  // The rAF loop must have stopped — the frames counter should be flat now.
  const framesA = await page.evaluate(() => (/** @type {any} */(window)).__hero?.frames ?? 0);
  await page.waitForTimeout(250);
  const framesB = await page.evaluate(() => (/** @type {any} */(window)).__hero?.frames ?? 0);
  expect(framesB).toBe(framesA);

  await ctx.close();
});
