// @ts-check
// tests/first-paint-visibility.spec.js
// -----------------------------------------------------------------------------
// Guards against the "reveal fallback silently breaks first-view content"
// bug that the perfection run caught: on the live P4 site, style.css set
// `.reveal { opacity: 0 }` unconditionally, so every fullPage screenshot
// captured before IntersectionObserver ran showed empty ghost sections.
//
// These tests replicate that: capture the page WITHOUT scrolling and assert
// that headline copy from every reveal-decorated section is visible at
// first paint. If a future edit reintroduces an unconditional .reveal hide,
// this suite fails.
// -----------------------------------------------------------------------------

import { test, expect } from '@playwright/test';

/**
 * Given a locator, return whether the element is *actually* visible at
 * first paint — Playwright's `toBeVisible()` is generous with opacity;
 * we want something stricter that would fail for opacity:0.
 * @param {import('@playwright/test').Locator} locator
 */
async function isPaintedVisible(locator) {
  return await locator.evaluate((el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const op = parseFloat(s.opacity);
    if (!Number.isFinite(op) || op < 0.99) return false;
    return true;
  });
}

test.describe('first paint — reveal fallback', () => {
  test('with JS disabled, every .reveal element is fully opaque', async ({ browser }) => {
    const ctx = await browser.newContext({
      javaScriptEnabled: false,
      colorScheme: 'dark',
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    await page.goto('/');

    // Take one .reveal from each named section that has one, to prove
    // no-JS clients see readable content.
    const sections = ['#skills', '#writing', '#projects', '#experience', '#contact'];
    for (const sel of sections) {
      const locator = page.locator(`${sel} .reveal`).first();
      // Some sections may not have a .reveal; skip if absent.
      if ((await locator.count()) === 0) continue;
      const painted = await isPaintedVisible(locator);
      expect(painted, `${sel} .reveal must be fully visible with JS off`).toBe(true);
    }

    await ctx.close();
  });

  test('sticky nav does not overlap a section heading after a nav-click jump', async ({ browser }) => {
    const ctx = await browser.newContext({
      colorScheme: 'dark',
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    await page.goto('/');

    // Jump to #systems via a hash change (equivalent to clicking the nav link
    // with the same href). Then compare the section's top rect vs the nav's
    // bottom rect — if the section top is BELOW the nav bottom, the sticky
    // nav is not overlapping, which is what F2 fix targets.
    await page.evaluate(() => {
      const el = document.querySelector('#systems');
      // scrollIntoView uses scroll-margin-top automatically.
      if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
    await page.waitForTimeout(200);

    const geometry = await page.evaluate(() => {
      const nav = document.querySelector('.nav');
      const section = document.querySelector('#systems');
      const h2 = section?.querySelector('h2');
      return {
        navBottom: nav ? nav.getBoundingClientRect().bottom : null,
        sectionTop: section ? section.getBoundingClientRect().top : null,
        headingTop: h2 ? h2.getBoundingClientRect().top : null,
      };
    });

    // The section's h2 should be at or below the nav's bottom edge.
    // Allow a small tolerance because scroll-margin uses the section's top,
    // and the h2 sits below the section's padding-top.
    if (geometry.headingTop != null && geometry.navBottom != null) {
      expect(
        geometry.headingTop,
        `#systems h2 (${geometry.headingTop}) must not be above nav bottom (${geometry.navBottom})`,
      ).toBeGreaterThanOrEqual(geometry.navBottom - 8);
    }

    await ctx.close();
  });
});
