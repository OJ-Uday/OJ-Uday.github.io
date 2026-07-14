// design/reveal.js
// -----------------------------------------------------------------------------
// Tiny IntersectionObserver wrapper. Adds 'is-visible' (and 'in' for legacy
// compat) to any element with class 'reveal' when it enters the viewport.
// Idempotent — safe to call more than once. Respects prefers-reduced-motion:
// when reduce is set (or IntersectionObserver is missing), every .reveal is
// promoted to visible immediately, no animation, no observer.
//
// Public API
//   initReveal(opts?) → { destroy }
//     opts.threshold: number     (default 0.12 — matches legacy behavior)
//     opts.rootMargin: string    (default '0px')
//     opts.selector: string      (default '.reveal')
// -----------------------------------------------------------------------------

/** @type {WeakSet<Element>} */
const promoted = new WeakSet();

/** Idempotently mark an element as revealed. */
function reveal(el) {
  if (promoted.has(el)) return;
  promoted.add(el);
  // 'is-visible' is the canonical class (primitives.css). 'in' preserves
  // legacy app.js behavior so we can drop this in without a CSS diff.
  el.classList.add("is-visible", "in");
}

/**
 * @param {{threshold?: number, rootMargin?: string, selector?: string}} [opts]
 * @returns {{ destroy(): void }}
 */
export function initReveal(opts = {}) {
  const threshold = opts.threshold ?? 0.12;
  const rootMargin = opts.rootMargin ?? "0px";
  const selector = opts.selector ?? ".reveal";

  const nodes = Array.from(document.querySelectorAll(selector));

  // Reduced motion or no IO support → promote immediately, skip animation.
  const reduced =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || typeof IntersectionObserver !== "function") {
    for (const el of nodes) reveal(el);
    return { destroy() {} };
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          reveal(e.target);
          io.unobserve(e.target);
        }
      }
    },
    { threshold, rootMargin },
  );

  for (const el of nodes) io.observe(el);

  return {
    destroy() {
      io.disconnect();
    },
  };
}

export default initReveal;
