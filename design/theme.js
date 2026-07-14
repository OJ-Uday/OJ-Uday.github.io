// design/theme.js
// -----------------------------------------------------------------------------
// Theme manager. No deps, no framework. Sibling to /design/tokens.css.
//
// State model
//   Persisted "mode" (localStorage key 'uday.theme') is one of:
//     'dark'   → force dark   (data-theme="dark" on <html>)
//     'light'  → force light  (data-theme="light" on <html>)
//     'system' → follow OS prefers-color-scheme (NO data-theme attribute)
//   Absent key is treated as 'system'.
//
//   The "effective" theme is what the user actually sees ('dark' | 'light').
//   For 'dark' / 'light' modes it equals the mode. For 'system' it's derived
//   from window.matchMedia('(prefers-color-scheme: dark)').
//
// Exports
//   default init()            call once from index.html
//   getTheme()                → { mode, effective }
//   setTheme(mode)            'dark' | 'light' | 'system'
//   toggleTheme()             binary flip: effective dark → light, else → dark
//   cycleTheme()              dark → light → system → dark
//   onThemeChange(cb)         subscribe to 'themechange' CustomEvent on document
//                             returns an unsubscribe fn
//
// Emits `themechange` CustomEvent on document with
//   detail = { mode: 'dark'|'light'|'system', effective: 'dark'|'light' }
//
// Keyboard shortcut
//   Shift+T toggles theme. Lowercase 't' is already bound by app.js to the
//   feed-format toggle in the telemetry console; using uppercase avoids
//   double-firing. The shortcut ignores modifier combinations (Ctrl/Meta/Alt)
//   and typing targets (input/textarea/contenteditable/open dialog).
// -----------------------------------------------------------------------------

const KEY = 'uday.theme';
const MODES = /** @type {const} */ (['dark', 'light', 'system']);
const mql = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

// Inline SVG for the nav toggle button. Kept in-module so callers don't need assets.
const SVG_SUN  = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
const SVG_MOON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

/** @returns {'dark'|'light'|'system'} */
function readMode() {
  try {
    const v = localStorage.getItem(KEY);
    return MODES.includes(/** @type {any} */ (v)) ? /** @type {any} */ (v) : 'system';
  } catch { return 'system'; }
}

/** @param {'dark'|'light'|'system'} mode */
function writeMode(mode) {
  try { localStorage.setItem(KEY, mode); } catch {}
}

/** Compute effective theme from mode + OS preference. */
function effectiveFor(/** @type {'dark'|'light'|'system'} */ mode) {
  if (mode === 'dark' || mode === 'light') return mode;
  return mql && mql.matches ? 'dark' : 'light';
}

/** Apply mode → DOM. 'system' clears the attribute so the CSS media query wins. */
function apply(/** @type {'dark'|'light'|'system'} */ mode) {
  const root = document.documentElement;
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
}

/** Broadcast + refresh any registered [data-theme-toggle] controls. */
function announce() {
  const mode = readMode();
  const effective = effectiveFor(mode);
  document.dispatchEvent(new CustomEvent('themechange', { detail: { mode, effective } }));
  for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
    // aria-pressed reflects "is dark active"; icon shows the mode you'll switch TO.
    btn.setAttribute('aria-pressed', String(effective === 'dark'));
    btn.innerHTML = effective === 'dark' ? SVG_SUN : SVG_MOON;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** @returns {{ mode: 'dark'|'light'|'system', effective: 'dark'|'light' }} */
export function getTheme() {
  const mode = readMode();
  return { mode, effective: effectiveFor(mode) };
}

/** @param {'dark'|'light'|'system'} mode */
export function setTheme(mode) {
  if (!MODES.includes(mode)) return;
  writeMode(mode);
  apply(mode);
  announce();
}

/** Binary flip based on current *effective* theme — for the nav button. */
export function toggleTheme() {
  setTheme(effectiveFor(readMode()) === 'dark' ? 'light' : 'dark');
}

/** Three-way cycle: dark → light → system → dark. */
export function cycleTheme() {
  const next = { dark: 'light', light: 'system', system: 'dark' }[readMode()];
  setTheme(/** @type {any} */ (next));
}

/**
 * Subscribe to theme changes.
 * @param {(detail: { mode: 'dark'|'light'|'system', effective: 'dark'|'light' }) => void} cb
 * @returns {() => void} unsubscribe
 */
export function onThemeChange(cb) {
  const handler = (/** @type {Event} */ e) => cb(/** @type {CustomEvent} */ (e).detail);
  document.addEventListener('themechange', handler);
  return () => document.removeEventListener('themechange', handler);
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

/** True when a keystroke should NOT be treated as a global shortcut. */
function isTypingTarget(/** @type {EventTarget|null} */ t) {
  if (!(t instanceof HTMLElement)) return false;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return true;
  if (t.isContentEditable) return true;
  if (t.closest('dialog[open]')) return true;
  return false;
}

let inited = false;

/** Wire toggle buttons, keyboard shortcut, and OS-preference listener. Call once. */
export default function init() {
  if (inited) return;
  inited = true;

  // 1) Apply the persisted mode to <html> BEFORE first paint of themed content.
  //    (The inline preflight in <head> did this already; this is a safety
  //    re-apply for callers that skip the preflight.)
  apply(readMode());

  // 2) Auto-wire toggles + emit an initial themechange so subscribers hydrate.
  const wire = () => {
    for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
      if (btn.dataset.themeToggleBound) continue;
      btn.dataset.themeToggleBound = '1';
      btn.addEventListener('click', () => toggleTheme());
    }
    announce();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
  else wire();

  // 3) Shift+T keyboard shortcut. Lowercase 't' is already bound by app.js to
  //    fmt-toggle in the telemetry console; the shift-variant avoids the
  //    double-fire.
  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!e.shiftKey) return;
    if (e.key !== 'T') return;
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    toggleTheme();
  });

  // 4) React to OS preference changes only while in 'system' mode.
  if (mql) {
    const onOS = () => { if (readMode() === 'system') announce(); };
    if (mql.addEventListener) mql.addEventListener('change', onOS);
    else if (mql.addListener) mql.addListener(onOS);  // Safari <14
  }
}
