# ADR 0001 — Site topology: portfolio-first, product elsewhere

Status: Accepted
Date: 2026-07-14
Deciders: Uday Ojha

## Context

`oj-uday.github.io` is my personal portfolio. It is hand-authored HTML/CSS/JS
(~83 KB total, zero runtime dependencies, no build step), deployed via a
GitHub Pages push-to-main workflow. The whole point of the site is to show
who I am and how I work — the ethos is the artefact: no framework tax, no
CDN reach-out, progressive enhancement, hard perf/a11y budgets.

Inside this portfolio there is one interactive exhibit — the vetlock live
lockfile scanner (`#scan`). It is real: browser → Cloudflare Worker →
GitHub Actions dispatch → poll → render. It is also the strongest piece of
technical proof on the site. Because it is compelling, there is a
foreseeable temptation to let it eat the site.

Separately, `vetlock` may grow into a product with its own commercial
landing page at `vetlock.dev`. That page will need a marketing narrative
(pricing, features, install, docs) that has nothing to do with me
personally, and it will need to iterate on its own cadence — pivot copy,
run A/B tests, add signup — without pulling the portfolio along for the
ride.

The design tokens, primitives, and the scanner component itself are the
two things both sites will legitimately want to share. Everything else
(narrative, structure, purpose) diverges.

This ADR decides how the two properties relate.

## Decision

**Adopt option (c): separate build entirely, shared design system.**

- `oj-uday.github.io` (this repo) stays a personal portfolio. It is
  primary. The scanner is an exhibit inside it, not its purpose.
- `vetlock.dev`, when it exists, is a separate repository with its own
  deploy pipeline, its own copy, its own analytics, its own release
  cadence.
- Both properties consume the same design system, which lives in this
  repo at `design/` as a self-contained folder (tokens, primitives, a
  small doc/styleguide route). The vetlock.dev repo vendors `design/`
  by copy. P0 does not publish an npm package; a copy is enough, matches
  the zero-dep ethos, and defers the packaging decision until there is
  real evidence a second consumer exists.
- The scanner lives behind a single well-defined component seam — one
  mount point, one JS entry, one CSS surface — so that vetlock.dev can
  drop it in without dragging the portfolio's DOM or narrative with it.

The portfolio's job is to say "here is who Uday is." The product's job is
to say "here is what vetlock is." These are two different jobs and they
get two different buildings.

## Alternatives considered

### (a) Multi-route within this repo (`/portfolio` and `/product`) — REJECTED

Concrete objections:

1. **GitHub Pages doesn't have first-class multi-route SPA support.**
   Making this work well means either adding a router (framework tax I
   have loudly rejected) or leaning on `404.html` redirect tricks that
   break the "core content usable with JS off" rule from the packet.
2. **The domain confuses the narrative.** `oj-uday.github.io/product`
   still lives at *my personal domain*. A commercial product landing at
   my `github.io` subdomain conflates identity with venture, and makes
   the future move to `vetlock.dev` look like a downgrade.
3. **Cadence coupling.** Every product-side experiment — headline
   rewrite, pricing tweak, signup flow — would ship through the same
   push-to-main pipeline as portfolio updates. The perf/a11y budgets on
   this portfolio (Lighthouse perf ≥ 95, a11y ≥ 98, LCP < 2s slow-4G,
   < 200 KB gz first view) then become the product's ceiling too, which
   is fine for a landing page but crushingly restrictive if the product
   ever grows a real app surface (dashboards, auth, docs, an actual
   product).
4. **Analytics and SEO get muddled.** OG tags, JSON-LD `Person` vs
   `Product`, sitemap, `theme-color` — all of these want to disagree
   between the two properties. A single repo forces one truth.

### (b) Product-first landing (product-lands-as-landing-of-portfolio) — REJECTED

Objected to by the packet's prime directive, and reinforced here:

1. **It inverts the audience.** The primary reader of this site is
   someone deciding whether to hire, collaborate with, or refer me.
   Leading with a product landing tells that reader "you're in the
   wrong place."
2. **It couples my personal reputation to product outcome.** If vetlock
   pivots, sunsets, or gets acquired, the portfolio-shaped surface it
   left behind either becomes an awkward tombstone or forces a full
   site rewrite to reclaim the domain for me.
3. **It kills the exhibit framing.** The scanner is powerful *because*
   it appears inside a portfolio — "this person built and shipped this,
   here it is running live." Promoting it to landing-page status
   collapses that context.

### (d) Subpath (`oj-uday.github.io/vetlock`) — REJECTED

Superficially the cheapest option, but the wrong one:

1. **Wrong URL for a commercial product.** A paying customer, a
   security-conscious CTO, or an investor is not going to trust
   `oj-uday.github.io/vetlock` as a place to enter billing details or
   run against their private repositories. The URL itself signals "toy
   project."
2. **No independent DNS, TLS, or headers.** Product pages want their
   own CSP, their own analytics domain, their own error-tracking
   endpoint. Living under my github.io means inheriting whatever I set
   at the top level and being unable to diverge.
3. **Still couples deploy cadence and budgets** — same objection as
   (a)3, just with a shabbier URL.
4. **Future migration is expensive.** Once `oj-uday.github.io/vetlock`
   is indexed and linked, moving it to `vetlock.dev` means 301s I
   control weakly (github.io is not mine at the DNS level), broken
   backlinks, and a rebrand tax I'd rather never pay.

## Consequences

Accepting (c) forces the following, and this ADR is the contract:

1. **`design/` becomes a self-contained folder.** Tokens, primitives,
   and the styleguide route live under `design/` with no upward
   imports into the rest of the portfolio. If a primitive needs
   something from portfolio-specific code, that dependency has to be
   inverted or the primitive is not a primitive. ADR 0002 covers the
   folder shape.
3. **The scanner lives behind one component seam.** One mount element,
   one JS entry, one CSS surface, one contract with the Cloudflare
   Worker. No cross-imports from `app.js` into the scanner's internals
   and vice versa. This is what makes vendoring the scanner into
   `vetlock.dev` a copy operation rather than a rewrite.
4. **The Cloudflare Worker (`worker/`) stays independent of the
   frontend.** Both properties will point at the same Worker; the
   Worker's contract is the API. No portfolio-only assumptions leak
   into it.
5. **Packaging is deferred, not designed away.** For P0, vetlock.dev
   consumes `design/` (and the scanner) by copy. If and when a second
   real consumer materialises, we can publish to npm. The folder
   layout must not be hostile to that future — no top-level
   `portfolio.css` imports inside `design/`.
6. **Portfolio narrative discipline is now a rule, not a taste.**
   Section copy on this site describes what I built, why, and how.
   Marketing copy for vetlock (pricing, "get started", CTAs to sign
   up) does not belong here. If vetlock has news, it links out.
7. **The perf/a11y budgets apply to this repo unmodified.** They no
   longer have to survive a product roadmap; the product roadmap has
   its own house.

## Notes

- P0 does not create `vetlock.dev`. It creates the *conditions* under
  which `vetlock.dev` can be spun up cheaply later — chiefly, a clean
  `design/` seam and a scanner that packages.
- The zero-runtime-deps rule in the packet (§0.6) applies to the
  portfolio's *shipped* bundle. Vendoring `design/` into a sibling
  repo by copy is a build-time / authoring-time act; it does not
  introduce a runtime dependency. This is compatible with (c).
- No external CDN. Shared assets ship from each property's own origin.
- If vetlock.dev is ever hosted from this same GitHub account (e.g.
  `OJ-Uday/vetlock-site`), that is an implementation detail of where
  the sibling repo lives — it does not weaken this ADR. What matters
  is the *build* is separate and the *domain* is separate.
