'use strict';

// The renderer modules are ES modules for the browser; bundle them to CJS on
// the fly so their pure functions can be tested in Node.

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

const { createMarkdown } = load('markdown.js');
const { parseFrontMatter, extractSection } = load('enhance.js');
const util = load('util.js');

const md = createMarkdown({ breaks: true });
const html = src => md.render(src).html;

test('wiki links render with labels and are collected', () => {
  const out = md.render('See [[Other Note]], [[Other Note#Section two|alias]] and [[folder/Deep#Part]].');
  assert.match(out.html, /<a href="#" class="wikilink" data-wiki="Other Note">Other Note<\/a>/);
  assert.match(out.html, /data-wiki="Other Note#Section two">alias<\/a>/);
  assert.match(out.html, /data-wiki="folder\/Deep#Part">Deep › Part<\/a>/);
  assert.deepEqual(out.wiki.sort(), ['Other Note', 'Other Note#Section two', 'folder/Deep#Part'].sort());
});

test('wiki embeds: images get sizes, notes become transclusion placeholders', () => {
  assert.match(html('![[pic.png|300]]'), /<img class="wiki-image" data-wiki-embed="pic.png" alt="pic.png" width="300">/);
  assert.match(html('![[pic.png|300x200]]'), /width="300" height="200"/);
  assert.match(html('![[Note#Part]]'), /class="wiki-transclude" data-wiki-embed="Note#Part"/);
});

test('wiki links in tables keep escaped pipes as aliases', () => {
  const out = html('| a | b |\n|---|---|\n| [[Note\\|Alias]] | x |');
  assert.match(out, /data-wiki="Note">Alias<\/a>/);
});

test('tags: real tags become pills, numbers and C# do not', () => {
  assert.match(html('a #project/alpha b'), /<span class="tag">#project\/alpha<\/span>/);
  assert.doesNotMatch(html('Issue #12 and C# here'), /class="tag"/);
  assert.match(html('# Heading'), /<h1>Heading<\/h1>/);
  assert.match(html('日本語 #タグ'), /<span class="tag">#タグ<\/span>/);
});

test('Obsidian comments are hidden', () => {
  assert.equal(html('a %%secret%% b').trim(), '<p>a  b</p>');
});

test('image size syntax and lazy loading', () => {
  const out = html('![Logo|120](img/logo.png)');
  assert.match(out, /src="img\/logo.png"/);
  assert.match(out, /alt="Logo"/);
  assert.match(out, /width="120"/);
  assert.match(out, /loading="lazy"/);
});

test('code fences: highlighting, aliases, mermaid, math', () => {
  assert.match(html('```js\nconst a = 1;\n```'), /<span class="hljs-keyword">const<\/span>/);
  assert.match(html('```ps1\nGet-ChildItem\n```'), /hljs-built_in|hljs-keyword/);
  assert.match(html('```unknownlang\n<b>x</b>\n```'), /&lt;b&gt;x&lt;\/b&gt;/);
  const mer = html('```mermaid\ngraph LR\nA-->B\n```');
  assert.match(mer, /<div class="mermaid-block"><pre class="mermaid-src">graph LR\nA--&gt;B\n<\/pre><\/div>/);
  assert.match(html('```math\nx^2\n```'), /class="math-block"><span class="katex-display">/);
});

test('math: inline and display, but prices stay text', () => {
  assert.match(html('Inline $E=mc^2$ here'), /class="katex"/);
  assert.match(html('$$\n\\frac{a}{b}\n$$'), /katex-display/);
  assert.doesNotMatch(html('Costs $5 and $10 today'), /katex/);
});

test('line breaks follow the setting', () => {
  assert.match(createMarkdown({ breaks: true }).render('a\nb').html, /a<br>\nb/);
  assert.doesNotMatch(createMarkdown({ breaks: false }).render('a\nb').html, /<br>/);
});

test('front matter is captured and not rendered', () => {
  const out = md.render('---\ntitle: T\ntags: [a, b]\n---\n# Body');
  assert.match(out.frontMatter, /title: T/);
  assert.doesNotMatch(out.html, /title: T/);
  assert.deepEqual(parseFrontMatter(out.frontMatter), [
    { key: 'title', values: ['T'] },
    { key: 'tags', values: ['a', 'b'] },
  ]);
});

test('parseFrontMatter handles lists and quotes', () => {
  assert.deepEqual(parseFrontMatter('aliases:\n  - one\n  - "two"\nurl: https://x.y/z'), [
    { key: 'aliases', values: ['one', 'two'] },
    { key: 'url', values: ['https://x.y/z'] },
  ]);
});

test('extractSection returns a heading section or a block', () => {
  const src = '# A\nintro\n## B\nb text\n### B1\nnested\n## C\nc text\nline ^blk';
  assert.equal(extractSection(src, 'B'), '## B\nb text\n### B1\nnested');
  assert.equal(extractSection(src, 'c'), '## C\nc text\nline ^blk');
  assert.equal(extractSection(src, '^blk'), 'line ^blk');
  assert.equal(extractSection(src, 'Nope'), src);
});

test('slugify matches GitHub style and keeps Unicode', () => {
  assert.equal(util.slugify('Hello, World!'), 'hello-world');
  assert.equal(util.slugify('What you will end up with'), 'what-you-will-end-up-with');
  assert.equal(util.slugify('日本語 見出し'), '日本語-見出し');
  assert.equal(util.slugify('C++ & Rust'), 'c--rust');
});

test('readingStats counts Latin words and CJK characters', () => {
  const s = util.readingStats('one two three 日本語');
  assert.equal(s.words, 6);
  assert.equal(s.minutes, 1);
});

test('path helpers', () => {
  assert.equal(util.dirname('E:\\a\\b.md'), 'E:\\a');
  assert.equal(util.dirname('E:\\b.md'), 'E:\\');
  assert.equal(util.basename('E:\\a\\b.md'), 'b.md');
  assert.deepEqual(util.relativeSegments('E:\\Vault', 'E:\\Vault\\x\\y'), ['x', 'y']);
  assert.equal(util.relativeSegments('E:\\Vault', 'E:\\Other\\y'), null);
});
