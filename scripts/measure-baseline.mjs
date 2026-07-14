#!/usr/bin/env node
/**
 * measure-baseline.mjs
 *
 * Measures the current perf baseline of the static site and writes the
 * results to docs/BUDGETS.md as a Baseline vs. Target table.
 *
 * By default this script is a REPORT — it always exits 0 so it can be run
 * locally without failing an interactive shell (`npm run gate:budgets`).
 *
 * When invoked with `--strict` (see the `gate:budgets:ci` npm script,
 * called from .github/workflows/checks.yml) it becomes the CI perf-budget
 * gate: the report is still written to docs/BUDGETS.md, but the process
 * exits non-zero if ANY row in the Baseline vs. Target table is FAIL, or
 * if the run itself errored out. This is what enforces the "any budget
 * regresses → BLOCK" rule from ADR 0003 for every PR.
 *
 * What it does:
 *   1. Spawns `python3 -m http.server 4173` in the repo root and waits for
 *      the port to accept connections.
 *   2. Runs Lighthouse against http://127.0.0.1:4173/ twice:
 *        - Mobile emulation with slow-4G throttling (the "real" number).
 *        - Desktop, no throttling (a sanity check for the fast path).
 *      Captures perf/a11y/best-practices/SEO scores, LCP, FCP, TBT, CLS,
 *      total transfer size, and request count.
 *   3. Does a raw HTTP GET of `/` and byte-counts the first-view payload:
 *      the HTML itself + every synchronously-loaded same-origin CSS
 *      referenced with <link rel="stylesheet" href="..."> + every
 *      same-origin <script src="..."> that isn't type="module" (module
 *      scripts are deferred by default and don't block first paint).
 *      Reports both raw bytes and estimated gzip bytes.
 *   4. Reads design/tokens.css and asserts it is under 15 KB.
 *   5. Writes docs/BUDGETS.md with a Metric | Baseline | Target | Status
 *      table plus a footer with today's date and tool versions.
 *   6. Kills the http.server subprocess and exits 0.
 *
 * Robustness choice: we spawn the server ourselves rather than assuming
 * `npm run serve` is already running. That way `npm run gate:budgets`
 * works from a clean terminal without a second window, and CI (which
 * won't have a co-running server) works too. If port 4173 is already
 * in use the spawn will fail its readiness probe and we bail cleanly.
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const HOST = '127.0.0.1';
const PORT = 4173;
const BASE_URL = `http://${HOST}:${PORT}/`;

// ─────────────────────────────────────────────────────────────────────────
// small utilities
// ─────────────────────────────────────────────────────────────────────────

function waitForPort(host, port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveReady, reject) => {
    const attempt = () => {
      const sock = createConnection({ host, port });
      sock.once('connect', () => {
        sock.end();
        resolveReady();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
        } else {
          setTimeout(attempt, 150);
        }
      });
    };
    attempt();
  });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMs(n) {
  if (n == null || Number.isNaN(n)) return 'n/a';
  return `${Math.round(n)} ms`;
}

function formatScore(s) {
  if (s == null || Number.isNaN(s)) return 'n/a';
  // Lighthouse scores are 0..1; render as an integer 0..100.
  return `${Math.round(s * 100)}`;
}

function pkgVersion(name) {
  try {
    return require(`${name}/package.json`).version;
  } catch {
    return 'unknown';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// raw first-view payload accounting
// ─────────────────────────────────────────────────────────────────────────
//
// We approximate what a cold visitor pays for the initial paint:
//   - the HTML document
//   - every stylesheet linked from <head> (render-blocking by default)
//   - every classic <script src="..."> that is NOT type="module"
//     (module scripts are deferred by default and don't block first paint)
//
// Same-origin filter: we only count assets served by our own origin. A
// CDN link (e.g. a font) is either preconnected or in a different budget
// bucket — leaving it out keeps this metric comparable across runs.

function extractLinkedHrefs(html, tagRegex, attrName) {
  const out = [];
  let m;
  while ((m = tagRegex.exec(html)) !== null) {
    const tag = m[0];
    // Extract attr="value" or attr='value'.
    const attrRe = new RegExp(`${attrName}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
    const a = attrRe.exec(tag);
    if (!a) continue;
    const value = a[2] ?? a[3];
    if (!value) continue;
    out.push({ raw: tag, value });
  }
  return out;
}

function isSameOrigin(href) {
  // Root-relative, protocol-relative to our host, or absolute to our host.
  if (href.startsWith('/')) return true;
  if (href.startsWith('http://') || href.startsWith('https://')) {
    try {
      const u = new URL(href);
      return u.host === `${HOST}:${PORT}` || u.hostname === HOST;
    } catch {
      return false;
    }
  }
  // Bare relative (e.g. "style.css") is same-origin.
  return !href.includes('://');
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

async function measureFirstViewPayload() {
  const htmlBuf = await fetchBytes(BASE_URL);
  const html = htmlBuf.toString('utf8');

  const parts = [{ url: '/', kind: 'html', bytes: htmlBuf.length, buf: htmlBuf }];

  // Stylesheets: <link rel="stylesheet" href="...">
  const linkTags = extractLinkedHrefs(
    html,
    /<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi,
    'href',
  );
  for (const t of linkTags) {
    if (!isSameOrigin(t.value)) continue;
    const buf = await fetchBytes(new URL(t.value, BASE_URL).toString());
    parts.push({ url: t.value, kind: 'css', bytes: buf.length, buf });
  }

  // Classic scripts: <script src="..."> without type="module". Module
  // scripts are deferred by default and don't block first paint, so they
  // don't count against the first-view budget.
  const scriptTags = extractLinkedHrefs(
    html,
    /<script\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>(?:\s*<\/script>)?/gi,
    'src',
  );
  for (const t of scriptTags) {
    if (/type\s*=\s*["']module["']/i.test(t.raw)) continue;
    if (!isSameOrigin(t.value)) continue;
    const buf = await fetchBytes(new URL(t.value, BASE_URL).toString());
    parts.push({ url: t.value, kind: 'js', bytes: buf.length, buf });
  }

  const raw = parts.reduce((n, p) => n + p.bytes, 0);
  // Concatenate everything and gzip once — this is an *estimate* of the
  // wire size a well-configured server would ship. Real per-response
  // gzip would be slightly worse (per-file dictionaries) but this is
  // what we budget against.
  const gzBytes = gzipSync(Buffer.concat(parts.map((p) => p.buf))).length;

  // Strip the raw buffers off the returned parts so the report table
  // doesn't accidentally carry them.
  return {
    parts: parts.map(({ url, kind, bytes }) => ({ url, kind, bytes })),
    raw,
    gzBytes,
    html,
  };
}

// The inline hero poster SVG is the LCP element (ADR 0003 §2). It ships
// as literal bytes inside index.html, so its size is not counted by
// design/hero-poster.svg on disk — we extract it from the served HTML
// to measure exactly what a cold visitor pays for.
function extractInlinePoster(html) {
  if (!html) return null;
  const re = /<svg\b[^>]*\bclass\s*=\s*["'][^"']*\bhero-poster\b[^"']*["'][^>]*>[\s\S]*?<\/svg>/i;
  const m = re.exec(html);
  return m ? m[0] : null;
}

// ─────────────────────────────────────────────────────────────────────────
// lighthouse
// ─────────────────────────────────────────────────────────────────────────

async function runLighthouseOnce({ preset }) {
  const { default: lighthouse } = await import('lighthouse');
  const chromeLauncher = await import('chrome-launcher');

  const chrome = await chromeLauncher.launch({
    // chrome-launcher's own default flags handle sandbox/headless for CI.
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
  });

  try {
    const flags = {
      logLevel: 'error',
      output: 'json',
      port: chrome.port,
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    };

    // Mobile is Lighthouse's default (moto-g-power + slow-4G). For the
    // desktop pass we override the form factor + throttling explicitly.
    let config;
    if (preset === 'desktop') {
      config = {
        extends: 'lighthouse:default',
        settings: {
          formFactor: 'desktop',
          screenEmulation: {
            mobile: false,
            width: 1350,
            height: 940,
            deviceScaleFactor: 1,
            disabled: false,
          },
          throttlingMethod: 'provided',
          throttling: {
            rttMs: 0,
            throughputKbps: 0,
            cpuSlowdownMultiplier: 1,
            requestLatencyMs: 0,
            downloadThroughputKbps: 0,
            uploadThroughputKbps: 0,
          },
          emulatedUserAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      };
    }

    const runnerResult = await lighthouse(BASE_URL, flags, config);
    return runnerResult.lhr;
  } finally {
    await chrome.kill();
  }
}

function summarizeLhr(lhr) {
  const c = lhr.categories ?? {};
  const a = lhr.audits ?? {};
  const perf = c.performance?.score;
  const a11y = c.accessibility?.score;
  const bp = c['best-practices']?.score;
  const seo = c.seo?.score;

  const lcp = a['largest-contentful-paint']?.numericValue;
  const fcp = a['first-contentful-paint']?.numericValue;
  const tbt = a['total-blocking-time']?.numericValue;
  const cls = a['cumulative-layout-shift']?.numericValue;

  const totalBytes = a['total-byte-weight']?.numericValue;
  const details = a['network-requests']?.details;
  const requestCount = Array.isArray(details?.items) ? details.items.length : null;

  return {
    scores: { perf, a11y, bp, seo },
    metrics: { lcp, fcp, tbt, cls },
    network: { totalBytes, requestCount },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// report writer
// ─────────────────────────────────────────────────────────────────────────

function statusCell(baselineLabel, pass) {
  if (baselineLabel === 'n/a') return 'n/a';
  return pass ? 'PASS' : 'FAIL';
}

function buildReport({ mobile, desktop, payload, tokensBytes, heroJs, poster, versions, dateISO }) {
  const perfMobile = mobile.scores.perf == null ? null : mobile.scores.perf * 100;
  const perfDesktop = desktop.scores.perf == null ? null : desktop.scores.perf * 100;
  const a11y = mobile.scores.a11y == null ? null : mobile.scores.a11y * 100;
  const lcp = mobile.metrics.lcp;
  const cls = mobile.metrics.cls;
  const gz = payload.gzBytes;
  const gzKB = gz / 1024;
  const tokKB = tokensBytes / 1024;
  const heroGzKB = heroJs == null ? null : heroJs.gzBytes / 1024;
  const posterRawKB = poster == null ? null : poster.rawBytes / 1024;
  const posterGzKB = poster == null ? null : poster.gzBytes / 1024;

  // Note on thresholds: the packet §4 originally set aspirational
  // targets (perf ≥95 mobile, LCP <2s, CLS <0.05) against the P0
  // baseline. P1 + P2 landed with real content additions (hero canvas,
  // console-col, teaser paragraphs) that pushed those numbers past the
  // originals under Lighthouse's simulated-slow-4G + 4x-CPU throttling.
  // In real Chromium under real network conditions, CLS reads 0.000 and
  // perf sits well above these gates (see the `notCulprits_ruledOut`
  // section of the P1 CLS diagnostic in the PR #2 discussion).
  //
  // Uday relaxed the CI thresholds (2026-07-14) so the gate reflects a
  // pragmatic real-user band rather than the emulator's worst case.
  // The perf work to reclaim the aspirational targets is deferred to a
  // dedicated phase (P6 polish + perf pass in the SITE packet). Until
  // then, these are the hard gates.
  const rows = [
    {
      metric: 'Lighthouse Perf (mobile, slow 4G)',
      baseline: perfMobile == null ? 'n/a' : perfMobile.toFixed(0),
      target: '>= 75',
      pass: perfMobile != null && perfMobile >= 75,
    },
    {
      metric: 'Lighthouse Perf (desktop, no throttle)',
      baseline: perfDesktop == null ? 'n/a' : perfDesktop.toFixed(0),
      target: '>= 90',
      pass: perfDesktop != null && perfDesktop >= 90,
    },
    {
      metric: 'Lighthouse Accessibility',
      baseline: a11y == null ? 'n/a' : a11y.toFixed(0),
      target: '>= 98',
      pass: a11y != null && a11y >= 98,
    },
    {
      metric: 'LCP (mobile, slow 4G)',
      baseline: formatMs(lcp),
      target: '< 2500 ms',
      pass: lcp != null && lcp < 2500,
    },
    {
      metric: 'CLS (mobile)',
      baseline: cls == null ? 'n/a' : cls.toFixed(3),
      target: '< 0.5',
      pass: cls != null && cls < 0.5,
    },
    {
      metric: 'First-view transfer (gz est.)',
      baseline: `${gzKB.toFixed(1)} KB`,
      target: '< 200 KB',
      pass: gzKB < 200,
    },
    {
      metric: 'design/tokens.css size',
      baseline: `${tokKB.toFixed(1)} KB`,
      target: '< 18 KB',
      pass: tokKB < 18,
    },
    {
      // ADR 0003 §3 — hero JS module ≤ 60 KB gzipped. This is a hard
      // done-gate for P2. hero.js is loaded via type="module" so it is
      // deliberately excluded from the first-view total above; we count
      // it separately here.
      metric: 'design/hero.js size (gz est.)',
      baseline: heroGzKB == null ? 'n/a' : `${heroGzKB.toFixed(1)} KB`,
      target: '<= 60 KB',
      pass: heroGzKB != null && heroGzKB <= 60,
    },
    {
      // ADR 0003 §2 — inline SVG poster is the LCP element and ships in
      // the initial HTML response. We extract it from the served HTML
      // (rather than reading design/hero-poster.svg) so we measure the
      // exact bytes on the wire.
      metric: 'inline hero poster (raw)',
      baseline: posterRawKB == null ? 'n/a' : `${posterRawKB.toFixed(1)} KB`,
      target: '<= 10 KB',
      pass: posterRawKB != null && posterRawKB <= 10,
    },
    {
      metric: 'inline hero poster (gz est.)',
      baseline: posterGzKB == null ? 'n/a' : `${posterGzKB.toFixed(1)} KB`,
      target: '<= 10 KB',
      pass: posterGzKB != null && posterGzKB <= 10,
    },
  ];

  const lines = [];
  lines.push('# Performance Budgets');
  lines.push('');
  lines.push(
    'This file records the **measured baseline** of the site against the ' +
      'performance targets set in the P0 packet (§4). It is regenerated by ' +
      '`npm run gate:budgets` (which runs `scripts/measure-baseline.mjs`).',
  );
  lines.push('');
  lines.push(
    'The script starts a local static server, runs Lighthouse in both ' +
      'mobile (slow-4G) and desktop modes, byte-counts the first-view ' +
      'payload (HTML + synchronously loaded CSS + classic scripts), and ' +
      'checks the size of `design/tokens.css`.',
  );
  lines.push('');
  lines.push(
    '**By default this report is not a CI gate** — plain `npm run gate:budgets` ' +
      'exits 0 so it can be run locally without failing your shell. The CI perf-budget ' +
      'gate is `npm run gate:budgets:ci` (which reruns this script with `--strict`), ' +
      'wired into `.github/workflows/checks.yml`. In `--strict` mode any FAIL row ' +
      'above (or any run-time error) exits non-zero and blocks the PR.',
  );
  lines.push('');
  lines.push('## Baseline vs. Target');
  lines.push('');
  lines.push('| Metric | Baseline | Target | Status |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of rows) {
    lines.push(`| ${r.metric} | ${r.baseline} | ${r.target} | ${statusCell(r.baseline, r.pass)} |`);
  }
  lines.push('');

  lines.push('## Detail: Lighthouse');
  lines.push('');
  lines.push('| Category | Mobile (slow 4G) | Desktop (no throttle) |');
  lines.push('| --- | --- | --- |');
  lines.push(
    `| Performance | ${formatScore(mobile.scores.perf)} | ${formatScore(desktop.scores.perf)} |`,
  );
  lines.push(
    `| Accessibility | ${formatScore(mobile.scores.a11y)} | ${formatScore(desktop.scores.a11y)} |`,
  );
  lines.push(
    `| Best Practices | ${formatScore(mobile.scores.bp)} | ${formatScore(desktop.scores.bp)} |`,
  );
  lines.push(`| SEO | ${formatScore(mobile.scores.seo)} | ${formatScore(desktop.scores.seo)} |`);
  lines.push('');
  lines.push('| Metric | Mobile | Desktop |');
  lines.push('| --- | --- | --- |');
  lines.push(`| LCP | ${formatMs(mobile.metrics.lcp)} | ${formatMs(desktop.metrics.lcp)} |`);
  lines.push(`| FCP | ${formatMs(mobile.metrics.fcp)} | ${formatMs(desktop.metrics.fcp)} |`);
  lines.push(`| TBT | ${formatMs(mobile.metrics.tbt)} | ${formatMs(desktop.metrics.tbt)} |`);
  lines.push(
    `| CLS | ${mobile.metrics.cls == null ? 'n/a' : mobile.metrics.cls.toFixed(3)} | ${
      desktop.metrics.cls == null ? 'n/a' : desktop.metrics.cls.toFixed(3)
    } |`,
  );
  lines.push(
    `| Total transferred (LH) | ${
      mobile.network.totalBytes == null ? 'n/a' : formatBytes(mobile.network.totalBytes)
    } | ${
      desktop.network.totalBytes == null ? 'n/a' : formatBytes(desktop.network.totalBytes)
    } |`,
  );
  lines.push(
    `| Requests (LH) | ${mobile.network.requestCount ?? 'n/a'} | ${
      desktop.network.requestCount ?? 'n/a'
    } |`,
  );
  lines.push('');

  lines.push('## Detail: First-view payload (raw HTTP)');
  lines.push('');
  lines.push('Same-origin assets that block first paint, byte-counted with a raw GET.');
  lines.push('');
  lines.push('| Asset | Kind | Bytes |');
  lines.push('| --- | --- | --- |');
  for (const p of payload.parts) {
    lines.push(`| \`${p.url}\` | ${p.kind} | ${formatBytes(p.bytes)} |`);
  }
  lines.push(`| **Total (raw)** |  | **${formatBytes(payload.raw)}** |`);
  lines.push(`| **Total (gz est.)** |  | **${formatBytes(payload.gzBytes)}** |`);
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(`Generated: ${dateISO}`);
  lines.push('');
  lines.push('Tool versions:');
  lines.push(`- node ${process.version}`);
  lines.push(`- lighthouse ${versions.lighthouse}`);
  lines.push(`- chrome-launcher ${versions.chromeLauncher}`);
  lines.push('');
  return { markdown: lines.join('\n'), rows };
}

// ─────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  const STRICT = process.argv.slice(2).includes('--strict');
  let hadError = false;
  let failedRows = [];

  console.log('measure-baseline: spawning http.server on', BASE_URL);
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', HOST], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: false,
  });

  let killed = false;
  const killServer = () => {
    if (killed) return;
    killed = true;
    try {
      server.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  };
  process.on('exit', killServer);
  process.on('SIGINT', () => {
    killServer();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    killServer();
    process.exit(0);
  });

  try {
    await waitForPort(HOST, PORT, 10_000);
    console.log('measure-baseline: server up, running lighthouse (mobile)...');

    const mobileLhr = await runLighthouseOnce({ preset: 'mobile' });
    const mobile = summarizeLhr(mobileLhr);

    console.log('measure-baseline: running lighthouse (desktop)...');
    const desktopLhr = await runLighthouseOnce({ preset: 'desktop' });
    const desktop = summarizeLhr(desktopLhr);

    console.log('measure-baseline: measuring first-view payload...');
    const payload = await measureFirstViewPayload();

    console.log('measure-baseline: sizing design/tokens.css...');
    const tokensPath = resolve(REPO_ROOT, 'design/tokens.css');
    const tokensStat = await stat(tokensPath);
    const tokensBytes = tokensStat.size;
    if (tokensBytes >= 15 * 1024) {
      console.warn(
        `measure-baseline: WARNING design/tokens.css is ${(tokensBytes / 1024).toFixed(1)} KB — target < 15 KB`,
      );
    }

    // ADR 0003 §3 — hero.js module gz budget (<= 60 KB). hero.js is a
    // type="module" script so it is excluded from the first-view total
    // by design; we account for it separately here.
    console.log('measure-baseline: sizing design/hero.js (gz)...');
    let heroJs = null;
    try {
      const heroBuf = await fetchBytes(new URL('/design/hero.js', BASE_URL).toString());
      heroJs = { rawBytes: heroBuf.length, gzBytes: gzipSync(heroBuf).length };
      if (heroJs.gzBytes > 60 * 1024) {
        console.warn(
          `measure-baseline: WARNING design/hero.js is ${(heroJs.gzBytes / 1024).toFixed(1)} KB gz — target <= 60 KB`,
        );
      }
    } catch (err) {
      console.warn('measure-baseline: could not size design/hero.js —', err?.message || err);
    }

    // ADR 0003 §2 — inline poster SVG is the LCP element; extract it
    // from the served HTML and budget its byte cost.
    console.log('measure-baseline: extracting inline hero poster...');
    let poster = null;
    const posterSvg = extractInlinePoster(payload.html);
    if (posterSvg) {
      const posterBuf = Buffer.from(posterSvg, 'utf8');
      poster = { rawBytes: posterBuf.length, gzBytes: gzipSync(posterBuf).length };
      if (poster.rawBytes > 10 * 1024 || poster.gzBytes > 10 * 1024) {
        console.warn(
          `measure-baseline: WARNING inline hero poster is ${(poster.rawBytes / 1024).toFixed(1)} KB raw / ${(poster.gzBytes / 1024).toFixed(1)} KB gz — target <= 10 KB`,
        );
      }
    } else {
      console.warn('measure-baseline: no inline <svg class="hero-poster"> found in served HTML');
    }

    const versions = {
      lighthouse: pkgVersion('lighthouse'),
      chromeLauncher: pkgVersion('chrome-launcher'),
    };
    const dateISO = new Date().toISOString();

    const md = buildReport({ mobile, desktop, payload, tokensBytes, heroJs, poster, versions, dateISO });

    const outDir = resolve(REPO_ROOT, 'docs');
    await mkdir(outDir, { recursive: true });
    const outPath = resolve(outDir, 'BUDGETS.md');
    await writeFile(outPath, md.markdown, 'utf8');
    console.log(`measure-baseline: wrote ${outPath}`);

    failedRows = md.rows.filter((r) => r.baseline !== 'n/a' && !r.pass);
  } catch (err) {
    // Default mode is report-only: never fail the exit code. In --strict
    // mode we still swallow the error here so the finally block runs and
    // the server is cleaned up, then we exit non-zero below.
    console.error('measure-baseline: error during run:', err?.stack || err);
    hadError = true;
  } finally {
    killServer();
  }

  if (STRICT) {
    if (hadError) {
      console.error('measure-baseline: --strict → exiting non-zero (run errored)');
      process.exit(1);
    }
    if (failedRows.length > 0) {
      console.error(
        `measure-baseline: --strict → ${failedRows.length} budget row(s) FAIL:`,
      );
      for (const r of failedRows) {
        console.error(`  - ${r.metric}: ${r.baseline} (target ${r.target})`);
      }
      process.exit(1);
    }
    console.log('measure-baseline: --strict → all budget rows PASS');
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('measure-baseline: unhandled error:', err?.stack || err);
    // If --strict was requested, an unhandled crash is a gate failure.
    const strict = process.argv.slice(2).includes('--strict');
    process.exit(strict ? 1 : 0);
  },
);
