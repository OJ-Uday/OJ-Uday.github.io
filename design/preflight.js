/*
 * FOUC PREFLIGHT
 * =============================================================================
 * This tiny script MUST run in <head>, BEFORE any CSS or JS loads, and it is
 * INLINED directly into index.html (see design/preflight.min.js for the
 * minified copy that actually ships in the <script> tag).
 *
 * WHY INLINE, WHY FIRST?
 * ----------------------------------------------------------------------------
 * The site supports three theme modes: 'light', 'dark', and 'system'. When a
 * user has explicitly chosen 'light' or 'dark' (stored under localStorage key
 * 'uday.theme'), we must apply that choice to the <html> element BEFORE the
 * browser paints the first frame. Otherwise the page briefly renders in the
 * OS-preferred colour scheme, then flips — a jarring flash of unstyled /
 * incorrectly-themed content (FOUC).
 *
 * Any delay — external <script src>, deferred module, DOMContentLoaded
 * handler — is too late. The stylesheet's :root selectors read
 * document.documentElement.dataset.theme at parse time, so we set that
 * attribute synchronously before the first CSS byte is requested.
 *
 * BEHAVIOUR
 * ----------------------------------------------------------------------------
 * - Add class 'js' to <html> so progressive-enhancement CSS gates (e.g.
 *   `.js .reveal:not(.is-visible)` in primitives.css) take effect BEFORE
 *   first paint whenever JS is running. With JS disabled this class is
 *   never added, so those gated rules never match and content stays in
 *   its plain, always-visible baseline.
 * - Read 'uday.theme' from localStorage.
 * - If it's 'dark' or 'light', set html[data-theme] to that exact value.
 * - If it's 'system' or missing/anything else, do NOTHING and let the CSS
 *   fall back to `prefers-color-scheme` media queries.
 * - Wrapped in try/catch: localStorage.getItem can throw in private-browsing
 *   mode (Safari) or when storage is disabled. The 'js' class is stamped
 *   BEFORE the try block, because it doesn't touch storage and must land
 *   even when storage access throws.
 *
 * CONSTRAINTS
 * ----------------------------------------------------------------------------
 * - Must NOT load any resource (no fetch, no image, no script).
 * - Must NOT query the DOM beyond document.documentElement.
 * - Must be under 400 bytes minified.
 * =============================================================================
 */
(function () {
  document.documentElement.classList.add('js');
  try {
    var t = localStorage.getItem('uday.theme');
    if (t === 'dark' || t === 'light') {
      document.documentElement.dataset.theme = t;
    }
  } catch (e) {
    /* localStorage unavailable (private mode, disabled storage) — CSS fallback */
  }
})();
