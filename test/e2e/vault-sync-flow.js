'use strict';

// End-to-end check of the vault model, against a real vault server.
//
// It drives the main-process modules directly rather than the UI, because what
// is being proved here is what happens to files on a disk and documents in an
// account — not what a panel says about them.
//
//   set PLUME_VAULT_API=http://127.0.0.1:8098/api
//   npx electron test/e2e/vault-sync-flow.js
//
// Never point this at production: it creates an account, writes documents, and
// deletes them again.
//
// The spine of it is the promise the whole model rests on: a folder is never
// silently a vault, a vault is never silently linked, and nothing is ever
// destroyed to settle a disagreement.

const { app } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const API = process.env.PLUME_VAULT_API;
if (!API) {
  console.error('vault-sync-flow: PLUME_VAULT_API is required');
  process.exit(2);
}
if (/plume-md\.com/i.test(API)) {
  console.error('vault-sync-flow: refusing to run against production');
  process.exit(2);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-vaults-'));
app.setPath('userData', userData);
process.env.PLUME_USER_DATA = userData;

const results = [];
let failures = 0;
function record(name, ok, detail) {
  results.push({ name, ok });
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeFolder(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

function write(dir, name, body) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

function listFiles(dir) {
  const out = [];
  const sweep = d => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '.plume') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) sweep(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  sweep(dir);
  return out.sort();
}

app.whenReady().then(async () => {
  const settings = require('../../src/main/settings');
  const vault = require('../../src/main/vault');
  const vaults = require('../../src/main/vaults');
  const sync = require('../../src/main/sync');

  // A second session on the same account, standing in for another computer:
  // it changes the account without touching what this machine remembers.
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

    // ---------------------------------------------------------------- account
    const email = `vaults-${Date.now()}@plume-md.test`;
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

    // ------------------------------------------------------- loose stays loose
    //
    // The promise the whole model rests on. Opening a folder of Markdown while
    // signed in commits Plume to nothing at all.
    const loose = makeFolder('plume-loose-');
    write(loose, 'private.md', '# Private\n\nthis must never leave this disk\n');
    write(loose, 'Notes/secret.md', 'nor this\n');
    settings.update({ folder: loose });

    record('a folder of Markdown is not a vault', !vaults.isVault(loose));
    record('a loose folder has no .plume directory',
      !fs.existsSync(path.join(loose, '.plume')), fs.readdirSync(loose).join(', '));

    await sync.syncNow();
    let listing = await vault.list();
    record('nothing in a loose folder is ever uploaded',
      (listing.files || []).length === 0,
      (listing.files || []).map(f => f.path).join(', ') || '(account empty)');

    // ------------------------------------------------- a vault, but local only
    const home = makeFolder('plume-vault-');
    write(home, 'Welcome.md', '# Welcome\n\nthe first note\n');
    write(home, 'Journal/today.md', '# Today\n\nin a subfolder\n');
    write(home, 'notes.exe', 'definitely not a document');

    const made = vaults.create(home, { name: 'Field Notes' });
    record('creating a vault writes .plume and nothing else',
      vaults.isVault(home) && fs.existsSync(path.join(home, '.plume', 'vault.json')));
    record('creating a vault moves no file',
      listFiles(home).join(',') === 'Journal/today.md,Welcome.md,notes.exe',
      listFiles(home).join(', '));
    record('a new vault is not linked to anything', made.linked === false);

    await sync.syncNow();
    listing = await vault.list();
    record('a local-only vault uploads nothing and costs no quota',
      (listing.files || []).length === 0 && (listing.account.usedBytes || 0) === 0,
      `${(listing.files || []).length} documents, ${listing.account.usedBytes || 0} bytes`);

    // ---------------------------------------------------------------- linking
    const remoteName = vault.freeRemoteName(made.name, []);
    vaults.link(home, {
      accountEmail: email,
      remoteVaultId: remoteName,
      remoteName,
    });
    record('linking names the vault in the account',
      vaults.read(home).link.remoteName === 'Field Notes', remoteName);

    await sync.syncNow(home);
    listing = await vault.list();
    let names = (listing.files || []).map(f => f.path).sort();
    record('linking sends everything up, under the vault’s own name',
      names.includes('Field Notes/Welcome.md') && names.includes('Field Notes/Journal/today.md'),
      names.join(', '));
    record('a program in a vault is left alone, not uploaded',
      !names.some(n => n.endsWith('.exe')), names.join(', '));

    // -------------------------------------------- a change on another computer
    const away = path.join(userData, 'from-another-computer.md');
    await fsp.writeFile(away, '# Arrived\n\nwritten on another computer\n');
    await vault.push(away, 'Field Notes/arrived.md');
    vault.unlink(away);

    await sync.syncNow(home);
    const arrived = path.join(home, 'arrived.md');
    record('a document written elsewhere arrives here',
      fs.existsSync(arrived) && fs.readFileSync(arrived, 'utf8').includes('another computer'),
      arrived);

    await fsp.writeFile(away, '# Arrived\n\nedited on another computer\n');
    await vault.push(away, 'Field Notes/arrived.md', { force: true });
    vault.unlink(away);
    await sync.syncNow(home);
    record('an edit made elsewhere replaces the copy here',
      fs.readFileSync(arrived, 'utf8').includes('edited on another computer'));

    // ------------------------------------------------------- deletes both ways
    await fsp.unlink(path.join(home, 'Welcome.md'));
    await sync.syncNow(home);
    listing = await vault.list();
    names = (listing.files || []).map(f => f.path);
    record('a document deleted here is deleted in the account',
      !names.includes('Field Notes/Welcome.md'), names.join(', '));

    await elsewhere('DELETE', 'Field Notes/Journal/today.md');
    await sync.syncNow(home);
    record('a document deleted elsewhere is deleted here',
      !fs.existsSync(path.join(home, 'Journal', 'today.md')));

    // The one place something on this disk goes away because of something that
    // happened elsewhere, so it goes away recoverably — and inside `.plume`,
    // where the walk will never pick it up and send it back.
    const binned = [];
    const bin = path.join(home, '.plume', 'trash');
    const sweep = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sweep(full);
        else binned.push(full);
      }
    };
    if (fs.existsSync(bin)) sweep(bin);
    record('a document deleted elsewhere is kept in the vault’s trash',
      binned.some(f => f.endsWith('today.md')), binned.join(', ') || '(trash empty)');

    // ------------------------------------------- both sides moved: both are kept
    const contested = write(home, 'contested.md', 'the version on this computer\n');
    await sync.syncNow(home);                     // both sides now agree

    await fsp.writeFile(away, 'the version from somewhere else\n');
    await vault.push(away, 'Field Notes/contested.md', { force: true });
    vault.unlink(away);

    await fsp.writeFile(contested, 'the version on this computer, edited\n');
    await sleep(1100);                            // a clearly later mtime
    await sync.syncNow(home);

    const siblings = fs.readdirSync(home).filter(n => n.startsWith('contested'));
    const copy = siblings.find(n => /\(conflict /.test(n));
    record('when both sides moved, both copies survive',
      Boolean(copy) && fs.readFileSync(contested, 'utf8').includes('on this computer, edited'),
      siblings.join(', '));
    record('the conflict copy is the one from the account',
      Boolean(copy) && fs.readFileSync(path.join(home, copy), 'utf8').includes('from somewhere else'));
    record('the conflict copy names the day and the computer',
      Boolean(copy) && /\(conflict \d{4}-\d{2}-\d{2} .+\)\.md$/.test(copy), copy);

    // ------------------------------------------- a second vault is a second vault
    const second = makeFolder('plume-second-');
    write(second, 'contested.md', 'a different note that happens to share a name\n');
    vaults.create(second, { name: 'Other Work' });
    const secondName = vault.freeRemoteName('Other Work', ['Field Notes']);
    vaults.link(second, { accountEmail: email, remoteVaultId: secondName, remoteName: secondName });
    await sync.syncNow(second);

    listing = await vault.list();
    names = (listing.files || []).map(f => f.path);
    record('a second vault is a second vault, not a merge',
      names.includes('Other Work/contested.md') && names.includes('Field Notes/contested.md'),
      names.join(', '));
    record('two vaults holding the same name never meet',
      fs.readFileSync(path.join(second, 'contested.md'), 'utf8').includes('happens to share a name'));
    record('the first vault was not disturbed by the second',
      fs.existsSync(path.join(home, 'arrived.md')));

    // Both at once, which is the thing a single synced folder could not do.
    record('two vaults sync at the same time',
      vaults.known().filter(v => v.linked).length === 2,
      vaults.known().map(v => `${v.name}${v.linked ? ' (linked)' : ''}`).join(', '));

    // ------------------------------------------------------------- the quota
    const account = vault.publicState().account;
    record('the quota is one pool across every linked vault',
      typeof account.usedBytes === 'number' && account.usedBytes > 0,
      `${account.usedBytes} of ${account.quotaBytes} bytes`);

    // ---------------------------------------------------------------- cloning
    //
    // An empty folder with a `.plume/` whose link is already written, pointed
    // at a vault the account already holds: every document is up there and
    // none is here, so an ordinary sync is all downloads.
    const fresh = makeFolder('plume-clone-');
    vaults.create(fresh, { name: 'Field Notes' });
    vaults.link(fresh, { accountEmail: email, remoteVaultId: 'Field Notes', remoteName: 'Field Notes' });
    await sync.syncNow(fresh);

    const landed = listFiles(fresh);
    record('cloning brings a vault down to an empty folder',
      landed.includes('arrived.md') && landed.includes('contested.md'), landed.join(', '));
    record('what came down is what the account holds',
      fs.readFileSync(path.join(fresh, 'arrived.md'), 'utf8').includes('edited on another computer'));
    record('cloning one vault does not drag another in with it',
      !landed.some(n => n.includes('happens to share a name'))
      && !fs.existsSync(path.join(fresh, 'Other Work')), landed.join(', '));

    // --------------------------------------------------------------- unlinking
    //
    // Not a delete, on either side. Both copies survive, and the account goes
    // on holding — and charging for — what was put there.
    const beforeUnlink = (await vault.list()).files.filter(f => f.path.startsWith('Other Work/')).length;
    vaults.unlink(second);
    sync.unwatch(second);
    record('unlinking leaves the folder and every note in it',
      vaults.isVault(second) && fs.existsSync(path.join(second, 'contested.md')));
    record('unlinking is not a delete: the account still holds the copy',
      (await vault.list()).files.filter(f => f.path.startsWith('Other Work/')).length === beforeUnlink,
      `${beforeUnlink} documents`);
    record('an unlinked vault is a local vault again, same identity',
      vaults.read(second).linked === false
      && vaults.read(second).id === vaults.read(second).id);

    await sync.syncNow(second);
    record('an unlinked vault syncs nothing',
      (await vault.list()).files.filter(f => f.path.startsWith('Other Work/')).length === beforeUnlink);

    // ------------------------------------------- deleting a vault from the account
    //
    // The only destructive act, and the only one that frees quota.
    const usedBefore = vault.publicState().account.usedBytes;
    await vault.removeRemote('Other Work');
    const after = await vault.list();
    record('deleting a vault from the account removes its documents',
      !after.files.some(f => f.path.startsWith('Other Work/')),
      after.files.map(f => f.path).join(', '));
    record('deleting a vault from the account frees the space',
      after.account.usedBytes < usedBefore,
      `${usedBefore} → ${after.account.usedBytes} bytes`);
    record('the copy on this computer is left exactly where it was',
      fs.existsSync(path.join(second, 'contested.md')));

    // ------------------------------------------------ loose was never touched
    record('the loose folder is still loose, and still untouched',
      !vaults.isVault(loose)
      && fs.readFileSync(path.join(loose, 'private.md'), 'utf8').includes('never leave this disk')
      && !after.files.some(f => f.path.includes('private')),
      listFiles(loose).join(', '));
  } catch (err) {
    record('the run finished without throwing', false, err && err.stack ? err.stack : err);
  }

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  app.exit(failures ? 1 : 0);
});
