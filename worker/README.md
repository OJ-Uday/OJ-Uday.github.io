# Cloudflare Worker — vetlock scan backend

The tiny relay that sits between the portfolio site and the
[vetlock-web-scans](https://github.com/OJ-Uday/vetlock-web-scans) GitHub
Actions workflow. Also serves per-scan Open Graph cards and share-shim
HTML so scan permalinks unfurl correctly on Slack, Discord, LinkedIn,
Twitter/X, and iMessage.

## Endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/scan` | Validate + rate-limit + dispatch the GitHub Actions workflow. Returns `{ scanId }`. |
| `GET`  | `/scan/:id` | Poll the workflow's committed `results/<id>.json`. Returns `202` while pending, `200 { status: "ready", result }` when done. |
| `GET`  | `/og/:id.svg` | Render the scan's verdict card as SVG (dark bg, teal accents, verdict + counts + primary package + wordmark). 24h edge cache. |
| `GET`  | `/og/:id.png` | Best-effort PNG. Currently 302-redirects to the SVG sibling — most social scrapers (Slack, Discord, LinkedIn) render SVG unfurls; a follow-up PR can wire an in-Worker rasterizer for Twitter/X. |
| `GET`  | `/s/:id` | HTML share shim. Fetches the site's canonical HTML, rewrites `og:image` / `og:title` / `og:description` / canonical link, and injects a `<meta http-equiv="refresh">` so humans bounce to `oj-uday.github.io/?scan=<id>`. 5-minute edge cache. Users share this URL; scrapers see the right meta; humans reach the interactive page. |
| `GET`  | `/` or `/health` | `{ ok: true, service, version }` — smoke test. |

**Endpoint characteristics:**

- `POST /scan` and `GET /scan/:id` are CORS-wrapped for the site origin
  (`https://oj-uday.github.io`). The other endpoints are scraper-facing and
  do NOT require CORS.
- `/og/*` and `/s/*` deliberately **skip** the `checkRateLimit()` gate —
  social scrapers pound these when a link goes viral, and rate-limiting
  would break every share. Cloudflare's edge cache (`Cache-Control:
  public, max-age=..., immutable`) prevents runaway origin hits.
- Every dynamic string in the SVG/HTML output is XML-escaped via `xml()`;
  package names are additionally normalized through `sanitizePkg()` before
  landing in a text node. The scan id is regex-validated hex-only at the
  router, so no user text reaches the response paths.

**Zero cost.** Cloudflare Workers free tier is 100 K requests/day. A portfolio
scanner won't touch that ceiling.

## Deploy — MANUAL step

Every merge that touches `worker/` requires a follow-up `wrangler deploy`.
There is no CI wiring for the Worker; the deploy stays under a human's finger.
Call this out in the PR body.

```bash
# From this directory (worker/)
npm install -g wrangler                          # or: brew install cloudflared/tap/wrangler
wrangler login                                   # opens browser, one-time OAuth
wrangler secret put GH_DISPATCH_TOKEN            # paste your fine-grained PAT (see below)
wrangler deploy
```

### Live-npm gate — `ENABLE_LIVE_NPM`

`POST /scan` accepts two shapes: `{ corpus_id }` (bundled fixture) or
`{ before, after }` (raw lockfile bytes → live GitHub Actions dispatch).
The raw-lockfile branch is **gated behind the `ENABLE_LIVE_NPM` env var**
until the startup packet's P1/P2 land — with the flag unset (the default),
the Worker returns `403 { error: "live-npm scanning is gated … use a corpus
fixture" }` for any lockfile payload, and only corpus scans get through.

Ship the P3 deploy with the flag **UNSET**. To flip it on later:

```bash
# In wrangler.toml under [vars], or via the CLI:
wrangler deploy --var ENABLE_LIVE_NPM:true
# Or set it in the Cloudflare dashboard → Settings → Variables.
```

Corpus scans (`{ corpus_id: "shai-hulud-2025" }`) always work regardless of
the flag — those are the safe demo path.

The deploy output prints the live URL, e.g. `https://vetlock-scan.oj-uday.workers.dev`.

Copy that URL into `app.js` (search for `SCAN_ENDPOINT`) if it differs from the
default. Push the site. Done.

### After deploy — smoke checklist

```bash
# Health
curl -s https://vetlock-scan.oj-uday.workers.dev/health

# Scan (corpus fixture)
curl -s -X POST https://vetlock-scan.oj-uday.workers.dev/scan \
  -H 'Content-Type: application/json' \
  -d '{"corpus_id":"shai-hulud-2025"}'

# Wait ~30-60s for the workflow to commit results/<id>.json, then:
curl -s https://vetlock-scan.oj-uday.workers.dev/scan/<id>

# OG card (once the scan is ready)
curl -sI https://vetlock-scan.oj-uday.workers.dev/og/<id>.svg  | head
curl -sI https://vetlock-scan.oj-uday.workers.dev/og/<id>.png  | head    # expect 302

# Share shim — verify og:image is rewritten to /og/<id>.png
curl -s https://vetlock-scan.oj-uday.workers.dev/s/<id> | grep -Ei 'og:(image|title|url)|canonical'
```

## The GitHub PAT

At [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new):

- **Fine-grained**, expires in ~1 year (max)
- **Repository access**: only `OJ-Uday/vetlock-web-scans`
- **Repository permissions**:
  - `Actions` → **Read and write** (needed to `workflow_dispatch`)
  - `Contents` → **Read** (needed to poll result files; actually the raw URL is public so this may not be strictly required, but Cloudflare's fetch may prefer the authenticated path)
  - `Metadata` → **Read** (mandatory for any fine-grained token)

Nothing else. That's the whole blast radius: if the token ever leaks,
someone can only dispatch scan jobs on your own repo. Rotate on schedule.

## Testing locally

```bash
wrangler dev
# then in another shell:
curl -X POST http://127.0.0.1:8787/scan \
  -H 'Content-Type: application/json' \
  -d '{"corpus_id":"shai-hulud-2025"}'

# OG card against a known scan id
curl -sD - http://127.0.0.1:8787/og/deadbeef12345678.svg -o /tmp/og.svg
open /tmp/og.svg
```

## OG palette lives here

The SVG endpoints render into a standalone document — CSS custom properties
in `design/tokens.css` can't resolve there. The Worker keeps a local
`OG_PALETTE` constant that mirrors the semantic-token hex values at their
current resolution. **If `design/tokens.css` changes a color, update
`OG_PALETTE` in `worker.js` in the same PR.** The block is well-commented
and maps each field back to its `--color-*` token.

## Ecosystem detection

`POST /scan` accepts optional `filename_before` / `filename_after` fields
alongside the lockfile text. When present, the Worker infers the ecosystem
from the filenames (`getEcosystem()`) and attaches an `ecosystem` field to
the workflow dispatch inputs:

- `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`
  → `npm`
- `requirements.txt`, `poetry.lock`, `pyproject.toml`, `*.requirements.txt`
  → `pypi`

The current `scan.yml` workflow ignores unknown inputs, so this is backward-
compatible. A follow-up PR against `OJ-Uday/vetlock-web-scans` will branch
the vetlock invocation once vetlock 0.4 supports PyPI + single-artifact scan.

## Ecosystem drift on legacy permalinks

Results committed before P3 don't include an `ecosystem` field. Client-side
`renderResult` and the Worker's OG/shim endpoints both treat a missing
ecosystem as `"npm"` (every pre-P3 scan was npm-only) and log a debug line.
This is safe drift — no user-facing mislabel — and will self-heal as new
scans land with the field set.

## What it protects against

- Anonymous abuse: 3 scans / 60 s per IP via the Workers cache API (free).
  **Only** `/scan` is rate-limited; OG/shim endpoints skip the check because
  they're scraper-facing and edge-cached.
- Oversize payloads: 500 KB per lockfile, 1 MB total request.
- Unknown corpus ids: whitelist matched against the actual fixtures in vetlock.
- Non-JSON payloads: rejected with 415.
- Non-lockfile-shaped strings: rejected with 400 before we spend a workflow run.
- SVG/HTML injection via scan data: every dynamic string is XML-escaped and
  package names are normalized through a strict alphabet.

## What it does NOT protect against

- Anyone determined to burn workflow minutes by rotating IPs. Public repo
  runs are unlimited, but excessive use can still make your Actions dashboard
  noisy. If someone abuses it: disable the token, revoke access, redeploy.
- Malicious lockfiles that try to exploit `pacote`/`tar`/`vetlock` itself. The
  workflow runs in an ephemeral Ubuntu VM with no repo write access outside
  `results/`; blast radius is one commit that gets caught by the diff.
