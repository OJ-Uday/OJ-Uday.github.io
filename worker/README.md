# Cloudflare Worker — vetlock scan backend

The tiny relay that sits between the portfolio site and the
[vetlock-web-scans](https://github.com/OJ-Uday/vetlock-web-scans) GitHub
Actions workflow.

**What it does:**

- `POST /scan` — takes a lockfile pair (or a `corpus_id`), validates size +
  shape, rate-limits per IP, dispatches `scan.yml` on `vetlock-web-scans` with
  the payload as workflow inputs.
- `GET /scan/:id` — polls `raw.githubusercontent.com/.../results/<id>.json`
  and returns the vetlock JSON when it appears.

**Zero cost.** Cloudflare Workers free tier is 100 K requests/day. A portfolio
scanner won't touch that ceiling.

## Deploy

```bash
# From this directory (worker/)
npm install -g wrangler                          # or: brew install cloudflared/tap/wrangler
wrangler login                                   # opens browser, one-time OAuth
wrangler secret put GH_DISPATCH_TOKEN            # paste your fine-grained PAT (see below)
wrangler deploy
```

The deploy output prints the live URL, e.g. `https://vetlock-scan.oj-uday.workers.dev`.

Copy that URL into `app.js` (search for `SCAN_ENDPOINT`) if it differs from the
default. Push the site. Done.

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
```

## What it protects against

- Anonymous abuse: 3 scans / 60 s per IP via the Workers cache API (free).
- Oversize payloads: 500 KB per lockfile, 1 MB total request.
- Unknown corpus ids: whitelist matched against the actual fixtures in vetlock.
- Non-JSON payloads: rejected with 415.
- Non-lockfile-shaped strings: rejected with 400 before we spend a workflow run.

## What it does NOT protect against

- Anyone determined to burn workflow minutes by rotating IPs. Public repo
  runs are unlimited, but excessive use can still make your Actions dashboard
  noisy. If someone abuses it: disable the token, revoke access, redeploy.
- Malicious lockfiles that try to exploit `pacote`/`tar`/`vetlock` itself. The
  workflow runs in an ephemeral Ubuntu VM with no repo write access outside
  `results/`; blast radius is one commit that gets caught by the diff.
