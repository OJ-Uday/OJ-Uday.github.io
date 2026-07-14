#!/usr/bin/env node
/**
 * no-hardcoded-colors.mjs
 *
 * CI gate: fail if hardcoded color values appear in any CSS-authoring surface
 * OUTSIDE design/tokens.css. Colors must be expressed via CSS custom properties
 * (design tokens), e.g. `var(--color-brand-primary)`.
 *
 * Sources scanned:
 *  - `.css` files (entire file body).
 *  - `.html` / `.htm` files: only the CSS-shaped regions — contents of every
 *    `<style>…</style>` block and every inline `style="…"` / `style='…'`
 *    attribute value. All other bytes (text content, tags, scripts) are
 *    blanked before matching so a hex literal that only appears as document
 *    prose (e.g. a swatch value label like `<span>#0a0e13</span>`) is not
 *    flagged. Line/column offsets are preserved for reporting.
 *
 * Detection:
 *  - Hex literals:      /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/
 *  - Functional colors: rgba?(...), hsla?(...)  (approximated: `rgba?(` / `hsla?(`)
 *  - Named colors:      the CSS named-color set (white, black, red, gainsboro, …)
 *                       matched as a whole identifier appearing in a property
 *                       *value* position (i.e. after a ':' on the same line).
 *                       This catches `background: white;` in @media print blocks
 *                       and similar patterns that hex/rgba scanning missed
 *                       during P0 adversarial review.
 *
 * Ignored / allowed:
 *  - Content inside /* ... *\/ comments and lines that are pure `//` comments
 *    (some preprocessors) and `@` at-rules like `@import`.
 *  - Occurrences preceded immediately by `var(` (i.e. the token pipeline itself
 *    is not a match — we only flag literals).
 *  - URLs: `url(...)` contents are stripped before matching so a filename that
 *    contains "rgba" or a hex-looking substring isn't flagged.
 *  - Keywords: transparent, currentColor, inherit, initial, unset (always OK —
 *    these are not literal colors).
 *  - The tokens file itself: design/tokens.css (where all literals live).
 *  - `node_modules/` and other build/vendor directories.
 *  - Explicit allowlist paths (see ALLOWLIST_PATHS below). Ideally empty at
 *    P0 end.
 *
 * Warnings (not failures):
 *  - Color literal appearing as a var() fallback, e.g. `var(--x, #abc)`. We
 *    warn so these can be migrated to a real token, but don't fail the build.
 *
 * Exit codes:
 *  - 0: no offenders (warnings may still be printed)
 *  - 1: one or more offenders
 *
 * Usage:
 *   node scripts/no-hardcoded-colors.mjs
 *   npm run gate:colors
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root = one level up from this script.
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');

// Files that are exempt from the gate. Paths are repo-relative and use
// forward slashes for portability.
const EXEMPT_FILES = new Set([
  'design/tokens.css',
]);

// Directories we never descend into.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.vercel',
  // Generated artifacts — never authored, mirror .gitignore.
  'playwright-report',
  'test-results',
  '.lighthouseci',
]);

// Legacy files we know still contain hardcoded colors and plan to migrate.
// Ideally empty by the end of P0. Paths are repo-relative, forward-slash.
const ALLOWLIST_PATHS = new Set([
  // e.g. 'legacy/old-theme.css',
]);

// Keywords that look like colors but are not literal color values. Never flag.
const COLOR_KEYWORD_WHITELIST = new Set([
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'none',
  'auto',
]);

// CSS named colors — the subset most likely to hide behind property values.
// Full list per CSS Color Module Level 4 §6.1. When one of these appears as
// an identifier in a value position (e.g. `color: white`), it's a hardcoded
// color literal even though it's a keyword, not a hex/rgba function call.
// currentColor / transparent are in the whitelist above and NOT flagged.
const CSS_NAMED_COLORS = new Set([
  'aliceblue','antiquewhite','aqua','aquamarine','azure','beige','bisque',
  'black','blanchedalmond','blue','blueviolet','brown','burlywood','cadetblue',
  'chartreuse','chocolate','coral','cornflowerblue','cornsilk','crimson','cyan',
  'darkblue','darkcyan','darkgoldenrod','darkgray','darkgreen','darkgrey',
  'darkkhaki','darkmagenta','darkolivegreen','darkorange','darkorchid','darkred',
  'darksalmon','darkseagreen','darkslateblue','darkslategray','darkslategrey',
  'darkturquoise','darkviolet','deeppink','deepskyblue','dimgray','dimgrey',
  'dodgerblue','firebrick','floralwhite','forestgreen','fuchsia','gainsboro',
  'ghostwhite','gold','goldenrod','gray','green','greenyellow','grey',
  'honeydew','hotpink','indianred','indigo','ivory','khaki','lavender',
  'lavenderblush','lawngreen','lemonchiffon','lightblue','lightcoral','lightcyan',
  'lightgoldenrodyellow','lightgray','lightgreen','lightgrey','lightpink',
  'lightsalmon','lightseagreen','lightskyblue','lightslategray','lightslategrey',
  'lightsteelblue','lightyellow','lime','limegreen','linen','magenta','maroon',
  'mediumaquamarine','mediumblue','mediumorchid','mediumpurple','mediumseagreen',
  'mediumslateblue','mediumspringgreen','mediumturquoise','mediumvioletred',
  'midnightblue','mintcream','mistyrose','moccasin','navajowhite','navy',
  'oldlace','olive','olivedrab','orange','orangered','orchid','palegoldenrod',
  'palegreen','paleturquoise','palevioletred','papayawhip','peachpuff','peru',
  'pink','plum','powderblue','purple','rebeccapurple','red','rosybrown',
  'royalblue','saddlebrown','salmon','sandybrown','seagreen','seashell','sienna',
  'silver','skyblue','slateblue','slategray','slategrey','snow','springgreen',
  'steelblue','tan','teal','thistle','tomato','turquoise','violet','wheat',
  'white','whitesmoke','yellow','yellowgreen',
]);

/** Recursively yield every scannable file (`.css`, `.html`, `.htm`) under `dir`. */
async function* walkCss(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.' && entry.name !== '..') {
      // Skip dotfiles/dotdirs like .git, .next — but let the explicit SKIP_DIRS
      // set also catch them. We still allow hidden files that aren't in SKIP_DIRS
      // to be walked if they're not directories, but for simplicity we skip.
      if (entry.isDirectory()) continue;
    }
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkCss(abs);
    } else if (entry.isFile()) {
      const n = entry.name;
      if (n.endsWith('.css') || n.endsWith('.html') || n.endsWith('.htm')) {
        yield abs;
      }
    }
  }
}

/**
 * Reduce an HTML document to only its CSS-shaped regions, so the same
 * line-oriented color scanner used for `.css` files can be reused on `.html`.
 *
 * We keep the bytes of every `<style>…</style>` block and every inline
 * `style="…"` / `style='…'` attribute value; everything else — tags, prose,
 * script bodies, comments — is replaced with spaces (newlines preserved) so
 * matches inside document text (e.g. a swatch label reading `#0a0e13`) are
 * NOT flagged, while line/column offsets still line up with the original
 * source for reporting.
 */
function extractCssFromHtml(src) {
  const n = src.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = src[i] === '\n' ? '\n' : ' ';

  // <style>…</style> blocks. Case-insensitive; permissive on attributes.
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  for (const m of src.matchAll(styleRe)) {
    const inner = m[1];
    const start = m.index + m[0].indexOf('>') + 1;
    for (let j = 0; j < inner.length; j++) out[start + j] = inner[j];
  }

  // Inline style="…" / style='…' attribute values.
  const attrRe = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const m of src.matchAll(attrRe)) {
    const inner = m[1] ?? m[2] ?? '';
    // Skip the quote char that follows `style = `.
    const quoteOffset = m[0].indexOf(m[1] != null ? '"' : "'");
    const start = m.index + quoteOffset + 1;
    for (let j = 0; j < inner.length; j++) out[start + j] = inner[j];
  }

  return out.join('');
}

/**
 * Strip `/* ... *\/` block comments from a single logical source string.
 * Replaces the comment body with spaces so column offsets are preserved.
 */
function stripBlockComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '*') {
      // Find the end of the block comment.
      const end = src.indexOf('*/', i + 2);
      if (end === -1) {
        // Unterminated — treat the rest as comment (blank it out).
        out += ' '.repeat(src.length - i);
        i = src.length;
      } else {
        // Replace `/* ... */` with spaces (preserving newlines).
        for (let j = i; j < end + 2; j++) {
          out += src[j] === '\n' ? '\n' : ' ';
        }
        i = end + 2;
      }
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

/**
 * Blank out the contents of `url(...)` expressions on a single line so that
 * things like `url(rgba-icon.png)` or `url(#abc123)` don't trigger the color
 * regexes. Columns are preserved.
 */
function stripUrlContents(line) {
  return line.replace(/url\s*\(([^)]*)\)/gi, (match, inner) => {
    return match.replace(inner, ' '.repeat(inner.length));
  });
}

/**
 * Return an array of matches on the given line (already comment-stripped and
 * url-stripped). Each match is { index, length, text, kind }.
 *
 * kind:
 *   - 'hex'   → #rgb / #rgba / #rrggbb / #rrggbbaa literal
 *   - 'func'  → rgb() / rgba() / hsl() / hsla() literal
 *   - 'named' → CSS named color (white, black, red, …) in a value position
 */
function findColorLiterals(line) {
  const results = [];

  // Hex literal: #, then 3–8 hex chars, not followed by another hex char.
  // This catches #abc, #abcd, #aabbcc, #aabbccdd.
  const hexRe = /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/g;
  for (const m of line.matchAll(hexRe)) {
    // Only accept exact lengths that are real hex color forms: 3, 4, 6, 8.
    const len = m[0].length - 1; // subtract the '#'
    if (len !== 3 && len !== 4 && len !== 6 && len !== 8) continue;
    results.push({
      index: m.index,
      length: m[0].length,
      text: m[0],
      kind: 'hex',
    });
  }

  // Functional color: rgb(, rgba(, hsl(, hsla(.
  const funcRe = /\b(?:rgba?|hsla?)\s*\(/gi;
  for (const m of line.matchAll(funcRe)) {
    // Skip if immediately preceded by `var(` — we want to flag the literal
    // form, not a var() usage. Real var() usage looks like `var(--x)` so this
    // guard is mostly belt-and-suspenders.
    const before = line.slice(0, m.index).trimEnd();
    if (before.endsWith('var(')) continue;
    results.push({
      index: m.index,
      length: m[0].length,
      text: m[0],
      kind: 'func',
    });
  }

  // Named colors: only flag if they appear in a *value* position — i.e.
  // there is a `:` earlier on the line and no un-balanced open `{` after it.
  // The heuristic is conservative on purpose: we'd rather miss an obscure
  // callsite than false-positive on prose or class names. See P0 adversarial
  // review — the gate previously missed `background: white; color: black`
  // in style.css @media print.
  const colonIdx = line.indexOf(':');
  if (colonIdx !== -1) {
    const ident = /\b([a-z][a-z0-9_-]+)\b/gi;
    for (const m of line.matchAll(ident)) {
      if (m.index <= colonIdx) continue;
      const name = m[0].toLowerCase();
      if (!CSS_NAMED_COLORS.has(name)) continue;
      // Avoid flagging identifiers that are property names, selectors, or
      // inside strings — cheap heuristics:
      //  - skip if the character immediately before the match is `-`
      //    (custom-property name segment) or `.` / `#` (selector).
      const prev = m.index > 0 ? line[m.index - 1] : '';
      if (prev === '-' || prev === '.' || prev === '#') continue;
      // Skip if the identifier is immediately followed by `:` (it's a
      // property name / pseudo-selector head).
      const next = line[m.index + m[0].length];
      if (next === ':') continue;
      // Skip if inside a quoted string on this line (rough check).
      const before = line.slice(0, m.index);
      const dq = (before.match(/"/g) || []).length;
      const sq = (before.match(/'/g) || []).length;
      if (dq % 2 === 1 || sq % 2 === 1) continue;
      results.push({
        index: m.index,
        length: m[0].length,
        text: m[0],
        kind: 'named',
      });
    }
  }

  return results;
}

/**
 * Given a match at column `col` on a line, decide whether it is inside a
 * `var(..., <match>)` fallback expression. If so, it's a warning, not an
 * error. This is a pragmatic scan — we walk backward looking for `var(` with
 * paren balancing.
 */
function isInsideVarFallback(line, col) {
  let depth = 0;
  for (let i = col - 1; i >= 0; i--) {
    const ch = line[i];
    if (ch === ')') {
      depth++;
    } else if (ch === '(') {
      if (depth === 0) {
        // We're at an unmatched '('. Check what precedes it.
        const prefix = line.slice(0, i).trimEnd();
        return /\bvar\s*$/i.test(prefix);
      }
      depth--;
    }
  }
  return false;
}

/**
 * Does the match at [col, col+len) sit inside a whitelisted keyword? We only
 * ever emit hex/func matches, so keyword whitelisting is really about not
 * flagging in the first place — but we also make sure the surrounding token
 * isn't one of the safe keywords. This is a defensive check.
 */
function isWhitelistedKeywordContext(line, col, len) {
  // Extract the identifier-ish substring around the match.
  let start = col;
  while (start > 0 && /[A-Za-z_-]/.test(line[start - 1])) start--;
  let end = col + len;
  while (end < line.length && /[A-Za-z_-]/.test(line[end])) end++;
  const word = line.slice(start, end).toLowerCase();
  return COLOR_KEYWORD_WHITELIST.has(word);
}

/** Scan a single file. Returns { errors: [...], warnings: [...] }. */
async function scanFile(absPath, relPath) {
  const errors = [];
  const warnings = [];

  let raw;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (err) {
    return { errors, warnings, readError: err };
  }

  // For HTML, reduce to CSS-shaped regions first so we don't flag literals
  // that appear only as document text (e.g. a swatch label). Newlines and
  // column offsets are preserved so line/column reporting still lines up
  // with the original source.
  const isHtml = /\.html?$/i.test(absPath);
  const source = isHtml ? extractCssFromHtml(raw) : raw;

  const stripped = stripBlockComments(source);
  const lines = stripped.split(/\r?\n/);

  for (let idx = 0; idx < lines.length; idx++) {
    const original = lines[idx];
    const trimmed = original.trimStart();

    // Skip at-rules and preprocessor line comments as instructed. Note that
    // legitimate `@media`/`@supports` blocks contain nested rules on their
    // own lines, so this only skips the at-rule declaration line itself.
    if (trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('@')) continue;

    // Strip url(...) contents so we don't match inside filenames.
    const line = stripUrlContents(original);

    const matches = findColorLiterals(line);
    if (matches.length === 0) continue;

    for (const m of matches) {
      if (isWhitelistedKeywordContext(line, m.index, m.length)) continue;

      const finding = {
        file: relPath,
        line: idx + 1,
        column: m.index + 1,
        text: m.text,
        kind: m.kind,
        lineText: original.trim(),
      };

      if (isInsideVarFallback(line, m.index)) {
        warnings.push(finding);
      } else {
        errors.push(finding);
      }
    }
  }

  return { errors, warnings };
}

function toRelPosix(absPath) {
  return relative(ROOT, absPath).split(sep).join('/');
}

async function main() {
  let scanned = 0;
  let skipped = 0;
  const allErrors = [];
  const allWarnings = [];

  // Sanity-check that ROOT exists.
  try {
    const s = await stat(ROOT);
    if (!s.isDirectory()) {
      console.error(`no-hardcoded-colors: root is not a directory: ${ROOT}`);
      process.exit(2);
    }
  } catch (err) {
    console.error(`no-hardcoded-colors: cannot stat root ${ROOT}: ${err.message}`);
    process.exit(2);
  }

  for await (const absPath of walkCss(ROOT)) {
    const rel = toRelPosix(absPath);

    if (EXEMPT_FILES.has(rel)) {
      skipped++;
      continue;
    }
    if (ALLOWLIST_PATHS.has(rel)) {
      skipped++;
      continue;
    }

    scanned++;
    const { errors, warnings, readError } = await scanFile(absPath, rel);
    if (readError) {
      console.error(`no-hardcoded-colors: could not read ${rel}: ${readError.message}`);
      process.exit(2);
    }
    allErrors.push(...errors);
    allWarnings.push(...warnings);
  }

  // Print warnings first (informational, non-fatal).
  if (allWarnings.length > 0) {
    console.warn('');
    console.warn(`no-hardcoded-colors: ${allWarnings.length} warning(s) (var() fallback literals):`);
    for (const w of allWarnings) {
      console.warn(`  ${w.file}:${w.line}:${w.column}  ${w.text}   -> ${w.lineText}`);
    }
  }

  // Print errors.
  if (allErrors.length > 0) {
    console.error('');
    console.error(`no-hardcoded-colors: ${allErrors.length} offender(s):`);
    for (const e of allErrors) {
      console.error(`  ${e.file}:${e.line}:${e.column}  ${e.text}   -> ${e.lineText}`);
    }
    console.error('');
    console.error(
      `FAIL: ${scanned} file(s) scanned, ${skipped} exempt, ${allErrors.length} offender(s), ${allWarnings.length} warning(s)`
    );
    console.error('Move color literals into design/tokens.css and reference them via var(--token-name).');
    process.exit(1);
  }

  console.log(
    `PASS: ${scanned} file(s) scanned, ${skipped} exempt, 0 offenders, ${allWarnings.length} warning(s)`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`no-hardcoded-colors: unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
