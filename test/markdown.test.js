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

const { createMarkdown, CODE_MARK } = load('markdown.js');
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

test('Obsidian block comments spanning blank lines are hidden', () => {
  assert.equal(html('%%\nPrivate para 1\n\nPrivate para 2\n%%\nAfter').trim(), '<p>After</p>');
  const interrupted = html('Visible\n%%\nhidden\n\n# Hidden heading\n%% tail');
  assert.doesNotMatch(interrupted, /hidden|Hidden|%%/);
  assert.match(interrupted, /<p>Visible<\/p>/);
  assert.match(interrupted, /<p>tail<\/p>/);
  assert.equal(html('%%\nunclosed\n\nstill hidden').trim(), '');
  assert.doesNotMatch(html('- a\n  %%\n  x\n\n  y\n  %%\n- b'), /x|y/);
});

test('block comment markers inside code stay code', () => {
  assert.match(html('```\n%%\nkept\n```'), /%%\nkept/);
  assert.match(html('    %%\n    indented'), /%%\nindented/);
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

test('genuine code blocks carry the session code mark', () => {
  assert.match(CODE_MARK, /^[0-9a-f]{24}$/);
  assert.ok(html('```sh\nls\n```').includes(`<div class="code-block" data-plume-code="${CODE_MARK}">`));
  assert.ok(html('    indented code').includes(`data-plume-code="${CODE_MARK}"`));
  // Raw HTML imitating a code block is passed through without the mark.
  assert.doesNotMatch(html('<div class="code-block"><div class="code-head"></div></div>'), /data-plume-code/);
  assert.doesNotMatch(html('```mermaid\ngraph LR\n```'), /data-plume-code/);
});

test('docId prefixes footnote ids so transclusions do not collide', () => {
  const src = 'Text[^1]\n\n[^1]: Note.';
  const plain = md.render(src).html;
  assert.match(plain, /href="#fn1" id="fnref1"/);
  assert.match(plain, /<li id="fn1"/);
  const scoped = md.render(src, { docId: 't7' }).html;
  assert.match(scoped, /href="#fn-t7-1" id="fnref-t7-1"/);
  assert.match(scoped, /<li id="fn-t7-1"/);
  assert.match(scoped, /href="#fnref-t7-1" class="footnote-backref"/);
  assert.doesNotMatch(scoped, /id="fn1"|id="fnref1"/);
});

test('Obsidian custom task states render as styled checkboxes', () => {
  const out = html('- [/] doing\n- [-] dropped\n- [>] later\n- [x] done\n- [ ] todo\n- [*] **star**\n- ["] quote');
  assert.match(out, /<ul class="contains-task-list">/);
  assert.match(out, /<li class="task-list-item" data-task="\/"><input class="task-list-item-checkbox" disabled="" type="checkbox" data-task="\/"> doing<\/li>/);
  assert.match(out, /<li class="task-list-item" data-task="-"><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox" data-task="-"> dropped<\/li>/);
  assert.match(out, /data-task="&gt;"> later<\/li>/);
  assert.match(out, /data-task="\*"> <strong>star<\/strong><\/li>/);
  assert.match(out, /checked="" disabled="" type="checkbox" data-task="&quot;"> quote/);
  assert.match(out, /<li class="task-list-item"><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> done/);
  assert.doesNotMatch(out, /\[\/\]|\[-\]|\[&gt;\]/);
  // Only list items are tasks, and the marker needs a following space.
  assert.doesNotMatch(html('[/] not a list'), /checkbox/);
  assert.doesNotMatch(html('- [/]'), /checkbox/);
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

test('parseFrontMatter keeps quoted commas inside flow lists', () => {
  assert.deepEqual(parseFrontMatter('tags: [a, "b, c", \'d\']'), [{ key: 'tags', values: ['a', 'b, c', 'd'] }]);
});

test('parseFrontMatter reads block scalars as one text value', () => {
  const raw = [
    'description: >-',
    '  A folded summary that',
    '  spans two lines.',
    'note: |-',
    '  Line one',
    '    - indented, not a list item',
    '',
    '  # not a comment',
    'keep: |',
    '  kept',
    'folded: >',
    '  para one',
    '  continues',
    '',
    '  para two',
    'empty: |',
    'after: x',
  ].join('\n');
  assert.deepEqual(parseFrontMatter(raw), [
    { key: 'description', values: ['A folded summary that spans two lines.'] },
    { key: 'note', values: ['Line one\n  - indented, not a list item\n\n# not a comment'] },
    { key: 'keep', values: ['kept'] },
    { key: 'folded', values: ['para one continues\npara two'] },
    { key: 'empty', values: [] },
    { key: 'after', values: ['x'] },
  ]);
});

test('extractSection returns a heading section or a block', () => {
  const src = '# A\nintro\n## B\nb text\n### B1\nnested\n## C\nc text\nline ^blk';
  assert.equal(extractSection(src, 'B'), '## B\nb text\n### B1\nnested');
  assert.equal(extractSection(src, 'c'), '## C\nc text\nline ^blk');
  assert.equal(extractSection(src, '^blk'), 'c text\nline ^blk');
  assert.equal(extractSection(src, 'Nope'), src);
});

test('extractSection ignores headings inside code fences and front matter', () => {
  const src = [
    '---',
    '# yaml comment',
    'title: T',
    '---',
    '## Setup',
    'Install the tool:',
    '```bash',
    '# install deps',
    'npm i',
    '```',
    '~~~~',
    '## not a heading',
    '```',
    '~~~~',
    'Then run it.',
    '## Next',
    'next text',
  ].join('\n');
  assert.equal(extractSection(src, 'Setup'), src.split('\n').slice(4, 15).join('\n'));
  assert.equal(extractSection(src, 'install deps'), src);
  assert.equal(extractSection(src, 'yaml comment'), src);
  assert.equal(extractSection(src, 'not a heading'), src);
  assert.equal(extractSection('## C#\nsharp\n## D ##\nd', 'C#'), '## C#\nsharp');
  assert.equal(extractSection('## C#\nsharp\n## D ##\nd', 'D'), '## D ##\nd');
  assert.equal(extractSection('## A\n#tag line\n##\nafter', 'A'), '## A\n#tag line');
});

test('extractSection follows Obsidian heading paths', () => {
  const src = '# One\n## Setup\none setup\n# Two\n## Setup\ntwo setup\n# Three\nthree';
  assert.equal(extractSection(src, 'Two#Setup'), '## Setup\ntwo setup');
  assert.equal(extractSection(src, 'One#Setup'), '## Setup\none setup');
  assert.equal(extractSection(src, 'Missing#Three'), '# Three\nthree');
  assert.equal(extractSection(src, 'Two#Missing'), src);
});

test('extractSection returns whole blocks for ^ids', () => {
  const src = [
    '# Title',
    'This paragraph starts here',
    'and continues on a second line ^blk',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '^tbl',
    '',
    '- first item',
    '- second item',
    '  wraps here ^li',
    '',
    '```',
    'not an id ^code',
    '```',
    '',
    '^fence',
  ].join('\n');
  assert.equal(extractSection(src, '^blk'), 'This paragraph starts here\nand continues on a second line ^blk');
  assert.equal(extractSection(src, '^tbl'), '| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(extractSection(src, '^li'), '- second item\n  wraps here ^li');
  assert.equal(extractSection(src, '^code'), src);
  assert.equal(extractSection(src, '^fence'), '```\nnot an id ^code\n```');
  assert.equal(extractSection(src, '^missing'), src);
});

test('extractSection treats odd block ids as plain text', () => {
  const src = 'para ^a(b\n\nother ^c++';
  assert.equal(extractSection(src, '^a(b'), 'para ^a(b');
  assert.equal(extractSection(src, '^c++'), 'other ^c++');
  assert.equal(extractSection(src, '^x)'), src);
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

test('path helpers keep the separator of the root path', () => {
  assert.equal(util.joinPath('E:\\Vault', 'notes'), 'E:\\Vault\\notes');
  assert.equal(util.joinPath('E:\\', 'notes'), 'E:\\notes');
  assert.equal(util.joinPath('/home/me/vault', 'notes'), '/home/me/vault/notes');
  assert.equal(util.joinPath('/', 'notes'), '/notes');
  assert.equal(util.dirname('/a.md'), '/');
  assert.equal(util.dirname('/home/me/a.md'), '/home/me');
  assert.deepEqual(util.relativeSegments('/home/me', '/home/me/x/y'), ['x', 'y']);
});
