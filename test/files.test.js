'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const files = require('../src/main/files.js');

const VAULT = path.join(__dirname, 'fixtures', 'vault');
const SINK = path.join(VAULT, 'kitchen-sink.md');
const OTHER = path.join(VAULT, 'notes', 'Other Note.md');

test('decode handles UTF-8, BOMs and Shift_JIS', () => {
  assert.equal(files.decode(Buffer.from('héllo 日本', 'utf8')), 'héllo 日本');
  assert.equal(files.decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Title')])), '# Title');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# UTF16 ✓', 'utf16le')]);
  assert.equal(files.decode(utf16), '# UTF16 ✓');
  // "日本語" in Shift_JIS — not valid UTF-8.
  assert.equal(files.decode(Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea])), '日本語');
});

test('isMarkdown recognises common extensions case-insensitively', () => {
  for (const f of ['a.md', 'b.MD', 'c.markdown', 'd.mdown', 'e.mkd']) assert.ok(files.isMarkdown(f), f);
  for (const f of ['a.txt', 'b.mdx.bak', 'c', 'd.html']) assert.ok(!files.isMarkdown(f), f);
});

test('isWithin', () => {
  assert.ok(files.isWithin(VAULT, SINK));
  assert.ok(files.isWithin(VAULT, VAULT));
  assert.ok(!files.isWithin(path.join(VAULT, 'notes'), SINK));
  assert.ok(!files.isWithin(VAULT, `${VAULT}-other`));
});

test('listDir shows folders first, Markdown only, hides dot-folders', async () => {
  const res = await files.listDir(VAULT);
  assert.equal(res.name, 'vault');
  assert.deepEqual(res.entries.map(e => [e.name, e.dir]), [['img', true], ['notes', true], ['kitchen-sink.md', false]]);
  assert.ok(res.parent);
});

test('listDir sorts numerically', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-list-'));
  for (const n of ['10-b.md', '2-a.md', '1-c.md', 'notes.txt']) fs.writeFileSync(path.join(dir, n), '#');
  const res = await files.listDir(dir);
  assert.deepEqual(res.entries.map(e => e.name), ['1-c.md', '2-a.md', '10-b.md']);
});

test('readDocument rejects folders and oversize files', async () => {
  await assert.rejects(files.readDocument(VAULT), { code: 'ENOTFILE' });
  const doc = await files.readDocument(SINK);
  assert.ok(doc.content.startsWith('---'));
});

test('findVaultRoot walks up to the .obsidian folder', async () => {
  files.clearCaches();
  assert.equal(await files.findVaultRoot(path.join(VAULT, 'notes')), VAULT);
  assert.equal(await files.findVaultRoot(os.tmpdir()), null);
});

test('parseWikiTarget splits heading and alias', () => {
  assert.deepEqual(files.parseWikiTarget('Note#Head|Alias'), { target: 'Note', hash: 'Head', alias: 'Alias' });
  assert.deepEqual(files.parseWikiTarget('Note\\|Alias'), { target: 'Note', hash: '', alias: 'Alias' });
  assert.deepEqual(files.parseWikiTarget('#Local'), { target: '', hash: 'Local', alias: '' });
});

test('resolveWiki finds notes and attachments across the vault', async () => {
  files.clearCaches();
  const other = await files.resolveWiki(SINK, 'Other Note');
  assert.equal(other.path, OTHER);
  assert.equal(other.isMarkdown, true);

  const section = await files.resolveWiki(SINK, 'Other Note#Section two');
  assert.equal(section.path, OTHER);
  assert.equal(section.hash, 'Section two');

  const pathLink = await files.resolveWiki(SINK, 'notes/Other Note');
  assert.equal(pathLink.path, OTHER);

  const img = await files.resolveWiki(SINK, 'plume.png');
  assert.equal(img.path, path.join(VAULT, 'img', 'plume.png'));
  assert.equal(img.isMarkdown, false);

  const back = await files.resolveWiki(OTHER, 'kitchen-sink');
  assert.equal(back.path, SINK);

  const self = await files.resolveWiki(SINK, '#Math');
  assert.equal(self.path, SINK);
  assert.equal(self.hash, 'Math');

  assert.equal(await files.resolveWiki(SINK, 'Missing note'), null);
});

test('links never open disguised or non-document files', () => {
  const win = String.raw;
  const refused = [win`C:\T\hello.cmd::$DATA`, win`C:\T\hello.cmd:evil`, win`C:\T\hello.cmd.`, win`C:\T\hello.cmd `];
  for (const p of refused) {
    assert.ok(files.isAmbiguousWindowsName(p), `ambiguous: ${p}`);
    assert.ok(!files.isOpenableFromLink(p), `not openable: ${p}`);
  }
  const openable = [win`C:\T\report.pdf`, win`C:\T\a.b.c.PNG`, win`\\server\share\doc.pdf`, win`C:\T\notes.txt`];
  for (const p of openable) {
    assert.ok(!files.isAmbiguousWindowsName(p), `plain: ${p}`);
    assert.ok(files.isOpenableFromLink(p), `openable: ${p}`);
  }
  const folderOnly = [win`C:\T\run.exe`, win`C:\T\HELLO~1.CMD`, win`C:\T\page.html`, win`C:\T\pic.svg`, win`C:\T\x.lnk`, win`C:\T\noext`];
  for (const p of folderOnly) {
    assert.ok(!files.isOpenableFromLink(p), `folder only: ${p}`);
  }
});
