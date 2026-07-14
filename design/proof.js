/* =====================================================================
 * design/proof.js — the honest proof layer.
 *
 * FOUR live widgets rendered inside `.proof-strip`. Each is completely
 * self-contained: it fetches its own data source, updates its own DOM
 * node, and — critically — HIDES itself on any of:
 *
 *   • network error
 *   • non-OK HTTP status
 *   • malformed / missing field
 *   • value below a minimum honesty threshold
 *
 * Packet rule #4 (truthful content) is enforced structurally, not by
 * discipline: there is no code path that writes a placeholder number or
 * rounds a small value up. Missing data → the tile is removed from flow
 * (aria-hidden + display:none), so the visitor never sees a stale zero.
 *
 * WIDGETS
 *   stars   GET https://api.github.com/repos/OJ-Uday/vetlock
 *           → shown when stargazers_count >= STARS_MIN
 *   npm     GET https://api.npmjs.org/downloads/point/last-week/vetlock
 *           → shown when downloads >= NPM_MIN
 *   scans   GET `${WORKER_URL}/stats/scans` (aggregate count)
 *           → SHOWN only when the Worker exposes the endpoint.
 *           TODO(after-P3-deploy): the Worker in this repo (worker/worker.js)
 *           currently exposes /, /health, POST /scan, GET /scan/:id. Once
 *           the Worker PR adds /stats/scans returning { total: <number> },
 *           this widget lights up automatically — nothing else to change.
 *   health  GET `${WORKER_URL}/health`
 *           → shown as a green dot when the Worker replies 200 with {ok:true}.
 *
 * CACHING
 *   The two 3rd-party endpoints (github + npm) are cached in localStorage
 *   for 1 hour so a repeat visitor doesn't burn through the unauthenticated
 *   GitHub rate limit (60 req/hr/IP). Cache misses or stale entries silently
 *   re-fetch. localStorage failures (private mode / quota) fall back to a
 *   plain network fetch — never fake a value.
 *
 * COLOR + THEME
 *   Every visible color goes through var(--*). The color gate script
 *   (scripts/no-hardcoded-colors.mjs) will fail this file on any hex
 *   literal or rgba() call, so hex only appears inside comments — never
 *   in style values.
 *
 * LAZY-LOAD CONTRACT
 *   This module exports a default init() that renders into the section
 *   already in the DOM (`#proof`). It is loaded on demand by a tiny
 *   IntersectionObserver bootstrap in index.html, so the parse/execute
 *   cost only lands after the visitor scrolls near the strip.
 * ===================================================================== */

const REPO           = 'OJ-Uday/vetlock';
const NPM_PKG        = 'vetlock';
const WORKER_URL     = 'https://vetlock-scan.oj-uday.workers.dev';

const STARS_MIN      = 5;         // packet rule #4: hide below threshold
const NPM_MIN        = 10;

const CACHE_TTL_MS   = 60 * 60 * 1000;  // 1 hour
const CACHE_PREFIX   = 'uo.proof.';

const FETCH_TIMEOUT_MS = 6000;

/**
 * Localstorage-backed 1h cache with graceful fallback.
 * Returns null on miss, expired, or storage failure.
 */
function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { v, t } = JSON.parse(raw);
    if (typeof t !== 'number' || Date.now() - t > CACHE_TTL_MS) return null;
    return v;
  } catch {
    return null;
  }
}

function cacheSet(key, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ v: value, t: Date.now() }));
  } catch {
    // Private mode / quota exceeded — the widget still renders from the live
    // fetch; we just won't cache. Never fabricate.
  }
}

/**
 * fetch() with a timeout so a slow/dead endpoint can't wedge the tile.
 * Any error (network, timeout, non-OK) returns null so the caller can
 * hide the widget.
 */
async function fetchJSON(url, { timeoutMs = FETCH_TIMEOUT_MS, headers } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Locale-formatted integer. Small helper so every widget uses the same
 * thousands separator and never rounds ("~1k" when it's really 47 would
 * be fabrication).
 */
function fmt(n) {
  try { return n.toLocaleString(); } catch { return String(n); }
}

/**
 * Show one tile with a big number and a subtitle.
 *
 * A11y ordering matters: the `.proof-strip` parent is `aria-live="polite"`,
 * but each tile ships with both `[hidden]` and `aria-hidden="true"`. If we
 * write textContent BEFORE unhiding, the mutation happens outside the a11y
 * tree and neither VoiceOver nor NVDA reliably fire an announcement when
 * the [hidden]/aria-hidden flip subsequently exposes the subtree
 * (SRs announce text mutations on VISIBLE descendants of a live region,
 * not subtree additions).
 *
 * So we:
 *   1. Set the `title` attribute (safe pre-unhide, non-announced).
 *   2. Unhide + drop aria-hidden — the tile enters the a11y tree while
 *      its `[data-proof-num]` / `[data-proof-sub]` slots are still empty
 *      (or, for health, pre-rendered but not yet announced).
 *   3. On the next animation frame, write the textContent. Because the
 *      nodes are now visible descendants of the aria-live region, this
 *      mutation is announced by VoiceOver / NVDA / Orca.
 */
function showTile(el, { value, sub, title }) {
  if (!el) return;
  const numEl = el.querySelector('[data-proof-num]');
  const subEl = el.querySelector('[data-proof-sub]');
  if (title) el.setAttribute('title', title);
  // Step 1: enter the accessibility tree first, with slots still empty.
  el.hidden = false;
  el.removeAttribute('aria-hidden');
  el.dataset.state = 'ok';
  // Step 2: write text on the next frame so screen readers see it as a
  // text mutation inside a visible live-region descendant. rAF is enough
  // to move the write off the same task that flipped `hidden`; a
  // microtask can still coalesce with the current paint on some engines.
  const write = () => {
    // `value == null` (undefined or null) means "leave the pre-rendered
    // markup alone" — used by the health tile, whose number slot ships
    // with a <span class="proof-dot"> that CSS `animation: pulse` hooks.
    // Writing textContent there would wipe the dot and kill the live
    // indicator.
    if (numEl && value != null) numEl.textContent = value;
    if (subEl && sub) subEl.textContent = sub;
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(write);
  } else {
    // Non-browser / test env fallback — still deferred one microtask so
    // the a11y-tree state has settled before the text mutation lands.
    Promise.resolve().then(write);
  }
}

/**
 * Hide a tile completely — never leaves a stale value visible.
 * Called on: error, missing data, below threshold, malformed response.
 */
function hideTile(el) {
  if (!el) return;
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
  el.dataset.state = 'hidden';
}

// ─── widget: vetlock GitHub stars ──────────────────────────────────────
async function renderStars(el) {
  const cached = cacheGet('stars');
  let stars = cached;
  if (stars == null) {
    // Unauthenticated GitHub API — 60 req/hr/IP. Cache above softens this.
    const data = await fetchJSON(`https://api.github.com/repos/${REPO}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!data || typeof data.stargazers_count !== 'number') return hideTile(el);
    stars = data.stargazers_count;
    cacheSet('stars', stars);
  }
  if (stars < STARS_MIN) return hideTile(el);
  showTile(el, {
    value: fmt(stars),
    sub: `github ${REPO}`,
    title: `${stars} stargazers via api.github.com`,
  });
}

// ─── widget: npm weekly downloads ─────────────────────────────────────
async function renderNpm(el) {
  const cached = cacheGet('npm');
  let dl = cached;
  if (dl == null) {
    // npm returns { downloads: <n>, package, start, end } for a published pkg,
    // { error: "package <x> not found" } (404) for unpublished. fetchJSON
    // returns null for the 404 case (res.ok false), so unpublished ⇒ hide.
    const data = await fetchJSON(`https://api.npmjs.org/downloads/point/last-week/${NPM_PKG}`);
    if (!data || typeof data.downloads !== 'number') return hideTile(el);
    dl = data.downloads;
    cacheSet('npm', dl);
  }
  if (dl < NPM_MIN) return hideTile(el);
  showTile(el, {
    value: fmt(dl),
    sub: `npm downloads · last week`,
    title: `${dl} downloads of ${NPM_PKG} in the last 7 days (api.npmjs.org)`,
  });
}

// ─── widget: total scans through the site ────────────────────────────
async function renderScans(el) {
  // The Worker in this repo (P3 deploy) doesn't yet expose an aggregate
  // count endpoint. We probe it and hide the tile if the endpoint is
  // absent (404) or malformed. When P3's follow-up adds:
  //     GET /stats/scans  →  { total: <number> }
  // this widget lights up with zero code change here.
  const data = await fetchJSON(`${WORKER_URL}/stats/scans`);
  if (!data || typeof data.total !== 'number') return hideTile(el);
  if (data.total < 1) return hideTile(el);
  showTile(el, {
    value: fmt(data.total),
    sub: 'scans run through this site',
    title: 'Aggregate scan count reported by the vetlock-scan worker',
  });
}

// ─── widget: backend health ───────────────────────────────────────────
async function renderHealth(el) {
  const data = await fetchJSON(`${WORKER_URL}/health`);
  // Worker returns { ok: true, service: "...", version: ... }. Anything
  // else (network error, wrong shape, ok:false) hides the pill.
  if (!data || data.ok !== true) return hideTile(el);
  showTile(el, {
    // value omitted on purpose — the health tile's [data-proof-num] ships
    // pre-rendered with <span class="proof-dot"> + <span>online</span>. Passing
    // undefined tells showTile to leave that markup intact so the CSS
    // pulse animation on .proof-dot keeps running.
    sub: 'scan backend · Cloudflare Worker',
    title: `Live health check: ${data.service || 'worker'} v${data.version ?? '?'}`,
  });
  el.classList.add('proof-tile--health');
}

// ─── public entry ────────────────────────────────────────────────────
let inited = false;

/**
 * Wire the four widgets. Idempotent — a repeated call (e.g. after a
 * re-intersection while the module is already loaded) is a no-op.
 * Every widget starts hidden and only shows on verified data.
 */
export default function init() {
  if (inited) return;
  inited = true;

  const strip = document.querySelector('.proof-strip');
  if (!strip) return;

  const starsEl  = strip.querySelector('[data-proof="stars"]');
  const npmEl    = strip.querySelector('[data-proof="npm"]');
  const scansEl  = strip.querySelector('[data-proof="scans"]');
  const healthEl = strip.querySelector('[data-proof="health"]');

  // Fire and forget — each promise handles its own errors internally.
  // We deliberately don't await them together: whichever comes back first
  // pops into place, and any that fail simply stay hidden.
  renderStars(starsEl);
  renderNpm(npmEl);
  renderScans(scansEl);
  renderHealth(healthEl);
}
