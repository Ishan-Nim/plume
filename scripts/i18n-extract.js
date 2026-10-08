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

// A release number is not a translation. It is replaced with {v} so one entry
// keeps working after a version bump instead of orphaning every string that
// mentions the release; i18n.js puts the real number back when it applies one.
function normalise(html) {
  return html
    .replace(/=""/g, '')
    .replace(/\d+\.\d+\.\d+(?:\.\d+)?/g, '{v}')
    .replace(/\s+/g, ' ')
    .trim();
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
    // Only a block child disqualifies an inline element. Inline children do
    // not: "<b>New</b> Plume 1.3.1 is out" is one phrase, and treating it as
    // several left it in English in every language. i18n.js walks the same way.
    if (!inside(m.index) && !new RegExp(`<(${BLOCK})\\b`, 'i').test(m[2])) {
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

// The download card is built in site/assets/site.js rather than written into a
// page, so no amount of reading HTML will find its words. They are listed here
// in the shape the DOM ends up holding — entities decoded, the release number
// replaced by {v} — so they are translated like everything else.
const BUILT_IN_JS = [
  // The hero and call-to-action buttons, relabelled for the visitor's system.
  'Download for Windows',
  'Download for macOS',
  'Download for Linux',
  'Download Plume',

  'Plume for Windows',
  'Windows 10 or 11, 64-bit · Plume-Setup-{v}.exe',
  'Download the installer',
  'On a Mac or Linux instead? <a href="#mac">macOS</a> · <a href="#linux">Linux</a>',

  'Plume for macOS',
  'Apple silicon (M1 and later) · Plume-{v}-mac-arm64.dmg',
  'Download for Apple silicon',
  'Got an Intel Mac? <a href="/api/download?file=Plume-{v}-mac-x64.dmg">Download the Intel build</a> · <a href="#mac">all macOS files</a>',

  'Plume for Linux',
  'x86-64 · Plume-{v}-linux-x86_64.AppImage',
  'Download the AppImage',
  'Debian or Ubuntu? <a href="/api/download?file=Plume-{v}-linux-amd64.deb">Download the .deb</a> · <a href="#linux">all Linux files</a>',

  'Pick your system',
  'Plume {v} runs on Windows, macOS and Linux',
  'See all downloads',
  '<a href="#win">Windows</a> · <a href="#mac">macOS</a> · <a href="#linux">Linux</a>',
];

for (const text of BUILT_IN_JS) remember(normalise(text), 'download.html <script>');

// The vault page builds its messages in site/assets/app.js, and passes each one
// through t('…') at the moment it is shown. Every such literal is collected
// here, so wrapping a sentence in t() is all it takes to make it translatable.
// app.js therefore passes t() one whole literal, never a variable or a sum.
const APP_JS = path.join(SITE, 'assets', 'app.js');
const T_CALL = /\bt\('((?:[^'\\\n]|\\.)*)'\)/g;
if (fs.existsSync(APP_JS)) {
  for (const m of fs.readFileSync(APP_JS, 'utf8').matchAll(T_CALL)) {
    remember(normalise(m[1].replace(/\\(.)/g, '$1')), 'app.html <script>');
  }
}

// What the API says back, which app.js also shows through t(). These are the
// sentences the sign-in, sign-up and reset endpoints answer with, word for
// word; if the server rewords one, it simply shows in English until this list
// and the dictionaries catch up.
const SERVER_SAID = [
  'That code is not right, or it has expired. Check it and try again, or ask for a new one.',
  'Creating an account needs email, and email is not switched on yet. Try again later.',
  'That email address does not look right.',
  'Use at least 10 characters.',
  'That password is too long.',
  'Mix letters with a number or a symbol.',
  'Too many sign-ups from here. Try again later.',
  'Too many attempts for that address. Try again later.',
  'There is already an account with that email. Try signing in.',
  'Too many attempts. Wait a few minutes and try again.',
  'Too many attempts for that address. Wait a few minutes.',
  'That email and password do not match.',
  'Too many reset requests from here. Try again later.',
  'Password reset is not switched on yet. Email the address on the site and it will be sorted by hand.',
  'Your password is set. Every other device, and every personal access token, has been signed out.',
];

for (const text of SERVER_SAID) remember(normalise(text), 'app.html <api>');

const list = [...strings.keys()];
const words = list.reduce((n, s) => n + s.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length, 0);

const dir = path.join(SITE, 'assets', 'i18n');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'strings.json'), JSON.stringify(list, null, 2));

console.log(`${list.length} strings, about ${words} words`);
for (const page of PAGES) {
  console.log(`  ${page}: ${[...strings.values()].filter((p) => [...p].some((x) => x.startsWith(page))).length}`);
}
