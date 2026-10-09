'use strict';

// Folder sync decides, for every document, which of two copies is newer and
// what to do about it. Getting that wrong deletes somebody's writing, so the
// decision is tested on its own, exhaustively, rather than only through a
// sync that happens to exercise some of it.
//
// The three inputs are the copy here, the copy in the vault, and `base` —
// what this machine last saw. Only `sha256` is read off each.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const os = require('node:os');
const fs = require('node:fs');

// sync.js asks vaults.js which computer this is, to name a conflict copy.
// Outside a window there is no userData folder, so it is told where to look.
process.env.PLUME_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-sync-test-'));

const sync = require(path.join(__dirname, '..', 'src', 'main', 'sync.js'));

const file = sha => ({ sha256: sha });
const seen = sha => ({ vaultPath: 'note.md', sha256: sha, syncedAt: '2026-10-09T00:00:00.000Z' });

test('a document the same on both sides is left alone', () => {
  assert.strictEqual(sync.decide(file('a'), file('a'), seen('a')), 'none');
  // Even with no record of ever having synced it: identical is identical.
  assert.strictEqual(sync.decide(file('a'), file('a'), null), 'none');
});

test('a change on one side only goes to the other', () => {
  // Written here since the last sync; the vault is still where we left it.
  assert.strictEqual(sync.decide(file('new'), file('old'), seen('old')), 'push');
  // Written elsewhere; this copy is still the one we synced.
  assert.strictEqual(sync.decide(file('old'), file('new'), seen('old')), 'pull');
});

test('a document new on one side appears on the other', () => {
  assert.strictEqual(sync.decide(file('a'), null, null), 'push');
  assert.strictEqual(sync.decide(null, file('a'), null), 'pull');
});

test('when both sides moved, both are kept', () => {
  // Neither matches what we last synced, so neither can be called stale.
  assert.strictEqual(sync.decide(file('mine'), file('theirs'), seen('old')), 'conflict');
});

test('signing in on a folder that already has a vault keeps both copies', () => {
  // The first sync of a folder has no base for anything. Two different
  // documents under one name is exactly the case that must not pick a winner.
  assert.strictEqual(sync.decide(file('mine'), file('theirs'), null), 'conflict');
});

test('a delete carries across only for a document left alone since it synced', () => {
  // Deleted in the vault, untouched here since we synced it: the delete is
  // the newer fact.
  assert.strictEqual(sync.decide(file('a'), null, seen('a')), 'delete-local');
  // Deleted here, and it was synced from here: the delete goes up.
  assert.strictEqual(sync.decide(null, file('a'), seen('a')), 'delete-remote');
});

test('an edit always beats a delete', () => {
  // Gone from the vault, but written here since the last sync. Honouring the
  // delete would throw away work that exists; it goes up instead, and forced,
  // because the base it would be checked against is no longer there.
  assert.strictEqual(sync.decide(file('edited'), null, seen('old')), 'push-force');
});

test('nothing is ever destroyed to settle a disagreement', () => {
  // The property that matters, stated as a property: for every combination of
  // three inputs, a document is only ever removed from a side when the other
  // side agreed it was unchanged since the last sync.
  const shas = ['a', 'b', undefined];
  for (const localSha of shas) {
    for (const remoteSha of shas) {
      for (const baseSha of shas) {
        const local = localSha ? file(localSha) : null;
        const remote = remoteSha ? file(remoteSha) : null;
        const base = baseSha ? seen(baseSha) : null;
        if (!local && !remote) continue;

        const verdict = sync.decide(local, remote, base);

        if (verdict === 'delete-local') {
          assert.ok(local && !remote, 'only deletes here when the vault has none');
          assert.strictEqual(local.sha256, base.sha256,
            'only deletes a local copy that is still the one we synced');
        }
        if (verdict === 'delete-remote') {
          assert.ok(!local && remote, 'only deletes in the vault when this disk has none');
          assert.ok(base, 'only deletes a vault copy this machine had synced');
        }
        if (verdict === 'conflict') {
          assert.ok(local && remote && local.sha256 !== remote.sha256,
            'a conflict needs two copies that really differ');
        }
      }
    }
  }
});

test('a vault path becomes a path inside the folder, and never outside it', () => {
  const root = path.join(path.sep, 'notes');
  assert.strictEqual(sync.localPathFor(root, 'a.md'), path.join(root, 'a.md'));
  assert.strictEqual(sync.localPathFor(root, 'Journal/2026/a.md'),
    path.join(root, 'Journal', '2026', 'a.md'));
  // Empty segments are dropped rather than producing a path that walks up.
  assert.strictEqual(sync.localPathFor(root, 'Journal//a.md'),
    path.join(root, 'Journal', 'a.md'));
});

test('only documents and images are ever uploaded', () => {
  // The allow-list is what keeps a folder's .exe or .zip on this computer.
  assert.strictEqual(sync.refuse('notes.md', 10), null);
  assert.strictEqual(sync.refuse('photo.png', 10), null);
  assert.ok(sync.refuse('setup.exe', 10));
  assert.ok(sync.refuse('archive.zip', 10));
  assert.ok(sync.refuse('script.sh', 10));
  assert.ok(sync.refuse('no-extension', 10));
  assert.ok(sync.refuse('huge.md', 11 * 1024 * 1024), 'over the per-file limit');
});

// ---------------------------------------------------------------------------
// A vault holds more than one notebook

test('a folder takes a folder of its own inside the vault, named after itself', () => {
  assert.strictEqual(sync.prefixFor(path.join('E:', 'notes', 'Journal')), 'Journal');
  assert.strictEqual(sync.prefixFor(path.join('E:', 'MD APP', 'docs')), 'docs');
  // Nothing the vault would refuse as a name gets through.
  assert.strictEqual(sync.prefixFor(path.join('E:', '  spaced  ')), 'spaced');
  assert.strictEqual(sync.prefixFor(''), 'Notes');
  assert.ok(!sync.prefixFor(path.join('E:', '...hidden')).startsWith('.'));
});

test('a document is named under its folder, and comes back to the same place', () => {
  const root = path.join(path.sep, 'notes');
  const file = path.join(root, 'Journal', 'today.md');
  const vaultPath = sync.vaultPathFor(file, root, 'Journal');
  assert.strictEqual(vaultPath, 'Journal/Journal/today.md');
  // Round trip: the name in the vault leads back to the file it came from.
  assert.strictEqual(sync.localPathFor(root, vaultPath, 'Journal'), file);
});

test('without a prefix, names are what they always were', () => {
  // An account syncing before vaults held more than one notebook keeps its
  // documents where it put them, rather than re-uploading the lot.
  const root = path.join(path.sep, 'notes');
  const file = path.join(root, 'a.md');
  assert.strictEqual(sync.vaultPathFor(file, root, ''), 'a.md');
  assert.strictEqual(sync.localPathFor(root, 'a.md', ''), file);
});

test('a folder only ever sees its own part of the vault', () => {
  assert.ok(sync.underPrefix('Journal/today.md', 'Journal'));
  assert.ok(sync.underPrefix('Journal', 'Journal'));
  // Another notebook is none of this folder's business — this is what stops
  // changing folders from merging two notebooks, or deleting the other one
  // for not being on this disk.
  assert.ok(!sync.underPrefix('Work/plan.md', 'Journal'));
  assert.ok(!sync.underPrefix('JournalOther/x.md', 'Journal'));
  // With no prefix, everything is this folder's business, as it used to be.
  assert.ok(sync.underPrefix('anything/at/all.md', ''));
});

test('a deep document keeps the name of the notebook it belongs to', () => {
  // The vault accepts twelve segments. The prefix is the one that cannot be
  // trimmed away, because it is what says which notebook this is.
  const root = path.join(path.sep, 'notes');
  const deep = path.join(root, ...Array.from({ length: 14 }, (_, i) => `d${i}`), 'note.md');
  const vaultPath = sync.vaultPathFor(deep, root, 'Journal');
  const parts = vaultPath.split('/');
  assert.ok(parts.length <= 12, `${parts.length} segments`);
  assert.strictEqual(parts[0], 'Journal');
  assert.strictEqual(parts[parts.length - 1], 'note.md');
});

// ---------------------------------------------------------------------------
// The guard against a sync that is really an accident

test('a sync that would remove most of a notebook is stopped', () => {
  // The shapes this is here to catch: a folder pointed at the wrong notebook,
  // a drive that has not finished mounting, a notebook name out of step with
  // its folder. All of them look like "everything was deleted".
  assert.ok(sync.alarming(47, 47), 'every document in the notebook');
  assert.ok(sync.alarming(30, 47), 'most of it');
  assert.ok(sync.alarming(10, 10), 'a small notebook, all of it');
});

test('ordinary tidying is not stopped', () => {
  // Both halves of the rule have to be true, so neither a few deletions out
  // of a large notebook nor a large share of a tiny one trips it.
  assert.ok(!sync.alarming(9, 10), 'under the count, however large the share');
  assert.ok(!sync.alarming(12, 200), 'a dozen out of two hundred is tidying');
  assert.ok(!sync.alarming(3, 3), 'three documents is not an accident');
  assert.ok(!sync.alarming(0, 47), 'nothing to delete');
});

// ---------------------------------------------------------------------------
// Conflict copies
//
// When both sides moved, both are kept. The copy that comes down has to be
// told apart from the one that was already here, and from a conflict on
// another machine last week — so it is named for the day and the computer.

test('a conflict copy sits beside the original, named for the day and the machine', () => {
  const made = sync.conflictPath(path.join('C:', 'Notes', 'idea.md'));
  const name = path.basename(made);

  assert.equal(path.dirname(made), path.join('C:', 'Notes'), 'beside the original');
  assert.ok(name.startsWith('idea (conflict '), `got ${name}`);
  assert.ok(name.endsWith('.md'), 'still a Markdown file, so it opens like one');
  assert.match(name, /\(conflict \d{4}-\d{2}-\d{2} /, 'the day it happened');
});

test('a conflict copy never overwrites the document it is a copy of', () => {
  const original = path.join('C:', 'Notes', 'idea.md');
  assert.notEqual(sync.conflictPath(original), original);
});

// ---------------------------------------------------------------------------
// Naming a vault in the account
//
// A remote vault is one top-level folder of the account's store. Two vaults
// linked under one name would merge into one notebook, so a name that is
// taken is never handed out twice.

const vault = require(path.join(__dirname, '..', 'src', 'main', 'vault.js'));

test('a vault name becomes a folder name the account will accept', () => {
  assert.equal(vault.remoteNameFrom('My Notes'), 'My Notes');
  assert.equal(vault.remoteNameFrom('Work/2026'), 'Work 2026', 'no second level smuggled in');
  assert.equal(vault.remoteNameFrom('..'), 'Vault', 'never a step outside');
  assert.equal(vault.remoteNameFrom('.hidden'), 'hidden');
  assert.equal(vault.remoteNameFrom(''), 'Vault');
  assert.equal(vault.remoteNameFrom(null), 'Vault');
});

test('a name already in use is not handed out a second time', () => {
  assert.equal(vault.freeRemoteName('Notes', []), 'Notes');
  assert.equal(vault.freeRemoteName('Notes', ['Notes']), 'Notes 2');
  assert.equal(vault.freeRemoteName('Notes', ['Notes', 'Notes 2']), 'Notes 3');
  // Case is not a distinction the store can be trusted to make.
  assert.equal(vault.freeRemoteName('Notes', ['notes']), 'Notes 2');
});

test('a document names the vault it belongs to', () => {
  assert.equal(vault.remoteOf('Work Notes/Projects/plan.md'), 'Work Notes');
  // A document at the top of the store belongs to no vault at all.
  assert.equal(vault.remoteOf('stray.md'), '');
});
