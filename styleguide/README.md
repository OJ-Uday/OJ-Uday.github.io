# /styleguide

The design-system reference page for the site. Lives at `/styleguide/`.

## What it is

A single self-contained HTML page that renders **every primitive from
`design/primitives.css` and every semantic token from `design/tokens.css`**,
so contributors can:

- see the palette in both themes with **live contrast readouts** vs
  `--color-bg`,
- eyeball the type scale, space scale, radii, shadows, and motion
  durations without opening the tokens file,
- inspect every button / card / tag / badge / code / dialog / section-header
  / nav variant against the real cascade, and
- prove the token system supports **scoped theming** (not just global) via
  the "Compare themes" split view.

If a change to the design system doesn't look right on this page, it isn't
right anywhere else either — treat `/styleguide` as the visual smoke test.

## Structure

Ten numbered sections, using the same `00 —` heading pattern as the main
site:

| # | Section | What it shows |
|---|---------|---------------|
| 01 | Palette | Every semantic color token as a swatch: name, computed value, WCAG contrast ratio vs `--color-bg`. |
| 02 | Type scale | Every `--fs-*` size, rendered in both `--font-sans` and `--font-mono`. |
| 03 | Space scale | `--space-1` .. `--space-12` as horizontal bars. |
| 04 | Radii · shadows · motion | Every `--radius-*`, `--shadow-*`, `--dur-*`, and easing token. |
| 05 | Buttons | `.btn` + `--primary` / `--ghost` / `--danger` and size modifiers. Includes disabled and forced-focus states. |
| 06 | Cards + surfaces | `.card`, `.card--raised`, nested composition, and the surface ramp. |
| 07 | Tags + badges | `.tag`, `.tag--label`, `.chip`, `.badge` variants. |
| 08 | Code + kbd | Block and inline code plus `<kbd>` styling. |
| 09 | Section headers + nav | Both legacy (`.h-idx`) and BEM (`.section-header__idx`) spellings, plus a mini nav. |
| 10 | Dialog | Native `<dialog>` styled by the `.dialog` primitive. |

## Live theme controls

Two icon buttons live in the top-right of the nav:

- **Theme toggle** (`[data-theme-toggle]`) — wired by `design/theme.js`.
  Flips the effective theme; persists to `localStorage['uday.theme']`.
  Keyboard shortcut: press <kbd>T</kbd> anywhere outside a text input.
- **Compare themes** — mounts a side-by-side split view: the same page,
  scoped `data-theme-scope="dark"` on the left and `data-theme-scope="light"`
  on the right. This proves our semantic tokens are **not tied to `<html>`**
  — the same names cascade correctly into any subtree, so a document could
  render both themes at once (e.g. a diff view, an embedded preview) with no
  primitive changes.

## Loading order

Same as the rest of the site, in this exact order:

1. **Inline FOUC preflight** (`<script>` in `<head>`, first). Reads the
   persisted theme and applies `html[data-theme]` before any CSS parses.
   Source of truth: `design/preflight.js`.
2. `design/tokens.css`.
3. `design/primitives.css`.
4. **Page-local `<style>`** — layout-only rules for the swatch grid, the
   type / space tables, and the compare-view. Every value resolves through
   a `var(--*)`; **no raw hex, no raw motion**.
5. `design/theme.js` as `type="module"` — hydrates the theme toggle
   button, wires the <kbd>T</kbd> shortcut, subscribes to OS-preference
   changes while in `'system'` mode.
6. A second inline module that computes contrast ratios, paints the
   swatches, and wires the "Compare themes" and "Open dialog" buttons.

## Progressive enhancement

The page is designed to be **useful without JS**:

- All primitives render, all sections read, all links work.
- Swatches still show the color chip + token name; only the *computed
  value string* and the *contrast ratio* are JS-populated (they show `…`
  and `–` as placeholders until hydration).
- The theme toggle button is inert until `theme.js` loads. The persisted
  theme is still applied by the inline preflight, so returning users see
  their chosen theme on first paint regardless.
- The "Compare themes" button is inert without JS. The scoped-theme CSS
  is still emitted, so ad-hoc `data-theme-scope` usage in inspector-driven
  demos works fine.

## Contribution rules

- Add a swatch when you add a semantic color token in `tokens.css`.
  Copy an existing `.swatch` block and set `data-token` + the inline
  `--sw-fill` to the new token name.
- Add a section (or extend an existing one) when you add a primitive to
  `primitives.css`. Sections are numbered — pick the next available `NN`.
- Never introduce a hardcoded color, spacing value, radius, or motion
  duration in this file. If you need one, it belongs in `tokens.css`
  first. The single exception is `swatch__chip { height: 96px }` (and a
  handful of similarly labeled "identity" sizes) — layout numbers that
  aren't semantically part of the token system live with an inline
  comment explaining why.
- After changes, page-through `/styleguide` in **both themes** and via
  the compare toggle. If anything jumps or misreads, it's a token bug,
  not a styleguide bug.
