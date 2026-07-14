// design/how-it-works.js
//
// Scrollytelling driver for #how-it-works. As each stage <li> enters the
// viewport, we swap which SVG frame is active in the sticky visualization
// column. This is presentational sugar — the section is fully readable
// (all six stages stacked with their inline SVGs) with JS OFF, on narrow
// viewports, and under prefers-reduced-motion. See design/how-it-works.css
// for the layout that makes those three fallbacks work without a fight.
//
// Contract:
//   Called as `init()` from the page bootstrap. Idempotent — a second call
//   is a no-op. The grid element carries data-active-stage; CSS handles
//   every visual consequence of that attribute changing.
//
// Frame markup lives in this module (not in index.html) — see LCP note.
//
// Why an IntersectionObserver instead of scroll math:
//   The sticky viz only advances when the entering stage crosses a stable
//   bandpass in the viewport. An IO with rootMargin lets us describe
//   "when this stage is roughly centered, advance to it" in a single line;
//   scroll-math versions of the same idea tend to jitter around the pin
//   point on trackpads because scroll events fire at unpredictable rates.
//
// Perf / LCP note:
//   The six sticky-rail frames (~10 KB of decorative inline SVG) used to
//   live in index.html — that inflated first-view HTML mass and pushed
//   mobile LCP past the 2000 ms budget under the local (non-gzipping)
//   measurement server. They are aria-hidden decoration and only visible
//   when JS is running AND viewport >= 900px, so moving them here (behind
//   the same lazy-load IO that already imports this module) drops them
//   from the initial HTML entirely. The load-bearing per-stage SVGs
//   (.hiw__stage-svg — the ones with role="img" + aria-label) remain
//   inline in the stage cards so the section still renders fully with
//   JS off.

// Frame markup for the sticky viz column. One <svg> per stage; each is
// aria-hidden decoration (the accessible description lives on the
// corresponding inline .hiw__stage-svg in the stage card). CSS in
// design/how-it-works.css gates which frame is opaque based on
// .hiw__grid[data-active-stage="N"].
const HIW_FRAMES = [
  `<svg class="hiw__frame hiw__gfx" data-stage="1" viewBox="0 0 320 240" preserveAspectRatio="xMidYMid meet" focusable="false" aria-hidden="true"><rect x="14" y="18" width="140" height="200" rx="6" class="g-node"/><rect x="166" y="18" width="140" height="200" rx="6" class="g-node"/><text x="24" y="34">before</text><text x="176" y="34">after</text><rect x="22" y="42" width="124" height="12" class="g-node" fill="transparent" stroke="none"/><text x="28" y="52" class="n-label-sm">"lodash": "4.17.21"</text><text x="180" y="52" class="n-label-sm">"lodash": "4.17.21"</text><rect x="22" y="58" width="124" height="14" class="g-diff-del-bg"/><text x="26" y="69" class="g-diff-del">-</text><text x="34" y="69" class="n-label-sm">"axios": "1.6.2"</text><rect x="174" y="58" width="124" height="14" class="g-diff-add-bg g-breathe"/><text x="178" y="69" class="g-diff-add">+</text><text x="186" y="69" class="n-label-sm">"axios": "1.7.9"</text><text x="28" y="88" class="n-label-sm">"chalk": "5.3.0"</text><text x="180" y="88" class="n-label-sm">"chalk": "5.3.0"</text><rect x="22" y="94" width="124" height="14" class="g-node" fill="transparent" stroke="none"/><rect x="174" y="94" width="124" height="14" class="g-diff-add-bg"/><text x="178" y="105" class="g-diff-add">+</text><text x="186" y="105" class="n-label-sm">"@scoped/util": "1.0.0"</text><text x="28" y="124" class="n-label-sm">"zod": "3.22.4"</text><text x="180" y="124" class="n-label-sm">"zod": "3.23.8"</text><text x="160" y="200" class="n-callout" text-anchor="middle">two lockfiles → structural delta</text><text x="160" y="212" class="n-label-sm" text-anchor="middle">package-lock.json · deterministic parse</text></svg>`,
  `<svg class="hiw__frame hiw__gfx" data-stage="2" viewBox="0 0 320 240" preserveAspectRatio="xMidYMid meet" focusable="false" aria-hidden="true"><rect x="130" y="26" width="60" height="24" rx="4" class="g-node"/><text x="160" y="42" text-anchor="middle">app</text><rect x="34" y="96" width="60" height="24" rx="4" class="g-node"/><text x="64" y="112" text-anchor="middle">chalk</text><rect x="130" y="96" width="60" height="24" rx="4" class="g-node--emph g-breathe"/><text x="160" y="112" text-anchor="middle" class="n-callout">axios</text><rect x="226" y="96" width="60" height="24" rx="4" class="g-node--emph g-breathe"/><text x="256" y="112" text-anchor="middle" class="n-callout">@scoped/util</text><rect x="34" y="170" width="60" height="24" rx="4" class="g-node"/><text x="64" y="186" text-anchor="middle" class="n-label-sm">ansi</text><rect x="130" y="170" width="60" height="24" rx="4" class="g-node"/><text x="160" y="186" text-anchor="middle" class="n-label-sm">follow-redirects</text><rect x="226" y="170" width="60" height="24" rx="4" class="g-node"/><text x="256" y="186" text-anchor="middle" class="n-label-sm">?</text><path d="M160 50 L64 96" class="g-edge"/><path d="M160 50 L160 96" class="g-edge--emph"/><path d="M160 50 L256 96" class="g-edge--emph"/><path d="M64 120 L64 170" class="g-edge"/><path d="M160 120 L160 170" class="g-edge"/><path d="M256 120 L256 170" class="g-edge"/><text x="160" y="222" class="n-callout" text-anchor="middle">2 changed roots · closure not yet resolved</text></svg>`,
  `<svg class="hiw__frame hiw__gfx" data-stage="3" viewBox="0 0 320 240" preserveAspectRatio="xMidYMid meet" focusable="false" aria-hidden="true"><rect x="130" y="26" width="60" height="24" rx="4" class="g-node"/><text x="160" y="42" text-anchor="middle">app</text><rect x="34" y="96" width="60" height="24" rx="4" class="g-node"/><text x="64" y="112" text-anchor="middle">chalk</text><rect x="130" y="96" width="60" height="24" rx="4" class="g-node--emph"/><text x="160" y="112" text-anchor="middle" class="n-callout">axios</text><rect x="226" y="96" width="60" height="24" rx="4" class="g-node--emph"/><text x="256" y="112" text-anchor="middle" class="n-callout">@scoped/util</text><rect x="34" y="170" width="60" height="24" rx="4" class="g-node"/><text x="64" y="186" text-anchor="middle" class="n-label-sm">ansi</text><rect x="130" y="170" width="60" height="24" rx="4" class="g-node--emph"/><text x="160" y="186" text-anchor="middle" class="n-label-sm n-callout">follow-redirects</text><rect x="226" y="170" width="60" height="24" rx="4" class="g-node--emph"/><text x="256" y="186" text-anchor="middle" class="n-label-sm n-callout">encode</text><path d="M160 50 L64 96" class="g-edge"/><path d="M160 50 L160 96" class="g-edge--flow"/><path d="M160 50 L256 96" class="g-edge--flow"/><path d="M64 120 L64 170" class="g-edge"/><path d="M160 120 L160 170" class="g-edge--flow"/><path d="M256 120 L256 170" class="g-edge--flow"/><text x="160" y="222" class="n-callout" text-anchor="middle">registry tarballs · HMAC-authed cache</text></svg>`,
  `<svg class="hiw__frame hiw__gfx" data-stage="4" viewBox="0 0 320 240" preserveAspectRatio="xMidYMid meet" focusable="false" aria-hidden="true"><rect x="130" y="20" width="60" height="24" rx="4" class="g-node"/><text x="160" y="36" text-anchor="middle">app</text><rect x="130" y="80" width="60" height="24" rx="4" class="g-node--emph"/><text x="160" y="96" text-anchor="middle" class="n-callout">axios</text><path d="M160 44 L160 80" class="g-edge"/><rect x="20" y="118" width="80" height="18" rx="9" class="g-pill--warn g-breathe"/><text x="60" y="130" text-anchor="middle" class="t-on-warn n-label-sm">install-script</text><rect x="110" y="118" width="80" height="18" rx="9" class="g-pill--warn"/><text x="150" y="130" text-anchor="middle" class="t-on-warn n-label-sm">new endpoint</text><rect x="200" y="118" width="100" height="18" rx="9" class="g-pill--block g-breathe"/><text x="250" y="130" text-anchor="middle" class="t-on-block n-label-sm">env-token harvest</text><rect x="20" y="146" width="80" height="18" rx="9" class="g-pill"/><text x="60" y="158" text-anchor="middle" class="n-label-sm">obfuscation Δ</text><rect x="110" y="146" width="80" height="18" rx="9" class="g-pill"/><text x="150" y="158" text-anchor="middle" class="n-label-sm">typosquat</text><rect x="200" y="146" width="100" height="18" rx="9" class="g-pill"/><text x="250" y="158" text-anchor="middle" class="n-label-sm">integrity mismatch</text><path d="M160 104 L60 118" class="g-edge"/><path d="M160 104 L150 118" class="g-edge"/><path d="M160 104 L250 118" class="g-edge--warn"/><text x="160" y="200" class="n-callout" text-anchor="middle">17 detectors · static-only · no code executed</text><text x="160" y="216" class="n-label-sm" text-anchor="middle">NEVER-EXECUTE invariant enforced by build canary</text></svg>`,
  `<svg class="hiw__frame hiw__gfx" data-stage="5" viewBox="0 0 320 240" preserveAspectRatio="xMidYMid meet" focusable="false" aria-hidden="true"><rect x="130" y="20" width="60" height="24" rx="4" class="g-node"/><text x="160" y="36" text-anchor="middle">app</text><rect x="34" y="86" width="60" height="24" rx="4" class="g-node"/><text x="64" y="102" text-anchor="middle">chalk</text><rect x="130" y="86" width="60" height="24" rx="4" class="g-node--emph"/><text x="160" y="102" text-anchor="middle" class="n-callout">axios</text><rect x="226" y="86" width="60" height="24" rx="4" class="g-node--warn"/><text x="256" y="102" text-anchor="middle" class="n-warn">@scoped/util</text><rect x="34" y="156" width="60" height="24" rx="4" class="g-node"/><text x="64" y="172" text-anchor="middle" class="n-label-sm">ansi</text><rect x="130" y="156" width="60" height="24" rx="4" class="g-node--emph"/><text x="160" y="172" text-anchor="middle" class="n-label-sm n-callout">follow-redirects</text><rect x="226" y="156" width="60" height="24" rx="4" class="g-node--warn"/><text x="256" y="172" text-anchor="middle" class="n-label-sm n-warn">encode</text><path d="M160 44 L64 86" class="g-edge"/><path d="M160 44 L160 86" class="g-edge--emph"/><path d="M160 44 L256 86" class="g-edge--warn"/><path d="M64 110 L64 156" class="g-edge"/><path d="M160 110 L160 156" class="g-edge--emph"/><path d="M256 110 L256 156" class="g-edge--warn"/><text x="64" y="200" text-anchor="middle" class="n-label-sm">npm · signed</text><text x="160" y="200" text-anchor="middle" class="n-label-sm n-callout">npm · signed</text><text x="256" y="200" text-anchor="middle" class="n-label-sm n-warn">npm · 3d old</text><text x="160" y="222" class="n-callout" text-anchor="middle">origin, integrity, adjacency · GHSA + typosquat</text></svg>`,
  `<svg class="hiw__frame hiw__gfx" data-stage="6" viewBox="0 0 320 240" preserveAspectRatio="xMidYMid meet" focusable="false" aria-hidden="true"><rect x="80" y="46" width="160" height="48" rx="24" class="g-pill--block g-breathe"/><text x="160" y="76" text-anchor="middle" class="g-verdict-label t-on-block">BLOCK</text><text x="160" y="112" text-anchor="middle" class="n-callout">@scoped/util 1.0.0</text><text x="160" y="128" text-anchor="middle" class="n-label-sm">install-script + env-token harvest</text><rect x="34" y="150" width="80" height="20" rx="10" class="g-pill--clean"/><text x="74" y="163" text-anchor="middle" class="t-on-clean n-label-sm">CLEAN · chalk</text><rect x="120" y="150" width="80" height="20" rx="10" class="g-pill--warn"/><text x="160" y="163" text-anchor="middle" class="t-on-warn n-label-sm">WARN · axios</text><rect x="206" y="150" width="80" height="20" rx="10" class="g-pill--block"/><text x="246" y="163" text-anchor="middle" class="t-on-block n-label-sm">BLOCK · util</text><path d="M160 198 L160 214" class="g-edge--warn"/><path d="M155 210 L160 218 L165 210 Z" class="g-arrow--warn"/><text x="160" y="230" class="n-label-sm" text-anchor="middle">exit code · CI fails the merge</text></svg>`,
];

let installed = false;

export default function init() {
  if (installed) return;

  const grid = document.querySelector('.hiw__grid');
  if (!grid) return;

  const stages = /** @type {HTMLElement[]} */ (
    Array.from(grid.querySelectorAll('.hiw__stage[data-stage]'))
  );
  if (stages.length === 0) return;

  // Inject the sticky-rail frames into .hiw__viz once. CSS keeps the whole
  // .hiw__viz-col hidden without JS and on narrow viewports, so this is a
  // pure enhancement — no visible surface changes for those clients.
  const viz = grid.querySelector('.hiw__viz');
  if (viz && viz.childElementCount === 0) {
    viz.innerHTML = HIW_FRAMES.join('');
  }

  // Reduced-motion escape hatch: skip the scroll-linked animation entirely
  // and just show stage 1 (or the last-hash target if the user linked
  // directly). This preserves the "static composite" fallback that the
  // task spec calls out for reduced-motion users.
  const prefersReducedMotion =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (prefersReducedMotion) {
    const targetStage = pickStageFromHash(stages) ?? '1';
    grid.dataset.activeStage = targetStage;
    installed = true;
    return;
  }

  // Also skip on narrow viewports — the CSS already hides the sticky rail
  // there, so we don't need to burn observer cycles keeping it in sync.
  // We still stamp an initial stage in case the layout grows to wide
  // mid-session (window resize).
  const mq = matchMedia('(min-width: 900px)');
  if (!mq.matches) {
    grid.dataset.activeStage = '1';
  }

  // Observer: fire when a stage is roughly in the middle third of the
  // viewport. The negative top/bottom rootMargin defines a bandpass; only
  // stages whose bounding-box top crosses that band are considered "active."
  // We disable the observer on narrow viewports (see above) but leave the
  // handler resilient to that state — the assignment is cheap.
  const observer = new IntersectionObserver(
    (entries) => {
      // Prefer the most-intersecting entry; if a scroll jumps multiple
      // stages, we want to land on the one that dominates the visible band.
      let bestStage = null;
      let bestRatio = 0;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        if (e.intersectionRatio > bestRatio) {
          bestRatio = e.intersectionRatio;
          bestStage = /** @type {HTMLElement} */ (e.target).dataset.stage;
        }
      }
      if (bestStage) {
        grid.dataset.activeStage = bestStage;
      }
    },
    {
      // The bandpass: ignore intersections in the top 40% and bottom 30%
      // of the viewport. This means "active" ≈ centered-ish.
      rootMargin: '-40% 0px -30% 0px',
      threshold: [0, 0.25, 0.5, 0.75, 1],
    },
  );

  for (const s of stages) observer.observe(s);

  // Set an initial stage so the sticky viz isn't empty before the first
  // intersection callback fires. If the user linked to a specific stage
  // via URL hash (#hiw-stage-3), honor that; else start at 1.
  const initial = pickStageFromHash(stages) ?? '1';
  grid.dataset.activeStage = initial;

  installed = true;
}

/** If the URL hash targets a stage, return its number; else null. */
function pickStageFromHash(stages) {
  const hash = (location.hash || '').replace(/^#/, '');
  if (!hash) return null;
  const match = stages.find((s) => s.id === hash);
  return match ? match.dataset.stage : null;
}
