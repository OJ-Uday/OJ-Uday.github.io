// @ts-check
// tests/theme-toggle.spec.js
// -----------------------------------------------------------------------------
// End-to-end tests for the theme system:
//   design/tokens.css  (dark + light values, prefers-reduced-motion override)
//   design/theme.js    (getTheme / setTheme / toggleTheme, keyboard, matchMedia)
//   design/preflight.min.js  (inline pre-paint theme write to <html>)
//
// The tests exercise real browser behavior via Playwright's Chromium runner
// backed by a local http.server started from playwright.config.js.
// -----------------------------------------------------------------------------

import { test, expect } from '@playwright/test';

/**
 * Read a getComputedStyle CSS variable off the <html> element.
 * @param {import('@playwright/test').Page} page
 * @param {string} name  e.g. '--color-bg'
 */
async function cssVar(page, name) {
  return await page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

/**
 * Read the *effective* body background color as an rgb(a) string.
 * @param {import('@playwright/test').Page} page
 */
async function bodyBg(page) {
  return await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

// ─── 1) Defaults to OS preference ────────────────────────────────────────────
test.describe('theme system', () => {
  test('defaults to OS preference: dark colorScheme yields dark bg, no data-theme attr', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto('/');
    // No explicit choice made → no data-theme attribute; body bg should be dark.
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    const bg = await bodyBg(page);
    // Dark bg is slate-950 (#0a0e13) — allow either form. The site paints a
    // radial gradient over it, so we just assert it's a dark value (RGB sum
    // well under 128*3 = 384) rather than the exact hex.
    const sum = (bg.match(/\d+/g) || []).slice(0, 3).map(Number).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThan(150);
    await ctx.close();
  });

  test('defaults to OS preference: light colorScheme yields light bg', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'light' });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    const bg = await bodyBg(page);
    const sum = (bg.match(/\d+/g) || []).slice(0, 3).map(Number).reduce((a, b) => a + b, 0);
    // Light bg is slate-100 (#f6f8fa) — RGB sum ~740 (well over 600).
    expect(sum).toBeGreaterThan(600);
    await ctx.close();
  });
});

// ─── 2) Toggle button flips theme ────────────────────────────────────────────
test('toggle click flips theme (dark → light)', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto('/');

  const beforeSum = (await bodyBg(page)).match(/\d+/g)?.slice(0, 3).map(Number).reduce((a, b) => a + b, 0) ?? 0;
  expect(beforeSum).toBeLessThan(150);

  await page.locator('[data-theme-toggle]').first().click();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const afterSum = (await bodyBg(page)).match(/\d+/g)?.slice(0, 3).map(Number).reduce((a, b) => a + b, 0) ?? 0;
  expect(afterSum).toBeGreaterThan(600);

  // localStorage got the choice.
  const stored = await page.evaluate(() => localStorage.getItem('uday.theme'));
  expect(stored).toBe('light');
  await ctx.close();
});

// ─── 3) Persists across reload — FOUC preflight ─────────────────────────────
test('persists across reload with no FOUC (preflight sets data-theme pre-paint)', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  const page = await ctx.newPage();

  // Seed localStorage BEFORE first navigation so the inline preflight runs
  // with the value present. addInitScript fires in every document, including
  // the first one, so the preflight can read what we set.
  await page.addInitScript(() => {
    try { localStorage.setItem('uday.theme', 'light'); } catch {}
  });
  await page.goto('/');

  // The <html> must already carry data-theme="light" BEFORE app.js finishes;
  // we assert it right after DOMContentLoaded — the preflight is inline in
  // <head> so it fires before any <link rel="stylesheet"> paints.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const bg = await bodyBg(page);
  const sum = (bg.match(/\d+/g) || []).slice(0, 3).map(Number).reduce((a, b) => a + b, 0);
  expect(sum).toBeGreaterThan(600);
  await ctx.close();
});

// ─── 4) Persists across bfcache-style navigation ─────────────────────────────
test('persists across back navigation', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.locator('[data-theme-toggle]').first().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.goto('about:blank');
  await page.goBack();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await ctx.close();
});

// ─── 5) Shift+T keyboard shortcut ────────────────────────────────────────────
test('Shift+T toggles theme when focus is on body', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto('/');

  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Shift+T');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await ctx.close();
});

test('Shift+T does NOT toggle theme when focus is in a text input', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto('/');

  // Inject a plain input we can focus. The site has no user-facing text input
  // on the home page path (the scanner uses file drop), so we synthesize one.
  await page.evaluate(() => {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.id = 'theme-test-input';
    document.body.appendChild(inp);
    inp.focus();
  });

  await page.keyboard.press('Shift+T');

  // No data-theme was set because the shortcut was suppressed inside an input.
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  await ctx.close();
});

// ─── 6) Reduced motion collapses --dur-* to ~0ms ─────────────────────────────
test('prefers-reduced-motion flattens --dur-base via tokens.css', async ({ browser }) => {
  const ctx = await browser.newContext({
    reducedMotion: 'reduce',
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  await page.goto('/');

  const val = await cssVar(page, '--dur-base');
  // Under reduced-motion, tokens.css overrides all --dur-* to 0.01ms.
  // Parse to a number of milliseconds so we can assert unambiguously.
  const ms = parseFloat(val);
  expect(Number.isFinite(ms)).toBe(true);
  expect(ms).toBeLessThan(0.02);
  await ctx.close();
});

// ─── 7) Styleguide renders and its toggle works too ──────────────────────────
test('/styleguide/ renders and honors data-theme-toggle', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto('/styleguide/');
  // Palette section exists.
  await expect(page.locator('#palette, [id*=palette], h2:has-text("Palette")').first()).toBeVisible();
  // Toggle works here too.
  await page.locator('[data-theme-toggle]').first().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await ctx.close();
});
