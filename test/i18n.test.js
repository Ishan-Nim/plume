'use strict';

// The website's translations have no markup in the pages: the English text is
// the key. That makes them easy to write and very easy to break — a key that
// drifts by one byte does not fail, it quietly shows English. These tests pin
// the three things that have actually gone wrong:
//
//   · scripts/i18n-extract.js and site/assets/i18n.js building different keys
//   · a release bump orphaning every string that mentions the version
//   · a translation losing a tag, a link, or the text inside <code>

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'site', 'assets', 'i18n');
const LANGS = ['ja', 'zh', 'ko', 'hi', 'es', 'fr', 'de', 'pt', 'ru'];

const read = (name) => fs.readFileSync(path.join(DIR, name));
const strings = JSON.parse(read('strings.json').toString('utf8'));
const keys = new Set(strings);

const tags = (s) => (String(s).match(/<[^>]+>/g) || []).map((t) => t.toLowerCase()).sort().join('');
const codes = (s) => (String(s).match(/<code[^>]*>[\s\S]*?<\/code>/g) || []).sort().join('');
const hrefs = (s) => (String(s).match(/href="([^"]*)"/g) || []).sort().join('');
const slots = (s) => (String(s).match(/\{v\}/g) || []).length;

test('no key carries a release number, so a version bump orphans nothing', () => {
  const stale = strings.filter((k) => /\d+\.\d+\.\d+/.test(k));
  assert.deepStrictEqual(stale, [], 'these keys would go stale on the next release');
  // The placeholder the extractor leaves behind is the proof it ran.
  assert.ok(strings.some((k) => k.includes('{v}')), 'expected at least one versioned string');
});

test('no key carries an icon, which i18n.js strips before looking one up', () => {
  assert.deepStrictEqual(strings.filter((k) => /<svg/i.test(k)), []);
});

test('no key carries an empty attribute value, which the DOM writes but the source does not', () => {
  assert.deepStrictEqual(strings.filter((k) => k.includes('=""')), []);
});

for (const lang of LANGS) {
  const raw = read(`${lang}.json`);

  test(`${lang}: the file is plain UTF-8 and no key or value hides a line break`, () => {
    assert.notStrictEqual(raw[0], 0xef, 'a byte-order mark breaks the first key');
    assert.doesNotThrow(() => JSON.parse(raw.toString('utf8')));

    // Not "the file contains no CR": git hands Windows a CRLF checkout, and a
    // line ending between JSON tokens is harmless. What is not harmless is a
    // carriage return inside a key, because the key is matched against what
    // innerHTML returns, which never has one.
    const parsed = JSON.parse(raw.toString('utf8'));
    const BREAK = /[\r\n]/;
    const offenders = Object.entries(parsed)
      .filter(([k, v]) => BREAK.test(k) || BREAK.test(v))
      .map(([k]) => k.slice(0, 60));
    assert.deepStrictEqual(offenders, []);
  });

  const dict = JSON.parse(raw.toString('utf8'));

  test(`${lang}: every entry is a string the site actually shows`, () => {
    const orphans = Object.keys(dict).filter((k) => !keys.has(k));
    assert.deepStrictEqual(orphans.slice(0, 5), [],
      `${orphans.length} entries can never be looked up — re-run scripts/i18n-extract.js`);
  });

  test(`${lang}: a translation keeps the markup of the string it replaces`, () => {
    const broken = Object.entries(dict)
      .filter(([k, v]) => tags(k) !== tags(v) || codes(k) !== codes(v) || hrefs(k) !== hrefs(v))
      .map(([k]) => k);
    assert.deepStrictEqual(broken.slice(0, 3), [],
      'the value is written straight into the page, so a lost tag or link is a broken page');
  });

  test(`${lang}: a translation leaves the version to the page`, () => {
    const hardCoded = Object.entries(dict).filter(([, v]) => /\d+\.\d+\.\d+/.test(v)).map(([k]) => k);
    assert.deepStrictEqual(hardCoded.slice(0, 3), [], 'use {v}; i18n.js fills in the real number');

    const dropped = Object.entries(dict).filter(([k, v]) => slots(k) !== slots(v)).map(([k]) => k);
    assert.deepStrictEqual(dropped.slice(0, 3), [], '{v} must survive translation, once per occurrence');
  });

  test(`${lang}: the dictionary covers most of the site`, () => {
    const covered = Object.keys(dict).length;
    assert.ok(covered / keys.size > 0.8,
      `only ${covered} of ${keys.size} strings are translated`);
  });
}
