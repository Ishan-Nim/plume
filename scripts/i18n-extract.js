'use strict';

// Pulls the translatable text out of the site's pages.
//
//   node scripts/i18n-extract.js
//
// Keys are the English text itself, normalised. The pages need no markup
// changes at all, and a string whose English wording later changes simply
// falls back to English rather than showing a stale translation.
//
// Block elements are taken whole, inline markup included, so a sentence with a
// <code> or a link in the middle is one string rather than three disconnected
// fragments. Inline elements are only taken when they stand on their own.

const fs = require('node:fs');
const path = require('node:path');

const SITE = path.join(__dirname, '..', 'site');
const PAGES = ['index.html', 'download.html', 'app.html', '404.html', 'docs.html'];

// Elements that read as one phrase, and the inline ones that sometimes stand
// alone (a nav link, a lone button) but must never split a sentence.
const BLOCK = 'p|li|h1|h2|h3|h4|figcaption|td|th|label|summary|option|blockquote';
const INLINE = 'a|button|span|b';

function normalise(html) {
  return html.replace(/\s+/g, ' ').trim();
}

/** Text that is not worth translating, or must not be. */
function skip(text) {
  const plain = text.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
  if (!plain || plain.length < 2) return true;
  if (!/[a-zA-Z]/.test(plain)) return true;
  if (/^[\d.,\s%+-]+$/.test(plain)) return true;
  // Product names, file names, versions, commands — the same in every language.
  if (/^Plume[-\s]?(Setup)?[-\s]?[\d.]*/.test(plain) && /\.(exe|dmg|zip|deb|AppImage)/.test(plain)) return true;
  if (/^(Plume|GitHub|MIT|macOS|Linux|Windows|MCP|npm|npx|JSON|API|Markdown|Obsidian|Claude Code|Codex)$/i.test(plain)) return true;
  if (/^[a-z0-9_.-]+\.(md|json|js|exe|dmg|deb|zip|png|html)$/i.test(plain)) return true;
  if (/^(Ctrl|Alt|Shift|Cmd|F\d|Enter|Esc)[\s+\w/←→\\=-]*$/i.test(plain)) return true;
  return false;
}

const strings = new Map();   // text -> Set of pages

function remember(text, where) {
  if (skip(text)) return;
  if (!strings.has(text)) strings.set(text, new Set());
  strings.get(text).add(where);
}

for (const page of PAGES) {
  const file = path.join(SITE, page);
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file, 'utf8');

  // Everything that must never be touched: code, scripts, styles and the
  // inline SVG icons, whose path data would otherwise look like prose.
  let html = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<pre[\s\S]*?<\/pre>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  // Pass one: block-level elements, taken whole.
  const blockRe = new RegExp(`<(${BLOCK})\\b[^>]*>([\\s\\S]*?)</\\1>`, 'gi');
  const taken = [];
  let m = blockRe.exec(html);
  while (m) {
    const inner = m[2];
    // A block containing another block is a wrapper; its children carry the text.
    if (!new RegExp(`<(${BLOCK})\\b`, 'i').test(inner)) {
      remember(normalise(inner), page);
      taken.push([m.index, m.index + m[0].length]);
    }
    m = blockRe.exec(html);
  }

  // Pass two: inline elements that are not already inside something taken.
  const inside = (i) => taken.some(([a, b]) => i >= a && i < b);
  const inlineRe = new RegExp(`<(${INLINE})\\b[^>]*>([\\s\\S]*?)</\\1>`, 'gi');
  m = inlineRe.exec(html);
  while (m) {
    if (!inside(m.index) && !new RegExp(`<(${BLOCK}|${INLINE})\\b`, 'i').test(m[2])) {
      remember(normalise(m[2]), page);
    }
    m = inlineRe.exec(html);
  }

  // What search engines show.
  const title = /<title>([\s\S]*?)<\/title>/i.exec(raw);
  if (title) remember(normalise(title[1]), page + ' <title>');
  for (const meta of raw.matchAll(/<meta\s+name="description"\s+content="([^"]+)"/gi)) {
    remember(normalise(meta[1]), page + ' <meta>');
  }
}

const list = [...strings.keys()];
const words = list.reduce((n, s) => n + s.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length, 0);

const dir = path.join(SITE, 'assets', 'i18n');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'strings.json'), JSON.stringify(list, null, 2));

console.log(`${list.length} strings, about ${words} words`);
for (const page of PAGES) {
  console.log(`  ${page}: ${[...strings.values()].filter((p) => [...p].some((x) => x.startsWith(page))).length}`);
}
