/**
 * Cloudflare Worker — vetlock lockfile scan backend.
 *
 * Sits between oj-uday.github.io (portfolio site) and the
 * OJ-Uday/vetlock-web-scans repo (GitHub Actions workflow).
 *
 * Endpoints:
 *   POST /scan          → validates payload, generates scan_id, dispatches workflow,
 *                          returns { scanId }
 *   GET  /scan/:id      → polls raw.githubusercontent.com/.../results/<id>.json;
 *                          202 while pending, 200 with {result} when ready
 *   GET  /og/:id.svg    → renders a scan verdict card as SVG (dark bg, teal accents,
 *                          verdict counts, filename, wordmark). Colors sourced from a
 *                          local palette constant that MIRRORS design/tokens.css values.
 *                          Cached at the edge for 24h and rate-limited at 60/min per IP
 *                          (scraper-tolerant — real unfurls are one GET per URL per
 *                          scraper; the ceiling exists purely to cap id-rotation abuse).
 *   GET  /og/:id.png    → best-effort PNG. Uses Cloudflare's image resizing (cf.image)
 *                          to rasterize the SVG when available on the account tier.
 *                          Falls back to a 302 redirect to the SVG variant so a
 *                          scraper still gets *something* rather than a 500.
 *   GET  /s/:id         → HTML share shim. Fetches the site's canonical HTML, rewrites
 *                          the og:image (and twitter:image) meta to point at the
 *                          per-scan OG endpoint, injects a canonical <link> to
 *                          oj-uday.github.io/?scan=<id>, and renders a truthful
 *                          inline summary (verdict + counts + primary package) so
 *                          JS-off scrapers/humans see the real scan result as
 *                          static HTML. Edge-cached 5 minutes. Users share /s/<id>;
 *                          social scrapers get correct meta; a <script> inside the
 *                          summary bounces JS-on humans to the interactive page as
 *                          progressive enhancement.
 *   GET  /health, GET / → { ok: true, service, version }
 *
 * Free tier fits: 100 K reqs/day, no compute-cost surprises.
 *
 * Environment (set via `wrangler secret put` or dashboard):
 *   GH_DISPATCH_TOKEN  — fine-grained GitHub PAT with `actions:write` on
 *                        OJ-Uday/vetlock-web-scans. Nothing else.
 *
 * Static config (below): REPO_OWNER, REPO_NAME, WORKFLOW_FILENAME, ALLOWED_ORIGIN,
 *                        MAX_BYTES_*, RATE_*, SITE_ORIGIN, WORDMARK_VERSION.
 *
 * DEPLOY: `wrangler deploy` from this directory — MANUAL step; not wired into CI.
 *         Document in the PR body. See worker/README.md for the checklist.
 */

const REPO_OWNER = "OJ-Uday";
const REPO_NAME = "vetlock-web-scans";
const WORKFLOW_FILENAME = "scan.yml";
const ALLOWED_ORIGIN = "https://oj-uday.github.io";
const MAX_BYTES_PER_LOCKFILE = 500_000;
const MAX_REQUEST_BYTES = 1_100_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_N = 3;
// Scraper-tolerant rate limit for /og/* and /s/* endpoints. 60/min per IP is
// far above what real crawlers (Slack, Discord, LinkedIn, X, Facebook, Telegram,
// iMessage) hit even for viral shares — a legitimate unfurl is one GET per URL
// per scraper — but it caps a single abusive IP that rotates scan ids from
// exhausting the GH_DISPATCH_TOKEN's 5000/hour authenticated Contents-API budget.
const RATE_LIMIT_OG_N = 60;

// Worker-side cache for results/<id>.json lookups. Keyed by scan id (not URL),
// so /og/<id>.svg, /og/<id>.png, and /s/<id> share the same entry — a scraper
// probing all three variants for the same id only costs one GitHub API call.
// Ready results are stable, so a longer TTL; pending/404/error variants use a
// short TTL so we pick up the workflow's commit within a poll window.
const RESULT_CACHE_S_READY = 300;   // 5 min — final result JSON
const RESULT_CACHE_S_PENDING = 5;   // 5 s  — pending / 404 / upstream error

// Canonical site origin — used to fetch HTML shell for /s/:id and to build
// permalink URLs embedded in the SVG/HTML output. Kept as a single constant
// so a future custom-domain move only edits one line.
const SITE_ORIGIN = "https://oj-uday.github.io";

// Displayed in OG SVG footer. Bumped alongside vetlock releases so shared
// cards carry a version footprint.
const WORDMARK_VERSION = "v0.3.0";

// OG image caching: social scrapers re-hit these endpoints aggressively.
// A 24h public+immutable cache lets Cloudflare serve them without invoking
// the Worker after the first hit, which also insulates OG traffic from the
// scan rate limit. Pending/error variants use a SHORT TTL AND drop the
// `immutable` directive (see svgResponse / redirectToSvg / handleShareShim)
// so we don't pin a "not found / processing" preview across scrapers for
// minutes when a permalink is shared before the workflow commits
// results/<id>.json — that's the primary P3 share flow (user hits Copy Link
// the instant the card renders; Slack unfurls a few seconds later; the real
// result lands 20-40 s after that). Cf. the packet: "OG images must reflect
// real verdict counts. Never fabricate."
const OG_CACHE_S_READY = 86_400;      // 24 h — final rendered card
const OG_CACHE_S_PLACEHOLDER = 15;    // 15 s — "not found" (short + revalidatable, no `immutable`)
const SHIM_CACHE_S = 300;             // 5  min — HTML shim for scrapers (ready state)
const SHIM_CACHE_S_PLACEHOLDER = 15;  // 15 s — HTML shim (scan not ready / missing)

// Corpus fixtures the workflow accepts (validated at Worker to reject unknown ids
// before spending a workflow run).
const ALLOWED_CORPUS_IDS = new Set([
  "shai-hulud-2025",
  "event-stream-2018",
  "eslint-scope-2018",
  "ua-parser-2021",
  "coa-rc-2021",
  "colors-2022",
  "node-ipc-2022",
  "solana-web3-2024",
  "lottie-player-2024",
  "rand-user-agent-2025",
  "hardened-evader-2026",
  "integrity-tamper-synthetic",
  "typosquat-synthetic",
]);

// ── OG PALETTE ────────────────────────────────────────────────────────
// Hex values MIRROR design/tokens.css semantic tokens, resolved through
// primitives. SVG is served standalone so CSS custom properties can't
// resolve — we hardcode the concrete hex here but document the token
// each value maps to. If tokens.css changes, update this table.
//
// Sourced from design/tokens.css (dark defaults):
//   --color-bg              = --slate-950 = #0a0e13
//   --color-surface         = --slate-900 = #10151c
//   --color-surface-raised  = --slate-850 = #141b24
//   --color-border-strong   ~ rgba(255,255,255,0.14) → flattened over bg
//   --color-text            = --slate-50  = #e6edf3
//   --color-text-muted      = --slate-350 = #97a3af
//   --color-text-dim        = --slate-500 = #647585
//   --color-accent          = --teal-300  = #4be3b0
//   --color-danger          = --red-400   = #ff6b6b
//   --color-warn            = --amber-300 = #ffb454
//   --color-info            = --cyan-300  = #7dd3fc
const OG_PALETTE = {
  bg:        "#0a0e13",  // --color-bg (dark)
  surface:   "#10151c",  // --color-surface
  raised:    "#141b24",  // --color-surface-raised
  border:    "#2a323d",  // flattened --color-border-strong
  text:      "#e6edf3",  // --color-text
  textMuted: "#97a3af",  // --color-text-muted
  textDim:   "#647585",  // --color-text-dim
  accent:    "#4be3b0",  // --color-accent (teal-300)
  danger:    "#ff6b6b",  // --color-danger (red-400)
  warn:      "#ffb454",  // --color-warn (amber-300)
  ok:        "#4be3b0",  // CLEAN uses accent — visually reinforces safe
  info:      "#7dd3fc",  // --color-info (cyan-300)
  unknown:   "#97a3af",  // fall back to muted text
};

export default {
  /**
   * @param {Request} request
   * @param {{ GH_DISPATCH_TOKEN?: string }} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── CORS preflight ────────────────────────────────────────────────
    // Only the site-facing scan endpoints need CORS. OG/share endpoints
    // are cross-origin GETs from crawler bots — no preflight applies.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      // ── Scan endpoints (CORS-wrapped) ──────────────────────────────
      if (url.pathname === "/scan" && request.method === "POST") {
        return withCors(await handleScan(request, env, ctx));
      }
      const scanMatch = url.pathname.match(/^\/scan\/([a-f0-9]{16,32})$/);
      if (scanMatch && request.method === "GET") {
        return withCors(await handleStatus(scanMatch[1], env, ctx));
      }

      // ── OG image endpoints (NOT CORS-wrapped; scraper-facing) ──────
      // Deliberately BEFORE the /s/:id shim so /og/:id.svg is never
      // matched by the shim regex. Both routes apply a scraper-tolerant
      // rate limit (60/min per IP) — high enough for real crawler traffic
      // but low enough to cap id-rotation abuse against fetchResult().
      const ogMatch = url.pathname.match(/^\/og\/([a-f0-9]{16,32})\.(svg|png)$/);
      if (ogMatch && request.method === "GET") {
        return handleOg(ogMatch[1], ogMatch[2], request, env, ctx);
      }

      // ── Share-shim endpoint (NOT CORS-wrapped; scraper-facing) ─────
      const shimMatch = url.pathname.match(/^\/s\/([a-f0-9]{16,32})$/);
      if (shimMatch && request.method === "GET") {
        return handleShareShim(shimMatch[1], request, env, ctx);
      }

      // ── Health ─────────────────────────────────────────────────────
      if (url.pathname === "/" || url.pathname === "/health") {
        return withCors(json({ ok: true, service: "vetlock-scan-worker", version: 2 }));
      }
      return withCors(text("Not found", 404));
    } catch (err) {
      // Never crash the Worker; return a structured error the site can render.
      // Public body carries a generic message + requestId only — internal detail
      // (err.message, stack, library internals) stays server-side. Operators
      // correlate a user-reported requestId to the log line via the same UUID.
      const requestId = crypto.randomUUID();
      console.error("worker error:", requestId, err?.stack || err?.message || err);
      return withCors(json({ error: "internal error", requestId }, 500));
    }
  },
};

// ─── handlers: scan (unchanged behavior) ─────────────────────────────

async function handleScan(request, env, ctx) {
  if (!env.GH_DISPATCH_TOKEN) {
    return json({ error: "backend not configured (missing GH_DISPATCH_TOKEN secret)" }, 500);
  }

  // Size gate first — before we read the whole body.
  const cl = Number(request.headers.get("Content-Length") || 0);
  if (cl > MAX_REQUEST_BYTES) {
    return json({ error: `request too large (${cl} > ${MAX_REQUEST_BYTES})` }, 413);
  }
  if ((request.headers.get("Content-Type") || "").indexOf("application/json") === -1) {
    return json({ error: "Content-Type must be application/json" }, 415);
  }

  // Rate limit per IP.
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  const rl = await checkRateLimit(ip);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: `rate limit — try again in ${rl.retryAfter}s` }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
    });
  }

  // Parse + validate payload.
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  const errs = validatePayload(payload);
  if (errs) return json({ error: errs }, 400);

  // Guardrail: raw-lockfile ("live-npm") scanning is gated behind an env flag
  // until the startup packet's P1/P2 land. Default deploy = corpus-only, so an
  // internet caller cannot burn workflow minutes or exfiltrate arbitrary
  // lockfile shapes via this endpoint. Flip ENABLE_LIVE_NPM in wrangler once
  // the upstream gates are in place.
  if (!env.ENABLE_LIVE_NPM && !payload.corpus_id) {
    return json({ error: "live-npm scanning is gated pending startup P1/P2 — use a corpus fixture" }, 403);
  }

  // Build workflow inputs.
  const scanId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  let workflowInputs;
  if (payload.corpus_id) {
    workflowInputs = { scan_id: scanId, corpus_id: payload.corpus_id };
  } else {
    const [beforeGz, afterGz] = await Promise.all([
      gzipBase64(payload.before),
      gzipBase64(payload.after),
    ]);
    // GitHub caps workflow input at 64 KB per field. Post-encoding, we need each
    // gzipped lockfile to fit in that budget. Most lockfiles compress to ~10-30% of
    // their raw size, so 500 KB in → ~50-150 KB gz → base64 → ~200 KB. Reject if
    // over the GH limit.
    if (beforeGz.length > 65_000 || afterGz.length > 65_000) {
      return json({
        error: "lockfile too large for GitHub workflow input after gzip+base64. Try `npx vetlock diff` locally, or scan a smaller subset."
      }, 413);
    }
    workflowInputs = {
      scan_id: scanId,
      before_b64_gz: beforeGz,
      after_b64_gz: afterGz,
      corpus_id: "",
    };
    // Ecosystem hint: derived from filenames when the site sends them.
    // Kept optional to preserve backward compat with the existing workflow —
    // vetlock-web-scans can ignore an unknown input, and older payloads
    // without filename_before/filename_after just skip it.
    const eco = getEcosystem([payload.filename_before, payload.filename_after]);
    if (eco) workflowInputs.ecosystem = eco;
  }

  // Dispatch the workflow.
  const dispatchRes = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_FILENAME}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "vetlock-scan-worker",
      },
      body: JSON.stringify({ ref: "main", inputs: workflowInputs }),
    }
  );
  if (!dispatchRes.ok) {
    const errText = await dispatchRes.text().catch(() => "");
    // Log upstream detail server-side only; never echo it to unauthenticated
    // callers — GitHub error bodies routinely include the private repo path,
    // workflow filename, ref, token-associated actor, and validation echoes
    // of the workflow inputs, all of which disclose internal topology.
    console.error("[handleScan] GitHub dispatch failed", dispatchRes.status, errText);
    return json({ error: "upstream dispatch failed", status: dispatchRes.status }, 502);
  }

  return json({ scanId, statusUrl: `/scan/${scanId}` }, 202);
}

async function handleStatus(scanId, env, ctx) {
  // Poll the GitHub Contents API — the workflow commits results/<scanId>.json.
  // We use the API rather than raw.githubusercontent.com because raw has a
  // Fastly-backed CDN cache (~5 min) that can 404-cache a not-yet-committed
  // file even after the workflow lands. The API is strongly consistent.
  const r = await fetchResult(scanId, env, ctx);
  if (r.status === 200) {
    return json({ status: "ready", result: r.result }, 200);
  }
  if (r.status === 404) {
    return json({ status: "pending", stage: "running" }, 202);
  }
  if (r.status === "corrupt") {
    return json({ status: "corrupt", detail: "result file not valid JSON yet" }, 202);
  }
  // Any OTHER upstream status (403 secondary-rate-limit, 5xx during a commit,
  // 502 from GitHub's edge, etc.) is TRANSIENT — the workflow is very likely
  // still running or the file is still propagating. Report as pending so the
  // client keeps polling instead of failing. If the workflow really is dead,
  // the client's 90-second overall timeout will catch it.
  return json({ status: "pending", stage: "running", note: `upstream-${r.status}` }, 202);
}

// ─── handlers: OG image ──────────────────────────────────────────────

/**
 * Renders a per-scan Open Graph card.
 * Route dispatch (svg vs png) is chosen by the file extension in the URL.
 *
 * @param {string} id      hex scan id (validated by the route regex)
 * @param {"svg"|"png"} format
 * @param {Request} request
 * @param {any} env
 * @param {ExecutionContext} ctx
 */
async function handleOg(id, format, request, env, ctx) {
  // Apply a SCRAPER-TOLERANT rate limit (60/min per IP, vs 3/min for /scan).
  // Legitimate crawler unfurls are one GET per (URL, scraper) — the ceiling
  // sits well above real traffic but blocks a single IP from rotating scan
  // ids to exhaust the GH_DISPATCH_TOKEN's 5000/hour Contents-API budget.
  // The result-JSON cache below (fetchResult()) is per-id, so URL-keyed edge
  // caches don't help against id-rotation attacks — this rate limit does.
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  const rl = await checkRateLimit(ip, "og", RATE_LIMIT_OG_N);
  if (!rl.ok) {
    return new Response("rate limit", {
      status: 429,
      headers: { "Content-Type": "text/plain", "Retry-After": String(rl.retryAfter) },
    });
  }

  const r = await fetchResult(id, env, ctx);

  // Not-yet-ready or missing — return a placeholder card, not a 5xx.
  // Some scrapers stop trying to unfurl a URL that ever 5xxed. These
  // placeholder responses MUST NOT be `immutable` — see the OG_CACHE_S_*
  // comment block above: a scraper hitting /og/<id>.* seconds after a
  // permalink is shared would otherwise pin "not found" for 5 min while
  // the workflow commits the real result 20-40 s later, violating the
  // packet's "OG images must reflect real verdict counts" rule.
  if (r.status === 404) {
    return format === "png"
      ? redirectToSvg(id, request, OG_CACHE_S_PLACEHOLDER, { immutable: false })
      : svgResponse(renderNotFoundSvg(id), OG_CACHE_S_PLACEHOLDER, { immutable: false });
  }
  if (r.status !== 200) {
    // Pending / corrupt / upstream-5xx: render a "processing" card.
    return format === "png"
      ? redirectToSvg(id, request, 0)  // no cache — try again soon
      : svgResponse(renderProcessingSvg(id), 0);
  }

  // Ready — build the real card from truthful counts.
  const svg = renderVerdictSvg(id, r.result);

  if (format === "svg") {
    return svgResponse(svg, OG_CACHE_S_READY);
  }

  // PNG path — best-effort. Cloudflare's image resizing can transform
  // the SVG in-flight to PNG on eligible plans. When the transform isn't
  // available, cf.image is silently ignored and we'd serve the raw SVG
  // bytes with the wrong Content-Type. To detect that reliably without
  // a plan probe, we take the safer route: 302 to the SVG variant, which
  // every scraper handles. When the SVG is enough (Slack/Discord/LinkedIn
  // all render SVG unfurls; only Twitter/X strictly needs PNG), no extra
  // dependency is needed. Future upgrade: inline @resvg/resvg-wasm.
  //
  // A follow-up PR can flip this to attempt cf.image first and fall back
  // to the redirect only on failure — for P3 we ship the redirect path
  // to keep the bundle under the 900 KB budget (see spec §D.3).
  return redirectToSvg(id, request, OG_CACHE_S_READY);
}

/**
 * Returns a 302 to the SVG sibling of a PNG request, with a Cache-Control
 * that matches the target's freshness so the redirect itself doesn't
 * churn on the scraper side. Content-Length is zero — no body.
 *
 * `immutable` defaults to true for the ready-card path (final, stable). Pass
 * `{ immutable: false }` for placeholder branches so a re-hit revalidates
 * instead of pinning "not found" for the full TTL — critical when a user
 * shares a permalink before the workflow commits results/<id>.json.
 */
function redirectToSvg(id, request, cacheSeconds, { immutable = true } = {}) {
  const url = new URL(request.url);
  url.pathname = `/og/${id}.svg`;
  const headers = new Headers({
    Location: url.toString(),
    "Cache-Control": cacheSeconds > 0
      ? `public, max-age=${cacheSeconds}${immutable ? ", immutable" : ""}`
      : "no-store",
    "X-Og-Format-Note": "png-not-supported-in-worker-fallback-to-svg",
  });
  return new Response(null, { status: 302, headers });
}

function svgResponse(svgString, cacheSeconds, { immutable = true } = {}) {
  return new Response(svgString, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": cacheSeconds > 0
        ? `public, max-age=${cacheSeconds}${immutable ? ", immutable" : ""}`
        : "no-store",
      // OG scrapers occasionally send an Origin header expecting CORS —
      // permissive since these images are meant to be embedded anywhere.
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Build the verdict-card SVG from a truthful result object.
 * All strings are XML-escaped; all numbers derive from result.findings.
 * NEVER fabricate a count, verdict, or package name.
 *
 * @param {string} id
 * @param {any} result  the parsed contents of results/<id>.json
 */
function renderVerdictSvg(id, result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const nBlock = findings.filter((f) => f?.severity === "BLOCK").length;
  const nWarn  = findings.filter((f) => f?.severity === "WARN").length;
  const nOk    = findings.filter((f) => f?.severity === "INFO" || f?.severity === "OK").length;

  // Determine a single "primary package" for the caption, when unambiguous.
  // Derive strictly from packages that carry BLOCK-severity findings — never
  // from result.changes, because a lone change package may have zero findings
  // and the caption claims "in <pkg>". Only claim "in <pkg>" when every BLOCK
  // finding is on that same package.
  const blockPkgs = [...new Set(
    findings
      .filter((f) => f?.severity === "BLOCK")
      .map((f) => f?.package)
      .filter(Boolean)
  )];
  const primaryPkg = blockPkgs.length === 1 ? sanitizePkg(blockPkgs[0]) : null;

  // Verdict + accent color. Uses the same findings-derived fallback as the
  // site (app.js renderResult) so a permalink preview never contradicts the
  // read-only page it links to when result.verdict is missing/invalid.
  const verdict = deriveVerdict(result?.verdict, findings);
  const verdictColor =
    verdict === "BLOCK" ? OG_PALETTE.danger :
    verdict === "WARN"  ? OG_PALETTE.warn   :
    verdict === "CLEAN" ? OG_PALETTE.ok     :
                          OG_PALETTE.unknown;

  // Ecosystem chip. Refuse to fabricate — if the workflow didn't stamp
  // result.ecosystem, hide the chip so the OG card, /s/<id> shim, and
  // /?scan=<id> site view all agree (they all key off the same field).
  const ecoRaw = typeof result?.ecosystem === "string" ? result.ecosystem.toLowerCase() : null;
  const eco = ecoRaw === "pypi" ? "PyPI" : ecoRaw === "npm" ? "npm" : null;

  // Caption — truthful. Prefer per-package if we have one.
  const caption = primaryPkg
    ? `vetlock caught ${nBlock} BLOCK finding${nBlock === 1 ? "" : "s"} in ${primaryPkg}`
    : blockPkgs.length > 1
      ? `vetlock caught ${nBlock} BLOCK finding${nBlock === 1 ? "" : "s"} across ${blockPkgs.length} packages`
      : `vetlock scan · ${verdict.toLowerCase()}`;

  const idSnippet = id.slice(0, 8);

  // XML-escape every dynamic string embedded in the SVG. Numbers are
  // constrained to non-negative integers by the .filter().length chain.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="vetlock scan verdict card">
  <!-- Background -->
  <rect width="1200" height="630" fill="${OG_PALETTE.bg}"/>
  <!-- Teal accent bar -->
  <rect x="0" y="40" width="1200" height="6" fill="${OG_PALETTE.accent}"/>
  <!-- Ecosystem chip (top-right) — omitted when the workflow didn't stamp result.ecosystem, so we never fabricate a label -->
  ${eco ? `<g transform="translate(1020, 74)">
    <rect x="0" y="0" width="140" height="44" rx="8" ry="8"
          fill="none" stroke="${OG_PALETTE.accent}" stroke-width="2"/>
    <text x="70" y="30" text-anchor="middle"
          font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
          font-size="24" fill="${OG_PALETTE.accent}">${xml(eco)}</text>
  </g>` : ""}
  <!-- Verdict, big monospace -->
  <text x="80" y="240"
        font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        font-size="120" font-weight="700" fill="${verdictColor}">${xml(verdict)}</text>
  <!-- Count row -->
  <text x="80" y="330"
        font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        font-size="48" fill="${OG_PALETTE.textMuted}">${nBlock} BLOCK  ·  ${nWarn} WARN  ·  ${nOk} OK</text>
  <!-- Caption -->
  <text x="80" y="420"
        font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
        font-size="36" fill="${OG_PALETTE.text}">${xml(caption)}</text>
  <!-- Bottom rule -->
  <rect x="80" y="510" width="1040" height="1" fill="${OG_PALETTE.border}"/>
  <!-- Footer: wordmark left, scan id right -->
  <text x="80" y="560"
        font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        font-size="24" fill="${OG_PALETTE.textDim}">vetlock <tspan fill="${OG_PALETTE.accent}">${xml(WORDMARK_VERSION)}</tspan></text>
  <text x="1120" y="560" text-anchor="end"
        font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        font-size="20" fill="${OG_PALETTE.textDim}">scan ${xml(idSnippet)}</text>
</svg>`;
}

/** Not-found fallback — branded, so a scraper unfurl looks intentional. */
function renderNotFoundSvg(id) {
  const snippet = xml(id.slice(0, 8));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="vetlock scan not found">
  <rect width="1200" height="630" fill="${OG_PALETTE.bg}"/>
  <rect x="0" y="40" width="1200" height="6" fill="${OG_PALETTE.accent}"/>
  <text x="80" y="260"
        font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        font-size="88" fill="${OG_PALETTE.textMuted}">scan not found</text>
  <text x="80" y="340"
        font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
        font-size="32" fill="${OG_PALETTE.text}">This scan link is invalid or has expired.</text>
  <text x="80" y="390"
        font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
        font-size="28" fill="${OG_PALETTE.textDim}">Results are retained for 24 hours after the scan runs.</text>
  <text x="80" y="560"
        font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        font-size="24" fill="${OG_PALETTE.textDim}">vetlock <tspan fill="${OG_PALETTE.accent}">${xml(WORDMARK_VERSION)}</tspan></text>
  <text x="1120" y="560" text-anchor="end"
        font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        font-size="20" fill="${OG_PALETTE.textDim}">${snippet}</text>
</svg>`;
}

/** In-flight placeholder — workflow hasn't committed the result yet. */
function renderProcessingSvg(id) {
  const snippet = xml(id.slice(0, 8));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="vetlock scan in progress">
  <rect width="1200" height="630" fill="${OG_PALETTE.bg}"/>
  <rect x="0" y="40" width="1200" height="6" fill="${OG_PALETTE.accent}"/>
  <text x="80" y="260"
        font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        font-size="88" fill="${OG_PALETTE.accent}">scanning...</text>
  <text x="80" y="340"
        font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
        font-size="32" fill="${OG_PALETTE.text}">vetlock is analyzing your lockfile diff.</text>
  <text x="80" y="390"
        font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
        font-size="28" fill="${OG_PALETTE.textDim}">Refresh the page in a moment to see the verdict.</text>
  <text x="80" y="560"
        font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        font-size="24" fill="${OG_PALETTE.textDim}">vetlock <tspan fill="${OG_PALETTE.accent}">${xml(WORDMARK_VERSION)}</tspan></text>
  <text x="1120" y="560" text-anchor="end"
        font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        font-size="20" fill="${OG_PALETTE.textDim}">${snippet}</text>
</svg>`;
}

// ─── handlers: /s/:id share shim ─────────────────────────────────────

/**
 * Rewrites the site's canonical HTML so social crawlers see per-scan meta.
 *
 * Flow:
 *   1. GET the canonical site HTML (once per shim cache TTL).
 *   2. Rewrite og:image, twitter:image, og:url, og:title, og:description
 *      to point at the specific scan.
 *   3. Inject <link rel="canonical" href=".../?scan=<id>"> so search engines
 *      dedupe the shim URL against the interactive URL.
 *   4. Inject a truthful inline summary block at the top of <body>
 *      (verdict, counts, ecosystem, primary package — all sourced from
 *      the committed results/<id>.json). JS-off scrapers and humans see
 *      the real scan result as static HTML; a plain <script> inside the
 *      block bounces JS-on humans to the interactive /?scan=<id> page
 *      as an enhancement. No meta-refresh — that would strand JS-off
 *      clients on the inert interactive shell.
 *   5. Return the rewritten HTML with a 5-minute edge cache.
 *
 * All string interpolation is via xml() / meta-attr escaping; the id is
 * regex-validated hex-only at the router; no user-controlled text reaches
 * the response.
 *
 * @param {string} id
 * @param {Request} request
 * @param {any} env
 * @param {ExecutionContext} ctx
 */
async function handleShareShim(id, request, env, ctx) {
  // Same scraper-tolerant limit as /og/* — same bucket, since /og and /s
  // share the underlying GitHub Contents-API budget via fetchResult().
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  const rl = await checkRateLimit(ip, "og", RATE_LIMIT_OG_N);
  if (!rl.ok) {
    return new Response("rate limit", {
      status: 429,
      headers: { "Content-Type": "text/plain", "Retry-After": String(rl.retryAfter) },
    });
  }

  const r = await fetchResult(id, env, ctx);

  const ok = r.status === 200;
  const result = ok ? r.result : null;

  // Truthful summary strings (or safe fallbacks when the scan hasn't landed).
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const nBlock = findings.filter((f) => f?.severity === "BLOCK").length;
  // Derive strictly from packages that carry BLOCK-severity findings — never
  // from result.changes, because a lone change package may have zero findings
  // and the title claims "in <pkg>". Only claim "in <pkg>" when every BLOCK
  // finding is on that same package.
  const blockPkgs = [...new Set(
    findings
      .filter((f) => f?.severity === "BLOCK")
      .map((f) => f?.package)
      .filter(Boolean)
  )];
  const primaryPkg = blockPkgs.length === 1 ? sanitizePkg(blockPkgs[0]) : null;
  // Refuse to fabricate ecosystem. When the workflow didn't stamp
  // result.ecosystem, hand null downstream so every renderer (SVG card,
  // shim summary, meta description) can omit the label instead of guessing.
  const ecoRaw = typeof result?.ecosystem === "string" ? result.ecosystem.toLowerCase() : null;
  const eco = ecoRaw === "pypi" ? "PyPI" : ecoRaw === "npm" ? "npm" : null;
  // WARN / OK counts — needed for the JS-off truthful summary block below,
  // not just the meta description. Kept as .filter().length so every value
  // in `summary` is a non-negative integer that's safe to embed unescaped.
  const nWarn = findings.filter((f) => f?.severity === "WARN").length;
  const nOk   = findings.filter((f) => f?.severity === "INFO" || f?.severity === "OK").length;
  // Match the site's findings-derived fallback (app.js renderResult) so the
  // shim's <h1> and meta description agree with the read-only replay page
  // when result.verdict is missing/invalid.
  const verdict = ok ? deriveVerdict(result?.verdict, findings) : "";

  const title = ok
    ? primaryPkg
      ? `vetlock caught ${nBlock} BLOCK finding${nBlock === 1 ? "" : "s"} in ${primaryPkg}`
      : blockPkgs.length > 1
        ? `vetlock caught ${nBlock} BLOCK finding${nBlock === 1 ? "" : "s"} across ${blockPkgs.length} packages`
        : `vetlock ${(verdict || "scan").toLowerCase()} — ${findings.length} findings`
    : `vetlock scan ${id.slice(0, 8)}`;
  const desc = ok
    ? `Behavioral supply-chain diff${eco ? ` · ${eco}` : ""} · ${nBlock} BLOCK / ${nWarn} WARN`
    : `This scan link isn't ready yet or has expired.`;

  const permalink = `${SITE_ORIGIN}/?scan=${id}`;
  const ogImage = `${new URL(request.url).origin}/og/${id}.png`;
  // Structured, truthful summary handed to both the canonical-HTML rewriter
  // and the minimal shell. Both need to render this INLINE (not just as
  // meta tags) so JS-off scrapers / humans see the actual scan result — the
  // interactive /?scan=<id> page is JS-heavy, so a bare redirect would
  // strand them on an inert shell. Every field here derives from truthful
  // counts / sanitized package names — never fabricated.
  const summary = {
    ok,
    verdict,
    eco,
    nBlock,
    nWarn,
    nOk,
    totalFindings: findings.length,
    primaryPkg,
    blockPkgsCount: blockPkgs.length,
    rawJsonUrl: `${new URL(request.url).origin}/scan/${id}`,
    repoUrl: "https://github.com/OJ-Uday/vetlock",
  };

  // Try to fetch the site's canonical HTML shell. If it fails (site down,
  // network blip), fall back to a minimal shell. Both branches render the
  // truthful summary inline so shared permalinks satisfy the packet's
  // "shared scan permalinks must render EXACTLY what the scan produced"
  // clause even when JS is disabled.
  const canonicalHtml = await fetchSiteShell(ctx).catch(() => null);
  const body = canonicalHtml
    ? rewriteMetaForScan(canonicalHtml, { id, title, desc, ogImage, permalink, summary })
    : minimalShimShell({ id, title, desc, ogImage, permalink, summary });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // 5-minute edge cache for ready scans — plenty for a viral share
      // cycle, short enough that a re-scan (rare) picks up new numbers
      // within a window most humans wouldn't notice.
      //
      // For NOT-yet-ready / missing scans we drop to 15 s so a permalink
      // shared before results/<id>.json commits doesn't pin the "scan
      // isn't ready" shell across scrapers for 5 min while the workflow
      // lands the real result 20-40 s later — the primary P3 share flow.
      // Same rationale as OG_CACHE_S_PLACEHOLDER above.
      "Cache-Control": `public, max-age=${ok ? SHIM_CACHE_S : SHIM_CACHE_S_PLACEHOLDER}`,
      "X-Robots-Tag": "noindex, follow",  // don't index shim URLs
    },
  });
}

/**
 * Fetches the site's canonical HTML shell. Cached at the Worker level
 * via caches.default so we don't hammer GitHub Pages when a share goes viral.
 */
async function fetchSiteShell(ctx) {
  const cacheKey = new Request(`${SITE_ORIGIN}/?__vetlock_shim_shell=1`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return await cached.text();

  const res = await fetch(SITE_ORIGIN, {
    headers: {
      "User-Agent": "vetlock-scan-worker (share-shim)",
      "Accept": "text/html",
    },
    cf: { cacheEverything: true, cacheTtl: 300 },
  });
  if (!res.ok) throw new Error(`site shell fetch failed (${res.status})`);
  const html = await res.text();

  // Cache in the local edge cache for 5 minutes.
  const cacheable = new Response(html, {
    headers: { "Content-Type": "text/html", "Cache-Control": "max-age=300" },
  });
  if (ctx?.waitUntil) ctx.waitUntil(caches.default.put(cacheKey, cacheable));
  return html;
}

/**
 * Rewrites the canonical HTML to embed per-scan meta.
 *
 * Uses simple regex substitutions rather than HTMLRewriter because the shim
 * runs at cold-request latency and the substitution set is small + boring.
 * Every replacement is bounded — no unbounded backtracking; each pattern
 * matches at most once per property.
 */
function rewriteMetaForScan(html, { id, title, desc, ogImage, permalink, summary }) {
  // Escape user-visible strings via xml() before embedding as HTML attribute
  // values. sanitizePkg + regex-validated id upstream mean the substrings
  // are already safe, but double-escaping via xml() defends against a future
  // change that widens the input surface.
  const T = xml(title);
  const D = xml(desc);
  const IMG = xml(ogImage);
  const URL_ = xml(permalink);
  const ID = xml(id.slice(0, 8));

  // Utility: rewrite a specific meta tag if present, else inject before </head>.
  function replaceOrInject(source, matcher, replacement, injectTag) {
    if (matcher.test(source)) {
      return source.replace(matcher, replacement);
    }
    return source.replace(/<\/head>/i, `${injectTag}\n</head>`);
  }

  let out = html;

  // og:title
  out = replaceOrInject(
    out,
    /<meta\s+property=["']og:title["'][^>]*>/i,
    `<meta property="og:title" content="${T}">`,
    `<meta property="og:title" content="${T}">`
  );

  // og:description
  out = replaceOrInject(
    out,
    /<meta\s+property=["']og:description["'][^>]*>/i,
    `<meta property="og:description" content="${D}">`,
    `<meta property="og:description" content="${D}">`
  );

  // og:image (with dimensions right after)
  out = replaceOrInject(
    out,
    /<meta\s+property=["']og:image["'][^>]*>/i,
    `<meta property="og:image" content="${IMG}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">`,
    `<meta property="og:image" content="${IMG}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">`
  );

  // og:url — canonical interactive URL
  out = replaceOrInject(
    out,
    /<meta\s+property=["']og:url["'][^>]*>/i,
    `<meta property="og:url" content="${URL_}">`,
    `<meta property="og:url" content="${URL_}">`
  );

  // twitter:card + twitter:image
  out = replaceOrInject(
    out,
    /<meta\s+name=["']twitter:card["'][^>]*>/i,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:card" content="summary_large_image">`
  );
  out = replaceOrInject(
    out,
    /<meta\s+name=["']twitter:image["'][^>]*>/i,
    `<meta name="twitter:image" content="${IMG}">`,
    `<meta name="twitter:image" content="${IMG}">`
  );

  // Canonical link — dedupe shim vs interactive URL for search engines.
  out = replaceOrInject(
    out,
    /<link\s+rel=["']canonical["'][^>]*>/i,
    `<link rel="canonical" href="${URL_}">`,
    `<link rel="canonical" href="${URL_}">`
  );

  // Progressive-enhancement redirect. The previous implementation used
  // <meta http-equiv="refresh">, which fires even without JS — bouncing
  // JS-off clients onto /?scan=<id>, a page that itself needs JS to render
  // anything meaningful. That stranded scrapers and JS-off humans on an
  // inert interactive shell.
  //
  // The fix: (1) drop meta-refresh, (2) let JS-on humans bounce via a plain
  // <script> below, and (3) inject an inline <noscript> block into <body>
  // that renders the truthful scan summary. That way `/s/<id>` renders the
  // real result as static HTML for JS-off scrapers/humans — satisfying the
  // packet's "shared scan permalinks must render EXACTLY what the scan
  // produced" clause. Injection is done in a separate pass below so it
  // participates in <body>, not <head>.

  // <title> — rewrite for humans who see the tab title mid-redirect.
  if (/<title>[\s\S]*?<\/title>/i.test(out)) {
    out = out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${T}</title>`);
  } else {
    out = out.replace(/<\/head>/i, `<title>${T}</title>\n</head>`);
  }

  // Marker so we can verify in tests + eyeball whether a page went through
  // the shim rewrite when debugging.
  out = out.replace(/<\/head>/i, `<meta name="x-vetlock-shim" content="scan-${ID}">\n</head>`);

  // Inject the truthful, JS-off-visible summary + progressive-enhancement
  // redirect script at the top of <body>. This is what a JS-disabled
  // scraper or human actually sees as page content. Kept as the first
  // element in <body> so it renders even if page CSS fails to load.
  const summaryHtml = shimSummaryHtml({ id, permalink, summary });
  if (/<body[^>]*>/i.test(out)) {
    out = out.replace(/<body([^>]*)>/i, `<body$1>\n${summaryHtml}`);
  } else {
    // Extremely defensive — the site shell always has <body>, but if it
    // didn't, append the summary at the end rather than lose it entirely.
    out = out + `\n${summaryHtml}`;
  }

  return out;
}

/**
 * Renders a JS-off-visible summary block for the /s/<id> share shim.
 *
 * The block satisfies the "shared scan permalinks must render EXACTLY
 * what the scan produced" clause of the packet: verdict, counts, ecosystem,
 * and primary package all come from truthful `summary.*` fields the caller
 * computed from the committed results/<id>.json — never fabricated.
 *
 * All dynamic strings are xml()-escaped. Numeric fields are integers by
 * construction (.filter().length) and safe to embed unescaped. Uses
 * inline styles because the shim is served across origins and we can't
 * rely on the site's stylesheet loading.
 *
 * A <script> below the visible content upgrades the JS-on experience by
 * bouncing to the interactive /?scan=<id> page — same behavior as the
 * old meta-refresh, but guarded by JS so JS-off clients keep the truthful
 * static content.
 */
function shimSummaryHtml({ id, permalink, summary }) {
  const URL_ = xml(permalink);
  const ID = xml(id.slice(0, 8));
  const s = summary || {};
  if (!s.ok) {
    // Scan not ready or missing — render an honest placeholder, not a
    // fabricated verdict. Still linkable + JS-off-visible.
    return `<main style="max-width:720px;margin:2rem auto;padding:1.5rem;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;">
  <h1 style="margin:0 0 .5rem;font-size:1.5rem;">vetlock scan ${ID}</h1>
  <p>This scan isn't ready yet or has expired. Results are retained for 24 hours after the scan runs.</p>
  <p><a href="${URL_}">Open the interactive scan viewer</a> · <a href="https://github.com/OJ-Uday/vetlock">vetlock on GitHub</a></p>
  <script>window.location.replace(${JSON.stringify(permalink)});</script>
</main>`;
  }
  const V = xml(s.verdict || "UNKNOWN");
  // Ecosystem is optional here — when the workflow didn't stamp
  // result.ecosystem, the caller passes s.eco === null and we omit the
  // label rather than fabricate 'npm' (would contradict the site view).
  const ECO = s.eco ? xml(s.eco) : null;
  const NB = Number(s.nBlock) | 0;
  const NW = Number(s.nWarn) | 0;
  const NO = Number(s.nOk) | 0;
  const TOT = Number(s.totalFindings) | 0;
  const PKG = s.primaryPkg ? xml(s.primaryPkg) : null;
  const BPKGS = Number(s.blockPkgsCount) | 0;
  const RAW = xml(s.rawJsonUrl || "");
  const REPO = xml(s.repoUrl || "https://github.com/OJ-Uday/vetlock");
  const captionHtml = PKG
    ? `caught <strong>${NB}</strong> BLOCK finding${NB === 1 ? "" : "s"} in <code>${PKG}</code>`
    : BPKGS > 1
      ? `caught <strong>${NB}</strong> BLOCK finding${NB === 1 ? "" : "s"} across ${BPKGS} packages`
      : `${V.toLowerCase()} — ${TOT} finding${TOT === 1 ? "" : "s"}`;
  return `<main style="max-width:720px;margin:2rem auto;padding:1.5rem;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;">
  <p style="margin:0 0 .25rem;font-size:.85rem;letter-spacing:.08em;text-transform:uppercase;opacity:.7;">vetlock scan ${ID}${ECO ? ` · ${ECO}` : ""}</p>
  <h1 style="margin:0 0 .75rem;font-size:1.75rem;">${V}</h1>
  <p style="margin:0 0 .75rem;font-size:1.05rem;">${captionHtml}</p>
  <p style="margin:0 0 1rem;font-size:1rem;"><strong>${NB}</strong> BLOCK · <strong>${NW}</strong> WARN · <strong>${NO}</strong> OK</p>
  <p style="margin:0;font-size:.95rem;">
    <a href="${URL_}">Open the interactive scan viewer</a>
    · <a href="${RAW}">Raw JSON</a>
    · <a href="${REPO}">vetlock on GitHub</a>
  </p>
  <script>window.location.replace(${JSON.stringify(permalink)});</script>
</main>`;
}

/**
 * Minimal shim shell used when we can't reach the site's HTML.
 *
 * Renders the truthful scan summary INLINE (not just as meta tags) so
 * JS-off scrapers/humans see the actual verdict, counts, ecosystem, and
 * primary package — the interactive /?scan=<id> page needs JS to render
 * anything, so a bare meta-refresh would strand them on an inert shell.
 *
 * The visible summary comes from shimSummaryHtml(), which pulls strictly
 * from the truthful `summary.*` fields the caller computed from the
 * committed results/<id>.json. JS-on humans still get bounced to the
 * interactive page via a plain <script> inside the summary block.
 */
function minimalShimShell({ id, title, desc, ogImage, permalink, summary }) {
  const T = xml(title);
  const D = xml(desc);
  const IMG = xml(ogImage);
  const URL_ = xml(permalink);
  const ID = xml(id.slice(0, 8));
  const summaryHtml = shimSummaryHtml({ id, permalink, summary });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${T}</title>
<meta name="description" content="${D}">
<meta property="og:title" content="${T}">
<meta property="og:description" content="${D}">
<meta property="og:image" content="${IMG}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${URL_}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${IMG}">
<meta name="x-vetlock-shim" content="scan-${ID}">
<link rel="canonical" href="${URL_}">
</head>
<body>
${summaryHtml}
</body>
</html>`;
}

// ─── shared: fetch result JSON from the vetlock-web-scans repo ────────

/**
 * Fetch results/<id>.json from vetlock-web-scans via the GitHub Contents API.
 * Single source of truth for handleStatus, handleOg, and handleShareShim.
 *
 * Wrapped in a caches.default layer keyed by scan id, so the three endpoints
 * that consume the same id (/scan/<id>, /og/<id>.svg, /og/<id>.png, /s/<id>)
 * share one origin hit per TTL. This dedupes even across the id-rotation
 * abuse pattern only for a given id — the outer rate limit is what caps
 * id-rotation itself.
 *
 * Note on caching: we cache BOTH ready and pending states, with different
 * TTLs. Pending state uses a short TTL (5s) so the workflow's commit becomes
 * visible within a poll window; ready state uses 5 minutes since a committed
 * result file is immutable.
 *
 * @returns {Promise<{status:200|404|"corrupt"|number, result?:any}>}
 */
async function fetchResult(scanId, env, ctx) {
  const cacheKey = new Request(`https://vetlock-scan.internal/result-cache/${encodeURIComponent(scanId)}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    try {
      const payload = await cached.json();
      // Payload is the same shape returned below — {status, result?}.
      return payload;
    } catch {
      // Fall through to a fresh fetch on cache corruption.
    }
  }

  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/results/${scanId}.json`;
  const headers = {
    Accept: "application/vnd.github.raw",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "vetlock-scan-worker",
  };
  if (env?.GH_DISPATCH_TOKEN) {
    headers.Authorization = `Bearer ${env.GH_DISPATCH_TOKEN}`;
  }
  let res;
  try {
    res = await fetch(apiUrl, { headers });
  } catch (err) {
    // Treat network blips as "pending" to callers. Don't cache — retry fast.
    return { status: 502 };
  }

  let payload;
  if (res.status === 200) {
    const text = await res.text();
    try {
      payload = { status: 200, result: JSON.parse(text) };
    } catch {
      payload = { status: "corrupt" };
    }
  } else {
    payload = { status: res.status };
  }

  // Cache with a TTL that reflects how stable the state is.
  const ttl = payload.status === 200 ? RESULT_CACHE_S_READY : RESULT_CACHE_S_PENDING;
  const cacheableResponse = new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` },
  });
  if (ctx?.waitUntil) {
    ctx.waitUntil(caches.default.put(cacheKey, cacheableResponse));
  } else {
    // Best-effort when no ctx (unit tests, direct calls) — fire-and-forget.
    caches.default.put(cacheKey, cacheableResponse).catch(() => {});
  }
  return payload;
}

// ─── validation ──────────────────────────────────────────────────────

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") return "payload must be a JSON object";

  // Corpus mode.
  if ("corpus_id" in payload) {
    if (typeof payload.corpus_id !== "string") return "corpus_id must be a string";
    if (!ALLOWED_CORPUS_IDS.has(payload.corpus_id)) return `unknown corpus_id: ${payload.corpus_id}`;
    return null;
  }

  // Lockfile mode.
  if (typeof payload.before !== "string" || typeof payload.after !== "string") {
    return "must provide corpus_id, or both before and after as strings";
  }
  if (payload.before.length > MAX_BYTES_PER_LOCKFILE) return `before exceeds ${MAX_BYTES_PER_LOCKFILE} bytes`;
  if (payload.after.length > MAX_BYTES_PER_LOCKFILE)  return `after exceeds ${MAX_BYTES_PER_LOCKFILE} bytes`;
  if (!looksLikeLockfile(payload.before)) return "before doesn't look like a lockfile (npm/yarn/pnpm)";
  if (!looksLikeLockfile(payload.after))  return "after doesn't look like a lockfile (npm/yarn/pnpm)";
  return null;
}

function looksLikeLockfile(s) {
  if (typeof s !== "string" || s.length < 3) return false;
  const head = s.slice(0, 400);
  if (head.trimStart().startsWith("{")) {
    // package-lock.json (v2/v3)
    try {
      const j = JSON.parse(s);
      return typeof j === "object" && typeof j.lockfileVersion === "number" && j.packages;
    } catch { return false; }
  }
  if (head.includes("# yarn lockfile v1")) return true;
  if (/^\s*lockfileVersion\s*:/m.test(head)) return true; // pnpm
  return false;
}

/**
 * Ecosystem detection based on filenames the client sent alongside the
 * lockfile payload. Used to attach an `ecosystem` hint to the workflow
 * dispatch so vetlock-web-scans can branch when it eventually supports
 * PyPI. For P3 the Worker recognizes the filename shapes; downstream
 * consumption is a follow-up PR against vetlock-web-scans.
 *
 * Returns "npm" | "pypi" | null.
 *
 * @param {(string|null|undefined)[]} filenames
 */
function getEcosystem(filenames) {
  const seen = new Set();
  for (const raw of filenames || []) {
    const lower = String(raw || "").toLowerCase();
    const base = lower.split("/").pop();
    if (!base) continue;
    if (
      base === "package-lock.json" ||
      base === "npm-shrinkwrap.json" ||
      base === "yarn.lock" ||
      base === "pnpm-lock.yaml"
    ) {
      seen.add("npm");
    } else if (
      base === "requirements.txt" ||
      base.endsWith(".requirements.txt") ||
      base === "poetry.lock" ||
      base === "pyproject.toml"
    ) {
      seen.add("pypi");
    }
  }
  if (seen.size !== 1) return null;
  return [...seen][0];
}

// ─── rate limiting ────────────────────────────────────────────────────

// Uses the Workers `caches.default` API — a native, free, per-colo cache.
// Not globally-consistent, but for a portfolio demo it's plenty.
//
// Buckets so /scan (strict 3/min) and /og+/s (scraper-tolerant 60/min) share
// the same code path but don't collide on cache keys.
async function checkRateLimit(ip, bucket = "scan", limit = RATE_LIMIT_N) {
  const key = `https://vetlock-scan.internal/rl/${encodeURIComponent(bucket)}/${encodeURIComponent(ip)}`;
  const cached = await caches.default.match(key);
  const now = Date.now();
  let hits = [];
  if (cached) {
    try { hits = await cached.json(); } catch { hits = []; }
  }
  // Keep only entries in the current window.
  hits = hits.filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= limit) {
    const oldest = hits[0];
    const retryAfter = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - oldest)) / 1000));
    return { ok: false, retryAfter };
  }
  hits.push(now);
  // Cache the hit list. TTL = RATE_WINDOW_MS.
  await caches.default.put(key, new Response(JSON.stringify(hits), {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${RATE_WINDOW_MS / 1000}` },
  }));
  return { ok: true };
}

// ─── helpers ─────────────────────────────────────────────────────────

async function gzipBase64(str) {
  // Compress via CompressionStream (Workers supports gzip). Then base64.
  const enc = new TextEncoder();
  const stream = new Response(enc.encode(str)).body.pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

/**
 * Single source of truth for verdict resolution across renderers.
 *
 * Mirrors app.js renderResult (lines ~1003-1009): trust result.verdict when
 * it's one of the known strings; otherwise derive from the findings so a
 * malformed/older workflow output ({findings:[{severity:'BLOCK'}], verdict:
 * undefined}) doesn't render as 'UNKNOWN' in the OG card + shim while the
 * site's read-only replay derives 'BLOCK' from the same findings. Only
 * returns 'UNKNOWN' when there's no field AND no findings to derive from.
 *
 * @param {any} rawVerdict  result.verdict from the parsed JSON
 * @param {any[]} findings  result.findings, already coerced to an array
 * @returns {"BLOCK"|"WARN"|"CLEAN"|"UNKNOWN"}
 */
function deriveVerdict(rawVerdict, findings) {
  const uc = String(rawVerdict || "").toUpperCase();
  if (uc === "BLOCK" || uc === "WARN" || uc === "CLEAN") return uc;
  const fs = Array.isArray(findings) ? findings : [];
  if (fs.some((f) => f && f.severity === "BLOCK")) return "BLOCK";
  if (fs.some((f) => f && f.severity === "WARN"))  return "WARN";
  if (fs.length > 0) return "CLEAN";
  return "UNKNOWN";
}

/** XML-safe escape for text embedded in SVG/HTML output. */
function xml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Constrain a package name to a printable, boring alphabet before it lands
 * in an SVG text node or HTML attribute. Any character outside the npm/PyPI
 * name grammar is dropped rather than escaped — cleaner render, no room
 * for someone smuggling `</text>...` through a scan output.
 */
function sanitizePkg(name) {
  if (typeof name !== "string") return null;
  const cleaned = name.replace(/[^a-zA-Z0-9._@/\-]/g, "").slice(0, 60);
  return cleaned.length > 0 ? cleaned : null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function withCors(res) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}
function text(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}
