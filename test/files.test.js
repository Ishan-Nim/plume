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
const SEP = String.fromCharCode(92);  // a backslash, spelled out

test('decode handles UTF-8, BOMs and Shift_JIS', () => {
  assert.equal(files.decode(Buffer.from('héllo 日本', 'utf8')), 'héllo 日本');
  assert.equal(files.decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Title')])), '# Title');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# UTF16 ✓', 'utf16le')]);
  assert.equal(files.decode(utf16), '# UTF16 ✓');
  // "日本語" in Shift_JIS — not valid UTF-8.
  assert.equal(files.decode(Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea])), '日本語');
  // "# 日本語" + newline + half-width "ｱｲ": ASCII and single-byte kana survive.
  const sjis = Buffer.from([0x23, 0x20, 0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a, 0xb1, 0xb2]);
  assert.equal(files.decode(sjis), '# 日本語\nｱｲ');
});

test('decode reads Windows-1252 files that are not Shift_JIS without losing letters', () => {
  const text = 'Café naïve résumé “quoted” – 50€';
  const cp1252 = Buffer.from([
    0x43, 0x61, 0x66, 0xe9, 0x20, 0x6e, 0x61, 0xef, 0x76, 0x65, 0x20, 0x72, 0xe9, 0x73, 0x75, 0x6d, 0xe9, 0x20,
    0x93, 0x71, 0x75, 0x6f, 0x74, 0x65, 0x64, 0x94, 0x20, 0x96, 0x20, 0x35, 0x30, 0x80,
  ]);
  assert.equal(files.decode(cp1252), text);
});

test('isMarkdown recognises common extensions case-insensitively', () => {
  for (const f of ['a.md', 'b.MD', 'c.markdown', 'd.mdown', 'e.mkd']) assert.ok(files.isMarkdown(f), f);
  for (const f of ['a.txt', 'b.mdx.bak', 'c', 'd.html']) assert.ok(!files.isMarkdown(f), f);
});

test('isViewable accepts Markdown, plain text and extensionless files', () => {
  for (const f of ['a.md', 'b.MARKDOWN', 'c.txt', 'd.log', 'e.Rmd', 'f.qmd', 'README', path.join('repo', 'LICENSE')]) {
    assert.ok(files.isViewable(f), f);
  }
  for (const f of ['a.png', 'b.pdf', 'c.exe', 'e.html']) assert.ok(!files.isViewable(f), f);
});

test('readDocument refuses binary content but reads UTF-16', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-bin-'));
  const bin = path.join(dir, 'README');
  fs.writeFileSync(bin, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0x00]));
  await assert.rejects(files.readDocument(bin), { code: 'EBINARY' });
  const utf16 = path.join(dir, 'NOTES');
  fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# Hi', 'utf16le')]));
  assert.equal((await files.readDocument(utf16)).content, '# Hi');
});

test('noteFileName takes a name and gives back a file name', () => {
  assert.equal(files.noteFileName('Q3 review'), 'Q3 review.md');
  assert.equal(files.noteFileName('  Ideas  '), 'Ideas.md');
  // A Markdown extension the user typed is kept; anything else is a name.
  assert.equal(files.noteFileName('Notes.markdown'), 'Notes.markdown');
  assert.equal(files.noteFileName('shopping.txt'), 'shopping.txt.md');
  assert.equal(files.noteFileName('日本語'), '日本語.md');
  // Windows drops trailing dots and spaces, so Plume does not write them.
  assert.equal(files.noteFileName('Draft.'), 'Draft.md');
});

test('noteFileName refuses names that are not names', () => {
  for (const bad of ['', '   ', '.', '..', '.hidden', 'a/b', `a${SEP}b`, 'Q3: plan', 'what?',
    'a*b', 'a"b', 'a<b', 'a>b', 'a|b', 'x'.repeat(121), 'CON', 'con.md', 'NUL', 'lpt1',
    `line${String.fromCharCode(10)}break`, null, undefined, 42]) {
    assert.equal(files.noteFileName(bad), null, JSON.stringify(bad));
  }
});

test('folderName allows a folder but not a path', () => {
  assert.equal(files.folderName('Projects'), 'Projects');
  assert.equal(files.folderName('Reading list.'), 'Reading list');
  // A folder name is never given an extension of its own.
  assert.equal(files.folderName('Notes.md'), 'Notes.md');
  for (const bad of ['', '..', '.git', `a${SEP}b`, 'a/b', 'aux', 'x'.repeat(121)]) {
    assert.equal(files.folderName(bad), null, JSON.stringify(bad));
  }
});

test('isPlainFolder keeps app bundles and shell folders out of link opening', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-bundle-'));
  const bare = path.join(dir, 'Tool');
  fs.mkdirSync(path.join(bare, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(bare, 'Contents', 'Info.plist'), '<plist/>');
  assert.ok(!files.isPlainFolder(path.join(dir, 'Tool.app'), 'darwin'));
  assert.ok(!files.isPlainFolder(bare, 'darwin'));
  assert.ok(files.isPlainFolder(dir, 'darwin'));
  assert.ok(!files.isPlainFolder(String.raw`C:\T\Bin.{645FF040-5081-101B-9F08-00AA002F954E}`, 'win32'));
  assert.ok(files.isPlainFolder(String.raw`C:\T\notes v1.2`, 'win32'));
  assert.ok(files.isPlainFolder('/home/me/Tool.app', 'linux'));
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

test('wiki names match case-insensitively on every platform', async () => {
  files.clearCaches();
  assert.equal((await files.resolveWiki(SINK, 'other note')).path, OTHER);
  const section = await files.resolveWiki(SINK, 'OTHER NOTE#Section two');
  assert.equal(section.path, OTHER);
  assert.equal(section.hash, 'Section two');
});

test('an expired wiki index still sees notes created or renamed since', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-idx-'));
  fs.mkdirSync(path.join(dir, '.obsidian'));
  fs.mkdirSync(path.join(dir, 'sub'));
  const from = path.join(dir, 'a.md');
  fs.writeFileSync(from, '[[New]]');
  const created = path.join(dir, 'sub', 'New.md');
  const renamed = path.join(dir, 'sub', 'Renamed.md');
  files.clearCaches();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  assert.equal(await files.resolveWiki(from, 'New'), null);

  t.mock.timers.tick(11_000);
  fs.writeFileSync(created, '# New');
  assert.equal((await files.resolveWiki(from, 'New')).path, created);

  t.mock.timers.tick(11_000);
  fs.renameSync(created, renamed);
  assert.equal(await files.resolveWiki(from, 'New'), null);
  assert.equal((await files.resolveWiki(from, 'Renamed')).path, renamed);
});

test('concurrent wiki lookups share one index build', async () => {
  files.clearCaches();
  const hits = await Promise.all(['Other Note', 'plume.png', 'kitchen-sink', 'Missing note']
    .map(t => files.resolveWiki(SINK, t)));
  assert.deepEqual(hits.map(h => h && h.path), [OTHER, path.join(VAULT, 'img', 'plume.png'), SINK, null]);
});

test('links never open disguised or non-document files', () => {
  const win = String.raw;
  const refused = [win`C:\T\hello.cmd::$DATA`, win`C:\T\hello.cmd:evil`, win`C:\T\hello.cmd.`, win`C:\T\hello.cmd `];
  for (const p of refused) {
    assert.ok(files.isAmbiguousWindowsName(p, 'win32'), `ambiguous: ${p}`);
    assert.ok(!files.isOpenableFromLink(p, 'win32'), `not openable: ${p}`);
  }
  const openable = [win`C:\T\report.pdf`, win`C:\T\a.b.c.PNG`, win`\\server\share\doc.pdf`, win`C:\T\notes.txt`];
  for (const p of openable) {
    assert.ok(!files.isAmbiguousWindowsName(p, 'win32'), `plain: ${p}`);
    assert.ok(files.isOpenableFromLink(p, 'win32'), `openable: ${p}`);
  }
  const folderOnly = [win`C:\T\run.exe`, win`C:\T\HELLO~1.CMD`, win`C:\T\page.html`, win`C:\T\pic.svg`, win`C:\T\x.lnk`, win`C:\T\noext`];
  for (const p of folderOnly) {
    assert.ok(!files.isOpenableFromLink(p, 'win32'), `folder only: ${p}`);
  }
});

test('colons and trailing dots are ordinary file names outside Windows', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.ok(!files.isAmbiguousWindowsName('/notes/10:30 meeting.pdf', platform));
    assert.ok(files.isOpenableFromLink('/notes/10:30 meeting.pdf', platform));
    assert.ok(!files.isOpenableFromLink('/notes/run.sh', platform));
  }
});

test('uncHost finds the server of Windows network paths', () => {
  const win = String.raw;
  assert.equal(files.uncHost(win`\\Server\share\a.md`, 'win32'), 'server');
  assert.equal(files.uncHost('//attacker.example/share/x.png', 'win32'), 'attacker.example');
  assert.equal(files.uncHost(win`\\?\UNC\Host\share\a.md`, 'win32'), 'host');
  assert.equal(files.uncHost(win`\\.\pipe\x`, 'win32'), '');
  assert.equal(files.uncHost(win`\\?\C:\notes\a.md`, 'win32'), null);
  assert.equal(files.uncHost(win`C:\notes\a.md`, 'win32'), null);
  assert.equal(files.uncHost('//host/share/a.md', 'linux'), null);
});

test('isForeignUnc keeps document-derived paths off other computers', () => {
  const win = String.raw;
  const local = win`C:\notes\a.md`;
  const shared = win`\\nas\notes\a.md`;
  assert.ok(!files.isForeignUnc(win`C:\notes\b.png`, local, 'win32'));
  assert.ok(files.isForeignUnc(win`\\attacker\share\x.png`, local, 'win32'));
  assert.ok(files.isForeignUnc(win`\\attacker\share\x.png`, null, 'win32'));
  assert.ok(!files.isForeignUnc(win`\\NAS\notes\img\b.png`, shared, 'win32'));
  assert.ok(files.isForeignUnc(win`\\other\notes\b.png`, shared, 'win32'));
  assert.ok(files.isForeignUnc(win`\\.\pipe\x`, shared, 'win32'));
  assert.ok(!files.isForeignUnc('//host/share/x.png', '/home/me/a.md', 'linux'));
});
