# ADR 0002 — Build tooling: defer the bundler until it pays for itself

Status: Accepted
Date: 2026-07-14
Deciders: Uday Ojha

## Context

`oj-uday.github.io` today has no build step. `index.html`, `style.css`,
and `app.js` are hand-authored, checked in as-is, and served literally
by GitHub Pages via the push-to-main workflow at
`.github/workflows/pages.yml`. Total shipped weight is ~83 KB. There is
no `package.json`, no `node_modules`, no lockfile, no bundler config,
no CSS preprocessor. `app.js` is a single IIFE that opens with the
comment "Hand-written IIFE. No frameworks, no bundler." That is not
decoration — it is the pitch. The site's ethos *is* the artefact.

ADR 0001 committed to a `design/` folder that hosts tokens,
primitives, and a `/styleguide` route, consumed by this portfolio and
(later) by a sibling `vetlock.dev` build. That folder needs a shape
that is authored the same way regardless of whether a bundler
processes it or a browser fetches it raw.

The packet §7 anticipates "likely a light build step (Vite) for the
design system, hero canvas/WebGL module, image optimization,
styleguide route — while keeping output as static files." §0.6 fixes
the boundary: "zero runtime dependencies stays a value. Build-time
tooling is fine." So the question is not "bundler forever" vs "never a
bundler." It is: **when.**

Concretely, we have to decide this now, at P0, because the design
system's authoring conventions — what CSS features are allowed, what
JS import syntax is allowed, how the styleguide route resolves paths —
are set here and would be expensive to reverse later.

Constraints that bind the decision:

- Zero runtime dependencies (packet §0.6). Whatever is shipped is
  browser-native; no shim, no polyfill loader, no framework.
- Progressive enhancement (packet §0.5). Core content must render
  and be usable with JS disabled.
- Hard perf/a11y budgets (packet §4): Lighthouse perf ≥ 95 mobile,
  a11y ≥ 98, LCP < 2s on slow-4G, < 200 KB gz first view.
- No external CDN (packet §6). Whatever we depend on at authoring
  time is either vendored or self-hosted.
- The hand-authored ethos is the flex. A framework is a smell unless
  it pays for itself in observable outcomes.

## Decision

**Adopt option (c): defer bundler adoption. Ship P0 without a build
step. Introduce Vite (or a minimal esbuild pipeline) only when
concrete authoring pain appears — not before.**

Concretely:

1. **P0 through P6 default to no build step.** The design system is
   authored as plain `.css` and native ES module `.js` files under
   `design/`. `index.html` loads them directly via `<link
   rel="stylesheet">` and `<script type="module">`. The `/styleguide`
   route is a second static HTML file that loads the same design
   assets from the same paths. GitHub Pages continues to serve the
   repo root literally.

2. **A dev-only `package.json` may exist at the repo root.** It hosts
   `playwright`, `@axe-core/playwright`, `lighthouse`, and any other
   *measurement* or *test* tooling. Nothing in it ends up in the
   deployed artefact. `.github/workflows/pages.yml` is not modified;
   the deploy still uploads the repo root, not a `dist/`. `node_modules/`
   is `.gitignore`d.

3. **The design system is authored to survive both modes.** No CSS
   preprocessor syntax, no SCSS-only features, no `@use` / `@mixin`,
   no CSS-modules-style local scoping. Only native CSS: custom
   properties, `@import` (used sparingly for a single tokens →
   primitives entry chain), `@media`, `color-mix`, `@layer` if
   needed. On the JS side: only browser-native ES modules with
   relative paths, no bare specifiers, no import-map hackery. This
   way, dropping a bundler in later is purely additive — same source,
   different output.

4. **The bundler adoption trigger is stated, not vague.** Any one of
   the following, observed and demonstrated, moves us to Vite:

   - The design system exceeds ~3 authored JS modules that a single
     page needs, *and* the aggregate HTTP-cost of loading them
     individually measurably violates the LCP budget on slow-4G in a
     Lighthouse run recorded in `docs/BUDGETS.md`.
   - The hero WebGL/canvas scene (P2) grows past a hand-minifiable
     size such that its uncompressed transfer regresses the
     < 200 KB gz first-view budget. Threshold: any single hand-
     authored JS asset > 40 KB gz shipped to first paint.
   - A second visualization (P4-ish) needs to share modules with the
     hero scene and the duplication becomes real. "Two visualizations
     share one utility module" is not yet a reason; "three
     visualizations share four utility modules and the load waterfall
     shows it" is.
   - Image asset variants (AVIF + WebP + JPEG fallback, multiple
     widths for `srcset`) are needed and hand-managing them starts
     costing edits.

   Absence of *all* four means no bundler. If we hit one, we add
   Vite for the affected surface only — not for `app.js`, not for
   `index.html`, not retroactively.

5. **When Vite arrives, it arrives with an ADR.** ADR 0003+ will
   document what changed, what triggered it, and what the output
   contract is with GitHub Pages. This ADR is not a promise the
   bundler comes later; it is a promise the decision is not made now.

6. **The `worker/` folder is untouched by this ADR.** The Cloudflare
   Worker has its own `wrangler.toml` and its own deploy path. Its
   build story is decided elsewhere (it is a Worker, not a front-end
   asset).

## Alternatives considered

### (a) Stay hand-authored forever, no build step, ever — REJECTED

The purest version of the ethos, and tempting because the current
site is 83 KB and ships in one push. But this position doesn't
survive contact with the packet's own P2 (hero canvas/WebGL) and P4
(multiple visualizations). Concrete objections:

1. **The trigger conditions are real.** A WebGL scene serious enough
   to be worth showing on the hero is not a hand-minifiable
   artefact. Once shaders, geometry, and interaction wiring are in
   play, "one big authored file" starts to lose to "several small
   authored files bundled at build time" on both authoring
   ergonomics and network cost. Refusing to adopt tooling then, for
   ideology, would sacrifice the perf budget — which the packet
   marks as a hard gate, not a nice-to-have.
2. **Image variants are drudgery, not craft.** AVIF/WebP/JPEG
   ×  multiple widths managed by hand is the kind of work that
   *should* be a build step. Hand-authoring it is not a flex; it is
   an error surface.
3. **"No bundler ever" bakes in a decision the future has better
   evidence to make.** ADR 0001 already deferred packaging until a
   second consumer exists. The same discipline applies here: don't
   pre-commit to "never" when "not yet" is available.

The ethos we are protecting is *zero runtime dependencies*, not
*zero build-time tooling*. Those are different rules. Conflating
them turns a value into a superstition.

### (b) Adopt Vite immediately in P0 — REJECTED

The packet's phrasing ("likely a light build step (Vite)") makes this
option feel default. It is not default. Objections:

1. **Nothing in P0 requires it.** The P0 done-gates are: styleguide
   renders both themes, tokens are the single source of truth,
   theme toggle persists, budgets baseline recorded. All four can
   be achieved with plain `.css` and native `<script type="module">`.
   Adopting Vite to do work Vite is not currently needed for is a
   framework tax paid on speculation.
2. **A build step in P0 pollutes the deploy story.** Right now the
   pipeline is: push to main → GitHub Pages serves the repo. That
   is 30 lines of workflow and no failure surface. Introducing a
   Vite build means the workflow now has an `npm ci && npm run
   build` step, a `dist/` upload target, and Node version pins —
   all before there is any evidence they are necessary. Every added
   pipeline step is a place a P0 deploy can fail.
3. **It weakens the story the site tells about itself.** "This
   portfolio is hand-authored, ~83 KB, zero deps, no bundler" is a
   specific, checkable claim. Trading it away in exchange for
   "someday we'll need Vite for the WebGL scene" is a bad exchange
   at the P0 stage — we pay the credibility cost now for a benefit
   that arrives in P2 at the earliest.
4. **Vite defaults nudge the authoring shape.** `import.meta.env`,
   `import.meta.glob`, CSS-modules, virtual modules — none of these
   are dependencies of the design system, but once the bundler is
   in place, contributors (including future me) reach for them.
   Deferring the bundler forces the design system to be authored in
   the more portable subset by default.
5. **It preempts ADR 0001's cadence.** ADR 0001 said "vendor
   `design/` by copy for now." Adopting Vite in P0 would push us
   toward publishing to npm faster than the second-consumer signal
   justifies, because the tooling suddenly makes it easy.

Vite is the right answer *eventually*, for specific reasons.
Choosing it now means choosing it without those reasons.

### (d) Introduce a minimal esbuild pipeline instead of Vite — DEFERRED, NOT REJECTED

Between "no build" and "Vite" there is a middle ground: a ~20-line
`esbuild` invocation that concatenates and minifies specific
entrypoints. It is intentionally not chosen in this ADR because it
also is not needed at P0; the trigger conditions for adopting *any*
bundler apply to esbuild too. When a bundler is warranted, ADR 0003+
will choose between Vite and esbuild on the merits at that time. The
authoring conventions in this ADR (native CSS, native ES modules,
relative paths) are compatible with both.

## Consequences

Accepting (c) forces the following, and this ADR is the contract:

1. **`design/` is authored in browser-native CSS and ES modules
   only.** No SCSS, no `@use`, no `@mixin`, no CSS-modules,
   no bare-specifier imports, no import maps. Every asset under
   `design/` can be opened in a browser directly and works. This
   keeps the "raw-served today, bundler-served tomorrow" property
   real, not aspirational.

2. **`index.html` and the `/styleguide` HTML load design assets by
   relative path.** No path aliases, no `@/` prefixes, no build-time
   substitutions. If a bundler is adopted later, it can rewrite
   these; but authored, they resolve in the browser as-is.

3. **A dev-only `package.json` is permitted at repo root.** It
   declares `playwright`, `@axe-core/playwright`, `lighthouse`, and
   friends as `devDependencies`. It has no `dependencies`. It has
   no `build` script that emits a `dist/`. `.gitignore` lists
   `node_modules/`. The GitHub Pages workflow does not run `npm
   install` or `npm run build`; it uploads the repo root exactly as
   it does today.

4. **Playwright and Lighthouse are dev-only measurement tools.**
   They exist to enforce the perf and a11y budgets in CI. They do
   not ship. Nothing in `playwright/` or `.lighthouseci/` (or wherever
   they land) is referenced by `index.html`.

5. **Every JS module in `design/` uses `<script type="module">`.**
   `app.js` remains a classic script for now (its IIFE opening
   comment is a load-bearing claim). New modules — theme toggle,
   styleguide harness, future hero scene — are modules from the
   start, so that the eventual bundler adoption doesn't have to
   convert them.

6. **`docs/BUDGETS.md` records the baseline WITHOUT a build step.**
   The perf/a11y numbers in the baseline are for the raw-served
   configuration. When a bundler is later adopted, the ADR that
   adopts it must show, in the same document, that the new
   configuration hits the same or better numbers. A bundler that
   regresses the budget is not adopted.

7. **The bundler trigger conditions in Decision §4 are the rule.**
   Adopting a bundler for aesthetic reasons ("it feels professional",
   "Vite is nice"), for speculative reasons ("we'll need it soon"),
   or for cargo-culted reasons is not permitted by this ADR. The
   trigger is observed pain with a measurement attached.

8. **This ADR is revisited when any trigger fires.** At that point
   we write ADR 0003+ that chooses the tool, states the surface it
   applies to, and documents the deploy-workflow changes. Until
   then, this ADR stands.

## Notes

- The "no build step" position is compatible with the packet's §7
  wording. Read carefully: §7 says "*likely* a light build step
  (Vite)". Likely is not "immediately". This ADR interprets the
  packet as: the door is open, walk through when there is a reason.
- The zero-runtime-deps rule (packet §0.6) is not weakened by
  eventually adopting Vite. Vite is build-time. What it emits is
  still framework-free, dependency-free, static.
- ADR 0001 committed `design/` to be vendored by copy into
  `vetlock.dev`. That commitment is easier to honor if `design/` has
  no build step of its own: the sibling repo copies `.css` and
  `.js` files that work. Adopting Vite here later means either
  publishing to npm (revisiting ADR 0001's packaging clause with
  evidence) or committing built output — both are decisions to make
  when they arrive.
- The employer-argus commit hooks referenced in the packet's rule
  §0.1 are unrelated to this ADR. They are bypassed at commit time
  via `-c core.hooksPath=/dev/null`, not via any build tooling.
- If a future contributor (including me) is tempted to `npm install
  vite` "just to see", this ADR is the answer: not until a trigger
  in Decision §4 fires. Write the ADR that supersedes this one
  first.
