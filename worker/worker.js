/**
 * Cloudflare Worker — vetlock lockfile scan backend.
 *
 * Sits between oj-uday.github.io (portfolio site) and the
 * OJ-Uday/vetlock-web-scans repo (GitHub Actions workflow).
 *
 * Flow:
 *   POST /scan     → validates payload, generates scan_id, dispatches workflow,
 *                    returns { scanId }
 *   GET  /scan/:id → polls raw.githubusercontent.com/.../results/<id>.json;
 *                    202 while pending, 200 with {result} when ready
 *
 * Free tier fits: 100 K reqs/day, no compute-cost surprises.
 *
 * Environment (set via `wrangler secret put` or dashboard):
 *   GH_DISPATCH_TOKEN  — fine-grained GitHub PAT with `actions:write` on
 *                        OJ-Uday/vetlock-web-scans. Nothing else.
 *
 * Static config:
 *   REPO_OWNER        = "OJ-Uday"
 *   REPO_NAME         = "vetlock-web-scans"
 *   WORKFLOW_FILENAME = "scan.yml"
 *   ALLOWED_ORIGIN    = "https://oj-uday.github.io"
 *   MAX_BYTES         = 500_000  (per lockfile, post-decode)
 *   POLL_TIMEOUT_MS   = 90_000
 *   RATE_WINDOW_MS    = 60_000
 *   RATE_LIMIT_N      = 3
 */

const REPO_OWNER = "OJ-Uday";
const REPO_NAME = "vetlock-web-scans";
const WORKFLOW_FILENAME = "scan.yml";
const ALLOWED_ORIGIN = "https://oj-uday.github.io";
const MAX_BYTES_PER_LOCKFILE = 500_000;
const MAX_REQUEST_BYTES = 1_100_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_N = 3;

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

export default {
  /**
   * @param {Request} request
   * @param {{ GH_DISPATCH_TOKEN: string }} env
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── CORS preflight ────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/scan" && request.method === "POST") {
        return withCors(await handleScan(request, env, ctx));
      }
      const m = url.pathname.match(/^\/scan\/([a-f0-9]{16,32})$/);
      if (m && request.method === "GET") {
        return withCors(await handleStatus(m[1]));
      }
      if (url.pathname === "/" || url.pathname === "/health") {
        return withCors(json({ ok: true, service: "vetlock-scan-worker", version: 1 }));
      }
      return withCors(text("Not found", 404));
    } catch (err) {
      // Never crash the Worker; return structured error the site can render.
      console.error("worker error:", err);
      return withCors(json({ error: err?.message || String(err) }, 500));
    }
  },
};

// ─── handlers ────────────────────────────────────────────────────────

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
    return json({ error: `GitHub dispatch failed (${dispatchRes.status})`, detail: errText.slice(0, 200) }, 502);
  }

  return json({ scanId, statusUrl: `/scan/${scanId}` }, 202);
}

async function handleStatus(scanId) {
  // Poll raw.githubusercontent.com — the workflow commits results/<scanId>.json.
  // Note: raw.githubusercontent.com has ~5 min CDN cache but honors If-None-Match,
  // and the file appears fresh on each new commit (URL doesn't change but content
  // does). To be safe we bust with a cache: 'no-store' on the fetch.
  const raw = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/results/${scanId}.json`;
  const res = await fetch(raw, { cache: "no-store" });
  if (res.status === 200) {
    const text = await res.text();
    try {
      const result = JSON.parse(text);
      return json({ status: "ready", result }, 200);
    } catch {
      return json({ status: "corrupt", detail: "result file not valid JSON yet" }, 202);
    }
  }
  if (res.status === 404) {
    // Not committed yet. Stage guess based on how long we've been waiting is
    // handled on the client (start time known there). We still return a hint.
    return json({ status: "pending", stage: "running" }, 202);
  }
  return json({ status: "upstream-error", code: res.status }, 502);
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

// ─── rate limiting ────────────────────────────────────────────────────

// Uses the Workers `caches.default` API — a native, free, per-colo cache.
// Not globally-consistent, but for a portfolio demo it's plenty.
async function checkRateLimit(ip) {
  const key = `https://vetlock-scan.internal/rl/${encodeURIComponent(ip)}`;
  const cached = await caches.default.match(key);
  const now = Date.now();
  let hits = [];
  if (cached) {
    try { hits = await cached.json(); } catch { hits = []; }
  }
  // Keep only entries in the current window.
  hits = hits.filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_N) {
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
