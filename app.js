// The page's own telemetry. Every event below is real — captured from this
// tab, rendered into the hero panel, and never transmitted anywhere.
(() => {
  "use strict";

  const feed = document.getElementById("feed");
  const MAX_ROWS = 48;
  const t0 = performance.now();

  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = () => {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  };

  function emit(name, detail = "") {
    if (!feed) return;
    const row = document.createElement("div");
    row.className = "evt";
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = stamp();
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = name;
    const d = document.createElement("span");
    d.className = "d";
    d.textContent = detail;
    row.append(t, n, d);
    feed.append(row);
    while (feed.children.length > MAX_ROWS) feed.firstChild.remove();
    feed.scrollTop = feed.scrollHeight;
  }

  // page view — the obligatory first event
  const vp = innerWidth && innerHeight ? ` · ${innerWidth}×${innerHeight}` : "";
  emit("page.view", `${location.pathname}${vp}`);
  emit("agent.hello", "welcome — poke around, everything you do shows up here");

  // section visibility (fires once per section)
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

  // reveal-on-scroll animation (CSS ignores it under reduced-motion)
  const reveals = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          reveals.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12 }
  );
  document.querySelectorAll(".reveal").forEach((el) => reveals.observe(el));

  // click capture — delegated once, labels from data-evt (the same pattern
  // as a real auto-capture SDK: subscribe at the root, resolve identity per event)
  addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest("a, button") : null;
    if (!target) return;
    const label =
      target.dataset.evt ||
      (target.textContent || "").trim().slice(0, 28) ||
      target.getAttribute("href") ||
      "unknown";
    emit("click", label);
  });

  // scroll depth milestones
  const marks = [25, 50, 75, 100];
  let next = 0;
  addEventListener(
    "scroll",
    () => {
      const doc = document.documentElement;
      const pct = Math.round(((scrollY + innerHeight) / doc.scrollHeight) * 100);
      while (next < marks.length && pct >= marks[next]) {
        emit("scroll.depth", `${marks[next]}%`);
        next += 1;
      }
    },
    { passive: true }
  );

  // tab visibility
  document.addEventListener("visibilitychange", () => {
    emit("visibility", document.visibilityState);
  });

  // uptime ticker in the panel header
  const up = document.getElementById("uptime");
  if (up) {
    setInterval(() => {
      up.textContent = `${Math.floor((performance.now() - t0) / 1000)}s`;
    }, 1000);
  }
})();
