// The page's own telemetry + the vetlock lockfile scanner.
//
// Every event in the console is real — captured from this tab, rendered into
// the hero panel, and never transmitted anywhere. The scanner is the ONE
// exception: it POSTs your lockfile once to a Cloudflare Worker that
// dispatches a public GitHub Actions workflow running vetlock. Full source at
// https://github.com/OJ-Uday/vetlock-web-scans — inspect before you click.
//
// Hand-written IIFE. No frameworks, no bundler.
(() => {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════
  // TELEMETRY CONSOLE
  // ═══════════════════════════════════════════════════════════════════════

  const feed = document.getElementById("feed");
  const uptimeEl = document.getElementById("uptime");
  const fmtToggle = document.getElementById("fmt-toggle");
  const MAX_ROWS = 64;
  const t0 = performance.now();
  const events = [];  // ring buffer of raw event objects for re-rendering

  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = () => {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  };

  function emit(name, detail = "") {
    if (!feed) return;
    const evt = { t: stamp(), n: name, d: String(detail) };
    events.push(evt);
    if (events.length > MAX_ROWS) events.shift();
    renderEvent(evt);
    while (feed.children.length > MAX_ROWS) feed.firstChild.remove();
    feed.scrollTop = feed.scrollHeight;
  }

  function renderEvent(evt) {
    const row = document.createElement("div");
    row.className = "evt";
    // Cache both renderings on the DOM node so format-toggle is instant
    row.dataset.json = JSON.stringify(evt);
    const t = document.createElement("span"); t.className = "t"; t.textContent = evt.t;
    const n = document.createElement("span"); n.className = "n"; n.textContent = evt.n;
    const d = document.createElement("span"); d.className = "d"; d.textContent = evt.d;
    row.append(t, n, d);
    feed.append(row);
  }

  // format toggle: human ↔ json
  function setFmt(f) {
    if (!feed || !fmtToggle) return;
    feed.classList.toggle("json", f === "json");
    fmtToggle.textContent = f;
    try { localStorage.setItem("uo.fmt", f); } catch {}
  }
  fmtToggle?.addEventListener("click", () => {
    const next = feed.classList.contains("json") ? "human" : "json";
    setFmt(next);
    emit("console.fmt", next);
  });
  fmtToggle?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fmtToggle.click(); }
  });
  try { const saved = localStorage.getItem("uo.fmt"); if (saved === "json") setFmt("json"); } catch {}

  // page-view + hello
  const vp = innerWidth && innerHeight ? ` · ${innerWidth}×${innerHeight}` : "";
  emit("page.view", `${location.pathname}${vp}`);
  emit("agent.hello", "welcome — poke around, everything you do shows up here");

  // Section visibility
  const seen = new Set();
  const sections = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting && !seen.has(e.target.id)) {
          seen.add(e.target.id);
          emit("section.visible", `#${e.target.id}`);
        }
      }
    },
    { threshold: 0.25 }
  );
  document.querySelectorAll("main section[id]").forEach((s) => sections.observe(s));

  // Reveal-on-scroll animation
  const reveals = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add("in"); reveals.unobserve(e.target); }
      }
    },
    { threshold: 0.12 }
  );
  document.querySelectorAll(".reveal").forEach((el) => reveals.observe(el));

  // Delegated click capture
  addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest("a, button, [role=button]") : null;
    if (!target) return;
    const label =
      target.dataset.evt ||
      (target.textContent || "").trim().slice(0, 28) ||
      target.getAttribute("href") ||
      "unknown";
    emit("click", label);
  });

  // Scroll-depth milestones
  const marks = [25, 50, 75, 100];
  let nextMark = 0;
  addEventListener(
    "scroll",
    () => {
      const doc = document.documentElement;
      const pct = Math.round(((scrollY + innerHeight) / doc.scrollHeight) * 100);
      while (nextMark < marks.length && pct >= marks[nextMark]) {
        emit("scroll.depth", `${marks[nextMark]}%`);
        nextMark += 1;
      }
    },
    { passive: true }
  );

  // Visibility
  document.addEventListener("visibilitychange", () => emit("visibility", document.visibilityState));

  // Uptime ticker
  if (uptimeEl) {
    setInterval(() => {
      uptimeEl.textContent = `${Math.floor((performance.now() - t0) / 1000)}s`;
    }, 1000);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // KEYBOARD PALETTE — g-prefix nav + ? help
  // ═══════════════════════════════════════════════════════════════════════

  const kbdDialog = document.getElementById("kbd-help");
  const kbdClose = kbdDialog?.querySelector(".kh-close");
  const sectionsList = ["hero", "scan", "systems", "projects", "experience", "skills", "writing", "contact"];

  function goto(id) {
    const el = document.getElementById(id);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); emit("kbd.goto", `#${id}`); }
  }
  function currentSectionIdx() {
    // Return index of first section whose top is below viewport top by <200px, else 0.
    for (let i = 0; i < sectionsList.length; i++) {
      const el = document.getElementById(sectionsList[i]);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.top > 120) return Math.max(0, i - 1);
    }
    return sectionsList.length - 1;
  }

  // Lightweight leader-key state machine for `g <letter>`
  let leaderTimer = 0;
  let leaderActive = false;
  function startLeader() {
    leaderActive = true;
    clearTimeout(leaderTimer);
    leaderTimer = setTimeout(() => { leaderActive = false; }, 1200);
  }
  function stopLeader() { leaderActive = false; clearTimeout(leaderTimer); }

  addEventListener("keydown", (e) => {
    // Ignore when typing in an input or when modifiers are held (except plain shift for `?`)
    const t = e.target;
    if (t instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(t.tagName)) return;
    if (t instanceof HTMLElement && t.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      e.preventDefault();
      if (kbdDialog?.open) kbdDialog.close(); else kbdDialog?.showModal();
      emit("kbd.help", kbdDialog?.open ? "open" : "close");
      return;
    }
    if (e.key === "Escape" && kbdDialog?.open) { kbdDialog.close(); return; }

    if (leaderActive) {
      stopLeader();
      const m = { h: "hero", s: "scan", p: "projects", x: "experience", c: "contact", w: "writing", k: "skills" };
      if (m[e.key]) { e.preventDefault(); goto(m[e.key]); }
      return;
    }
    if (e.key === "g") { e.preventDefault(); startLeader(); return; }
    if (e.key === "j") { e.preventDefault(); const i = Math.min(sectionsList.length - 1, currentSectionIdx() + 1); goto(sectionsList[i]); return; }
    if (e.key === "k") { e.preventDefault(); const i = Math.max(0, currentSectionIdx() - 1); goto(sectionsList[i]); return; }
    if (e.key === "t") { e.preventDefault(); fmtToggle?.click(); return; }
  });
  kbdClose?.addEventListener("click", () => kbdDialog?.close());

  // ═══════════════════════════════════════════════════════════════════════
  // VETLOCK LOCKFILE SCANNER
  // ═══════════════════════════════════════════════════════════════════════

  // Backend endpoint. If the Worker isn't deployed yet, the site falls back to
  // the offline example renderer (still useful — shows what a scan looks like).
  const SCAN_ENDPOINT =
    // production Cloudflare Worker
    (window.__VETLOCK_SCAN_ENDPOINT__) ||
    "https://vetlock-scan.oj-uday.workers.dev";
  const POLL_INTERVAL_MS = 2000;
  const POLL_MAX_MS = 90_000;
  const MAX_LOCKFILE_BYTES = 500 * 1024;

  const state = {
    files: { before: null, after: null },
    corpusId: null,
    scanning: false,
    scanId: null,
    startedAt: 0,
    pollTimer: 0,
    aborter: null,
    elapsedTimer: 0,
  };

  const $ = (id) => document.getElementById(id);
  const dzBefore = $("dz-before");
  const dzAfter = $("dz-after");
  const runBtn = $("scan-run");
  const exBtn = $("scan-example");
  const exBenignBtn = $("scan-example-benign");
  const clearBtn = $("scan-clear");
  const cancelBtn = $("scan-cancel");
  const progressEl = $("scan-progress");
  const spFill = $("sp-fill");
  const spElapsed = $("sp-elapsed");
  const spMsg = $("sp-msg");
  const resultEl = $("scan-result");
  const errorEl = $("scan-error");

  // Hard reset — used on initial pageload AND on bfcache restore (browser back/forward
  // that resurrects the whole tab including live JS variables). Without this, closing
  // the tab mid-scan and reopening leaves a phantom "scan failed" banner glued to the
  // UI with a live poll timer that keeps firing showError() the moment you click Clear.
  function hardResetScanner() {
    // Kill any in-flight scan machinery — synchronous, not the delayed stopScan version.
    state.scanning = false;
    clearTimeout(state.pollTimer);
    clearInterval(state.elapsedTimer);
    if (state.aborter) { try { state.aborter.abort(); } catch {} state.aborter = null; }
    state.pollTimer = 0;
    state.elapsedTimer = 0;
    state.scanId = null;
    state.startedAt = 0;

    // Clear file state.
    state.files.before = null;
    state.files.after = null;
    state.corpusId = null;

    // Reset every visible UI slot.
    for (const dz of [dzBefore, dzAfter]) {
      if (!dz) continue;
      dz.classList.remove("filled", "error", "dragging");
      const meta = dz.querySelector(".dz-meta");
      if (meta) { meta.hidden = true; meta.textContent = ""; meta.classList.remove("warn"); }
      const inp = dz.querySelector("input[type=file]");
      if (inp) inp.value = "";
    }
    if (errorEl)    errorEl.hidden = true;
    if (resultEl)   resultEl.hidden = true;
    if (progressEl) progressEl.hidden = true;
    if (cancelBtn)  cancelBtn.hidden = true;
    if (clearBtn)   clearBtn.hidden = true;
    const seMsg = document.getElementById("se-msg");
    if (seMsg) seMsg.textContent = "";
    if (runBtn) runBtn.disabled = true;
  }

  // Attach dropzone handlers
  function wireDropzone(dz) {
    if (!dz) return;
    const input = dz.querySelector('input[type=file]');
    dz.addEventListener("click", () => input?.click());
    dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input?.click(); } });
    input?.addEventListener("change", () => { if (input.files?.[0]) handleFile(dz, input.files[0]); });

    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragging"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("dragging"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("dragging");
      const f = e.dataTransfer?.files?.[0];
      if (f) handleFile(dz, f);
    });
  }
  wireDropzone(dzBefore);
  wireDropzone(dzAfter);

  async function handleFile(dz, file) {
    const slot = dz.dataset.slot; // "before" | "after"
    if (file.size > MAX_LOCKFILE_BYTES) {
      dz.classList.add("error");
      dz.classList.remove("filled");
      const meta = dz.querySelector(".dz-meta");
      if (meta) { meta.hidden = false; meta.classList.add("warn"); meta.textContent = `× file too large (${(file.size/1024).toFixed(0)} KB, max ${MAX_LOCKFILE_BYTES/1024} KB)`; }
      state.files[slot] = null;
      updateRunEnabled();
      emit("scan.file.reject", `${slot} · too-large`);
      return;
    }
    let text;
    try { text = await file.text(); } catch (err) {
      showFileError(dz, `couldn't read file: ${err.message || err}`);
      return;
    }
    if (!validateLockfileText(text)) {
      showFileError(dz, "not a valid lockfile — need package-lock.json (v2/v3), yarn.lock, or pnpm-lock.yaml");
      return;
    }
    state.files[slot] = { name: file.name, size: file.size, text };
    state.corpusId = null;  // real file drop overrides any prior corpus selection
    clearScanUi();
    dz.classList.remove("error");
    dz.classList.add("filled");
    const meta = dz.querySelector(".dz-meta");
    if (meta) { meta.hidden = false; meta.classList.remove("warn"); meta.textContent = `✓ ${file.name} · ${(file.size/1024).toFixed(1)} KB`; }
    updateRunEnabled();
    emit("scan.file.load", `${slot} · ${file.name}`);
  }
  function showFileError(dz, msg) {
    dz.classList.add("error");
    dz.classList.remove("filled");
    const meta = dz.querySelector(".dz-meta");
    if (meta) { meta.hidden = false; meta.classList.add("warn"); meta.textContent = `× ${msg}`; }
    state.files[dz.dataset.slot] = null;
    updateRunEnabled();
    emit("scan.file.reject", msg.slice(0, 40));
  }
  function validateLockfileText(text) {
    if (!text || typeof text !== "string") return false;
    const head = text.slice(0, 200);
    if (head.startsWith("{")) {
      // package-lock.json — must have lockfileVersion
      try {
        const j = JSON.parse(text);
        return typeof j === "object" && "lockfileVersion" in j && j.packages;
      } catch { return false; }
    }
    if (head.includes("# yarn lockfile v1")) return true;
    if (head.includes("lockfileVersion:")) return true;   // pnpm
    return false;
  }
  function updateRunEnabled() {
    const ok = !!(state.files.before && state.files.after);
    runBtn.disabled = !ok || state.scanning;
    clearBtn.hidden = !(state.files.before || state.files.after);
  }

  // ── Example lockfiles ────────────────────────────────────────────────
  // Both examples reference REAL npm versions the backend can actually fetch.
  // - "malicious": ua-parser-js 0.7.28 → 0.7.29. Version 0.7.29 is the real
  //   password-stealer hijack from Oct 2021 (still on npm). vetlock's GHSA
  //   index knows GHSA-fh58-9fw3-vf2v and its behavioral detectors light up
  //   on the postinstall + child_process + net endpoints.
  // - "benign":    debug 4.3.4 → 4.3.5. Legitimate patch bump. Should scan CLEAN.
  const EXAMPLES = {
    shai: {
      label: "malicious — ua-parser-js@0.7.29 (real hijack, Oct 2021)",
      before: {
        name: "my-app", version: "1.0.0", lockfileVersion: 3,
        packages: {
          "": { name: "my-app", version: "1.0.0", dependencies: { "ua-parser-js": "^0.7.28" } },
          "node_modules/ua-parser-js": {
            name: "ua-parser-js", version: "0.7.28",
            resolved: "https://registry.npmjs.org/ua-parser-js/-/ua-parser-js-0.7.28.tgz",
            integrity: "sha512-6Gurc1n//gjp9eQNXjD9O3M/sMwVtN5S8Lv9bvOYBfKfDNiIIhqiyi01vMBO45u4zkDE420w/e0se7Vs+sIg+g==",
          },
        },
      },
      after: {
        name: "my-app", version: "1.0.0", lockfileVersion: 3,
        packages: {
          "": { name: "my-app", version: "1.0.0", dependencies: { "ua-parser-js": "^0.7.29" } },
          "node_modules/ua-parser-js": {
            name: "ua-parser-js", version: "0.7.29",
            resolved: "https://registry.npmjs.org/ua-parser-js/-/ua-parser-js-0.7.29.tgz",
            integrity: "sha512-gDZtHIloSe2CIhFbFqbcQEqTaXeUPzTvUyDCVCVAJvyDU0IsyOqhtBRToVsIDIapjKzMVw2Nx2eQxfEfhrhaog==",
          },
        },
      },
    },
    benign: {
      label: "benign — debug@4.3.4 → 4.3.5 (routine patch)",
      before: {
        name: "my-app", version: "1.0.0", lockfileVersion: 3,
        packages: {
          "": { name: "my-app", version: "1.0.0", dependencies: { debug: "^4.3.0" } },
          "node_modules/debug": {
            name: "debug", version: "4.3.4",
            resolved: "https://registry.npmjs.org/debug/-/debug-4.3.4.tgz",
            integrity: "sha512-PRWFHuSU3eDtQJPvnNY7Jcket1j0t5OuOsFzPPzsekD52Zl8qUfFIPEiswXqIvHWGVHOgX+7G/vCNNhehwxfkQ==",
          },
          "node_modules/ms": {
            name: "ms", version: "2.1.2",
            resolved: "https://registry.npmjs.org/ms/-/ms-2.1.2.tgz",
            integrity: "sha512-sGkPx+VjMtmA6MX27oA4FBFELFCZZ4S4XqeGOXCv68tT+jb3vk/RyaKWP0PTKyWtmLSM0b+adUTEvbs1PEaH2w==",
          },
        },
      },
      after: {
        name: "my-app", version: "1.0.0", lockfileVersion: 3,
        packages: {
          "": { name: "my-app", version: "1.0.0", dependencies: { debug: "^4.3.0" } },
          "node_modules/debug": {
            name: "debug", version: "4.3.5",
            resolved: "https://registry.npmjs.org/debug/-/debug-4.3.5.tgz",
            integrity: "sha512-pt0bNEmneDIvdL1Xsd9oDQ/wrQRkXDT4AUWlNZNPKvW5x/jyO9VFXkJUP07vQ2upmw5PlaITaPKc31jK13V+jg==",
          },
          "node_modules/ms": {
            name: "ms", version: "2.1.2",
            resolved: "https://registry.npmjs.org/ms/-/ms-2.1.2.tgz",
            integrity: "sha512-sGkPx+VjMtmA6MX27oA4FBFELFCZZ4S4XqeGOXCv68tT+jb3vk/RyaKWP0PTKyWtmLSM0b+adUTEvbs1PEaH2w==",
          },
        },
      },
    },
  };
  function loadExample(kind) {
    const ex = EXAMPLES[kind];
    if (!ex) return;
    state.corpusId = null;
    clearScanUi();
    const beforeText = JSON.stringify(ex.before, null, 2);
    const afterText = JSON.stringify(ex.after, null, 2);
    state.files.before = { name: `example-${kind}.before.json`, size: beforeText.length, text: beforeText };
    state.files.after = { name: `example-${kind}.after.json`, size: afterText.length, text: afterText };
    for (const [slot, dz] of [["before", dzBefore], ["after", dzAfter]]) {
      dz.classList.add("filled");
      dz.classList.remove("error");
      const meta = dz.querySelector(".dz-meta");
      if (meta) { meta.hidden = false; meta.classList.remove("warn"); meta.textContent = `✓ example-${kind}.${slot}.json · ${(state.files[slot].size/1024).toFixed(1)} KB`; }
    }
    updateRunEnabled();
    emit("scan.example.load", kind);
  }
  exBtn?.addEventListener("click", () => loadCorpusExample("shai-hulud-2025"));
  exBenignBtn?.addEventListener("click", () => loadExample("benign"));

  // A "corpus example" runs the workflow in `corpus_id` mode — the backend
  // uses vetlock's bundled fixture instead of decoding lockfile bytes. Perfect
  // for showcasing full malicious-scan output (13 Shai-Hulud findings) without
  // depending on hijack tarballs still being live on npm (most are unpublished).
  function loadCorpusExample(id) {
    state.corpusId = id;
    clearScanUi();
    state.files.before = { name: `corpus/${id}/lockfile.before.json`, size: 0, text: "" };
    state.files.after  = { name: `corpus/${id}/lockfile.after.json`,  size: 0, text: "" };
    for (const [slot, dz] of [["before", dzBefore], ["after", dzAfter]]) {
      dz.classList.add("filled");
      dz.classList.remove("error");
      const meta = dz.querySelector(".dz-meta");
      if (meta) { meta.hidden = false; meta.classList.remove("warn"); meta.textContent = `✓ (bundled fixture — vetlock corpus/${id}/lockfile.${slot}.json)`; }
    }
    updateRunEnabled();
    emit("scan.example.corpus", id);
  }
  clearBtn?.addEventListener("click", () => {
    hardResetScanner();
    emit("scan.clear", "");
  });

  // ── Run scan ─────────────────────────────────────────────────────────
  // Small helper: drop any stale scan UI (previous error banner, previous
  // result, previous progress bar) so a new scan starts on a clean slate.
  // Called by every user action that means "I want a fresh scan": Run,
  // Try example, Try benign, drop a file, Clear, Retry.
  function clearScanUi() {
    errorEl.hidden = true;
    resultEl.hidden = true;
    const seMsg = document.getElementById("se-msg");
    if (seMsg) seMsg.textContent = "";
    // If a scan was mid-flight, tear it down cleanly.
    if (state.scanning) stopScan("reset");
  }

  runBtn?.addEventListener("click", async () => {
    if (state.scanning || !state.files.before || !state.files.after) return;
    clearScanUi();
    startScan();
  });

  cancelBtn?.addEventListener("click", () => {
    if (!state.scanning) return;
    stopScan("cancelled");
    emit("scan.cancel", "");
  });

  function startScan() {
    state.scanning = true;
    state.startedAt = performance.now();
    state.aborter = new AbortController();
    runBtn.disabled = true;
    cancelBtn.hidden = false;
    resultEl.hidden = true;
    errorEl.hidden = true;
    progressEl.hidden = false;
    setStage("submitted");
    emit("scan.request", `before=${state.files.before.size}B after=${state.files.after.size}B`);
    // Elapsed ticker
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = setInterval(() => {
      const s = Math.floor((performance.now() - state.startedAt) / 1000);
      spElapsed.textContent = `${s}s`;
    }, 500);
    dispatchScan().catch((err) => {
      stopScan("error");
      showError(err.message || String(err));
      emit("scan.error", err.message || "");
    });
  }

  async function dispatchScan() {
    const payload = state.corpusId
      ? { corpus_id: state.corpusId }
      : { before: state.files.before.text, after: state.files.after.text };
    const body = JSON.stringify(payload);
    let res;
    try {
      res = await fetch(`${SCAN_ENDPOINT}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: state.aborter.signal,
      });
    } catch (err) {
      // Network / DNS / CORS failure — very likely the Worker isn't deployed yet.
      throw new Error(
        "The scan backend isn't reachable from this browser. This usually means the Cloudflare Worker hasn't been deployed yet — see the setup docs at github.com/OJ-Uday/vetlock-web-scans. In the meantime, you can run vetlock locally: `npx vetlock diff before.json after.json`."
      );
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After") || "60";
      throw new Error(`Rate-limited. Try again in ${retryAfter}s.`);
    }
    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`Backend rejected the scan (HTTP ${res.status}). ${text}`);
    }
    const { scanId } = await res.json();
    if (!scanId) throw new Error("Backend didn't return a scanId.");
    state.scanId = scanId;
    setStage("dispatched");
    emit("scan.dispatched", scanId);
    pollUntilReady(scanId);
  }

  async function pollUntilReady(scanId) {
    let transientErrors = 0;
    const MAX_TRANSIENT = 5;   // 5xx / network blips we tolerate before giving up
    const poll = async () => {
      if (!state.scanning) return;
      const elapsed = performance.now() - state.startedAt;
      if (elapsed > POLL_MAX_MS) {
        stopScan("timeout");
        showError("The scan is taking too long (>90s). This can happen when GitHub Actions is under heavy load. Try again, or run `npx vetlock diff` locally for an instant scan.");
        return;
      }
      let res;
      try {
        res = await fetch(`${SCAN_ENDPOINT}/scan/${scanId}`, { signal: state.aborter.signal });
      } catch { schedulePoll(); return; }
      if (res.status === 202) {
        // still running — extract stage hint if the Worker provides it
        try {
          const j = await res.json();
          if (j.stage) setStage(j.stage);
          if (j.msg) spMsg.textContent = j.msg;
        } catch {}
        transientErrors = 0;
        schedulePoll();
        return;
      }
      if (res.status === 200) {
        setStage("ready");
        const j = await res.json();
        stopScan("ready");
        emit("scan.result", `${j.result?.verdict || "?"} · ${j.result?.findings?.length || 0} findings`);
        renderResult(j.result);
        return;
      }
      // Transient upstream blips (5xx from CF / GitHub API mid-scan): keep polling
      // instead of showing a failure banner. The workflow is very likely still
      // running or the result file is still propagating on GitHub's edge.
      if (res.status >= 500 && res.status < 600) {
        transientErrors++;
        emit("scan.transient", `${res.status} · attempt ${transientErrors}/${MAX_TRANSIENT}`);
        if (transientErrors < MAX_TRANSIENT) { schedulePoll(); return; }
      }
      // Genuine client errors (400/413/415/429) or too many 5xx in a row: give up.
      const text = await safeText(res);
      stopScan("error");
      showError(`Scan failed (HTTP ${res.status}). ${text}`);
      emit("scan.error", `${res.status} ${text.slice(0, 40)}`);
    };
    schedulePoll();
    function schedulePoll() {
      const elapsed = performance.now() - state.startedAt;
      // Speed up polling early, back off later
      const interval = elapsed < 30_000 ? POLL_INTERVAL_MS : POLL_INTERVAL_MS * 2;
      state.pollTimer = setTimeout(poll, interval);
    }
  }

  function stopScan(reason) {
    state.scanning = false;
    clearTimeout(state.pollTimer);
    clearInterval(state.elapsedTimer);
    if (state.aborter) { try { state.aborter.abort(); } catch {} state.aborter = null; }
    cancelBtn.hidden = true;
    updateRunEnabled();
    if (reason !== "ready") {
      // fade progress ui out on failure/cancel
      setTimeout(() => { if (!state.scanning) progressEl.hidden = true; }, 400);
    }
  }

  async function safeText(res) {
    try { const t = await res.text(); return t.slice(0, 200); } catch { return ""; }
  }

  function showError(msg) {
    errorEl.hidden = false;
    document.getElementById("se-msg").textContent = msg;
  }
  document.getElementById("se-retry")?.addEventListener("click", () => {
    clearScanUi();
    if (state.files.before && state.files.after) startScan();
  });

  // ── Progress stages ──────────────────────────────────────────────────
  const STAGES = ["submitted", "dispatched", "running", "collecting", "ready"];
  function setStage(stage) {
    const idx = STAGES.indexOf(stage);
    if (idx < 0) return;
    const nodes = progressEl.querySelectorAll(".sp-stages li");
    nodes.forEach((li, i) => {
      li.classList.toggle("done", i < idx);
      li.classList.toggle("active", i === idx);
    });
    // Fill bar. 5 stages → 20% each, plus a smooth interpolation during long "running".
    const pct = ((idx + 1) / STAGES.length) * 100;
    spFill.style.width = `${pct}%`;
    emit("scan.progress", stage);
    if (stage !== "running") spMsg.textContent = "";
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RESULT RENDERER
  // ═══════════════════════════════════════════════════════════════════════

  function renderResult(result) {
    if (!result) { showError("Empty result from backend."); return; }
    resultEl.hidden = false;
    const verdict = result.verdict || "CLEAN";
    const findings = Array.isArray(result.findings) ? result.findings : [];
    const dur = result.durationMs != null ? `${result.durationMs}ms` : "";
    const nPkg = new Set(findings.map((f) => f.package)).size;

    $("sr-verdict").textContent = verdict;
    $("sr-verdict").className = `sr-verdict ${verdict}`;
    $("sr-meta").textContent = `${findings.length} finding${findings.length === 1 ? "" : "s"} · ${nPkg} package${nPkg === 1 ? "" : "s"}${dur ? " · " + dur : ""}`;

    const body = $("sr-body");
    body.innerHTML = "";

    if (findings.length === 0) {
      body.innerHTML = `<div class="sr-empty"><span class="sr-emoji" aria-hidden="true">✓</span>No behavioral changes detected — this update looks clean.</div>`;
      wireCopyBtn(result);
      return;
    }

    // Mobile collapse: wrap all severity groups in a single native <details>.
    // Rendered <details open> so wide viewports see the full report; on
    // viewports <=480px the inline matchMedia check below removes `open` so
    // the panel collapses to the summary chip until tapped. The <summary>
    // is hidden on wide screens via CSS (styled as a chip on mobile). Native
    // <details> gives us keyboard toggle (Enter/Space), focusable summary,
    // and an accessible expanded/collapsed state for free — no aria juggling,
    // no JS required to toggle.
    const details = document.createElement("details");
    details.className = "sr-details";
    details.open = true;
    const summary = document.createElement("summary");
    summary.className = "sr-summary mono";
    const nFindings = findings.length;
    const plural = nFindings === 1 ? "" : "s";
    const labelFor = (open) => `${nFindings} finding${plural} — ${open ? "tap to collapse" : "tap to expand"}`;
    summary.textContent = labelFor(details.open);
    details.addEventListener("toggle", () => { summary.textContent = labelFor(details.open); });
    details.appendChild(summary);

    // Group by severity → then by package
    const groups = { BLOCK: {}, WARN: {}, INFO: {} };
    for (const f of findings) {
      const bucket = groups[f.severity] || groups.INFO;
      const key = `${f.package}@${f.from || "∅"}→${f.to || "∅"}`;
      (bucket[key] ||= { pkg: f.package, from: f.from, to: f.to, provenance: f.provenance, findings: [] }).findings.push(f);
    }
    for (const sev of ["BLOCK", "WARN", "INFO"]) {
      const pkgs = groups[sev];
      const nFind = Object.values(pkgs).reduce((a, p) => a + p.findings.length, 0);
      if (nFind === 0) continue;
      const groupEl = document.createElement("div");
      groupEl.className = "sr-group";
      groupEl.innerHTML = `<div class="sr-group-h ${sev}">${sev} · ${nFind}</div>`;
      for (const p of Object.values(pkgs)) {
        const pkgEl = document.createElement("div");
        pkgEl.className = "sr-pkg";
        const arrow = p.from && p.to ? `<span class="from">${escapeHtml(p.from)}</span><span class="arrow">→</span><span class="to">${escapeHtml(p.to)}</span>` :
          p.to ? `<span class="to">${escapeHtml(p.to)}</span> <span class="from">(added)</span>` :
          p.from ? `<span class="from">${escapeHtml(p.from)}</span> (removed)` : "";
        pkgEl.innerHTML = `<div class="sr-pkg-h">${escapeHtml(p.pkg)} ${arrow}</div>`;
        if (p.provenance?.[0]?.length) {
          pkgEl.innerHTML += `<div class="sr-prov">via: ${p.provenance[0].map(escapeHtml).join('<span class="sep">→</span>')}</div>`;
        }
        for (const f of p.findings) {
          const cat = f.category || "";
          const row = document.createElement("div");
          row.className = `finding-row ${f.severity}`;
          row.innerHTML = `
            <div class="fr-head">
              <span class="fr-detector">${escapeHtml(f.detector)}</span>
              <span class="fr-cat ${cat}">${escapeHtml(cat)}</span>
            </div>
            <div class="fr-msg">${escapeHtml(f.message || "")}</div>
            ${renderEvidence(f.evidence)}
          `;
          pkgEl.appendChild(row);
        }
        groupEl.appendChild(pkgEl);
      }
      details.appendChild(groupEl);
    }
    body.appendChild(details);

    // Collapse on narrow viewports. Guarded — matchMedia is present in every
    // supported browser, but the try/catch keeps hostile test envs safe.
    // If the viewport later widens past 480px (rotation, resize, DevTools),
    // re-open the details — the <summary> trigger is `display:none` on wide
    // viewports (style.css:253), so a collapsed panel would otherwise leave
    // no visible or keyboard-reachable way to reveal the report.
    try {
      if (window.matchMedia) {
        const mql = window.matchMedia("(max-width: 480px)");
        if (mql.matches) details.open = false;
        const onChange = (e) => { if (!e.matches) details.open = true; };
        if (mql.addEventListener) mql.addEventListener("change", onChange);
        else if (mql.addListener) mql.addListener(onChange); // Safari <14 fallback
      }
    } catch { /* leave open if matchMedia throws */ }

    wireCopyBtn(result);
  }

  function renderEvidence(evidence) {
    if (!Array.isArray(evidence) || evidence.length === 0) return "";
    const first = evidence[0];
    const more = evidence.length > 1 ? ` <span class="ev-loc">(+${evidence.length - 1} more)</span>` : "";
    return `<div class="fr-evidence"><span class="ev-loc">${escapeHtml(first.file)}:${first.line}</span><span class="ev-snip">${escapeHtml((first.snippet || "").slice(0, 140))}</span>${more}</div>`;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function wireCopyBtn(result) {
    const btn = $("sr-copy");
    if (!btn) return;
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
        const orig = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = orig; }, 1400);
        emit("scan.copy", "");
      } catch (err) {
        emit("scan.copy.err", err.message || "");
      }
    };
  }

  // Initial state — everything hidden, no files, no zombies.
  hardResetScanner();

  // If the user closes the tab mid-scan and comes back via browser back/forward,
  // Chrome/Safari's bfcache restores the whole JS environment — including any
  // running poll timer + persisted error banner. Force a clean scanner on restore.
  addEventListener("pageshow", (e) => {
    if (e.persisted) {
      hardResetScanner();
      emit("scan.restored", "bfcache — scanner reset");
    }
  });

  emit("scan.ready", "drop a lockfile pair or click try example");
})();
