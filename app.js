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
    // P3: single-artifact profile mode uses files.single; diff mode still uses before/after.
    files: { before: null, after: null, single: null },
    corpusId: null,
    scanning: false,
    scanId: null,
    startedAt: 0,
    pollTimer: 0,
    aborter: null,
    elapsedTimer: 0,
    // P3 additions
    mode: "profile",           // "profile" | "diff" — packet §6.1 makes profile the default
    ecosystem: null,             // "npm" | "pypi" | null (set on file drop)
    readOnly: false,             // permalink bootstrap sets true
    lastScanEndedAt: 0,          // client-side 5s cooldown throttle
    cooldownTimer: 0,
    // Injected DOM elements (populated by injectScanModeUI once at boot)
    dzSingle: null,
    tabProfile: null,
    tabDiff: null,
    panelProfile: null,
    panelDiff: null,
    readOnlyBanner: null,
  };

  // P3: filename → ecosystem. Called before validation on every file drop.
  function getEcosystem(filename) {
    const lower = String(filename || "").toLowerCase();
    const base = lower.split("/").pop();
    if (base === "package-lock.json" || base === "npm-shrinkwrap.json" ||
        base === "yarn.lock" || base === "pnpm-lock.yaml") return "npm";
    if (base === "requirements.txt" || base.endsWith(".requirements.txt") ||
        base === "poetry.lock" || base === "pyproject.toml") return "pypi";
    return null;
  }

  // P3: client-side throttle so users can't hammer Run. 5-second cooldown after
  // any scan resolves (ready / error / cancelled). Permalink loads bypass this.
  const COOLDOWN_MS = 5000;
  function cooldownActive() {
    return state.lastScanEndedAt > 0 &&
           (Date.now() - state.lastScanEndedAt) < COOLDOWN_MS;
  }
  function cooldownRemainingSec() {
    return Math.max(0, Math.ceil((COOLDOWN_MS - (Date.now() - state.lastScanEndedAt)) / 1000));
  }
  function startCooldown() {
    state.lastScanEndedAt = Date.now();
    clearInterval(state.cooldownTimer);
    // Live-update the run button label every second while cooling down.
    const tick = () => {
      updateRunEnabled();
      if (!cooldownActive()) {
        clearInterval(state.cooldownTimer);
        state.cooldownTimer = 0;
        // Restore normal run label on expiry.
        if (runBtn && runBtn.dataset.origLabel) {
          runBtn.textContent = runBtn.dataset.origLabel;
        }
      } else if (runBtn) {
        if (!runBtn.dataset.origLabel) runBtn.dataset.origLabel = runBtn.textContent;
        runBtn.textContent = `Ready in ${cooldownRemainingSec()}s…`;
      }
    };
    tick();
    state.cooldownTimer = setInterval(tick, 500);
  }

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

  // P3: inject tab UI + profile-mode dropzone + read-only banner into the
  // existing scanner shell. We can't edit index.html here, so we add the DOM
  // once, right before .scan-inputs, and wrap .scan-inputs in a "diff" panel.
  //
  // Structure created:
  //   .scan-wrap
  //     .scan-mode         (role=tablist)
  //     #panel-profile     (role=tabpanel — dropzone for single lockfile)
  //     #panel-diff        (role=tabpanel — wraps existing .scan-inputs)
  //     .scan-actions      (existing)
  //     ...
  function injectScanModeUI() {
    const wrap = document.querySelector("#scan .scan-wrap");
    if (!wrap) return;

    // P3: index.html now ships the static tab UI, both panels, and the
    // read-only banner. If that static markup is present we ONLY wire
    // event handlers + state refs — no DOM creation. If the static shell
    // is missing (older cached HTML, testing harnesses) we fall back to
    // the original dynamic-injection path so the scanner never regresses.
    const staticTablist = document.getElementById("scan-mode");
    const staticPanelProfile = document.getElementById("panel-profile");
    const staticPanelDiff = document.getElementById("panel-diff");
    const staticDzSingle = document.getElementById("dz-single");
    const staticBanner = document.getElementById("scan-readonly-banner");

    if (staticTablist && staticPanelProfile && staticPanelDiff && staticDzSingle) {
      // Wire refs from the pre-rendered HTML.
      state.tabProfile = document.getElementById("tab-profile");
      state.tabDiff = document.getElementById("tab-diff");
      state.panelProfile = staticPanelProfile;
      state.panelDiff = staticPanelDiff;
      state.dzSingle = staticDzSingle;
      state.readOnlyBanner = staticBanner;

      const tabs = [state.tabProfile, state.tabDiff].filter(Boolean);
      tabs.forEach((tab) => {
        tab.addEventListener("click", () => setMode(tab.dataset.scanMode));
        tab.addEventListener("keydown", (e) => {
          const idx = tabs.indexOf(document.activeElement);
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            const dir = e.key === "ArrowRight" ? 1 : -1;
            const next = tabs[(idx + dir + tabs.length) % tabs.length];
            next.focus();
            setMode(next.dataset.scanMode);
          } else if (e.key === "Home") {
            e.preventDefault(); tabs[0].focus(); setMode(tabs[0].dataset.scanMode);
          } else if (e.key === "End") {
            e.preventDefault(); tabs[tabs.length - 1].focus(); setMode(tabs[tabs.length - 1].dataset.scanMode);
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault(); setMode(tab.dataset.scanMode);
          }
        });
      });

      wireDropzone(state.dzSingle);
      document.getElementById("srb-new")?.addEventListener("click", exitReadOnlyMode);
      document.getElementById("srb-copy")?.addEventListener("click", copyShareLink);
      return;
    }

    // Fallback: legacy dynamic-injection path when static shell is missing.
    const inputs = wrap.querySelector(".scan-inputs");
    if (!inputs) return;

    // Tablist
    const tablist = document.createElement("div");
    tablist.id = "scan-mode";
    tablist.className = "scan-mode";
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", "Scan mode");
    tablist.innerHTML = `
      <button role="tab" id="tab-profile" data-scan-mode="profile"
              aria-selected="false" aria-controls="panel-profile" tabindex="-1"
              class="scan-mode-tab">Capability profile
              <span class="scan-mode-sub">single artifact</span></button>
      <button role="tab" id="tab-diff" data-scan-mode="diff"
              aria-selected="true" aria-controls="panel-diff" tabindex="0"
              class="scan-mode-tab is-active">Diff
              <span class="scan-mode-sub">before → after</span></button>
    `;

    // Profile panel (single dropzone)
    const panelProfile = document.createElement("div");
    panelProfile.id = "panel-profile";
    panelProfile.setAttribute("role", "tabpanel");
    panelProfile.setAttribute("aria-labelledby", "tab-profile");
    panelProfile.hidden = true;
    panelProfile.innerHTML = `
      <div class="dropzone" id="dz-single" data-slot="single" tabindex="0"
           role="button" aria-label="Drop a lockfile for capability profile">
        <div class="dz-label mono">Drop a lockfile</div>
        <div class="dz-hint">package-lock.json · yarn.lock · pnpm-lock.yaml ·
                             requirements.txt · poetry.lock · pyproject.toml</div>
        <div class="dz-meta mono" hidden></div>
        <input type="file"
               accept=".json,.lock,.yaml,.yml,.toml,.txt,application/json,text/plain"
               aria-label="Lockfile for capability profile" hidden>
      </div>
    `;

    // Diff panel wraps the existing .scan-inputs so we can hide/show together.
    const panelDiff = document.createElement("div");
    panelDiff.id = "panel-diff";
    panelDiff.setAttribute("role", "tabpanel");
    panelDiff.setAttribute("aria-labelledby", "tab-diff");
    wrap.insertBefore(tablist, inputs);
    wrap.insertBefore(panelProfile, inputs);
    wrap.insertBefore(panelDiff, inputs);
    panelDiff.appendChild(inputs); // move .scan-inputs INSIDE #panel-diff

    // Wire refs into state
    state.tabProfile = document.getElementById("tab-profile");
    state.tabDiff = document.getElementById("tab-diff");
    state.panelProfile = panelProfile;
    state.panelDiff = panelDiff;
    state.dzSingle = document.getElementById("dz-single");

    // Tab click + keyboard nav per WAI-ARIA tabs pattern.
    const tabs = [state.tabProfile, state.tabDiff];
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => setMode(tab.dataset.scanMode));
      tab.addEventListener("keydown", (e) => {
        const idx = tabs.indexOf(document.activeElement);
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const dir = e.key === "ArrowRight" ? 1 : -1;
          const next = tabs[(idx + dir + tabs.length) % tabs.length];
          next.focus();
          setMode(next.dataset.scanMode);
        } else if (e.key === "Home") {
          e.preventDefault(); tabs[0].focus(); setMode(tabs[0].dataset.scanMode);
        } else if (e.key === "End") {
          e.preventDefault(); tabs[tabs.length - 1].focus(); setMode(tabs[tabs.length - 1].dataset.scanMode);
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); setMode(tab.dataset.scanMode);
        }
      });
    });

    wireDropzone(state.dzSingle);

    // Read-only banner (permalink mode). Hidden by default.
    const banner = document.createElement("div");
    banner.id = "scan-readonly-banner";
    banner.className = "scan-readonly-banner mono";
    banner.hidden = true;
    banner.setAttribute("role", "status");
    banner.innerHTML = `
      <span class="srb-msg">Viewing a shared scan result.</span>
      <button type="button" class="btn small" id="srb-new" data-evt="scan.new">Try your own scan</button>
      <button type="button" class="btn small ghost" id="srb-copy" data-evt="scan.share">Copy link</button>
    `;
    wrap.insertBefore(banner, tablist);
    state.readOnlyBanner = banner;
    document.getElementById("srb-new")?.addEventListener("click", exitReadOnlyMode);
    document.getElementById("srb-copy")?.addEventListener("click", copyShareLink);
  }

  // P3: switch between "profile" and "diff" modes. Purely UI — dispatch payload
  // shape branches on state.mode.
  function setMode(mode) {
    if (mode !== "profile" && mode !== "diff") return;
    state.mode = mode;
    // Mirror the current mode onto the #scan section — CSS, screen readers,
    // and the Playwright suite all read this single source of truth (packet
    // §6.1: default is profile; test asserts data-scan-mode="profile").
    document.getElementById("scan")?.setAttribute("data-scan-mode", mode);
    if (state.tabProfile && state.tabDiff) {
      const activeTab = mode === "profile" ? state.tabProfile : state.tabDiff;
      const inactiveTab = mode === "profile" ? state.tabDiff : state.tabProfile;
      activeTab.setAttribute("aria-selected", "true");
      activeTab.classList.add("is-active");
      activeTab.tabIndex = 0;
      inactiveTab.setAttribute("aria-selected", "false");
      inactiveTab.classList.remove("is-active");
      inactiveTab.tabIndex = -1;
    }
    if (state.panelProfile) state.panelProfile.hidden = (mode !== "profile");
    if (state.panelDiff)    state.panelDiff.hidden    = (mode !== "diff");
    updateRunEnabled();
    emit("scan.mode", mode);
  }


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
    state.files.single = null;
    state.corpusId = null;
    state.ecosystem = null;

    // Reset every visible UI slot.
    for (const dz of [dzBefore, dzAfter, state.dzSingle]) {
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
    const slot = dz.dataset.slot; // "before" | "after" | "single"
    if (file.size > MAX_LOCKFILE_BYTES) {
      dz.classList.add("error");
      dz.classList.remove("filled");
      const meta = dz.querySelector(".dz-meta");
      if (meta) { meta.hidden = false; meta.classList.add("warn"); meta.textContent = `× file too large (${(file.size/1024).toFixed(0)} KB, max ${MAX_LOCKFILE_BYTES/1024} KB)`; }
      if (slot === "single") state.files.single = null;
      else state.files[slot] = null;
      updateRunEnabled();
      emit("scan.file.reject", `${slot} · too-large`);
      return;
    }
    // P3: filename → ecosystem. Unknown filenames rejected with a helpful hint.
    const eco = getEcosystem(file.name);
    if (!eco) {
      showFileError(dz,
        "filename not recognised — expected package-lock.json / yarn.lock / pnpm-lock.yaml / requirements.txt / poetry.lock / pyproject.toml");
      return;
    }
    // P3 §6.2 — reveal the ecosystem chip as soon as we've identified the
    // ecosystem from the filename, before any of the live/demo gates fire.
    // The chip is purely a filename-derived label; it has to appear whether
    // or not the file is subsequently accepted for scanning, so a user
    // dropping a poetry.lock in a demo-gated build still sees "PyPI".
    ensureEcosystemChip(eco);
    // Live-npm gate (defense-in-depth, all slots): before we even read the
    // file bytes, refuse any user lockfile drop when live scanning is disabled
    // on this deploy. Applies to before/after/single equally — so diff mode
    // gets the same two-layer defense (file-drop rejection + dispatch-time
    // rejection at dispatchScan) that profile mode has. Fixture buttons still
    // work because loadCorpusExample/loadExample populate state.files without
    // going through handleFile. Gate runs BEFORE `await file.text()` so raw
    // lockfile bytes never enter JS memory for a rejected drop.
    if (typeof isLiveEnabled === "function" && !isLiveEnabled()) {
      showFileError(dz,
        "Live lockfile scanning is disabled — use the Try malicious / Try benign fixture buttons below.");
      return;
    }
    // Live-npm gate: single-artifact profile mode ships as demo-only in
    // production until vetlock 0.4 + startup P1/P2 land the corpus/allowlist.
    // On the same origins where the broader live gate is disabled (production
    // deploy) we refuse arbitrary user lockfile drops so raw bytes never leave
    // the browser. On dev origins (localhost/__VETLOCK_LIVE__) the ecosystem
    // chip + drop preview are the P3 §6.2 UX; a followup unlocks dispatch.
    // Also runs before file.text() so bytes don't hit memory for a rejected drop.
    if (slot === "single" && !isLiveEnabled() && !window.__VETLOCK_ENABLE_PROFILE_LIVE__) {
      showFileError(dz,
        "Capability profile is demo-only right now — use the fixture buttons below. Live scans of your own lockfiles land with vetlock 0.4.");
      return;
    }
    let text;
    try { text = await file.text(); } catch (err) {
      showFileError(dz, `couldn't read file: ${err.message || err}`);
      return;
    }
    // For single/profile mode we're permissive: any recognised filename with
    // some content is accepted (backend does the real parse). For diff mode we
    // keep the existing strict npm-lockfile check to avoid dispatching junk.
    if (slot !== "single" && eco === "npm" && !validateLockfileText(text)) {
      showFileError(dz, "not a valid lockfile — need package-lock.json (v2/v3), yarn.lock, or pnpm-lock.yaml");
      return;
    }
    if (slot === "single") {
      state.files.single = { name: file.name, size: file.size, text };
    } else {
      state.files[slot] = { name: file.name, size: file.size, text };
    }
    state.ecosystem = eco;
    state.corpusId = null;  // real file drop overrides any prior corpus selection
    clearScanUi();
    dz.classList.remove("error");
    dz.classList.add("filled");
    const meta = dz.querySelector(".dz-meta");
    if (meta) { meta.hidden = false; meta.classList.remove("warn"); meta.textContent = `✓ ${file.name} · ${(file.size/1024).toFixed(1)} KB · ${eco === "npm" ? "npm" : "PyPI"}`; }
    updateRunEnabled();
    emit("scan.file.load", `${slot} · ${file.name} · ${eco}`);
  }
  function showFileError(dz, msg) {
    dz.classList.add("error");
    dz.classList.remove("filled");
    const meta = dz.querySelector(".dz-meta");
    if (meta) { meta.hidden = false; meta.classList.add("warn"); meta.textContent = `× ${msg}`; }
    const slot = dz.dataset.slot;
    if (slot === "single") state.files.single = null;
    else state.files[slot] = null;
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
    // Mode-aware readiness:
    //   profile → single file present
    //   diff    → before AND after present
    //   corpus  → treated as diff (state.files.before/after populated by loadCorpusExample)
    const hasSingle = !!state.files.single;
    const hasPair   = !!(state.files.before && state.files.after);
    const ready = state.mode === "profile" ? hasSingle : hasPair;
    // P3 guardrail (defense-in-depth): when live-npm scanning is disabled on
    // this deploy, the ONLY allowed dispatch is a bundled corpus fixture. Keep
    // the Run button disabled for any user-populated files even if the panels
    // were force-shown (bug, devtools, cached CSS). Fixture buttons still work
    // because loadCorpusExample sets state.corpusId, which flips this back on.
    const corpusOnly = typeof isLiveEnabled === "function" ? !isLiveEnabled() : false;
    const blockedByCorpusOnly = corpusOnly && !state.corpusId;
    if (runBtn) runBtn.disabled = !ready || state.scanning || cooldownActive() || state.readOnly || blockedByCorpusOnly;
    if (clearBtn) clearBtn.hidden = !(state.files.before || state.files.after || state.files.single);
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
    // Benign/malicious canned examples are before/after PAIRS, so ensure the
    // scanner is in diff mode before populating slots — otherwise mode stays
    // at the default "profile" and Run remains disabled with the example loaded.
    setMode("diff");
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
    // The malicious corpus fixture is a before/after PAIR, so switch the
    // scanner into diff mode before populating slots. Without this the
    // updateRunEnabled() check reads mode="profile" (the default), expects
    // state.files.single, and keeps Run disabled — the fixture button
    // then appears broken on production origin.
    setMode("diff");
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
    if (state.scanning || state.readOnly || cooldownActive()) return;
    if (state.mode === "profile" && !state.files.single) return;
    if (state.mode === "diff" && !(state.files.before && state.files.after)) return;
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
    // Log a mode-appropriate size summary. Corpus mode has no local bytes.
    let sizeMsg;
    if (state.corpusId) sizeMsg = `corpus=${state.corpusId}`;
    else if (state.mode === "profile") sizeMsg = `single=${state.files.single.size}B · ${state.ecosystem || "?"}`;
    else sizeMsg = `before=${state.files.before.size}B after=${state.files.after.size}B · ${state.ecosystem || "?"}`;
    emit("scan.request", sizeMsg);
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
    // Payload branches on mode. The Worker validates + rejects unsupported
    // combos (e.g. PyPI profile until vetlock 0.4). Corpus mode is unchanged.
    // P3 guardrail (last chance): if live-npm scanning isn't enabled on this
    // deploy, only bundled-corpus dispatches are allowed. Refuse everything
    // else here so no code path (permalink replay, test hook, direct call)
    // can ship user lockfile bytes to the Worker.
    const corpusOnly = typeof isLiveEnabled === "function" ? !isLiveEnabled() : false;
    if (corpusOnly && !state.corpusId) {
      throw new Error(
        "Live lockfile scanning is disabled on this deploy — use the Try malicious / Try benign fixture buttons."
      );
    }
    let payload;
    if (state.corpusId) {
      payload = { corpus_id: state.corpusId };
    } else if (state.mode === "profile") {
      // Defense-in-depth: profile-mode dispatch is gated. handleFile refuses
      // arbitrary drops, but re-check here so no future code path (e.g. a
      // permalink replay, a test hook) can smuggle a user lockfile out.
      if (!window.__VETLOCK_ENABLE_PROFILE_LIVE__) {
        throw new Error(
          "Capability profile is demo-only right now — pick a fixture from the buttons below. Live single-artifact scans land with vetlock 0.4."
        );
      }
      payload = {
        mode: "profile",
        ecosystem: state.ecosystem,
        lockfile: state.files.single.text,
        filename: state.files.single.name,
      };
    } else {
      payload = {
        mode: "diff",
        ecosystem: state.ecosystem,
        before: state.files.before.text,
        after: state.files.after.text,
        filename_before: state.files.before.name,
        filename_after: state.files.after.name,
      };
    }
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
    // P3: 5s cooldown after any resolved scan (ready / error / cancelled /
    // timeout). Skip on "reset" — that's the caller clearing UI for a fresh
    // start, not a user-visible failure.
    if (reason !== "reset") startCooldown();
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
    const ready = state.mode === "profile"
      ? !!state.files.single
      : !!(state.files.before && state.files.after);
    if (ready) startScan();
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
    const findings = Array.isArray(result.findings) ? result.findings : [];
    // Truthful-content invariant: never silently default a missing verdict to
    // CLEAN — a malformed result with BLOCK findings but no verdict field
    // would otherwise be announced as safe (false negative on the primary
    // safety signal). Derive from findings when the field is absent or is not
    // one of the known verdict strings, so the page can never contradict the
    // OG card (worker/worker.js falls back to UNKNOWN on the same case, but
    // the findings themselves already prove BLOCK/WARN when present).
    const rawVerdictUC = String(result.verdict || "").toUpperCase();
    const verdict =
      rawVerdictUC === "BLOCK" || rawVerdictUC === "WARN" || rawVerdictUC === "CLEAN"
        ? rawVerdictUC
        : findings.some((f) => f && f.severity === "BLOCK") ? "BLOCK"
        : findings.some((f) => f && f.severity === "WARN")  ? "WARN"
        : "CLEAN";
    const dur = result.durationMs != null ? `${result.durationMs}ms` : "";
    const nPkg = new Set(findings.map((f) => f.package)).size;
    // Truthful ecosystem: only accept a value the workflow/worker stamped
    // onto result.ecosystem. state.ecosystem can't be a fallback here
    // because permalink replays wipe it (hardResetScanner) — using it
    // would let the same scan id render 'PyPI' on the fresh view and 'npm'
    // on a reload. The OG card (worker.js renderVerdictSvg) and shim
    // summary (worker.js shimSummaryHtml) also refuse to fabricate, so
    // all three renderers agree: label present, or label hidden.
    const rawEco = typeof result.ecosystem === "string" ? result.ecosystem.toLowerCase() : null;
    const ecosystem = rawEco === "npm" || rawEco === "pypi" ? rawEco : null;
    if (!result.ecosystem) console.debug("[vetlock] result missing ecosystem — chip hidden");

    // Compact per-severity roll-up in the meta line so the top of the card
    // is scannable without expanding groups.
    const counts = { BLOCK: 0, WARN: 0, INFO: 0 };
    for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
    const rollup = `[BLOCK ${counts.BLOCK} · WARN ${counts.WARN} · INFO ${counts.INFO}]`;

    $("sr-verdict").textContent = verdict;
    $("sr-verdict").className = `sr-verdict ${verdict}`;
    $("sr-meta").textContent = `${rollup} · ${findings.length} finding${findings.length === 1 ? "" : "s"} · ${nPkg} package${nPkg === 1 ? "" : "s"}${dur ? " · " + dur : ""}`;

    // Ecosystem chip in the result header (created once, updated per render).
    ensureEcosystemChip(ecosystem);

    // Share button (created once, enabled when we have a scanId to share).
    ensureShareButton();

    const body = $("sr-body");
    body.innerHTML = "";

    if (findings.length === 0) {
      body.innerHTML = `<div class="sr-empty"><span class="sr-emoji" aria-hidden="true">✓</span>No behavioral changes detected — this update looks clean.</div>`;
      wireCopyBtn(result);
      ensureCliHint(result, ecosystem);
      afterRenderPermalink();
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
    const isWide = matchMedia("(min-width: 481px)").matches;
    for (const sev of ["BLOCK", "WARN", "INFO"]) {
      const pkgs = groups[sev];
      const nFind = Object.values(pkgs).reduce((a, p) => a + p.findings.length, 0);
      if (nFind === 0) continue;
      // P3: wrap each severity group in <details> so mobile can collapse to
      // just the count + tap-to-expand. Wide screens force open (no toggle).
      const groupEl = document.createElement("details");
      groupEl.className = `sr-group ${sev}`;
      groupEl.open = isWide;
      const summary = document.createElement("summary");
      summary.className = `sr-group-h ${sev}`;
      summary.innerHTML = `
        <span class="sev-dot sev-${sev}" role="img" aria-label="${sev}"></span>
        <span class="sr-group-count"><strong>${nFind}</strong> ${sev}</span>
        <span class="sr-group-tap" aria-hidden="true"></span>
      `;
      groupEl.appendChild(summary);
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
    ensureCliHint(result, ecosystem);
    afterRenderPermalink();

    // P2 graph reaction seam (guarded). If P2 hasn't landed yet this no-ops.
    // Wire-up: once P2 exposes window.__vetlockGraph.reactTo, this call fires
    // per-scan with { verdict, blockCount, packageName } and lights up the
    // affected node in the hero graph.
    try {
      if (typeof window.__vetlockGraph?.reactTo === "function") {
        const primaryPkg = [...new Set(findings.map((f) => f.package))][0] || null;
        window.__vetlockGraph.reactTo({
          verdict,
          blockCount: counts.BLOCK || 0,
          packageName: primaryPkg,
        });
      } else {
        console.debug("[vetlock] graph reaction seam idle — P2 not present");
      }
    } catch (err) {
      console.debug("[vetlock] graph reaction threw", err);
    }
  }

  // P3: after every renderResult, if we have a scanId and we're NOT in
  // read-only mode, rewrite the address bar to a shareable permalink. This
  // makes copy-URL the canonical share path.
  function afterRenderPermalink() {
    if (state.readOnly) return;
    if (!state.scanId) return;
    try {
      const nextUrl = `${location.pathname}?scan=${encodeURIComponent(state.scanId)}`;
      if (location.search !== `?scan=${encodeURIComponent(state.scanId)}`) {
        history.replaceState({}, "", nextUrl);
        emit("scan.permalink", state.scanId.slice(0, 8));
      }
    } catch (err) {
      // history API can throw in some sandboxed contexts — non-fatal.
      console.debug("[vetlock] history.replaceState failed", err);
    }
  }

  // P3: injected once. On drop the chip lands right above the actions row so
  // the ecosystem label is visible immediately (the result panel is still
  // hidden at that point); when renderResult runs we move it into .sr-head
  // next to sr-meta so it sits with the verdict + counts. Pass a null
  // ecosystem to hide the chip — we refuse to fabricate 'npm' when the
  // workflow didn't stamp result.ecosystem, because the OG card and /s/<id>
  // shim would then hard-default the other way and contradict this view.
  function ensureEcosystemChip(ecosystem) {
    let chip = document.getElementById("sr-ecosystem");
    if (!chip) {
      chip = document.createElement("span");
      chip.id = "sr-ecosystem";
      chip.className = "sr-eco-chip mono";
      chip.setAttribute("aria-label", "Ecosystem");
    }
    // Prefer the result header when it's mounted AND visible (renderResult
    // sets resultEl.hidden = false first). Otherwise dock the chip just
    // above the scan actions so Playwright + real users can see it after
    // a file drop but before any Run.
    const resultVisible = resultEl && !resultEl.hidden;
    const head = document.querySelector("#scan-result .sr-head");
    const meta = document.getElementById("sr-meta");
    const actions = document.querySelector("#scan .scan-actions");
    if (resultVisible && head) {
      if (meta && chip.parentNode !== head) head.insertBefore(chip, meta.nextSibling);
      else if (chip.parentNode !== head) head.appendChild(chip);
    } else if (actions && actions.parentNode) {
      // Dock as a sibling right before .scan-actions inside the .scan-wrap.
      if (chip.parentNode !== actions.parentNode || chip.nextSibling !== actions) {
        actions.parentNode.insertBefore(chip, actions);
      }
    } else if (head) {
      if (chip.parentNode !== head) head.appendChild(chip);
    }
    if (ecosystem !== "npm" && ecosystem !== "pypi") {
      chip.hidden = true;
      chip.textContent = "";
      chip.classList.remove("npm", "pypi");
      return;
    }
    chip.hidden = false;
    chip.classList.remove("npm", "pypi");
    chip.classList.add(ecosystem);
    chip.textContent = ecosystem === "pypi" ? "PyPI" : "npm";
  }

  // P3: share button next to Copy JSON. Copies ?scan=<id> permalink.
  function ensureShareButton() {
    let btn = document.getElementById("sr-share");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.id = "sr-share";
      btn.className = "btn small ghost sr-share";
      btn.dataset.evt = "scan.share";
      btn.textContent = "Copy link";
      const copy = document.getElementById("sr-copy");
      if (copy && copy.parentNode) copy.parentNode.insertBefore(btn, copy.nextSibling);
      btn.addEventListener("click", copyShareLink);
    }
    btn.disabled = !state.scanId;
  }

  // P3: CLI-equivalent hint block. Sits inside the existing .sr-foot; if a
  // #sr-cli anchor already exists we just update its text. Mode + ecosystem
  // drive the shown command so the copy actually matches the scan.
  function ensureCliHint(result, ecosystem) {
    const foot = document.querySelector("#scan-result .sr-foot");
    if (!foot) return;
    let block = document.getElementById("sr-cli-block");
    if (!block) {
      block = document.createElement("div");
      block.id = "sr-cli-block";
      block.className = "sr-cli-block";
      block.innerHTML = `
        <span class="sr-cli-lbl">CLI equivalent:</span>
        <code id="sr-cli" class="sr-cli"></code>
        <button type="button" id="sr-cli-copy" class="btn small ghost sr-cli-copy"
                data-evt="scan.cli.copy" aria-label="Copy CLI command">Copy</button>
        <span id="sr-cli-note" class="sr-cli-note" hidden></span>
      `;
      foot.appendChild(block);
      document.getElementById("sr-cli-copy")?.addEventListener("click", copyCli);
    }
    const cli = document.getElementById("sr-cli");
    const note = document.getElementById("sr-cli-note");
    // Permalink replays wipe session state (state.mode defaults back to "diff",
    // state.files.* and state.corpusId are null), so a raw `state.mode` read
    // fabricates the wrong CLI for any shared scan that wasn't a diff-with-drops.
    // Prefer values that the Worker/workflow stamped onto `result`; fall back to
    // session state for fresh scans in the same tab. If we can't infer a
    // truthful command in read-only mode, hide the block rather than lie.
    const corpusId = result?.corpusId || result?.corpus_id ||
      (state.readOnly ? null : state.corpusId);
    let mode = result?.mode;
    if (!mode) {
      const singleName = result?.filename ||
        (Array.isArray(result?.changes) && result.changes.length === 1
          ? result.changes[0]?.name : null);
      const pairFrom = result?.filename_before || result?.filename_after;
      if (corpusId) mode = "diff";                       // corpus replay is a diff
      else if (pairFrom) mode = "diff";
      else if (singleName) mode = "profile";
      else if (state.readOnly) mode = null;              // can't tell → no fabricated CLI
      else mode = state.mode;
    }
    let cmd = null;
    let footnote = "";
    if (corpusId) {
      cmd = `npx vetlock diff --corpus ${corpusId} --json`;
    } else if (mode === "profile") {
      // Prefer a truthful filename the worker/workflow stamped; only fall
      // back to a canonical name when we know the ecosystem. With ecosystem
      // unknown AND no stamped filename, we can't reconstruct a CLI
      // without fabricating one — hide the block instead.
      const stampedName = result?.filename ||
        (Array.isArray(result?.changes) && result.changes[0]?.name) ||
        (state.readOnly ? null : state.files.single?.name);
      const canonicalName = ecosystem === "pypi" ? "requirements.txt"
                          : ecosystem === "npm"  ? "package-lock.json"
                          : null;
      const fname = stampedName || canonicalName;
      if (fname) {
        const ecoFlag = ecosystem === "pypi" ? " --ecosystem pypi" : "";
        cmd = `npx vetlock scan ${fname}${ecoFlag} --json`;
        footnote = "(requires vetlock ≥ 0.4)";
      }
    } else if (mode === "diff") {
      const b = result?.filename_before ||
        (state.readOnly ? null : state.files.before?.name) || "before.json";
      const a = result?.filename_after ||
        (state.readOnly ? null : state.files.after?.name) || "after.json";
      cmd = `npx vetlock diff ${b} ${a} --json`;
    }
    if (cmd) {
      block.hidden = false;
      if (cli) cli.textContent = cmd;
      if (note) {
        note.hidden = !footnote;
        note.textContent = footnote;
      }
    } else {
      // Read-only replay we can't reconstruct a truthful command for — hide
      // rather than fabricate. (Copy JSON + share link still work.)
      block.hidden = true;
    }
  }

  // P3 a11y: write status messages into the off-screen aria-live region so
  // screen readers announce clipboard/share success/failure. A button's own
  // textContent flip ("Copy JSON" → "Copied") is silent to NVDA/JAWS/VO.
  function announceCopy(msg) {
    const live = document.getElementById("scan-copy-live");
    if (!live) return;
    // Force a text change so repeated announcements retrigger the live region.
    live.textContent = "";
    // rAF gives the DOM a chance to observe the empty state before we refill.
    (window.requestAnimationFrame || setTimeout)(() => { live.textContent = msg; });
  }

  async function copyCli() {
    const cli = document.getElementById("sr-cli");
    const btn = document.getElementById("sr-cli-copy");
    if (!cli || !btn) return;
    try {
      await navigator.clipboard.writeText(cli.textContent || "");
      const orig = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = orig; }, 1400);
      announceCopy("Copied CLI command to clipboard.");
      emit("scan.cli.copy", "");
    } catch (err) {
      announceCopy("Copy failed — clipboard blocked.");
      emit("scan.cli.copy.err", err.message || "");
    }
  }

  async function copyShareLink() {
    if (!state.scanId) return;
    // P3 goal #4: social unfurls need per-scan OG image + truthful per-scan
    // title/description. Only the Worker's /s/:id share shim rewrites those
    // meta tags; the interactive /?scan=<id> URL serves the static portfolio
    // shell (index.html:22-26), so pasting it into Slack/LinkedIn/iMessage
    // would preview 'Uday Ojha — Software Engineer' instead of the verdict
    // card. Copy the shim URL — it edge-caches rewritten HTML for scrapers
    // and 0-second-meta-refreshes humans onto ?scan=<id> so the interactive
    // read-only replay still fires.
    const url = `${SCAN_ENDPOINT}/s/${encodeURIComponent(state.scanId)}`;
    const btn = document.getElementById("sr-share") || document.getElementById("srb-copy");
    try {
      // Prefer native share on touch devices; fall back to clipboard.
      if (typeof navigator.share === "function" && matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ url, title: `vetlock scan ${state.scanId.slice(0, 8)}` });
        emit("scan.share.native", "");
        return;
      }
      await navigator.clipboard.writeText(url);
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = orig; }, 1400);
      }
      announceCopy("Copied share link to clipboard.");
      emit("scan.share", state.scanId.slice(0, 8));
    } catch (err) {
      announceCopy("Copy failed — clipboard blocked.");
      emit("scan.share.err", err.message || "");
    }
  }

  // P3: permalink bootstrap. On DOMContentLoaded, if ?scan=<id> is present,
  // fetch the result and render read-only. Same JSON shape as pollUntilReady's
  // ready case — the Worker's handleStatus unwraps { status, result } → result.
  function bootstrapPermalink() {
    let id;
    try {
      id = new URL(location.href).searchParams.get("scan");
    } catch { return false; }
    if (!id) return false;
    // Allow hex (Worker's 16-char scanId), hyphenated UUIDs, and hyphenated
    // test/legacy ids. Reject anything with characters that could be
    // injected into markup or the fetch URL (space, /, ?, #, quotes, etc.).
    if (!/^[a-zA-Z0-9_-]{4,64}$/.test(id)) {
      console.debug("[vetlock] rejected permalink id (bad format)");
      return false;
    }
    enterReadOnlyMode(id);
    return true;
  }

  function enterReadOnlyMode(id) {
    state.readOnly = true;
    state.scanId = id;
    // Hide the interactive scanner shell.
    if (state.panelProfile) state.panelProfile.hidden = true;
    if (state.panelDiff)    state.panelDiff.hidden = true;
    document.getElementById("scan-mode")?.setAttribute("hidden", "");
    const actions = document.querySelector("#scan .scan-actions");
    if (actions) actions.hidden = true;
    if (progressEl) progressEl.hidden = true;
    if (errorEl) errorEl.hidden = true;
    if (state.readOnlyBanner) {
      const banner = state.readOnlyBanner;
      const msg = banner.querySelector(".srb-msg");
      // role="status" is an implicit aria-live="polite" region. Screen readers
      // announce subtree MUTATIONS, not visibility flips — and they ignore
      // mutations on hidden nodes. So: unhide first, then swap the message
      // textContent on the next frame so NVDA/JAWS/VO announce the replay.
      banner.hidden = false;
      if (msg) {
        const text = msg.textContent || "Viewing a shared scan result.";
        msg.textContent = "";
        requestAnimationFrame(() => { msg.textContent = text; });
      }
    }
    emit("scan.permalink.load", id.slice(0, 8));

    // Fetch with a small poll for 202 (permalinks should be issued only for
    // ready scans, but the Worker may not have flushed the KV write yet).
    let attempts = 0;
    const MAX_ATTEMPTS = 4;
    const tryFetch = async () => {
      attempts += 1;
      let res;
      try {
        res = await fetch(`${SCAN_ENDPOINT}/scan/${id}`);
      } catch (err) {
        showError(`Could not load shared scan: ${err.message || err}`);
        return;
      }
      if (res.status === 200) {
        let j;
        try { j = await res.json(); }
        catch { showError("Shared scan payload was malformed."); return; }
        // Envelope may be { status: "ready", result } OR the bare result JSON.
        const result = j && j.result ? j.result : j;
        renderResult(result);
        emit("scan.permalink.ready", id.slice(0, 8));
        return;
      }
      if (res.status === 202 && attempts < MAX_ATTEMPTS) {
        setTimeout(tryFetch, 2000);
        return;
      }
      if (res.status === 202) {
        showError("This scan hasn't completed yet — refresh in a moment.");
        return;
      }
      if (res.status === 404) {
        showError("This scan link is invalid or has expired (results are kept for 24h).");
        return;
      }
      const text = await safeText(res);
      showError(`Could not load shared scan (HTTP ${res.status}). ${text}`);
    };
    tryFetch();
  }

  function exitReadOnlyMode() {
    state.readOnly = false;
    state.scanId = null;
    try { history.replaceState({}, "", location.pathname); } catch {}
    if (state.readOnlyBanner) state.readOnlyBanner.hidden = true;
    document.getElementById("scan-mode")?.removeAttribute("hidden");
    const actions = document.querySelector("#scan .scan-actions");
    if (actions) actions.hidden = false;
    hardResetScanner();
    // Re-apply mode to un-hide the active panel that hardReset doesn't know about.
    setMode(state.mode);
    // P3 guardrail: re-hide the tablist + panels if live-npm scanning is still
    // gated. Without this, exiting a permalink into a non-live deploy would
    // resurrect the free-form dropzones we just carefully hid at boot.
    applyLiveGate();
    emit("scan.permalink.exit", "");
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
        announceCopy("Copied scan JSON to clipboard.");
        emit("scan.copy", "");
      } catch (err) {
        announceCopy("Copy failed — clipboard blocked.");
        emit("scan.copy.err", err.message || "");
      }
    };
  }

  // P3: inject the tab UI + single-artifact dropzone + read-only banner into
  // the existing scanner shell before the first reset (so injected inputs get
  // reset too), then run permalink bootstrap.
  injectScanModeUI();
  // Sync UI to state.mode ("profile" per packet §6.1). Also stamps
  // data-scan-mode onto #scan — Playwright + CSS both key off that.
  setMode(state.mode);

  // P3 guardrail: live-npm scanning (arbitrary user lockfiles) is gated
  // client-side until the startup packet's P1 + P2 land. The Worker enforces
  // the same gate server-side (env.ENABLE_LIVE_NPM). By default, hide the
  // tablist and BOTH tabpanels so the corpus-fixture buttons (Shai-Hulud /
  // benign) are the only interactive path — matching the packet's §6.6
  // guardrail: keep bundled/corpus fixtures as safe default demo. Live mode
  // is opt-in via window.__VETLOCK_LIVE__ = true (requires devtools console)
  // or a localhost/127.0.0.1 origin (dev only). A URL query param is NOT a
  // valid opt-in: the JS ships to production and any visitor can flip it.
  function isLiveEnabled() {
    try {
      if (window.__VETLOCK_LIVE__ === true) return true;
      const host = location.hostname;
      if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    } catch {}
    return false;
  }
  function applyLiveGate() {
    if (isLiveEnabled()) return;
    const scanSection = document.getElementById("scan");
    if (scanSection) scanSection.setAttribute("data-live-gated", "true");
    const tablist = document.getElementById("scan-mode");
    if (tablist) tablist.hidden = true;
    if (state.panelProfile) state.panelProfile.hidden = true;
    if (state.panelDiff)    state.panelDiff.hidden    = true;
  }
  applyLiveGate();

  // Initial state — everything hidden, no files, no zombies.
  hardResetScanner();

  // P3: if ?scan=<id> is present, replay that result read-only. Otherwise
  // fall through to the normal interactive scanner.
  bootstrapPermalink();

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
