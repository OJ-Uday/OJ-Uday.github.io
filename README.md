# oj-uday.github.io

My portfolio — [oj-uday.github.io](https://oj-uday.github.io/).

Hand-written HTML/CSS/JS. No frameworks, no build step, no trackers, no
cookies, no external requests. The hero panel streams the page's own
telemetry (page view, section visibility, clicks, scroll depth) — captured
with the same delegated auto-capture pattern I use in
[telemetry-sdk-patterns](https://github.com/OJ-Uday/telemetry-sdk-patterns),
and it never leaves the tab.

Deployed to GitHub Pages by [`pages.yml`](.github/workflows/pages.yml) on
every push to `main`.

```
index.html   structure + content
style.css    design tokens (dark/light via prefers-color-scheme), layout, motion
app.js       the self-instrumentation panel + reveal-on-scroll
resume.pdf   current résumé
```

© 2026 Uday Ojha
