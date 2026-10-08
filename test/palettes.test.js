'use strict';

// A palette is spread across six files: the settings whitelist, the desktop
// stylesheet, the desktop picker, the website stylesheet, the website's script
// and every page's footer. Missing from any one of them it is a theme that
// silently does nothing — it would still pass every other test in here, and
// nobody would notice until a user picked it. So the list is read from
// settings.js and each place is checked against it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function paletteList(source, label) {
  const match = /(?:const|var) PALETTES = \[([^\]]+)\]/.exec(source);
  assert.ok(match, `${label} should declare a PALETTES array`);
  return match[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

const PALETTES = paletteList(read('src/main/settings.js'), 'settings.js');
// 'plume' is the absence of a palette, so it has no block of its own.
const EXTRA = PALETTES.filter((p) => p !== 'plume');

test('there is more than one palette, and plume is the default', () => {
  assert.ok(PALETTES.includes('plume'));
  assert.ok(EXTRA.length >= 1, 'at least one palette beyond the default');
  const settings = read('src/main/settings.js');
  assert.match(settings, /palette: 'plume'/, 'plume is the default');
  assert.match(settings, /palette: v => PALETTES\.includes\(v\)/, 'and the setting is validated against the list');
  assert.match(settings, /RENDERER_KEYS = new Set\(\[[^\]]*'palette'/, 'the renderer may change it');
});

test('the desktop app styles every palette, light and dark', () => {
  const css = read('src/renderer/styles.css');
  for (const p of EXTRA) {
    assert.ok(css.includes(`[data-theme="dark"][data-palette="${p}"]`), `${p} has no dark block`);
    assert.ok(css.includes(`[data-theme="light"][data-palette="${p}"]`), `${p} has no light block`);
    assert.ok(css.includes(`[data-set="palette:${p}"]`), `${p} has no swatch colour`);
  }
});

// Everything a palette must restate. Skipping one of these means inheriting
// that colour from Plume's own scheme, which the rest of the palette no longer
// matches — a grey border in a green theme, a purple link on a black page.
// A palette may define more than this (Greenwood retints its warnings, Lapis
// its highlight); it may not define less.
const REQUIRED = [
  'bg', 'chrome', 'chrome-2', 'pop-bg', 'seg-active',
  'border', 'border-soft', 'border-strong',
  'text', 'heading', 'text-2', 'text-3',
  'accent', 'accent-strong', 'accent-soft', 'link',
  'code-bg', 'inline-code-bg', 'quote-border', 'zebra', 'selection', 'img-border',
];

test('every palette restates every token that carries its character', () => {
  const css = read('src/renderer/styles.css');
  const tokensOf = (selector) => {
    const start = css.indexOf(selector);
    assert.ok(start >= 0, `${selector} is missing`);
    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return [...css.slice(open, close).matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]);
  };

  for (const mode of ['dark', 'light']) {
    for (const p of EXTRA) {
      const got = tokensOf(`[data-theme="${mode}"][data-palette="${p}"]`);
      const missing = REQUIRED.filter((t) => !got.includes(t));
      assert.deepStrictEqual(missing, [], `${p}'s ${mode} block does not set: ${missing.join(', ')}`);
    }
  }
});

test('the desktop picker offers exactly the palettes that exist', () => {
  const html = read('src/renderer/index.html');
  const offered = [...html.matchAll(/data-set="palette:([a-z]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(offered.slice().sort(), PALETTES.slice().sort());
  assert.match(html, /<html[^>]*data-palette="plume"/, 'the document starts on the default');
});

test('the website styles every palette, and in both ways dark can arrive', () => {
  const css = read('site/assets/site.css');
  for (const p of EXTRA) {
    assert.ok(css.includes(`:root[data-palette="${p}"]`), `${p} has no light block`);
    assert.ok(css.includes(`:root[data-theme="dark"][data-palette="${p}"]`), `${p} has no chosen-dark block`);
    assert.ok(css.includes(`:root:not([data-theme="light"])[data-palette="${p}"]`), `${p} has no system-dark block`);
  }
});

test('the website script and every page agree with the list', () => {
  assert.deepStrictEqual(paletteList(read('site/assets/site.js'), 'site.js'), PALETTES);

  const pages = fs.readdirSync(path.join(root, 'site')).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length >= 5, 'the site should have its pages');
  for (const page of pages) {
    const html = read(path.join('site', page));
    const options = [...html.matchAll(/<option value="([a-z]+)">/g)].map((m) => m[1])
      .filter((v) => PALETTES.includes(v));
    assert.deepStrictEqual(options, PALETTES, `${page} does not offer every palette`);
    // Applied before paint, or the page shows Plume's colours and then swaps.
    assert.match(html, /localStorage\.getItem\('plume-palette'\)/,
      `${page} does not apply the stored palette before paint`);
  }
});
