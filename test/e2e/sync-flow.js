'use strict';

// End-to-end check that folder sync really goes both ways, against a real
// vault server. It drives the main-process modules directly rather than the
// UI, because what is being proved here is what happens to files on a disk
// and documents in a vault — not what a panel says about them.
//
//   set PLUME_VAULT_API=http://127.0.0.1:8098/api
//   npx electron test/e2e/sync-flow.js
//
// Never point this at production: it creates an account, writes documents,
// and deletes them again.

const { app } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const API = process.env.PLUME_VAULT_API;
if (!API) {
  console.error('sync-flow: PLUME_VAULT_API is required');
  process.exit(2);
}
if (/plume-md\.com/i.test(API)) {
  console.error('sync-flow: refusing to run against production');
  process.exit(2);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-sync-'));
app.setPath('userData', userData);

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-sync-notes-'));
const PREFIX = path.basename(folder);

const results = [];
let failures = 0;
function record(name, ok, detail) {
  results.push({ name, ok });
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const write = (name, body) => {
  const p = path.join(folder, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};

app.whenReady().then(async () => {
  const settings = require('../../src/main/settings');
  const vault = require('../../src/main/vault');
  const sync = require('../../src/main/sync');

  // A second session on the same account, standing in for another machine:
  // it changes the vault without touching what this machine remembers.
  let awayToken = null;
  const elsewhere = async (method, vaultPath) => {
    const res = await fetch(`${API}/vault/file?path=${encodeURIComponent(vaultPath)}`, {
      method,
      headers: { authorization: `Bearer ${awayToken}` },
    });
    if (!res.ok) throw new Error(`${method} ${vaultPath} → ${res.status}`);
    return res;
  };

  try {
    settings.load();

    // ---- an account to sync into ----
    const email = `sync-${Date.now()}@plume-md.test`;
    const password = 'correct horse battery staple';
    await vault.signUp(email, password);
    awayToken = await (async () => {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      return (await res.json()).token;
    })();
    record('an account can be made', vault.publicState().signedIn, email);

    // Local-first: the copy on this disk is the real one, and signing in does
    // not hand a folder to the cloud. A folder open in the window stays a
    // folder open in the window until somebody says otherwise.
    settings.update({ folder });
    record('signing in syncs nothing on its own',
      !settings.get().vaultFolder && !settings.get().vaultPrefix,
      `vaultFolder=${settings.get().vaultFolder} prefix=${settings.get().vaultPrefix}`);

    settings.update({ vaultFolder: folder, vaultPrefix: PREFIX, syncPaused: false });

    // ---- what is written here goes up ----
    write('one.md', '# One\n\nthe first note\n');
    write(path.join('Journal', 'two.md'), '# Two\n\nin a subfolder\n');
    await sync.syncNow();

    let listing = await vault.list();
    let names = listing.files.map(f => f.path).sort();
    record('documents go up, under the folder they came from',
      names.includes(`${PREFIX}/one.md`) && names.includes(`${PREFIX}/Journal/two.md`),
      names.join(', '));

    // ---- a document written elsewhere comes down ----
    //
    // "Elsewhere" is another machine pushing into the same vault: a file
    // outside the folder, pushed under a name inside it, with this machine's
    // memory of it dropped so it looks like news.
    const away = path.join(userData, 'from-another-machine.md');
    await fsp.writeFile(away, '# Three\n\nwritten on another machine\n');
    await vault.push(away, `${PREFIX}/three.md`);
    vault.unlink(away);

    await sync.syncNow();
    const arrived = path.join(folder, 'three.md');
    record('a document written elsewhere arrives here',
      fs.existsSync(arrived)
      && fs.readFileSync(arrived, 'utf8').includes('written on another machine'),
      arrived);

    // ---- an edit made elsewhere comes down ----
    await fsp.writeFile(away, '# Three\n\nedited on another machine\n');
    await vault.push(away, `${PREFIX}/three.md`, { force: true });
    vault.unlink(away);
    await sync.syncNow();
    record('an edit made elsewhere replaces the copy here',
      fs.readFileSync(arrived, 'utf8').includes('edited on another machine'),
      JSON.stringify(fs.readFileSync(arrived, 'utf8').slice(0, 40)));

    // ---- deleting here deletes there ----
    await fsp.unlink(path.join(folder, 'one.md'));
    await sync.syncNow();
    listing = await vault.list();
    names = listing.files.map(f => f.path);
    record('a document deleted here is deleted in the vault',
      !names.includes(`${PREFIX}/one.md`), names.join(', '));

    // ---- deleting there deletes here ----
    //
    // Deleted from another machine, which is the only way this happens in
    // life. It matters that it is not vault.remove() from here: that also
    // forgets this machine's record of the document, and without that record
    // the file on this disk is indistinguishable from one that was never
    // synced — so it would go back up rather than come down, which is the
    // safe way to be wrong but not the behaviour being tested.
    await elsewhere('DELETE', `${PREFIX}/Journal/two.md`);
    await sync.syncNow();
    record('a document deleted in the vault is deleted here',
      !fs.existsSync(path.join(folder, 'Journal', 'two.md')),
      fs.existsSync(path.join(folder, 'Journal')) ? fs.readdirSync(path.join(folder, 'Journal')).join(', ') : '(no Journal folder)');

    // The one place something on this disk goes away because of something
    // that happened elsewhere, so it goes away recoverably.
    const binned = [];
    const bin = path.join(folder, '.plume-trash');
    const sweep = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sweep(full);
        else binned.push(full);
      }
    };
    if (fs.existsSync(bin)) sweep(bin);
    record('a document deleted elsewhere is kept in the folder trash',
      binned.some(f => f.endsWith('two.md')), binned.join(', '));

    // ---- both sides moved: both are kept ----
    const contested = write('contested.md', 'the version on this machine\n');
    await sync.syncNow();                       // both sides now agree
    // Someone else edits it…
    await fsp.writeFile(away, 'the version from somewhere else\n');
    await vault.push(away, `${PREFIX}/contested.md`, { force: true });
    vault.unlink(away);
    // …and so do we, before hearing about it.
    await fsp.writeFile(contested, 'the version on this machine, edited\n');
    await sleep(1100);                          // a clearly later mtime
    await sync.syncNow();

    const siblings = fs.readdirSync(folder).filter(n => n.startsWith('contested'));
    const copy = siblings.find(n => /vault copy/.test(n));
    record('when both sides moved, both copies survive',
      Boolean(copy) && fs.readFileSync(contested, 'utf8').includes('on this machine, edited'),
      siblings.join(', '));
    record('the copy kept is the one from the vault',
      Boolean(copy) && fs.readFileSync(path.join(folder, copy), 'utf8').includes('from somewhere else'));

    // ---- another folder is another notebook, not a merge ----
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-sync-other-'));
    const secondPrefix = path.basename(second);
    fs.writeFileSync(path.join(second, 'only-here.md'), '# Only here\n');
    settings.update({ vaultFolder: second, vaultPrefix: secondPrefix });
    await sync.syncNow();

    listing = await vault.list();
    names = listing.files.map(f => f.path);
    record('switching folders adds a notebook rather than merging one',
      names.includes(`${secondPrefix}/only-here.md`)
      && names.some(n => n.startsWith(`${PREFIX}/`)),
      names.join(', '));
    record('the folder that stopped syncing is still in the vault',
      names.includes(`${PREFIX}/three.md`), names.join(', '));
    record('the new folder did not take the old one down with it',
      fs.readdirSync(second).filter(n => n.endsWith('.md')).length === 1,
      fs.readdirSync(second).join(', '));
    // ---- a second machine opens a notebook that already exists ----
    //
    // An empty folder, pointed at a notebook that is already in the vault:
    // every document is in the vault and none is here, so an ordinary sync is
    // all downloads. This is what "open my vault on this computer" is.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-sync-fresh-'));
    settings.update({ vaultFolder: fresh, vaultPrefix: PREFIX });
    await sync.syncNow();

    const landed = fs.readdirSync(fresh).filter(n => n.endsWith('.md')).sort();
    record('an existing notebook downloads into an empty folder',
      landed.includes('three.md') && landed.includes('contested.md'), landed.join(', '));
    record('what downloaded is what the vault holds',
      fs.readFileSync(path.join(fresh, 'three.md'), 'utf8').includes('edited on another machine'));
    record('the other notebook was not dragged in with it',
      !fs.existsSync(path.join(fresh, 'only-here.md')), landed.join(', '));
  } catch (err) {
    record('the run finished without throwing', false, err && err.message);
  }

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  app.exit(failures ? 1 : 0);
});
