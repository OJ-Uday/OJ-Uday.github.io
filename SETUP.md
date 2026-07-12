# SETUP.md — deploying the vetlock scanner backend

This site's [Scan a lockfile](https://oj-uday.github.io/#scan) feature runs a real vetlock analysis on GitHub Actions and reports back in-page. It needs one small Cloudflare Worker to relay between the browser and GitHub. Total setup: ~5 minutes.

## Prereqs (one-time)

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier)
- Node.js 20+ locally
- [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) CLI: `npm i -g wrangler`

## 1 — Create a GitHub fine-grained PAT

Go to https://github.com/settings/personal-access-tokens/new

- Token name: `vetlock-scan-worker`
- Resource owner: `OJ-Uday`
- Repository access: **Only select repositories** → `OJ-Uday/vetlock-web-scans`
- Repository permissions:
  - **Actions**: `Read and write`
  - **Metadata**: `Read` (mandatory)
- Expiration: 1 year

Save the token — you'll paste it in the next step.

## 2 — Deploy the Worker

```bash
cd worker/
wrangler login                          # browser OAuth
wrangler secret put GH_DISPATCH_TOKEN   # paste the PAT from step 1
wrangler deploy
```

wrangler will print a URL like `https://vetlock-scan.YOUR-SUBDOMAIN.workers.dev`. Copy that URL.

## 3 — Wire the site

Open `app.js`, find:

```js
const SCAN_ENDPOINT =
  (window.__VETLOCK_SCAN_ENDPOINT__) ||
  "https://vetlock-scan.oj-uday.workers.dev";
```

Replace the default URL with your worker's URL. Commit + push.

## 4 — Verify

Visit https://oj-uday.github.io/#scan, click **Try malicious (Shai-Hulud fixture)**, then **Run vetlock scan**. Within ~25 seconds you should see 13 BLOCK findings rendered in-page.

If it doesn't work, in this order:

```bash
# Is the Worker reachable?
curl -sf https://vetlock-scan.YOUR-SUBDOMAIN.workers.dev/health
# → { "ok": true, ... }

# Can the Worker dispatch to GH? (corpus mode = smallest possible test)
curl -X POST https://vetlock-scan.YOUR-SUBDOMAIN.workers.dev/scan \
  -H 'Content-Type: application/json' \
  -d '{"corpus_id":"shai-hulud-2025"}'
# → { "scanId":"...", "statusUrl":"/scan/..." }

# Did the workflow actually run?
gh run list -R OJ-Uday/vetlock-web-scans -L 3

# Did results/<scanId>.json land?
gh api repos/OJ-Uday/vetlock-web-scans/contents/results/<scanId>.json
```

## Costs

$0/month. The whole stack is on free tiers:

- Cloudflare Workers: 100 K reqs/day
- GitHub Actions on public repo: unlimited minutes
- Content storage: results are ~1 KB each, cleaned up daily

## Kill switch

If someone abuses the endpoint or you want to take it down:

```bash
# Revoke the PAT: github.com/settings/tokens
# — the Worker's next dispatch call will 401 and every scan will fail closed.

# OR: rate-limit to 0
# Edit worker/worker.js: `RATE_LIMIT_N = 0;` → wrangler deploy

# OR: delete the Worker outright
wrangler delete vetlock-scan
```
