'use strict';

// What makes a folder a vault.
//
// A folder on disk is never silently a vault. You can open a folder of
// Markdown and read and write every file in it, and Plume will not have
// decided anything about it: no identity, no settings of its own, and nothing
// that could ever be uploaded. It stays loose until somebody says otherwise.
//
// Saying otherwise writes a `.plume/` directory into the folder. That
// directory is the whole of the claim — it holds the vault's permanent id, its
// settings, the file index that sync diffs against, and, once the vault is
// connected to an account, the record of which remote vault it is. Delete
// `.plume/` and the folder is loose again with every note untouched, which is
// the property that makes the claim safe to make.
//
// Three states, and a folder can stop at any of them:
//
//   loose          no .plume/ — editable, never synced, no index
//   local vault    .plume/ exists, no link.json — fully usable offline
//   linked vault   .plume/link.json exists — saves reach the account
//
// Locality and sync are orthogonal to being a vault. Loose files are always
// loose; promotion happens to a folder, never to one file at a time.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { app } = require('electron');

const DIR = '.plume';
const SCHEMA_VERSION = 1;

// How far up the tree a folder is asked about before deciding it is loose.
// Deeper than any sane note nesting, shallow enough to stay instant.
const MAX_WALK_UP = 40;

// Looking for a vault *underneath* a folder is only done to refuse nesting,
// and only ever near the top: a vault buried eight levels down inside another
// is not a case worth the walk.
const MAX_NEST_SCAN_DEPTH = 3;
const SKIP_DIR = /^[.]|^node_modules$|^__pycache__$|^\$RECYCLE/i;

const file = {
  vault: 'vault.json',
  config: 'config.json',
  link: 'link.json',
  workspace: 'workspace.json',
  manifest: path.join('sync', 'manifest.json'),
  state: path.join('sync', 'state.json'),
  pending: path.join('sync', 'pending'),
  cache: 'cache',
};

// ---------- small file helpers ----------

function writeAtomic(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

function readJson(target, fallback = null) {
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(target, value) {
  writeAtomic(target, JSON.stringify(value, null, 2));
}

const inside = (root, ...rest) => path.join(root, DIR, ...rest);

/**
 * Where this computer's own records live — the device id and the list of
 * vaults it knows about. Electron's userData folder in the app; an explicit
 * folder when something is driving this module without a window, which is how
 * the tests and the end-to-end runs reach it.
 */
function userData() {
  if (process.env.PLUME_USER_DATA) return process.env.PLUME_USER_DATA;
  return app.getPath('userData');
}

function isDirSync(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------- this computer ----------

// A device id so a conflict copy can say which machine it came from, and so
// two machines syncing the same remote vault keep separate sync cursors. It is
// local, random, and never leaves this computer except inside a file name.
let device = null;

function thisDevice() {
  if (device) return device;
  const target = path.join(userData(), 'device.json');
  const found = readJson(target);
  if (found && typeof found.id === 'string' && typeof found.name === 'string') {
    device = found;
    return device;
  }
  let name = 'this computer';
  try {
    name = os.hostname() || name;
  } catch { /* a name is a nicety */ }
  device = { id: crypto.randomUUID(), name: String(name).slice(0, 60) };
  try {
    writeJson(target, device);
  } catch { /* a regenerated id costs nothing but a differently named conflict copy */ }
  return device;
}

// ---------- finding one ----------

/** The vault a path belongs to, or null when it belongs to none. */
function find(startDir) {
  if (!startDir) return null;
  let cur = path.resolve(startDir);
  for (let i = 0; i < MAX_WALK_UP; i += 1) {
    if (isDirSync(path.join(cur, DIR))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

function isVault(dir) {
  return Boolean(dir) && isDirSync(path.join(path.resolve(dir), DIR));
}

/**
 * A vault anywhere near the top of this folder, which would make ownership of
 * a file ambiguous if this folder became a vault too.
 */
function vaultBelow(dir, depth = 0) {
  if (depth > MAX_NEST_SCAN_DEPTH) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIR.test(entry.name)) continue;
    const child = path.join(dir, entry.name);
    if (isDirSync(path.join(child, DIR))) return child;
    const deeper = vaultBelow(child, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

// ---------- reading one ----------

/**
 * Everything the rest of the app needs to know about a vault, or null when the
 * folder is loose.
 *
 * Deliberately total: a `.plume/` with a damaged `vault.json` is still a vault,
 * and is repaired here rather than being reported as a folder — forgetting
 * that a folder was a vault is how a second copy of a notebook gets made.
 */
function read(root) {
  if (!root || !isVault(root)) return null;
  const abs = path.resolve(root);

  let identity = readJson(inside(abs, file.vault));
  if (!identity || typeof identity.vault_id !== 'string') {
    identity = {
      schema_version: SCHEMA_VERSION,
      vault_id: crypto.randomUUID(),
      name: path.basename(abs) || 'Vault',
      created_at: new Date().toISOString(),
    };
    try {
      writeJson(inside(abs, file.vault), identity);
    } catch { /* read-only disk: still a vault, just not a repaired one */ }
  }

  const link = readJson(inside(abs, file.link));
  const state = readJson(inside(abs, file.state), {});

  return {
    root: abs,
    id: identity.vault_id,
    name: typeof identity.name === 'string' && identity.name ? identity.name : path.basename(abs),
    createdAt: identity.created_at || null,
    schemaVersion: identity.schema_version || SCHEMA_VERSION,
    linked: Boolean(link && link.remote_vault_id),
    link: link && link.remote_vault_id ? {
      accountId: link.account_id || null,
      accountEmail: link.account_email || null,
      remoteVaultId: link.remote_vault_id,
      remoteName: link.remote_name || link.remote_vault_id,
      linkedAt: link.linked_at || null,
    } : null,
    lastSyncAt: state.last_sync_at || null,
    lastSyncedRev: state.last_synced_rev || 0,
  };
}

/** The vault a document or folder belongs to, read through. */
function forPath(somePath) {
  const start = somePath && isDirSync(somePath) ? somePath : path.dirname(somePath || '');
  const root = find(start);
  return root ? read(root) : null;
}

// ---------- making one ----------

/**
 * Turns a folder into a vault.
 *
 * Non-destructive by construction: nothing is moved, copied or rewritten. The
 * Markdown that was already in the folder is simply now the vault's content,
 * indexed where it lies. This is both "Create Vault" on an empty folder and
 * "Create Vault here" on a folder that already holds a pile of notes — there
 * is no difference between them worth an extra code path.
 */
function create(dir, { name } = {}) {
  const abs = path.resolve(dir);
  if (!isDirSync(abs)) throw new Error('That folder is not there.');

  if (isVault(abs)) return read(abs);

  // Nesting makes it ambiguous which vault owns a file, which makes it
  // ambiguous where that file syncs. Refused on both sides.
  const above = find(path.dirname(abs));
  if (above) {
    throw new Error(`That folder is already inside the vault “${path.basename(above)}”.`);
  }
  const below = vaultBelow(abs);
  if (below) {
    throw new Error(`“${path.basename(below)}” inside this folder is already a vault. `
      + 'A vault cannot hold another one.');
  }

  const identity = {
    schema_version: SCHEMA_VERSION,
    vault_id: crypto.randomUUID(),
    name: cleanName(name) || path.basename(abs) || 'Vault',
    created_at: new Date().toISOString(),
  };

  fs.mkdirSync(inside(abs, 'sync'), { recursive: true });
  fs.mkdirSync(inside(abs, file.pending), { recursive: true });
  fs.mkdirSync(inside(abs, file.cache), { recursive: true });
  writeJson(inside(abs, file.vault), identity);
  writeJson(inside(abs, file.config), { editor: {}, appearance: {} });
  writeJson(inside(abs, file.manifest), { rev: 0, files: {} });
  writeJson(inside(abs, file.state), {
    device_id: thisDevice().id,
    last_synced_rev: 0,
    last_sync_at: null,
  });

  // Plume's own bookkeeping is not somebody's work, and every vault that ends
  // up in Git would otherwise carry a per-device sync cursor into the repo.
  try {
    writeAtomic(inside(abs, '.gitignore'), [
      '# Plume keeps per-device state here. The rest of .plume/ is portable.',
      'link.json',
      'workspace.json',
      'cache/',
      'sync/state.json',
      'sync/pending/',
      '',
    ].join('\n'));
  } catch { /* a missing ignore file is cosmetic */ }

  remember(abs);
  return read(abs);
}

function cleanName(raw) {
  const given = String(raw == null ? '' : raw).replace(/[\r\n\t]/g, ' ').trim();
  return given.slice(0, 120);
}

/** Renames the vault without touching the folder it lives in. */
function rename(root, name) {
  const vault = read(root);
  if (!vault) throw new Error('That folder is not a vault.');
  const clean = cleanName(name);
  if (!clean) throw new Error('Give the vault a name.');
  const identity = readJson(inside(vault.root, file.vault)) || {};
  writeJson(inside(vault.root, file.vault), { ...identity, name: clean });
  remember(vault.root);
  return read(vault.root);
}

// ---------- the account link ----------

function link(root, { accountId, accountEmail, remoteVaultId, remoteName }) {
  const vault = read(root);
  if (!vault) throw new Error('That folder is not a vault.');
  writeJson(inside(vault.root, file.link), {
    account_id: accountId || null,
    account_email: accountEmail || null,
    remote_vault_id: remoteVaultId,
    remote_name: remoteName || remoteVaultId,
    linked_at: new Date().toISOString(),
  });
  remember(vault.root);
  return read(vault.root);
}

/**
 * Disconnects a vault from the account.
 *
 * Both copies survive: the folder keeps every note, and the remote vault keeps
 * every note and goes on counting against the quota. This is not a delete and
 * must never become one — deleting the remote copy is a separate, named act.
 */
function unlink(root) {
  const vault = read(root);
  if (!vault) throw new Error('That folder is not a vault.');
  try {
    fs.rmSync(inside(vault.root, file.link), { force: true });
  } catch { /* already gone */ }
  // The manifest records what the remote held, and means nothing once the
  // remote is no longer this vault's. Keeping it would let a relink to a
  // different remote compare against a base it never had.
  writeManifest(vault.root, { rev: 0, files: {} });
  writeState(vault.root, { last_synced_rev: 0, last_sync_at: null });
  remember(vault.root);
  return read(vault.root);
}

// ---------- the index sync diffs against ----------

/**
 * path -> { hash, size, mtime, rev } for every tracked file, as of the last
 * sync. This is the third opinion that makes a sync a sync: without it "these
 * two copies differ" cannot be told apart from "one of them changed", and one
 * side always loses silently.
 */
function readManifest(root) {
  const found = readJson(inside(root, file.manifest), null);
  if (!found || typeof found.files !== 'object' || !found.files) return { rev: 0, files: {} };
  return { rev: Number(found.rev) || 0, files: found.files };
}

function writeManifest(root, manifest) {
  writeJson(inside(root, file.manifest), {
    rev: Number(manifest.rev) || 0,
    files: manifest.files || {},
  });
}

function readState(root) {
  const found = readJson(inside(root, file.state), {}) || {};
  return {
    deviceId: found.device_id || thisDevice().id,
    lastSyncedRev: Number(found.last_synced_rev) || 0,
    lastSyncAt: found.last_sync_at || null,
    // Pausing is about this machine, not about the vault, so it lives with the
    // sync cursor rather than in the settings that travel between computers.
    paused: Boolean(found.paused),
  };
}

function writeState(root, patch) {
  const current = readJson(inside(root, file.state), {}) || {};
  const keep = (key, value) => (value !== undefined ? value : current[key]);
  writeJson(inside(root, file.state), {
    device_id: current.device_id || thisDevice().id,
    last_synced_rev: keep('last_synced_rev', patch.last_synced_rev) || 0,
    last_sync_at: keep('last_sync_at', patch.last_sync_at) || null,
    paused: Boolean(keep('paused', patch.paused)),
  });
}

// ---------- work that could not go up yet ----------

// When a push would take the account past its quota the local save still
// happened — it is on this disk, which is the copy that matters — and only the
// upload waits. What waits is recorded here so it is still waiting after a
// restart, and so the panel can say how much is held back rather than quietly
// falling behind.

function pendingPath(root, vaultPath) {
  const key = crypto.createHash('sha256').update(vaultPath).digest('hex').slice(0, 32);
  return inside(root, file.pending, `${key}.json`);
}

function queue(root, item) {
  try {
    fs.mkdirSync(inside(root, file.pending), { recursive: true });
    writeJson(pendingPath(root, item.vaultPath), { ...item, queuedAt: new Date().toISOString() });
  } catch { /* the edit is on disk; the queue is an optimisation */ }
}

function unqueue(root, vaultPath) {
  try {
    fs.rmSync(pendingPath(root, vaultPath), { force: true });
  } catch { /* already gone */ }
}

function pending(root) {
  const dir = inside(root, file.pending);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const item = readJson(path.join(dir, name));
    if (item && typeof item.vaultPath === 'string') out.push(item);
  }
  return out;
}

// ---------- open tabs and pane layout ----------

// Device-local on purpose. Two machines on the same vault keep their own
// windows; nobody wants a laptop's tab order to arrive from a desktop.

function readWorkspace(root) {
  return readJson(inside(root, file.workspace), null);
}

function writeWorkspace(root, value) {
  try {
    writeJson(inside(root, file.workspace), value);
  } catch { /* layout is a nicety */ }
}

// ---------- the vaults this computer knows about ----------

// Enough to offer them on launch. The folder is the truth; this is a list of
// where to look, pruned whenever one of them turns out to be gone.

const registryFile = () => path.join(userData(), 'vaults.json');

function registry() {
  const found = readJson(registryFile(), null);
  const rows = found && Array.isArray(found.vaults) ? found.vaults : [];
  return rows.filter(r => r && typeof r.root === 'string');
}

function remember(root) {
  const abs = path.resolve(root);
  const vault = read(abs);
  if (!vault) return;
  const same = p => (process.platform === 'win32'
    ? p.toLowerCase() === abs.toLowerCase() : p === abs);
  const rows = registry().filter(r => !same(r.root));
  rows.unshift({
    root: abs,
    id: vault.id,
    name: vault.name,
    linked: vault.linked,
    remoteName: vault.link ? vault.link.remoteName : null,
    openedAt: new Date().toISOString(),
  });
  try {
    writeJson(registryFile(), { vaults: rows.slice(0, 40) });
  } catch { /* the list is a convenience */ }
}

function forget(root) {
  const abs = path.resolve(root);
  const same = p => (process.platform === 'win32'
    ? p.toLowerCase() === abs.toLowerCase() : p === abs);
  try {
    writeJson(registryFile(), { vaults: registry().filter(r => !same(r.root)) });
  } catch { /* nothing to do about it */ }
}

/** The known vaults that are still on disk, freshest first. */
function known() {
  const out = [];
  for (const row of registry()) {
    const vault = read(row.root);
    if (!vault) continue;
    out.push({ ...vault, openedAt: row.openedAt || null });
  }
  return out;
}

// ---------- the move from one synced folder to vaults ----------

/**
 * Carries an older Plume's single synced folder across.
 *
 * Before vaults, an account synced exactly one folder, named by two settings:
 * which folder, and which top-level name it occupied in the store. That is a
 * linked vault in all but the `.plume/` directory, so it becomes one — same
 * folder, same remote name, same documents — and the first sync afterwards
 * finds everything already up there and does nothing.
 *
 * The manifest starts empty, which means that first sync hashes both sides and
 * compares. Identical files are left alone by `decide`, so a vault carried
 * across uploads nothing and downloads nothing; only genuinely divergent
 * documents are treated as a conflict, which is the right answer anyway.
 */
function adoptLegacy({ folder, prefix, paused, accountId, accountEmail }) {
  if (!folder || !isDirSync(folder)) return null;

  const abs = path.resolve(folder);
  const existing = read(abs);
  if (existing && existing.linked) return existing;

  const vault = existing || create(abs, { name: prefix || path.basename(abs) });
  if (!prefix) {
    // An account that synced to the top of the store has no name to take; it
    // is still a vault, just one that has to be linked again by hand rather
    // than silently claiming every loose document in the account.
    remember(abs);
    return vault;
  }

  const linked = link(abs, {
    accountId: accountId || null,
    accountEmail: accountEmail || null,
    remoteVaultId: prefix,
    remoteName: prefix,
  });
  if (paused) writeState(abs, { paused: true });
  return linked;
}

module.exports = {
  DIR,
  SCHEMA_VERSION,
  adoptLegacy,
  find,
  isVault,
  vaultBelow,
  read,
  forPath,
  create,
  rename,
  link,
  unlink,
  readManifest,
  writeManifest,
  readState,
  writeState,
  queue,
  unqueue,
  pending,
  readWorkspace,
  writeWorkspace,
  thisDevice,
  known,
  remember,
  forget,
  cleanName,
};
