'use strict';

// Live preview rests on two things that can be checked without a window: the
// line range each rendered block is stamped with, and the arithmetic that
// puts a caret and splices an edited block back into the document.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

function load(entry) {
  const res = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'renderer', entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  });
  const m = new Module(entry);
  m.paths = module.paths;
  m._compile(res.outputFiles[0].text, entry);
  return m.exports;
}

const { createMarkdown, SRC_MARK, srcRange } = load('markdown.js');
const { sourceOffset, spliceLines, lineEnding, splitLines } = load('mdkeys.js');

const md = createMarkdown({ breaks: true });

// Every data-plume-src in the rendering, in document order.
function ranges(src) {
  const html = md.render(src, { srcMap: true }).html;
  return [...html.matchAll(/data-plume-src="([^"]+)"/g)].map(m => srcRange(m[1]));
}

const DOC = [
  '---',
  'title: Notes',
  '---',
  '',
  '# Heading',
  '',
  'First paragraph,',
  'carried over two lines.',
  '',
  '- one',
  '- two',
  '',
  '> [!note] A callout',
  '> with a body',
  '',
  '```js',
  'code();',
  '```',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  'Last.',
  '',
].join('\n');

test('a block is stamped with the lines it was rendered from', () => {
  const lines = DOC.split('\n');
  const found = ranges(DOC);
  const text = found.map(([from, to]) => lines.slice(from, to).join('\n'));

  assert.deepEqual(text, [
    '# Heading',
    'First paragraph,\ncarried over two lines.',
    '- one\n- two',
    '> [!note] A callout\n> with a body',
    '```js\ncode();\n```',
    '| a | b |\n|---|---|\n| 1 | 2 |',
    'Last.',
  ]);
});

test('ranges are only produced when the document asks for them', () => {
  assert.equal(md.render(DOC).html.includes('data-plume-src'), false);
  assert.equal(md.render(DOC, { srcMap: true }).html.includes('data-plume-src'), true);
  // A transcluded note is rendered without them, so another file's text is
  // never editable from the document that embeds it.
  assert.equal(md.render(DOC, { docId: 't1' }).html.includes('data-plume-src'), false);
});

test('a range a document wrote itself is not ours', () => {
  // Raw HTML in a document can imitate the attribute; it cannot know the mark.
  assert.equal(srcRange('0:0:4'), null);
  assert.equal(srcRange(`${SRC_MARK}:0:4`) && srcRange(`${SRC_MARK}:0:4`).join(), '0,4');
  assert.equal(srcRange(`${SRC_MARK}:4:4`), null, 'an empty range is refused');
  assert.equal(srcRange(`${SRC_MARK}:-1:4`), null);
  assert.equal(srcRange(`${SRC_MARK}:a:b`), null);
  assert.equal(srcRange(''), null);
  assert.equal(srcRange(null), null);
});

test('a list keeps the blank line that separates it from what follows', () => {
  const lines = DOC.split('\n');
  const list = ranges(DOC).find(([from]) => lines[from] === '- one');
  assert.equal(lines[list[1] - 1], '- two');
});

test('every stamped range covers lines that exist, in order', () => {
  const total = DOC.split('\n').length;
  let last = -1;
  for (const [from, to] of ranges(DOC)) {
    assert.ok(from > last, 'blocks are stamped in document order');
    assert.ok(to > from && to <= total, `${from}..${to} is inside the document`);
    last = from;
  }
});

test('editing a block replaces only its own lines', () => {
  const next = spliceLines(DOC, 6, 8, 'One line now.');
  assert.ok(next.includes('One line now.'));
  assert.ok(!next.includes('carried over two lines.'));
  assert.ok(next.includes('# Heading'), 'the heading above is untouched');
  assert.ok(next.includes('- one'), 'the list below is untouched');
  assert.equal(splitLines(next).length, splitLines(DOC).length - 1);
});

test('line endings are kept as the document had them', () => {
  const crlf = DOC.replace(/\n/g, '\r\n');
  assert.equal(lineEnding(crlf), '\r\n');
  assert.equal(lineEnding(DOC), '\n');
  const next = spliceLines(crlf, 6, 8, 'One line now.');
  assert.ok(next.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(next), 'no bare newline is left behind');
  // Line numbers from the renderer are the same either way.
  assert.deepEqual(ranges(crlf), ranges(DOC));
});

test('a caret in rendered text lands on the same word in the source', () => {
  const at = (src, text, word) => sourceOffset(src, text, text.indexOf(word));

  const bold = '**bold** and *italic* text';
  assert.equal(at(bold, 'bold and italic text', 'italic'), bold.indexOf('italic'));

  const link = 'See [the guide](docs/guide.md) for more';
  assert.equal(at(link, 'See the guide for more', 'guide'), link.indexOf('guide'));
  assert.equal(at(link, 'See the guide for more', 'more'), link.indexOf('more'));

  const heading = '## A heading here';
  assert.equal(at(heading, 'A heading here', 'here'), heading.indexOf('here'));

  const item = '- [ ] a task to do';
  assert.equal(at(item, ' a task to do', 'task'), item.indexOf('task'));

  // A line break in the source arrives as whitespace in the rendering.
  const wrapped = 'first line\nsecond line';
  assert.equal(at(wrapped, 'first line second line', 'second'), wrapped.indexOf('second'));

  // Out of range is clamped rather than throwing.
  assert.equal(sourceOffset('abc', 'abc', 99), 3);
  assert.equal(sourceOffset('abc', 'abc', -5), 0);
});

test('a caret past the end of the rendered text lands at the end of the source', () => {
  const src = '**done**';
  assert.equal(sourceOffset(src, 'done', 4), src.length);
});
