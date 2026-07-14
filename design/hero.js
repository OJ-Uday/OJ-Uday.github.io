// design/hero.js
// -----------------------------------------------------------------------------
// P2 Hero Watcher — bespoke canvas 2D scene for the site's above-the-fold hero.
// "The watcher watching": a small dependency-graph field with a slow radial
// sweep that lights each node as its wavefront passes. One node is a whisper
// of danger (--color-danger). No text, no labels, no telemetry — decorative
// geometry that reads as "systems watching systems."
//
// Contract (see P2 spec + ADR 0003):
//   * Zero deps. ES module. Single default export.
//   * Poster SVG is the LCP element; this module ONLY overlays the poster
//     once it has decided the environment can afford animation.
//   * Degrades to a no-op (poster shines through) when:
//       - prefers-reduced-motion: reduce
//       - deviceMemory <= 2 OR hardwareConcurrency <= 2
//       - canvas.getContext('2d') is unavailable
//       - runtime perf watchdog trips (p50 frametime > 22ms sustained, or a
//         500ms window with mean > 33ms)
//   * Every color read via CSS custom property; re-read on 'themechange'.
//   * Pauses when document.hidden. Cleans up on destroy().
//
// The module is intentionally hand-written and ~200-400 lines. Bytes matter —
// see comments tagged `[bytes]` for why a construct exists.
// -----------------------------------------------------------------------------

// ---------- Baked node positions -------------------------------------------
// Deterministic Poisson-disk sample in [0.02, 0.98]^2, mulberry32 seed
// 0xC0DE1055, r=0.075 desktop. Index 0 = root at (0.18, 0.42). Index 7 =
// danger. Sizes: {1,2,3} weighted 60/30/10. Root and danger are always size 3.
// Coordinates are pre-baked once (offline) so we spend zero runtime on layout.
//
// Format: [x, y, size, kind] where kind is 'root' | 'danger' | 'std'.
// Mobile (viewport < 900px) uses the first 28 entries — the slice is
// guaranteed to contain the root and the danger node. [bytes] one array is
// smaller than two.
const NODES_RAW = [
  [0.18, 0.42, 3, 2],  // 2 = root
  [0.7, 0.632, 1, 0],
  [0.3, 0.977, 1, 0],
  [0.439, 0.858, 2, 0],
  [0.892, 0.22, 3, 0],
  [0.396, 0.528, 3, 0],
  [0.149, 0.269, 2, 0],
  [0.787, 0.217, 3, 1],  // 1 = danger
  [0.437, 0.66, 1, 0],
  [0.544, 0.306, 1, 0],
  [0.9, 0.032, 1, 0],
  [0.215, 0.053, 1, 0],
  [0.873, 0.914, 2, 0],
  [0.068, 0.062, 1, 0],
  [0.4, 0.258, 1, 0],
  [0.858, 0.456, 1, 0],
  [0.767, 0.922, 1, 0],
  [0.028, 0.433, 1, 0],
  [0.393, 0.762, 2, 0],
  [0.289, 0.596, 1, 0],
  [0.683, 0.148, 3, 0],
  [0.544, 0.492, 2, 0],
  [0.213, 0.331, 1, 0],
  [0.68, 0.044, 1, 0],
  [0.676, 0.332, 2, 0],
  [0.126, 0.185, 1, 0],
  [0.698, 0.739, 1, 0],
  [0.058, 0.272, 1, 0],
  [0.323, 0.893, 3, 0],
  [0.077, 0.764, 1, 0],
  [0.413, 0.418, 1, 0],
  [0.593, 0.836, 1, 0],
  [0.263, 0.177, 2, 0],
  [0.973, 0.247, 1, 0],
  [0.726, 0.49, 1, 0],
  [0.101, 0.897, 1, 0],
  [0.587, 0.215, 3, 0],
  [0.27, 0.757, 2, 0],
  [0.397, 0.05, 2, 0],
  [0.15, 0.721, 2, 0],
  [0.094, 0.671, 3, 0],
  [0.34, 0.184, 3, 0],
  [0.68, 0.838, 1, 0],
  [0.843, 0.632, 2, 0],
  [0.802, 0.099, 1, 0],
  [0.256, 0.511, 2, 0],
  [0.29, 0.046, 1, 0],
  [0.949, 0.827, 2, 0],
  [0.771, 0.317, 2, 0],
  [0.767, 0.559, 1, 0],
  [0.956, 0.401, 2, 0],
  [0.88, 0.142, 1, 0],
  [0.971, 0.484, 1, 0],
  [0.519, 0.815, 1, 0],
  [0.841, 0.359, 2, 0],
  [0.518, 0.394, 1, 0],
  [0.928, 0.552, 1, 0],
  [0.219, 0.872, 1, 0],
  [0.66, 0.963, 1, 0],
  [0.801, 0.841, 2, 0],
];

// Node kind enum: 0 = std, 1 = danger, 2 = root. Small ints keep JSON tiny.
const KIND_STD = 0;
const KIND_DANGER = 1;
const KIND_ROOT = 2;

// Radius in CSS px at 1x DPR, indexed by size (1..3).
const RADIUS = [0, 2.5, 4, 6];

// Timing constants (seconds).
const SWEEP_CYCLE = 10.0;
const SWEEP_EXPAND = 3.2;
const SWEEP_HOLD_END = 3.5;
const PULSE_STD = 3.2;
const PULSE_HOT = 2.4;
const AFTERGLOW_TAU = 0.35; // seconds, exponential decay of lit trail
const POINTER_RADIUS = 100; // CSS px
const POINTER_TIMEOUT_MS = 2000;

// Perf watchdog thresholds.
const P50_BUDGET_MS = 22;   // ~45 fps sustained
const MEAN500_BUDGET_MS = 33; // ~30 fps window
const WATCHDOG_GRACE_MS = 3000; // don't judge boot heat
const FRAME_WINDOW = 60;    // ~1s at 60fps

// ---------- Boot & degradation ---------------------------------------------

/** Return truthy iff we should even attempt a canvas boot. */
function shouldRunCanvas(canvas) {
  // Trigger 1: motion respect.
  if (typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  // Trigger 2: low-power heuristic. Undefined (Safari, older FF) is NOT low —
  // we only bail when the browser explicitly reports a small machine. Guard on
  // `typeof … === "number"` (not truthiness) so that privacy-preserving
  // browsers reporting 0 for deviceMemory/hardwareConcurrency are correctly
  // treated as "small machine" per ADR 0003, not accidentally passed through.
  const dm = navigator.deviceMemory;
  const hc = navigator.hardwareConcurrency;
  if ((typeof dm === "number" && dm <= 2) ||
      (typeof hc === "number" && hc <= 2)) return false;
  // Trigger 3: Save-Data hint. When the user has data-saver enabled the OS/UA
  // is signalling "spend as few bytes and cycles as possible" — the poster is
  // the right answer. ADR 0003 §5 lists this as one of six mandatory triggers;
  // we only bail on an explicit `=== true`, so a missing NetworkInformation API
  // (Safari, privacy-hardened browsers) is treated as "no signal", not "opt in".
  const sd = navigator.connection && navigator.connection.saveData;
  if (sd === true) return false;
  // Trigger 4: init capability.
  if (!canvas || typeof canvas.getContext !== "function") return false;
  try {
    const ctx = canvas.getContext("2d");
    return ctx ? { canvas, ctx } : false;
  } catch {
    return false;
  }
}

// ---------- Palette --------------------------------------------------------

/**
 * Read the five hero tokens fresh. Called at boot and on 'themechange'.
 * Returns null if ANY token is missing — the ADR/design-system rule is that
 * every hero color must resolve to a designed primitive from tokens.css, so
 * we refuse to invent a fallback. Boot treats null as an init failure and
 * flips to poster mode; theme-change treats it as "keep the last known good
 * palette" so a transient CSSOM read never repaints in bogus colors.
 */
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const bg     = cs.getPropertyValue("--color-bg").trim();
  const idle   = cs.getPropertyValue("--color-text-dim").trim();
  const edge   = cs.getPropertyValue("--color-text-muted").trim();
  const accent = cs.getPropertyValue("--color-accent").trim();
  const danger = cs.getPropertyValue("--color-danger").trim();
  if (!bg || !idle || !edge || !accent || !danger) return null;
  return { bg, idle, edge, accent, danger };
}

// ---------- Edge derivation ------------------------------------------------

/**
 * For each node, connect to its 2 nearest neighbors by Euclidean distance in
 * normalized [0,1]^2 space. De-duplicate — Uint16Array of [a,b,a,b,...].
 * Cheap: O(n^2) with n<=60 is 3600 ops, done once.
 */
function deriveEdges(nodes) {
  const n = nodes.length;
  const K = 2;
  const seen = new Set();
  const pairs = [];
  for (let i = 0; i < n; i++) {
    const ni = nodes[i];
    // Find K nearest.
    const dists = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dx = nodes[j][0] - ni[0];
      const dy = nodes[j][1] - ni[1];
      dists.push([j, dx * dx + dy * dy]);
    }
    dists.sort((a, b) => a[1] - b[1]);
    for (let k = 0; k < K && k < dists.length; k++) {
      const j = dists[k][0];
      const key = i < j ? (i * n + j) : (j * n + i);
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(i < j ? i : j, i < j ? j : i);
    }
  }
  return new Uint16Array(pairs);
}

// ---------- init -----------------------------------------------------------

/**
 * Boot the hero. Overloaded:
 *   init()                       — resolve canvas via default selector
 *   init(canvasElement)          — use this canvas
 *   init(canvasElement, opts)    — canvas + options
 *   init(opts)                   — object with { canvasSelector, rootSelector }
 *
 * Returns { destroy } always — the caller doesn't need to know whether we
 * actually booted a scene or bailed to poster-only mode.
 */
export default function init(canvasOrOpts, maybeOpts) {
  // Argument disambiguation. [bytes] tiny cost, big API flexibility.
  const isEl = canvasOrOpts && typeof canvasOrOpts.getContext === "function";
  const opts = (isEl ? maybeOpts : canvasOrOpts) || {};
  const rootSelector = opts.rootSelector || ".hero-bg";
  const canvasSelector = opts.canvasSelector || ".hero-canvas";
  const canvas = isEl ? canvasOrOpts : document.querySelector(canvasSelector);
  const bg = document.querySelector(rootSelector);

  const gate = shouldRunCanvas(canvas);
  if (!gate) {
    // Poster-only mode. Nothing to clean up. Still publish the testability
    // handle + set data-hero-state so consumers (tests, telemetry) can see
    // that we deliberately stayed in poster mode. [spec §G / test contract]
    if (bg) bg.setAttribute("data-hero-state", "poster");
    const posterHandle = {
      get state() { return "poster"; },
      get frames() { return 0; },
      get paletteReads() { return 0; },
      destroy() {},
    };
    try { window.__hero = posterHandle; } catch {}
    return { destroy() {} };
  }
  const ctx = gate.ctx;

  // ---------- State -------------------------------------------------------
  // Per-node scratch buffers live in `s` so re-allocating them on a
  // desktop <-> mobile viewport flip is a single object mutation. Float32
  // is cache-friendly and avoids per-node `{x, y}` allocations. [perf]
  let active = NODES_RAW;
  let edges = deriveEdges(active);
  const s = {
    offX: new Float32Array(active.length), // pointer-drift offsets (x)
    offY: new Float32Array(active.length), // pointer-drift offsets (y)
    lit:  new Float32Array(active.length), // sweep-lit contribution [0..1]
  };
  let colors = readPalette();
  // If any hero token failed to resolve, we refuse to render the canvas —
  // ADR 0003 makes canvas-init failure a degradation trigger, and painting
  // with hex fallbacks would violate the design-system rule (no raw literals
  // in hero code). Fall back to poster-only mode; the poster ships regardless.
  if (!colors) {
    if (bg) bg.setAttribute("data-hero-state", "poster");
    const posterHandle = {
      get state() { return "poster"; },
      get frames() { return 0; },
      get paletteReads() { return 0; },
      destroy() {},
    };
    try { window.__hero = posterHandle; } catch {}
    return { destroy() {} };
  }
  let paletteReads = 1;   // count the boot read for test hook parity
  let framesDrawn = 0;    // rAF frame counter for test hook
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let cssW = 0, cssH = 0;
  let rootCanvasX = 0, rootCanvasY = 0; // cached root position in CSS px

  // Pointer
  const pointer = { x: 0, y: 0, active: false, tid: 0 };

  // Timing
  let running = false;
  let rafId = 0;
  let sceneStart = 0;   // ms epoch of first animated frame
  let lastFrame = 0;    // ms epoch of previous frame

  // Perf watchdog — ring buffers of frametimes (ms).
  const frameMs = new Float32Array(FRAME_WINDOW);
  let frameHead = 0;
  let frameCount = 0;
  let win500Sum = 0;
  let win500Count = 0;
  let win500Start = 0;
  let degraded = false;

  // ---------- Layout / resize --------------------------------------------
  function resetScratch() {
    if (s.offX.length !== active.length) {
      s.offX = new Float32Array(active.length);
      s.offY = new Float32Array(active.length);
      s.lit  = new Float32Array(active.length);
    } else {
      s.offX.fill(0); s.offY.fill(0); s.lit.fill(0);
    }
  }
  function pickActive() {
    // Mobile: viewport < 900px → first 28 nodes (contains root idx 0 and
    // danger idx 7 by construction).
    const target = window.innerWidth < 900 ? NODES_RAW.slice(0, 28) : NODES_RAW;
    if (target === active) return false;
    active = target;
    edges = deriveEdges(active);
    resetScratch();
    return true;
  }

  function measure() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, rect.width | 0);
    cssH = Math.max(1, rect.height | 0);
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    // Reset transform then scale; setTransform is idempotent.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Cache root position in canvas CSS px.
    rootCanvasX = active[0][0] * cssW;
    rootCanvasY = active[0][1] * cssH;
  }

  // Debounced resize via rAF.
  let resizePending = false;
  function onResize() {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      pickActive();
      measure();
    });
  }

  // ResizeObserver on the bg wrapper for accurate size events.
  const ro = typeof ResizeObserver === "function"
    ? new ResizeObserver(onResize)
    : null;
  if (ro && bg) ro.observe(bg);
  window.addEventListener("resize", onResize, { passive: true });

  // ---------- Pointer -----------------------------------------------------
  function onPointerMove(ev) {
    // Only mouse/pen — touch users get the pure autonomous scene.
    if (ev.pointerType && ev.pointerType !== "mouse" && ev.pointerType !== "pen") return;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ev.clientX - rect.left;
    pointer.y = ev.clientY - rect.top;
    pointer.active = true;
    clearTimeout(pointer.tid);
    pointer.tid = setTimeout(() => { pointer.active = false; }, POINTER_TIMEOUT_MS);
  }
  function onPointerLeave() { pointer.active = false; }
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  canvas.addEventListener("pointerleave", onPointerLeave, { passive: true });

  // ---------- Theme rehook -----------------------------------------------
  // Theme rehook: re-read tokens; if a transient read yields null (any token
  // temporarily missing), keep the last known good palette rather than
  // repainting in nothing.
  function onThemeChange() {
    const next = readPalette();
    if (next) { colors = next; paletteReads++; }
  }
  document.addEventListener("themechange", onThemeChange);

  // Also watch <html> attribute changes as a fallback for callers not using
  // design/theme.js's CustomEvent bus.
  const mo = new MutationObserver(onThemeChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });

  // ---------- Visibility (pause when hidden) -----------------------------
  function onVisibility() {
    if (document.hidden) stop();
    else start();
  }
  document.addEventListener("visibilitychange", onVisibility);

  // ---------- Reduced-motion (runtime toggle) ----------------------------
  // A user can flip the OS-level 'Reduce motion' switch after boot; the boot
  // gate in shouldRunCanvas() only samples once, so we observe changes here
  // and degrade to poster the instant the preference flips ON. [a11y/ADR-0003]
  const rmq = typeof matchMedia === "function"
    ? matchMedia("(prefers-reduced-motion: reduce)")
    : null;
  function onReducedMotion() {
    if (rmq && rmq.matches) degrade("reduced-motion");
  }
  if (rmq) {
    if (rmq.addEventListener) rmq.addEventListener("change", onReducedMotion);
    else if (rmq.addListener) rmq.addListener(onReducedMotion); // legacy Safari
  }

  // ---------- rAF loop ---------------------------------------------------
  function start() {
    if (running || degraded) return;
    running = true;
    lastFrame = performance.now();
    if (!sceneStart) sceneStart = lastFrame;
    rafId = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function frame(now) {
    if (!running) return;
    const dt = now - lastFrame;
    lastFrame = now;

    // Perf watchdog — track frametimes but ignore the first WATCHDOG_GRACE_MS.
    const elapsed = now - sceneStart;
    if (elapsed > WATCHDOG_GRACE_MS) {
      // p50 rolling window.
      frameMs[frameHead] = dt;
      frameHead = (frameHead + 1) % FRAME_WINDOW;
      if (frameCount < FRAME_WINDOW) frameCount++;
      // Cheap median: only compute when window is full; every 30 frames.
      if (frameCount === FRAME_WINDOW && (frameHead % 30) === 0) {
        // Copy + sort; 60 elements is trivial.
        const buf = Array.from(frameMs).sort((a, b) => a - b);
        const p50 = buf[30];
        if (p50 > P50_BUDGET_MS) return degrade("p50");
      }
      // 500ms mean window.
      if (!win500Start) win500Start = now;
      win500Sum += dt; win500Count++;
      if (now - win500Start >= 500) {
        const mean = win500Sum / win500Count;
        if (mean > MEAN500_BUDGET_MS) return degrade("win500");
        win500Sum = 0; win500Count = 0; win500Start = now;
      }
    }

    render(now, dt);
    framesDrawn++;
    rafId = requestAnimationFrame(frame);
  }

  function degrade(reason) {
    if (degraded) return;
    degraded = true;
    stop();
    // Fade the canvas out by removing the .is-canvas-ready flag; the CSS
    // transition brings the poster back. Remove the canvas after transition.
    if (bg && bg.classList.contains("is-canvas-ready")) {
      const onEnd = () => {
        canvas.removeEventListener("transitionend", onEnd);
        try { canvas.remove(); } catch {}
      };
      canvas.addEventListener("transitionend", onEnd, { once: true });
      bg.classList.remove("is-canvas-ready");
    }
    if (bg) bg.setAttribute("data-hero-state", "poster");
    // Telemetry ping — align with app.js's 'telemetry' CustomEvent bus.
    document.dispatchEvent(new CustomEvent("telemetry", {
      detail: { kind: "hero.degraded", reason },
    }));
  }

  // ---------- Render ------------------------------------------------------
  // `dtMs` is optional (undefined on the boot-time static frame). We clamp it
  // to a plausible frame window so a tab-restore doesn't blast the decay.
  function render(now, dtMs) {
    const t = (now - sceneStart) / 1000; // seconds since first frame
    const dtSec = Math.min(0.05, Math.max(0.001, (dtMs == null ? 16.7 : dtMs) / 1000));

    // Sweep phase.
    const tSweep = t % SWEEP_CYCLE;
    let sweepR = 0, ringAlpha = 0, sweepActive = false;
    if (tSweep < SWEEP_HOLD_END) {
      sweepActive = true;
      const Rmax = 1.4; // diagonal of the [0,1] canvas in normalized units
      if (tSweep < SWEEP_EXPAND) {
        const u = tSweep / SWEEP_EXPAND;
        sweepR = Rmax * (1 - Math.pow(1 - u, 4)); // ease-out-quart
      } else {
        sweepR = Rmax;
      }
      ringAlpha = Math.max(0, 0.4 * (1 - tSweep / SWEEP_HOLD_END));
    }

    // Update pointer drift (spring relaxation each frame).
    if (pointer.active) {
      for (let i = 0; i < active.length; i++) {
        const nx = active[i][0] * cssW;
        const ny = active[i][1] * cssH;
        const dx = pointer.x - nx;
        const dy = pointer.y - ny;
        const d = Math.hypot(dx, dy);
        if (d < POINTER_RADIUS) {
          const falloff = 1 - d / POINTER_RADIUS;
          s.offX[i] += falloff * dx * 0.06;
          s.offY[i] += falloff * dy * 0.06;
        }
        s.offX[i] *= 0.88;
        s.offY[i] *= 0.88;
      }
    } else {
      for (let i = 0; i < s.offX.length; i++) {
        s.offX[i] *= 0.88;
        s.offY[i] *= 0.88;
      }
    }

    // Update sweep lighting (band-pass + exponential decay using real dt).
    const decay = Math.exp(-dtSec / AFTERGLOW_TAU);
    if (sweepActive) {
      for (let i = 0; i < active.length; i++) {
        const dx = active[i][0] - active[0][0];
        const dy = active[i][1] - active[0][1];
        const d = Math.hypot(dx, dy);
        const bandpass = Math.max(0, 1 - Math.abs(sweepR - d) / 0.04);
        // Rise instantly to bandpass value; decay otherwise.
        if (bandpass > s.lit[i]) s.lit[i] = bandpass;
        else s.lit[i] *= decay;
      }
    } else {
      for (let i = 0; i < s.lit.length; i++) s.lit[i] *= decay;
    }

    // ---- Draw ------------------------------------------------------------
    // 1. Clear with panel bg (opaque — avoids ghosting from previous frames).
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    // 2. Edges — single stroked path, batched. Per-edge opacity variance
    // requires per-edge strokes, but we skip that: baseline opacity + a
    // second pass for lit edges keeps state changes to 2. [bytes/perf]
    ctx.strokeStyle = colors.edge;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    for (let e = 0; e < edges.length; e += 2) {
      const a = edges[e], b = edges[e + 1];
      ctx.moveTo(active[a][0] * cssW + s.offX[a], active[a][1] * cssH + s.offY[a]);
      ctx.lineTo(active[b][0] * cssW + s.offX[b], active[b][1] * cssH + s.offY[b]);
    }
    ctx.stroke();

    // Second pass: any edge whose endpoint is lit gets an accent overlay.
    ctx.strokeStyle = colors.accent;
    ctx.beginPath();
    let anyLit = false;
    for (let e = 0; e < edges.length; e += 2) {
      const a = edges[e], b = edges[e + 1];
      const l = Math.max(s.lit[a], s.lit[b]) * 0.6;
      if (l < 0.05) continue;
      ctx.globalAlpha = Math.min(0.9, l);
      // Individual stroke per lit edge — sacrifice a batch for correctness.
      // Fewer than a dozen lit edges at a time in practice.
      ctx.beginPath();
      ctx.moveTo(active[a][0] * cssW + s.offX[a], active[a][1] * cssH + s.offY[a]);
      ctx.lineTo(active[b][0] * cssW + s.offX[b], active[b][1] * cssH + s.offY[b]);
      ctx.stroke();
      anyLit = true;
    }
    if (!anyLit) ctx.globalAlpha = 1;

    // 3. Sweep ring.
    if (sweepActive && ringAlpha > 0.01) {
      ctx.globalAlpha = ringAlpha;
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      // sweepR is in normalized [0,1] units — scale by hero diagonal so the
      // ring reads circular even on wide viewports.
      const scale = Math.hypot(cssW, cssH);
      ctx.arc(rootCanvasX, rootCanvasY, sweepR * scale * 0.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 4. Nodes.
    ctx.globalAlpha = 1;
    for (let i = 0; i < active.length; i++) {
      const n = active[i];
      const kind = n[3];
      const size = n[2] | 0;
      const r = RADIUS[size];

      // Pulse envelope.
      const period = kind === KIND_STD ? PULSE_STD : PULSE_HOT;
      const phi = (i * 0.618) % 1;
      const pulse = 0.85 + 0.15 * Math.sin(t * 2 * Math.PI / period + phi * 2 * Math.PI);

      // Alpha and color per lit.
      const l = s.lit[i];
      const alpha = Math.min(1, pulse * (1 - l) + 1.0 * l);
      let fill;
      if (kind === KIND_DANGER) fill = colors.danger;
      else if (kind === KIND_ROOT) fill = colors.accent;
      else fill = l > 0.15 ? colors.accent : colors.idle;

      const x = n[0] * cssW + s.offX[i];
      const y = n[1] * cssH + s.offY[i];

      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- Boot the scene ---------------------------------------------
  pickActive();
  measure();
  resetScratch();
  // Paint an immediate static frame so the canvas fade-in reveals content,
  // not a blank rectangle. `now = performance.now()` keeps timing coherent.
  sceneStart = performance.now();
  render(sceneStart);
  // Fade the canvas in — the poster stays visible for LCP-stable paint,
  // then the canvas takes over on next frame. `is-canvas-ready` triggers the
  // CSS opacity transition in style.css.
  if (bg) {
    bg.classList.add("is-canvas-ready");
    bg.setAttribute("data-hero-state", "running");
  }
  start();

  // ---------- Cleanup ----------------------------------------------------
  function destroy() {
    stop();
    if (ro) ro.disconnect();
    mo.disconnect();
    window.removeEventListener("resize", onResize);
    window.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    document.removeEventListener("themechange", onThemeChange);
    document.removeEventListener("visibilitychange", onVisibility);
    if (rmq) {
      if (rmq.removeEventListener) rmq.removeEventListener("change", onReducedMotion);
      else if (rmq.removeListener) rmq.removeListener(onReducedMotion);
    }
    clearTimeout(pointer.tid);
    if (bg) {
      bg.classList.remove("is-canvas-ready");
      bg.setAttribute("data-hero-state", "poster");
    }
    try { if (window.__hero === handle) delete window.__hero; } catch {}
  }

  // Testability handle — documented in tests/hero.spec.js contract. Only the
  // four fields listed there are guaranteed API; everything else is internal.
  const handle = {
    get state() { return degraded ? "poster" : (running ? "running" : "poster"); },
    get frames() { return framesDrawn; },
    get paletteReads() { return paletteReads; },
    destroy,
  };
  try { window.__hero = handle; } catch {}

  return { destroy };
}
