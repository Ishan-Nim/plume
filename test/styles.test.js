'use strict';

// The window's own classes, against the stylesheet.
//
// Plume puts state on <body> as classes, and the stylesheet uses classes for
// components. Nothing stopped the two sets colliding, and when they did — a
// `live-edit` class on <body> meeting a `.live-edit { display: block }` rule
// written for a textarea — <body> stopped being a grid and the layout
// collapsed to the height of the document. No unit test could have caught
// that, so this is that test: a class on <body> may be the *ancestor* in a
// selector (`.is-welcome .markdown-body`), but never the subject of one that
// lays anything out.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

const scripts = fs.readdirSync(SRC)
  .filter(f => f.endsWith('.js'))
  .map(f => fs.readFileSync(path.join(SRC, f), 'utf8'))
  .join('\n');

/** Every class the renderer puts on, or takes off, <body>. */
function bodyClasses() {
  const found = new Set();
  // body.classList.toggle('x', cond): the first argument only — the second is
  // the condition, not a class.
  const call = /(?:document\.)?body\.classList\.(?:add|remove|toggle)\(\s*(?:'([^']+)'|"([^"]+)")/g;
  for (const m of scripts.matchAll(call)) found.add(m[1] || m[2]);
  // And the ones the page is born with.
  const opening = /<body\s+class="([^"]*)"/.exec(html);
  if (opening) for (const c of opening[1].split(/\s+/)) if (c) found.add(c);
  return [...found];
}

// Rules as { selector, decls } pairs. At-rule preludes are dropped so the
// rules inside a @media block are read like any others.
function rules() {
  const flat = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@[a-z-]+[^{]*\{/gi, ' ');
  const out = [];
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const one of m[1].split(',')) {
      const selector = one.trim();
      if (!selector || selector.startsWith('@') || /^(from|to|\d+%)$/.test(selector)) continue;
      out.push({ selector, decls: m[2] });
    }
  }
  return out;
}

// The last compound selector — what the rule is actually about.
function subject(selector) {
  const parts = selector.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// What the window is made of. A rule that sets one of these on <body> by
// accident does not look wrong in the stylesheet — it takes the page apart.
const STRUCTURAL = new RegExp(
  '(?:^|[;{\\s])(?:display|position|grid[a-z-]*|flex[a-z-]*|height|min-height|max-height'
  + '|overflow[a-z-]*|white-space|resize|margin|padding)\\s*:', 'i',
);

test('the renderer puts a known, deliberate set of classes on <body>', () => {
  const classes = bodyClasses().sort();
  assert.ok(classes.length > 5, `found only ${classes.join(', ')}`);
  // Every one should read as a state of the window rather than a component.
  const odd = classes.filter(c => !/^(is-|no-|has-|can-|platform-)/.test(c)
    && !['booting', 'dragging', 'resizing', 'sidebar-hidden', 'just-updated'].includes(c));
  assert.deepEqual(odd, [], 'a body class should say what state the window is in');
});

test('no class on <body> is the subject of a rule that lays the window out', () => {
  const classes = new Set(bodyClasses());
  const clashes = [];
  for (const { selector, decls } of rules()) {
    // `.name`, `.name:hover`, `.name[attr]` — but not `body.name` or
    // `#id.name`, which are deliberate, and not the ancestor of a selector.
    const m = /^\.([A-Za-z0-9_-]+)/.exec(subject(selector));
    if (!m || !classes.has(m[1])) continue;
    // Cursors and colours on <body> are harmless; structure is not.
    if (STRUCTURAL.test(decls)) clashes.push(`${selector} {${decls.trim()}}`);
  }
  assert.deepEqual(clashes, [],
    'this rule would also lay out <body>, which carries the same class');
});

test('the stylesheet parses as balanced blocks', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const open = (stripped.match(/\{/g) || []).length;
  const close = (stripped.match(/\}/g) || []).length;
  assert.equal(open, close, 'an unbalanced brace silently swallows the rules after it');
});

test('the window is a grid of the title bar and everything else', () => {
  // The two rules the whole layout rests on, pinned because a third rule
  // quietly overriding either of them is what went wrong before.
  assert.match(css, /html,\s*body\s*\{\s*height:\s*100%;\s*\}/);
  assert.match(css, /grid-template-rows:\s*var\(--titlebar-h\)\s+minmax\(0,\s*1fr\)/);
});

test('live preview styles the textarea, not whatever else shares its class', () => {
  for (const { selector } of rules()) {
    if (!/\blive-edit\b/.test(selector)) continue;
    assert.match(selector, /^textarea\.live-edit/,
      `${selector} should name the element it is for`);
  }
});
