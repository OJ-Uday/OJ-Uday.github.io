# ADR 0003 — Hero visualization tech

- Status: Accepted
- Date: 2026-07-14
- Deciders: Uday Ojha
- Phase context: P0 (design-system foundations) records this decision; P2 implements against it.
- Related: ADR 0001 (site topology), ADR 0002 (design tokens), packet §2, §4, §6, §7.

## Context

The hero at `/` needs a "watcher" motif — a small, tasteful visualization that pays for the "awe" beat the packet asks for (§2) without violating the site's other hard rules:

- **Zero runtime dependencies is a value** (packet §0.6). Build-time tooling is fine; a bundled framework in the critical path is not.
- **Progressive enhancement** — core content usable with JS off (§0.5).
- **Perf budgets are HARD gates** (§4): Lighthouse perf ≥ 95 mobile, a11y ≥ 98, LCP < 2s on slow 4G, < 200 KB gzipped first view.
- **No external CDN** (§6).
- **Hand-authored ethos is the flex** (§7); a framework or engine is a smell unless it pays for itself.

The current site (see the P0 audit) is ~83 KB total, hand-authored, and ships one `<script src="app.js">` and one `<link rel="stylesheet">`. There is no build step. The hero today is static markup + a decorative telemetry console. There is nothing on the page called "the watcher" yet.

Packet §7's last bullets are prescriptive about the render tech: prefer **Canvas 2D**, allow WebGL only if it clears the perf budget with clean degradation, and always ship a **static SVG poster** for reduced-motion + low-power devices. This ADR ratifies that guidance and pins the specific triggers, budgets, and a11y contract so P2 has no ambiguity.

## Decision

### 1. Renderer: Canvas 2D, hand-authored, primary. WebGL deferred.

The hero watcher is a **bespoke Canvas 2D scene**, hand-authored as a single small module. **No three.js, no pixi, no regl, no p5** — the ethos is the flex, and none of those pay for their weight on a ~200 KB total budget.

**WebGL is DEFERRED**, not banned. It is reconsidered at the P2 done-gate if, and only if:

1. Canvas 2D cannot hold 60 fps on a mid-tier laptop (baseline: 2020-era MacBook Air, throttled 4× CPU in DevTools), **AND**
2. A specific visual effect that materially advances the "awe" thesis is impossible or ugly in Canvas 2D and clean in WebGL, **AND**
3. The WebGL variant still clears every gate in §4 (LCP, perf score, a11y score, JS budget below), **AND**
4. The WebGL variant degrades to the same static SVG poster (§2 below) on init failure, reduced motion, or the low-power heuristic (§5 below).

If those four conditions are not all met, Canvas 2D stands. WebGL is not a default; it is an escape hatch with a checklist.

### 2. Static SVG poster fallback ALWAYS ships alongside; the poster is the LCP element.

An inline `<svg>` "poster" — a still frame of the watcher, hand-drawn, hinted to sit on the token palette — **always ships**. It is not a placeholder; it is the fallback path for every degradation branch (§5).

- The poster is **inlined in the initial HTML response** (no separate request; not a `<link rel="preload">` dance) so it is paintable on the first HTML paint.
- The poster is the **LCP element** for the route. The Canvas 2D scene is **lazy-loaded** (JS fetched after `load` via a small init script, or on `requestIdleCallback` with a `setTimeout` fallback) so it never competes with LCP.
- When (and only when) the canvas scene has initialized and rendered its first frame successfully, the canvas fades in on top of the poster (opacity crossfade, one `--duration-slow` step) and the poster is marked `aria-hidden="true"` if it was ever visible to AT (see §4).
- If any degradation branch fires, the canvas never mounts, the poster stays visible, and it is the final frame — not a loading state.

This design has three properties worth naming:

- **LCP is deterministic** and lives in HTML, not JS. Slow-4G LCP < 2s is achievable because the LCP candidate is bytes already on the wire.
- **JS-off users see the poster and it looks intentional.** Progressive enhancement is satisfied by construction, not by feature detection.
- **The scene can be as ambitious as it wants** because it is not on the LCP critical path.

### 3. Budget for the hero module: < 60 KB gzipped JS.

The hero's JS module (renderer + scene + init + degradation logic combined) must be **≤ 60 KB gzipped**, measured on the deployed asset. This is a hard gate at P2's done-gate; a scene that overshoots is cut back, not shipped.

Corollaries:

- No 3D math library. If a vector or matrix helper is needed, it is 20 lines of hand-authored code, not a dependency.
- No easing library. One easing curve is exposed as a design token (see Consequences, §D0); the scene uses that curve and, if strictly necessary, hand-authored variations (e.g. an `easeOutCubic` written inline).
- No animation runtime. `requestAnimationFrame` + a delta-time loop is the entire scheduler.
- The 60 KB includes the poster's SVG source **only if** the poster is authored as a JS-emitted string; if the poster is inlined in `index.html` (the recommended path), it counts against the HTML budget, not the JS budget.

### 4. Accessibility: canvas is `aria-hidden`, description lives in adjacent DOM.

- The `<canvas>` element is `aria-hidden="true"` and has no `role`. Canvas pixels are not accessible content; pretending otherwise is worse than admitting it.
- An **adjacent DOM element** (visible copy, or `.sr-only` if the visual reads for itself) carries the description of what the watcher represents. This element is a sibling of the canvas inside the hero landmark and is present in the initial HTML — it does not depend on JS.
- Focus never lands on the canvas. There is no `tabindex="0"` on it. The watcher is decorative-with-meaning; the meaning is in the adjacent text, not in the pixels.
- The poster `<svg>` gets `role="img"` and an `<title>` child with the same short description; when the canvas mounts on top, the poster is flipped to `aria-hidden="true"` (only one description should be exposed at a time).
- `prefers-reduced-motion` behavior is defined in §5.

### 5. Degradation triggers — tested explicitly, not "should work".

The hero mounts the Canvas 2D scene **only if all** of the following are true. Any single failure keeps the static poster.

| Trigger | Check | Behavior |
|---|---|---|
| Reduced motion | `window.matchMedia('(prefers-reduced-motion: reduce)').matches` | poster only; canvas never mounts |
| Low memory | `navigator.deviceMemory !== undefined && navigator.deviceMemory <= 2` | poster only |
| Low core count | `navigator.hardwareConcurrency !== undefined && navigator.hardwareConcurrency <= 2` | poster only |
| Canvas init failure | `canvas.getContext('2d')` returns null, or a first-frame draw throws | poster only, remove the canvas node |
| JS disabled | (implicit — module never runs) | poster only |
| `Save-Data` header hint | `navigator.connection?.saveData === true` | poster only |

Notes:

- The `deviceMemory` and `hardwareConcurrency` checks use `<=` intentionally: 2 GB / 2 cores is a legitimate low-end device, not an edge case.
- The low-power heuristics use `!== undefined` guards because both APIs are not on every browser; a missing signal is treated as "capable", not "incapable", to avoid punishing privacy-hardened browsers that hide the value.
- **Every trigger has an automated test in P2's verification pass** — the P2 verification checklist enumerates them and asserts the poster is what the user sees. "It should degrade" is not a verification; a test is.

### 6. Bespoke scene, no 3D or 2D engine.

Per packet §7 ("hand-authored ethos is the flex"), the scene is written as one small module of `renderer.js` + `scene.js` (or a single file — cheaper is better). No **three.js**, no **pixi.js**, no **regl**, no **p5.js**, no **anime.js**, no **gsap**. If a helper is unavoidable it is < 30 lines and lives in the same file.

This is not asceticism for its own sake. Every one of those libraries is 40–600 KB gzipped and pulls in an animation runtime the scene does not need. A hand-authored 2D scene at < 60 KB tells a stronger story about the author on a portfolio than the same scene using three.js at 200 KB.

## Consequences

### For P0 (this phase) — tokens the hero will need

P0 does **not** build the hero. P0 **does** need to expose the tokens the hero will consume so P2 is a pure-implementation phase with no design-system detours. The following must be present in `style.css` at the end of P0:

- **Accent colors**: `--accent`, `--accent-2`, `--accent-dim`, `--accent-glow` (already present per the CSS audit — keep the names). The scene reads these via `getComputedStyle(document.documentElement).getPropertyValue(...)` on init and on the theme-change event. Do not hardcode hex in the scene.
- **Motion durations**: `--duration-fast` (150 ms), `--duration-normal` (180 ms), `--duration-slow` (500 ms). Named in the CSS audit's "missing token candidates" section — must be added in P0. The scene reads `--duration-slow` for the poster→canvas crossfade and may use the other two for internal transitions.
- **One easing curve**: `--ease` (default). The audit shows the current site uses `ease` uniformly; a single named token is enough. The scene uses this token; there is not a suite of easings.
- **On-accent text**: `--on-accent` (the audit flagged `#06251b` hardcoded in three places). Not directly used by the hero scene, but the hero's CTA sits on accent — depending on this token being real prevents a light-mode contrast regression when the scene is added.

Nothing else in the design system is gated on this ADR. Colors used inside the scene (line/fill/highlight) map to existing accent + text tokens; no scene-only palette is introduced.

### For P2 — done-gate additions

The P2 done-gate must include, in addition to whatever the P2 spec adds:

1. Lighthouse perf ≥ 95 mobile with the canvas scene running (throttled).
2. LCP < 2 s on slow 4G (the poster is the LCP element; this is measured, not assumed).
3. Hero JS module ≤ 60 KB gzipped, measured on deployed assets.
4. All six degradation triggers from §5 have automated tests that assert the poster is the visible artifact.
5. A11y score ≥ 98 with canvas mounted; canvas is `aria-hidden`; adjacent description is present.
6. A **WebGL reconsideration note** — a written yes/no with the checklist from §1. If "yes", it becomes an ADR of its own; this one does not authorize the switch.

### For everything else

- **No CDN, no dependency**: satisfied by construction (§3, §6).
- **PE / JS-off users**: they see the poster, which is intentional design (§2).
- **Theme swap**: the scene reads CSS custom properties at runtime, so a theme change is a property re-read + a redraw, not a re-init.
- **The scanner exhibit** at `#scan` is unaffected — this ADR is about the hero only.

## Alternatives considered

- **WebGL primary (three.js or hand-written).** Rejected. Even hand-written WebGL is a step-change in scene-init complexity and shader/texture surface; it does not clear the packet's "zero runtime dep" flex and it makes LCP harder to defend. Deferred as an escape hatch, per §1.
- **CSS-only animation.** Rejected as primary because the "watcher" motif in the packet is a scene with state, not a decoration. CSS keyframes are still used elsewhere on the site (the pulse dot) and remain the right tool for those; the hero is not one of them.
- **Video (mp4 / webm) loop.** Rejected. A short loop clears the perf budget on paper but fails the "hand-authored flex" test, is expensive to iterate on, and its accessibility story is worse than a canvas + adjacent description.
- **Static SVG only, no canvas ever.** Rejected as the primary shipping state — the packet asks for an "awe" beat, and a still poster does not deliver it — but this is exactly what every degradation branch falls back to, so the outcome for reduced-motion / low-power / JS-off users **is** this option, by design.
- **Lottie / rive.** Rejected. Both pull runtimes (Lottie's is ~40–60 KB gzipped for the light build; rive's WASM is heavier). Both externalize authoring to a tool the site does not otherwise use. Neither pays for its weight.
