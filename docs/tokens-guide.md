# Design Tokens — Author's Guide

Companion documentation for `design/tokens.css`. The CSS file itself carries
only what a build tool needs; the *why* lives here.

See also:
- ADR 0001 — design-system foundation
- ADR 0002 — theming model

## Why this file exists

Before `tokens.css` existed, `style.css` baked visual decisions into ~119
selectors with 26 `:root` variables, 26 raw hex literals, and 18 raw `rgba()`
calls. Half the light theme silently failed WCAG. Motion had four ad-hoc
durations and three different easing curves. There was no scale.

`tokens.css` collapses that surface into ONE place with THREE layers, plus a
fourth compatibility block:

1. **PRIMITIVES** — the raw palette + numeric scales. Never referenced from
   component CSS; consumed only by semantic tokens below.
2. **SEMANTIC** — role-based names (`--color-bg`, `--color-text`, …) that
   components consume. Themes swap these, not primitives.
3. **COMPONENT** — a thin optional layer (`--btn-primary-bg`, `--card-bg`)
   for cross-cutting patterns.
4. **COMPAT** — re-declares the legacy variable names `style.css` already
   uses (`--bg`, `--panel`, `--accent`, `--shadow`, …) in terms of the new
   semantic tokens. Result: dropping `tokens.css` into the page BEFORE
   `style.css` makes the refactor invisible to `style.css`.

## Theming model

| Selector | Effect |
| --- | --- |
| `:root` | dark defaults (the site's canonical DNA) |
| `:root[data-theme="light"]` | explicit light override |
| `:root[data-theme="dark"]` | explicit dark override (safety no-op) |
| `@media (prefers-color-scheme: light) :root:not([data-theme="dark"])` | follow the OS if the user hasn't chosen |

The `color-scheme` property is declared on both `:root` and the light
overrides so native UA chrome (scrollbars, form controls, autofill) follows
the resolved theme.

## Accessibility

Every text-on-bg pair against `--color-bg` / `--color-surface` passes AA in
both themes; body text pairs pass AAA. Status tokens (`danger` / `warn` /
`info` / `link`) and `--color-accent`, when placed as text on nested raised
surfaces in light mode, ride the AA line — components should default to
painting status text on `--color-bg` / `--color-surface`.

### `--slate-500` — known trade-off

`--slate-500` (`#647585`) preserves the original site DNA. As tertiary text
on `--color-bg` it computes **3.06:1** — AA-large only, not AA-normal.
Callsites therefore MUST NOT paint body text with `--color-text-dim`; it is
reserved for UI chrome (timestamps, meta captions).

The Lighthouse Accessibility score stays at 100 because no rendered text
callsite uses `--color-text-dim` at body-text sizes. A tighter value is
deferred to a follow-up.

### Light-mode brand contrast pins

| Token | Value | Contrast |
| --- | --- | --- |
| `--teal-600` | `#067050` | 5.73 / 5.42 / 4.91 across light surfaces |
| `--teal-700` | `#066b4f` | 5.24 on `--slate-200` |
| `--red-700`  | `#b81e29` | 5.19 on `--slate-200` |
| `--amber-800` | `#7a5100` | 5.63 / 5.91 across light surfaces |
| `--blue-700` | `#0757b3` | 5.59 on `--slate-200` |
| `--teal-950` on `--teal-600` | | 6.10:1 (`--color-on-accent`) |

## Motion

One standard easing curve for 95% of motion. One "emphasized" curve for
dialogs and hero. Four durations. A single `prefers-reduced-motion` block
near the bottom of `tokens.css` flattens every `--dur-*` to ~0ms, so no
per-selector reduced-motion code is needed anywhere else.

## Print

Two extra tokens (`--color-bg-print`, `--color-text-print`) exist so the
`@media print` block in `style.css` flows through the token layer instead
of hard-coding `#fff` / `#000`.

## Layer legend inside `tokens.css`

The file itself keeps small section markers so a maintainer can find each
layer without leaving the CSS:

- `LAYER 1 — PRIMITIVES`
- `LAYER 2 — SEMANTIC TOKENS`
- `LAYER 3 — COMPONENT TOKENS`
- `LAYER 4 — LEGACY-COMPAT SHIMS`

Everything else — rationale, contrast math, dark/light mapping — lives here.
