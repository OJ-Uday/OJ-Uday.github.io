#!/usr/bin/env node
/**
 * gate-perf.mjs
 *
 * Hard CI gate that reads docs/BUDGETS.md's "Baseline vs. Target" table
 * and exits non-zero on any FAIL row.
 *
 * Companion to scripts/measure-baseline.mjs, which is intentionally
 * report-only (always exits 0). This script is the enforcement seam
 * referenced by BUDGETS.md's "The actual gate lives in
 * .github/workflows/checks.yml" note.
 *
 * The gate is intentionally simple:
 *   1. Read docs/BUDGETS.md.
 *   2. Locate the "## Baseline vs. Target" section and its markdown
 *      table.
 *   3. Parse the Status column of every data row.
 *   4. Exit 1 if any row's status is FAIL; exit 0 otherwise. Rows with
 *      status "n/a" are treated as passing (the metric could not be
 *      measured; measure-baseline.mjs already logged the reason).
 *
 * Why parse the committed report instead of re-running Lighthouse in
 * CI? Re-running Lighthouse from GitHub Actions is noisy (shared
 * runners, variable throttling) and would require a much heavier CI
 * setup. Reading the committed report forces the author to (a) run
 * `npm run gate:budgets` locally when perf-relevant code changes and
 * (b) commit the updated BUDGETS.md — any FAIL row then blocks merge.
 * If the committed report is stale, the reviewer sees stale numbers
 * and can request a refresh; that failure mode is louder than the
 * previous "no gate at all" failure mode this script replaces.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const BUDGETS_PATH = resolve(REPO_ROOT, 'docs/BUDGETS.md');

function parseBaselineTable(md) {
  // Find the "## Baseline vs. Target" section. Anything after this
  // heading and before the next "## " heading is the section body.
  const startRe = /^##\s+Baseline vs\. Target\s*$/m;
  const startMatch = startRe.exec(md);
  if (!startMatch) {
    throw new Error('gate-perf: could not find "## Baseline vs. Target" section in docs/BUDGETS.md');
  }
  const afterStart = md.slice(startMatch.index + startMatch[0].length);
  const nextHeadingRe = /^##\s+/m;
  const nextHeadingMatch = nextHeadingRe.exec(afterStart);
  const section = nextHeadingMatch ? afterStart.slice(0, nextHeadingMatch.index) : afterStart;

  const lines = section.split('\n');

  // A markdown table row looks like: | col1 | col2 | col3 | col4 |
  // We want data rows only — skip the header row and the separator
  // row (which contains only dashes and pipes).
  const rows = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    // Split on unescaped pipes and drop the empty first/last cells that
    // come from the leading/trailing pipe.
    const cells = line.slice(1, -1).split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    // Skip separator row (e.g. | --- | --- | --- | --- |).
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    // Skip header row.
    if (cells[0].toLowerCase() === 'metric' && cells[3].toLowerCase() === 'status') continue;
    rows.push({ metric: cells[0], baseline: cells[1], target: cells[2], status: cells[3] });
  }

  if (rows.length === 0) {
    throw new Error('gate-perf: found "Baseline vs. Target" section but no data rows');
  }

  return rows;
}

async function main() {
  let md;
  try {
    md = await readFile(BUDGETS_PATH, 'utf8');
  } catch (err) {
    console.error(`gate-perf: could not read ${BUDGETS_PATH}: ${err.message}`);
    console.error('gate-perf: run `npm run gate:budgets` to generate the report.');
    process.exit(1);
  }

  let rows;
  try {
    rows = parseBaselineTable(md);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const failed = rows.filter((r) => r.status.toUpperCase() === 'FAIL');
  const passed = rows.filter((r) => r.status.toUpperCase() === 'PASS');
  const na = rows.filter((r) => r.status.toLowerCase() === 'n/a');

  console.log(`gate-perf: ${passed.length} PASS, ${failed.length} FAIL, ${na.length} n/a`);
  for (const r of rows) {
    const tag = r.status.toUpperCase() === 'FAIL' ? 'FAIL' : r.status;
    console.log(`  [${tag}] ${r.metric}: ${r.baseline} (target ${r.target})`);
  }

  if (failed.length > 0) {
    console.error('');
    console.error(`gate-perf: ${failed.length} budget row(s) FAIL in docs/BUDGETS.md.`);
    console.error('gate-perf: fix the regression or update the baseline via `npm run gate:budgets`.');
    process.exit(1);
  }

  console.log('gate-perf: all budget rows PASS.');
  process.exit(0);
}

main().catch((err) => {
  console.error('gate-perf: unexpected error:', err?.stack || err);
  process.exit(1);
});
