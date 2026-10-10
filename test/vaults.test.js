'use strict';

// What makes a folder a vault, and what must never make one.
//
// The promise this module carries is that opening a folder commits Plume to
// nothing. A reader who opens a folder of notes and closes it again should
// find it byte for byte as it was, with no `.plume/` in it and nothing
// uploaded. Everything below is that promise, stated as a test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// vaults.js keeps this computer's own records — the device id and the list of
// known vaults — in Electron's userData folder. Outside a window there is no
// such folder, so it is told where to put them.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-userdata-'));
process.env.PLUME_USER_DATA = home;

const vaults = require(path.join(__dirname, '..', 'src', 'main', 'vaults.js'));

function tempDir(label = 'plume-vault-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

function write(dir, name, text) {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}

// ---------- loose is the default ----------

test('a folder of Markdown is not a vault', () => {
  const dir = tempDir();
  write(dir, 'idea.md', '# An idea');
  write(dir, 'Notes/deeper.md', 'nested');

  assert.equal(vaults.isVault(dir), false);
  assert.equal(vaults.find(dir), null);
  assert.equal(vaults.read(dir), null);
  // Nothing has been written into it just by being asked about.
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Notes', 'idea.md']);
});

test('a file in a loose folder belongs to no vault', () => {
  const dir = tempDir();
  const note = write(dir, 'idea.md', '# An idea');
  assert.equal(vaults.forPath(note), null);
});

// ---------- creating one ----------

test('creating a vault adopts what is already there and moves nothing', () => {
  const dir = tempDir();
  write(dir, 'Welcome.md', '# Welcome');
  write(dir, 'Notes/today.md', 'today');
  write(dir, 'attachments/diagram.png', 'not really a png');

  const vault = vaults.create(dir, { name: 'My Vault' });

  assert.equal(vault.name, 'My Vault');
  assert.equal(vault.root, path.resolve(dir));
  assert.equal(vault.linked, false);
  assert.ok(vault.id, 'a vault has a permanent id');

  // Every file is exactly where it was.
  assert.equal(fs.readFileSync(path.join(dir, 'Welcome.md'), 'utf8'), '# Welcome');
  assert.equal(fs.readFileSync(path.join(dir, 'Notes', 'today.md'), 'utf8'), 'today');
  assert.ok(fs.existsSync(path.join(dir, 'attachments', 'diagram.png')));

  // And the bookkeeping is all in one place.
  const plume = path.join(dir, '.plume');
  assert.ok(fs.existsSync(path.join(plume, 'vault.json')));
  assert.ok(fs.existsSync(path.join(plume, 'config.json')));
  assert.ok(fs.existsSync(path.join(plume, 'sync', 'manifest.json')));
  assert.ok(fs.existsSync(path.join(plume, 'sync', 'state.json')));
  assert.ok(fs.existsSync(path.join(plume, 'cache')));
  // Not linked, so there is no link file at all — its absence is the state.
  assert.equal(fs.existsSync(path.join(plume, 'link.json')), false);
});

test('a vault takes the folder name when it is given none', () => {
  const dir = tempDir('plume-named-');
  const vault = vaults.create(dir);
  assert.equal(vault.name, path.basename(dir));
});

test('creating a vault twice is the same vault, not a second one', () => {
  const dir = tempDir();
  const first = vaults.create(dir, { name: 'Once' });
  const again = vaults.create(dir, { name: 'Twice' });
  assert.equal(again.id, first.id);
  assert.equal(again.name, 'Once', 'the name is not quietly rewritten');
});

test('deleting .plume makes the folder loose again, with every note intact', () => {
  const dir = tempDir();
  write(dir, 'idea.md', '# An idea');
  vaults.create(dir);
  assert.equal(vaults.isVault(dir), true);

  fs.rmSync(path.join(dir, '.plume'), { recursive: true, force: true });

  assert.equal(vaults.isVault(dir), false);
  assert.equal(fs.readFileSync(path.join(dir, 'idea.md'), 'utf8'), '# An idea');
});

// ---------- making one from a name and a place ----------

// The other order: the name first, and the folder made to match it, so a new
// vault is not stuck being called whatever a file dialog's New Folder button
// was given.

test('a new vault is made in a folder of its own name', () => {
  const parent = tempDir('plume-parent-');

  const vault = vaults.createNew(parent, 'Field Notes');

  assert.equal(vault.name, 'Field Notes');
  assert.equal(vault.root, path.join(parent, 'Field Notes'));
  assert.equal(vaults.isVault(vault.root), true);
  // The folder it was put in is otherwise untouched.
  assert.deepEqual(fs.readdirSync(parent), ['Field Notes']);
});

test('a name a folder cannot have is refused, and nothing is made', () => {
  const parent = tempDir('plume-parent-');

  for (const bad of ['', '   ', '...', 'NUL', 'com1', '<>:"|?*']) {
    assert.throws(() => vaults.createNew(parent, bad), /name a folder can have|Letters/i,
      `“${bad}” should not be a vault name`);
  }
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('a name with path separators in it does not escape the location', () => {
  const parent = tempDir('plume-parent-');
  // The separators are not cleaned into a deeper path: they are not allowed
  // in a folder name at all, so what is left is one folder, here.
  const vault = vaults.createNew(parent, 'Notes/../../escaped');

  assert.equal(path.dirname(vault.root), path.resolve(parent));
  assert.deepEqual(fs.readdirSync(parent), [path.basename(vault.root)]);
});

test('a folder that is already there is not taken over', () => {
  const parent = tempDir('plume-parent-');
  write(parent, 'Journal/old.md', 'mine');

  assert.throws(() => vaults.createNew(parent, 'Journal'), /already in that folder/);
  // Which is the whole point: the notes in it are untouched and it is still
  // loose, so claiming it is still a choice somebody gets to make.
  assert.equal(fs.readFileSync(path.join(parent, 'Journal', 'old.md'), 'utf8'), 'mine');
  assert.equal(vaults.isVault(path.join(parent, 'Journal')), false);
});

test('a vault cannot be made inside another one, and leaves no empty folder', () => {
  const outer = tempDir();
  vaults.create(outer, { name: 'Outer' });

  assert.throws(() => vaults.createNew(outer, 'Inner'), /already inside the vault/);
  assert.equal(fs.existsSync(path.join(outer, 'Inner')), false);
});

// ---------- a vault is found from anywhere inside it ----------

test('a note deep inside a vault knows which vault it is in', () => {
  const dir = tempDir();
  const note = write(dir, 'Projects/2026/plan.md', 'a plan');
  const vault = vaults.create(dir, { name: 'Deep' });

  assert.equal(vaults.find(path.dirname(note)), vault.root);
  assert.equal(vaults.forPath(note).id, vault.id);
});

// ---------- nesting is refused on both sides ----------

test('a folder inside a vault cannot become a vault', () => {
  const outer = tempDir();
  vaults.create(outer, { name: 'Outer' });
  const innerDir = path.join(outer, 'Projects');
  fs.mkdirSync(innerDir, { recursive: true });

  assert.throws(() => vaults.create(innerDir), /already inside the vault/i);
  assert.equal(fs.existsSync(path.join(innerDir, '.plume')), false);
});

test('a folder holding a vault cannot become a vault', () => {
  const parent = tempDir();
  const inner = path.join(parent, 'Notebook');
  fs.mkdirSync(inner, { recursive: true });
  vaults.create(inner, { name: 'Inner' });

  assert.throws(() => vaults.create(parent), /cannot hold another one/i);
  assert.equal(fs.existsSync(path.join(parent, '.plume')), false);
});

// ---------- linking and unlinking ----------

test('linking records the account, and unlinking leaves every note alone', () => {
  const dir = tempDir();
  write(dir, 'idea.md', '# An idea');
  const vault = vaults.create(dir, { name: 'Linkable' });
  assert.equal(vault.linked, false);

  const linked = vaults.link(dir, {
    accountId: 'acct_1',
    accountEmail: 'me@example.com',
    remoteVaultId: 'Linkable',
    remoteName: 'Linkable',
  });
  assert.equal(linked.linked, true);
  assert.equal(linked.link.remoteName, 'Linkable');
  assert.equal(linked.link.accountEmail, 'me@example.com');
  assert.ok(linked.link.linkedAt);

  const loose = vaults.unlink(dir);
  assert.equal(loose.linked, false);
  assert.equal(loose.link, null);
  // Still a vault, still every note, same id.
  assert.equal(loose.id, vault.id);
  assert.equal(fs.readFileSync(path.join(dir, 'idea.md'), 'utf8'), '# An idea');
  assert.equal(fs.existsSync(path.join(dir, '.plume', 'link.json')), false);
});

test('unlinking clears the base a sync would compare against', () => {
  // Keeping it would let a relink to a different remote diff against a
  // revision that remote never had, and silently call it a conflict — or
  // worse, not.
  const dir = tempDir();
  vaults.create(dir, { name: 'Based' });
  vaults.link(dir, { remoteVaultId: 'Based', remoteName: 'Based' });
  vaults.writeManifest(dir, { rev: 7, files: { 'Based/idea.md': { hash: 'abc', size: 3 } } });

  vaults.unlink(dir);

  const manifest = vaults.readManifest(dir);
  assert.equal(manifest.rev, 0);
  assert.deepEqual(Object.keys(manifest.files), []);
  assert.equal(vaults.readState(dir).lastSyncedRev, 0);
});

// ---------- the manifest ----------

test('the manifest survives a round trip, and a damaged one is not fatal', () => {
  const dir = tempDir();
  vaults.create(dir);

  vaults.writeManifest(dir, {
    rev: 3,
    files: { 'Vault/idea.md': { hash: 'deadbeef', size: 12, mtime: 1, rev: 3 } },
  });
  const back = vaults.readManifest(dir);
  assert.equal(back.rev, 3);
  assert.equal(back.files['Vault/idea.md'].hash, 'deadbeef');

  fs.writeFileSync(path.join(dir, '.plume', 'sync', 'manifest.json'), 'not json at all');
  const repaired = vaults.readManifest(dir);
  assert.equal(repaired.rev, 0);
  assert.deepEqual(Object.keys(repaired.files), []);
});

test('a document the server calls __proto__ cannot reparent the manifest', () => {
  // The keys are paths somebody else chose. Assigning to `__proto__` on an
  // ordinary object does not store anything — it reparents the object — so
  // every lookup after it would answer about the wrong file.
  const dir = tempDir();
  vaults.create(dir);
  fs.writeFileSync(
    path.join(dir, '.plume', 'sync', 'manifest.json'),
    '{"rev":1,"files":{"__proto__":{"hash":"evil"},"ok.md":{"hash":"good"}}}',
  );

  const manifest = vaults.readManifest(dir);
  assert.equal(manifest.files['ok.md'].hash, 'good');
  assert.equal(Object.getPrototypeOf(manifest.files), null, 'no prototype to reach');
  assert.equal(manifest.files.hash, undefined, 'nothing leaked through a prototype');

  // And a document genuinely called __proto__ is stored as a key, not applied.
  manifest.files['__proto__'] = { hash: 'later' };
  vaults.writeManifest(dir, manifest);
  const back = vaults.readManifest(dir);
  assert.equal(back.files['ok.md'].hash, 'good');
});

test('pausing a sync is remembered on this computer, not in the vault itself', () => {
  const dir = tempDir();
  vaults.create(dir);
  assert.equal(vaults.readState(dir).paused, false);

  vaults.writeState(dir, { paused: true });
  assert.equal(vaults.readState(dir).paused, true);

  // Writing something else does not quietly un-pause it.
  vaults.writeState(dir, { last_sync_at: '2026-10-09T00:00:00.000Z' });
  assert.equal(vaults.readState(dir).paused, true);
  assert.equal(vaults.readState(dir).lastSyncAt, '2026-10-09T00:00:00.000Z');
});

// ---------- work held back by a full account ----------

test('an upload held back by a full account is still held back after a restart', () => {
  const dir = tempDir();
  vaults.create(dir);
  assert.deepEqual(vaults.pending(dir), []);

  vaults.queue(dir, { vaultPath: 'V/big.md', localPath: path.join(dir, 'big.md'), size: 999 });
  const waiting = vaults.pending(dir);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].vaultPath, 'V/big.md');
  assert.ok(waiting[0].queuedAt);

  vaults.unqueue(dir, 'V/big.md');
  assert.deepEqual(vaults.pending(dir), []);
});

// ---------- a damaged vault is still a vault ----------

test('a vault with an unreadable vault.json is repaired, not forgotten', () => {
  // Forgetting that a folder was a vault is how a second copy of a notebook
  // gets made, so this case heals rather than reporting a plain folder.
  const dir = tempDir();
  vaults.create(dir, { name: 'Fragile' });
  fs.writeFileSync(path.join(dir, '.plume', 'vault.json'), '{ broken');

  const vault = vaults.read(dir);
  assert.ok(vault, 'still a vault');
  assert.ok(vault.id);
  assert.equal(vault.name, path.basename(dir));
});

// ---------- the list this computer keeps ----------

test('a vault is remembered, and forgetting it leaves the folder alone', () => {
  const dir = tempDir('plume-known-');
  write(dir, 'idea.md', '# An idea');
  const vault = vaults.create(dir, { name: 'Remembered' });

  assert.ok(vaults.known().some(v => v.root === vault.root));

  vaults.forget(vault.root);
  assert.equal(vaults.known().some(v => v.root === vault.root), false);
  // The folder is untouched: forgetting is about this list, nothing else.
  assert.equal(vaults.isVault(dir), true);
  assert.equal(fs.readFileSync(path.join(dir, 'idea.md'), 'utf8'), '# An idea');
});

test('a vault that is no longer on disk drops out of the list', () => {
  const dir = tempDir('plume-gone-');
  const vault = vaults.create(dir, { name: 'Gone' });
  assert.ok(vaults.known().some(v => v.root === vault.root));

  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(vaults.known().some(v => v.root === vault.root), false);
});

test('claiming a folder that is already a vault puts it back on the list', () => {
  // Taking a vault off the list is about the list. Opening the folder as a
  // vault again is how it goes back on — and it was not doing that, so a vault
  // removed from the list and reopened was one you were working in that the
  // app said you did not have.
  const dir = tempDir();
  write(dir, 'note.md', 'mine');
  const made = vaults.create(dir, { name: 'Field Notes' });
  assert.ok(vaults.known().some(v => v.id === made.id));

  vaults.forget(dir);
  assert.equal(vaults.known().some(v => v.id === made.id), false);

  const again = vaults.create(dir, { name: 'ignored, it is already named' });

  assert.equal(again.id, made.id, 'same vault, not a new one');
  assert.equal(again.name, 'Field Notes', 'claiming it again does not rename it');
  assert.ok(vaults.known().some(v => v.id === made.id), 'and it is on the list again');
  assert.equal(fs.readFileSync(path.join(dir, 'note.md'), 'utf8'), 'mine');
});

// ---------- the move from one synced folder ----------

test('an older Plume’s synced folder becomes a linked vault, keeping its name', () => {
  const dir = tempDir('plume-legacy-');
  write(dir, 'idea.md', '# An idea');

  const vault = vaults.adoptLegacy({
    folder: dir,
    prefix: 'Work Notes',
    paused: false,
    accountEmail: 'me@example.com',
  });

  assert.equal(vault.linked, true);
  assert.equal(vault.link.remoteName, 'Work Notes', 'it syncs to where it already was');
  assert.equal(fs.readFileSync(path.join(dir, 'idea.md'), 'utf8'), '# An idea');
});

test('a folder synced to the top of the account is made a vault but not linked', () => {
  // There is no name for it to take, and claiming every loose document in the
  // account on its behalf would be a guess with no way back.
  const dir = tempDir('plume-legacy-root-');
  const vault = vaults.adoptLegacy({ folder: dir, prefix: null });
  assert.equal(vault.linked, false);
});

test('a synced folder that is no longer there is not invented', () => {
  const gone = path.join(os.tmpdir(), 'plume-not-here-at-all-12345');
  assert.equal(vaults.adoptLegacy({ folder: gone, prefix: 'Whatever' }), null);
});

// ---------- the device ----------

test('this computer has a stable name and id for conflict copies', () => {
  const device = vaults.thisDevice();
  assert.ok(device.id);
  assert.ok(device.name);
  assert.equal(vaults.thisDevice().id, device.id, 'asked twice, the same answer');
});
