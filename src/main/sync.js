'use strict';

// Keeping a vault in step with its remote copy.
//
// Only a *linked* vault reaches this file. A loose folder has nothing here to
// talk about, and a local-only vault is a deliberate, fully supported way to
// use Plume forever — it has an index and settings and a graph, and nothing in
// it ever leaves the computer. Sync is something a vault opts into, once, by
// being linked to an account.
//
// Any number of vaults can be linked at once. Each is its own job with its own
// manifest, its own cursor and its own watcher; they share only the account's
// quota, which is a pool of bytes rather than a limit on how many vaults may
// draw on it.
//
// What makes this a sync rather than an overwrite is that every document is
// judged on three things, not two: the copy here, the copy in the remote
// vault, and the manifest entry — what this machine last saw of that document.
// Without the third, "these two differ" cannot be told apart from "one of them
// changed", and one side always loses silently.
//
// Nothing is ever destroyed to settle a disagreement. When both sides moved,
// both are kept: the remote copy lands beside the local one as a conflict file
// naming the day and the machine, and the local one goes up. A delete is only
// ever carried across for a document that was synced and then left alone — an
// edit always beats a delete.
//
// Only documents and images are ever uploaded. Programs, installers, archives
// and anything else are not merely skipped by accident: they are refused by an
// allow-list, so a vault that happens to contain an .exe or a .zip syncs its
// notes and leaves the rest alone.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const vault = require('./vault');
const vaults = require('./vaults');

// The only things that go up. Anything not named here stays on this computer.
const SYNC_EXT = new Set([
  '.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn', '.mdtxt', '.mdtext',
  '.txt', '.csv', '.json', '.yaml', '.yml',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif',
]);

// Named only so the reason given to the user can be specific. The allow-list
// above is what actually decides; this never widens it.
const REFUSED_EXT = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.js', '.jar',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.dmg', '.pkg',
  '.app', '.deb', '.rpm', '.appimage', '.dll', '.so', '.dylib', '.sys',
  '.lnk', '.url', '.reg', '.sh', '.py', '.pl', '.rb', '.php',
]);

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 2000;
// Enough to show somebody what is being left behind, not enough to matter.
const MAX_SKIPPED_LISTED = 200;
const MAX_DEPTH = 10;
const SKIP_DIR = /^[.]|^node_modules$|^__pycache__$|^\$RECYCLE/i;

const SETTLE_MS = 1500;     // wait for an editor to finish writing
const RESCAN_MS = 5 * 60 * 1000;

// A sync that would remove this many documents, and this much of what is
// there, stops and says so instead of doing it.
//
// Deleting is the only thing here that syncing again cannot undo, and the ways
// it goes wrong are not small ones: a vault relinked to the wrong remote, a
// drive that has not finished mounting, a folder restored from a backup that
// is a month behind. Every one of those looks from in here exactly like "they
// deleted everything", and the right answer to a sync that wants to delete
// everything is to stop and let a person look at it.
const DELETE_ALARM_COUNT = 10;
const DELETE_ALARM_SHARE = 0.34;

// ---------- what may be uploaded ----------

/** Why a file is not syncable, or null when it is. */
function refuse(file, size) {
  const ext = path.extname(file).toLowerCase();
  if (!ext) return 'no file extension';
  if (REFUSED_EXT.has(ext)) return `${ext} files are never uploaded`;
  if (!SYNC_EXT.has(ext)) return `${ext} is not a document or an image`;
  if (typeof size === 'number' && size > MAX_FILE_BYTES) return 'larger than 10 MB';
  return null;
}

function syncable(file) {
  return SYNC_EXT.has(path.extname(file).toLowerCase());
}

// ---------- which remote vault a file belongs to ----------

// A remote vault is one top-level folder of the account's store, and every
// document in it is named under that folder. That is what lets one account
// hold any number of vaults without them ever meeting: two vaults can each
// have a `Notes/today.md` and neither can see the other's.
//
// `prefix` below is that top-level name — the vault's `remoteName`. A vault
// linked before this existed has none, and keeps none: its documents sit at
// the top of the store where it put them, and giving it a prefix now would
// re-upload the whole notebook under a new name.

/** A folder name the vault will accept, from a folder name on disk. */
function prefixFor(folder) {
  const base = path.basename(folder || '').replace(/[\\/]+/g, ' ').trim();
  const clean = [...base].filter(ch => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('').replace(/^[.]+/, '').trim();
  return clean.slice(0, 120) || 'Notes';
}

/** The name a local file takes in the remote vault, under its prefix. */
function vaultPathFor(localPath, folder, prefix) {
  const relative = vault.suggestVaultPath(localPath, folder);
  if (!prefix) return relative;
  const parts = [prefix, ...relative.split('/')].filter(Boolean);
  // The server accepts twelve segments. The prefix is the one that must
  // survive trimming, because it is what says which vault this is.
  if (parts.length <= 12) return parts.join('/');
  return [parts[0], ...parts.slice(parts.length - 11)].join('/');
}

/** Whether a document in the account belongs to this vault. */
function underPrefix(vaultPath, prefix) {
  if (!prefix) return true;
  return vaultPath === prefix || vaultPath.startsWith(`${prefix}/`);
}

/** Where a remote path lives inside the vault folder. */
function localPathFor(folder, vaultPath, prefix) {
  let parts = String(vaultPath).split('/').filter(Boolean);
  if (prefix && parts[0] === prefix) parts = parts.slice(1);
  return path.join(folder, ...parts);
}

// ---------- reading the folder ----------

async function walk(dir, root, out, depth = 0) {
  if (depth > MAX_DEPTH || out.files.length >= MAX_FILES) return out;

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }

  for (const entry of entries) {
    if (out.files.length >= MAX_FILES) break;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // `.plume` itself is caught by this: the vault's own bookkeeping, its
      // trash and its cache are never content, and must never go up.
      if (SKIP_DIR.test(entry.name)) continue;
      await walk(full, root, out, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;

    let stat;
    try {
      stat = await fsp.stat(full);
    } catch (err) {
      continue;
    }

    const why = refuse(full, stat.size);
    if (why) {
      // Counted always, listed only up to a point. Both caps in walk() key on
      // files.length, so a vault holding nothing but non-syncable files — a
      // photo archive, a Steam library — kept neither of them and allocated
      // one object per file, on every rescan, for files it would never send.
      out.skippedTotal = (out.skippedTotal || 0) + 1;
      if (out.skipped.length < MAX_SKIPPED_LISTED) out.skipped.push({ localPath: full, reason: why });
      continue;
    }
    out.files.push({ localPath: full, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return out;
}

async function sha256Of(file) {
  // Streamed, and checked again: the walk's size was taken earlier, and a file
  // can grow between being listed and being read.
  const stat = await fsp.stat(file);
  if (stat.size > MAX_FILE_BYTES) throw new Error('larger than 10 MB');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// ---------- telling the windows ----------

// One record per vault being watched, keyed by its root folder.
const jobs = new Map();
let listeners = [];

function blank(root, name) {
  return {
    root,
    name: name || path.basename(root),
    status: 'idle',          // idle | scanning | syncing | paused | error | offline
    prefix: '',
    total: 0,
    done: 0,
    uploaded: 0,
    downloaded: 0,
    conflicts: 0,
    removed: 0,
    skipped: 0,
    wontFit: 0,
    pending: 0,
    failed: 0,
    lastSyncAt: null,
    lastError: null,
    message: null,
  };
}

function job(root) {
  const abs = path.resolve(root);
  if (!jobs.has(abs)) {
    const vaultInfo = vaults.read(abs);
    jobs.set(abs, {
      state: blank(abs, vaultInfo ? vaultInfo.name : null),
      watcher: null,
      settleTimer: null,
      rescanTimer: null,
      running: false,
      queued: false,
    });
  }
  return jobs.get(abs);
}

function publicState() {
  const list = [...jobs.values()].map(j => ({ ...j.state }));
  const busy = list.some(s => s.status === 'syncing' || s.status === 'scanning');
  return {
    vaults: list,
    syncing: busy,
    account: vault.publicState().account || null,
    signedIn: Boolean(vault.publicState().signedIn),
  };
}

/** One vault's state, or a blank one for a vault that is not being synced. */
function stateFor(root) {
  if (!root) return null;
  const abs = path.resolve(root);
  const found = jobs.get(abs);
  if (found) return { ...found.state };
  const vaultInfo = vaults.read(abs);
  if (!vaultInfo) return null;
  const state = blank(abs, vaultInfo.name);
  state.status = vaultInfo.linked ? 'idle' : 'off';
  state.lastSyncAt = vaultInfo.lastSyncAt;
  state.pending = vaults.pending(abs).length;
  return state;
}

function announce() {
  const snapshot = publicState();
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch (err) { /* a dead window must not stop the sync */ }
  }
}

function set(root, patch) {
  const j = job(root);
  j.state = { ...j.state, ...patch };
  announce();
}

function onChange(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter(x => x !== fn); };
}

// ---------- what will fit, and what went wrong ----------

/**
 * Bytes left in the account, or null when we cannot tell.
 *
 * One pool across every linked vault. A folder is routinely much larger than
 * what it syncs — a 1.45 GB vault holding 3 MB of Markdown is normal, because
 * only documents and images are ever sent — but an account that really is out
 * of room should be told so once, not discover it one refused upload at a time.
 */
function roomLeft() {
  const account = vault.publicState().account;
  if (!account || typeof account.quotaBytes !== 'number') return null;
  const used = typeof account.usedBytes === 'number' ? account.usedBytes : 0;
  return Math.max(0, account.quotaBytes - used);
}

function mb(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Why documents failed, rather than how many. "259 documents could not be
 * synced" tells the reader nothing they can act on; the reason almost always
 * applies to most of them at once.
 */
function describeFailures(failed) {
  if (!failed || !failed.length) return null;

  const byReason = new Map();
  for (const f of failed) {
    const reason = (f.error || 'could not be synced').replace(/[.]$/, '');
    byReason.set(reason, (byReason.get(reason) || 0) + 1);
  }
  const ranked = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  const [top, count] = ranked[0];

  if (ranked.length === 1) {
    return `${plural(failed.length, 'document', 'documents')} not synced — ${top}`;
  }
  return `${plural(failed.length, 'document', 'documents')} not synced — ${count} because ${top}, `
    + `and ${ranked.length - 1} other ${ranked.length === 2 ? 'reason' : 'reasons'}`;
}

/** The standing note under a vault: what is deliberately left behind. */
function describeVault(skipped, tooBig) {
  const parts = [];
  if (tooBig && tooBig.length) {
    const bytes = tooBig.reduce((n, f) => n + (f.size || 0), 0);
    parts.push(`${plural(tooBig.length, 'document is', 'documents are')} waiting on space — `
      + `${mb(bytes)} more than your account holds`);
  }
  if (skipped) {
    parts.push(`${plural(skipped, 'file', 'files')} left alone — only documents and images are uploaded`);
  }
  return parts.length ? parts.join('. ') : null;
}

// ---------- deciding what happens to each document ----------

/**
 * What should happen to one document, given the copy here, the copy in the
 * remote vault, and `base` — what this machine last saw of it.
 *
 * `base` is the whole reason this is a sync. With only two sides you can see
 * that they differ but not which one moved, so one of them always loses.
 */
function decide(local, remote, base) {
  if (local && !remote) {
    // Synced once and untouched since, so the remote's delete is the newer
    // fact and it goes here too. Edited here since, and the edit wins: work
    // that exists is never thrown away to honour a delete somewhere else.
    if (base && base.sha256 === local.sha256) return 'delete-local';
    // A stale base against a remote copy that is gone would be refused as a
    // conflict, so this one goes up as new.
    return base ? 'push-force' : 'push';
  }
  if (!local && remote) {
    // Known here once and now missing: deleted on this machine. Never seen
    // here at all: it is simply new, and comes down.
    return base ? 'delete-remote' : 'pull';
  }
  if (local.sha256 === remote.sha256) return 'none';
  if (base && base.sha256 === local.sha256) return 'pull';    // only the remote moved
  if (base && base.sha256 === remote.sha256) return 'push';   // only this machine moved
  // Both moved since the last sync — or neither was ever synced here and they
  // disagree, which is what linking a vault to a remote that already has
  // content looks like. Keep both.
  return 'conflict';
}

/**
 * Whether a plan is removing enough of a vault to be an accident rather than
 * an intention. Both have to be true: ten documents is nothing out of a
 * thousand, and a third of a vault is nothing out of three.
 */
function alarming(deletes, known) {
  return deletes >= DELETE_ALARM_COUNT && deletes >= known * DELETE_ALARM_SHARE;
}

/** The manifest entry for a path, in the shape decide() reads. */
function baseFrom(manifest, vaultPath) {
  const entry = manifest.files[vaultPath];
  if (!entry || typeof entry.hash !== 'string') return null;
  return { sha256: entry.hash, syncedAt: entry.syncedAt || null, size: entry.size || 0 };
}

/**
 * Reads both sides and works out the whole job before doing any of it, so an
 * interrupted sync has not half-applied a plan made from a vault that has
 * since moved on.
 */
async function planSync(info) {
  const { root, prefix } = info;
  const manifest = vaults.readManifest(root);
  const found = await walk(root, root, { files: [], skipped: [] });

  const here = new Map();
  for (const file of found.files) {
    file.vaultPath = vaultPathFor(file.localPath, root, prefix);
    here.set(file.vaultPath, file);
  }

  // Only this vault's own part of the account. Another vault synced from
  // another machine is none of this one's business, and must not be pulled
  // into it or deleted because it is not here.
  const listing = await vault.list();
  const there = new Map();
  for (const file of listing.files || []) {
    if (underPrefix(file.path, prefix)) there.set(file.path, file);
  }

  const plan = {
    rising: [], pull: [], deleteLocal: [], deleteRemote: [], conflict: [],
    // Everything either side holds, changed or not. The alarm is about the
    // share of a vault a sync would remove, and documents it is leaving alone
    // never reach the lists above.
    known: Math.max(here.size, there.size),
  };

  for (const vaultPath of new Set([...here.keys(), ...there.keys()])) {
    const local = here.get(vaultPath) || null;
    const remote = there.get(vaultPath) || null;
    const localPath = local ? local.localPath : localPathFor(root, vaultPath, prefix);
    const base = baseFrom(manifest, vaultPath);

    if (local && (remote || base)) {
      // A file not written since it was last synced, against a remote copy
      // still at the revision we synced, cannot have moved on either side —
      // and that is almost every file almost every time, so it is worth not
      // reading them all off the disk to find out.
      const untouched = base && base.syncedAt && local.mtimeMs <= Date.parse(base.syncedAt);
      if (untouched && remote && remote.sha256 === base.sha256) continue;
      try {
        local.sha256 = await sha256Of(local.localPath);
      } catch (err) {
        continue;   // gone, or grown past the limit, since the walk
      }
    }

    const item = {
      vaultPath,
      localPath,
      base: base ? base.sha256 : null,
      size: local ? local.size : (remote ? remote.size : 0),
    };
    switch (decide(local, remote, base)) {
      case 'push': plan.rising.push({ ...item, force: false }); break;
      case 'push-force': plan.rising.push({ ...item, force: true }); break;
      case 'pull': plan.pull.push(item); break;
      case 'delete-local': plan.deleteLocal.push(item); break;
      case 'delete-remote': plan.deleteRemote.push(item); break;
      case 'conflict':
        plan.conflict.push(item);
        plan.rising.push({ ...item, force: true });
        break;
      default: break;
    }
  }
  return { plan, found, manifest };
}

/**
 * Takes a document out of the vault because the remote says it is gone.
 *
 * Moved, not deleted. Everything else here is recoverable — a conflict keeps
 * both copies, an edit beats a delete — and this is the one place where
 * something on this disk disappears because of something that happened
 * somewhere else. If that is ever wrong, for any reason, the file is still
 * here. It goes inside `.plume/`, so the walk skips it and nothing in it is
 * ever uploaded again.
 */
async function trash(root, localPath) {
  const bin = path.join(root, vaults.DIR, 'trash', new Date().toISOString().slice(0, 10));
  const relative = path.relative(root, localPath);
  const dest = path.join(bin, relative.startsWith('..') ? path.basename(localPath) : relative);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(localPath, dest);
  } catch (err) {
    // Across devices, or a name already taken by an earlier deletion of the
    // same note: copy it in under a name of its own and drop the original.
    const spare = `${dest}.${Date.now()}`;
    await fsp.copyFile(localPath, spare);
    await fsp.unlink(localPath);
  }
}

/**
 * Where the remote copy goes when both sides moved.
 *
 * Named for the day and the machine, because a conflict a week old on a laptop
 * and one from this morning on a desktop are different things and a reader
 * sorting them out needs to be told which is which.
 */
function conflictPath(localPath) {
  const dir = path.dirname(localPath);
  const ext = path.extname(localPath);
  const base = path.basename(localPath, ext);
  const day = new Date().toISOString().slice(0, 10);
  const device = vaults.thisDevice().name.replace(/[\\/:*?"<>|]/g, '-').slice(0, 40);
  return path.join(dir, `${base} (conflict ${day} ${device})${ext}`);
}

// ---------- the sync itself ----------

/** What the vault at this root is, and whether it has anything to sync. */
function readable(root) {
  const info = vaults.read(root);
  if (!info) return { ok: false, reason: 'That folder is not a vault.' };
  if (!info.linked) return { ok: false, reason: 'off' };
  return {
    ok: true,
    root: info.root,
    name: info.name,
    prefix: info.link.remoteName || '',
    info,
  };
}

async function runOnce(root) {
  const abs = path.resolve(root);
  const j = job(abs);

  const look = readable(abs);
  if (!look.ok) {
    if (look.reason === 'off') set(abs, { status: 'off', message: null });
    else set(abs, { status: 'error', lastError: look.reason });
    return;
  }
  set(abs, { name: look.name, prefix: look.prefix });

  if (!vault.publicState().signedIn) {
    set(abs, { status: 'offline', message: 'Sign in to sync this vault.' });
    return;
  }
  if (vaults.readState(abs).paused) {
    set(abs, { status: 'paused', message: null });
    return;
  }
  if (j.running) {
    j.queued = true;
    return;
  }

  j.running = true;
  set(abs, { status: 'scanning', message: null, done: 0, total: 0, lastError: null });

  try {
    if (!fs.existsSync(abs)) {
      throw Object.assign(new Error('That vault folder is no longer there.'), { gone: true });
    }

    const { plan, found, manifest } = await planSync(look);

    // What will actually fit. Only what goes up costs anything, and sending
    // documents until the server starts refusing them is a slow way to find
    // out there is no room.
    const room = roomLeft();
    const fitting = [];
    const tooBig = [];
    let planned = 0;
    for (const file of plan.rising) {
      const already = manifest.files[file.vaultPath];
      const cost = file.size - (already ? already.size || 0 : 0);
      if (room !== null && planned + cost > room) {
        tooBig.push(file);
        continue;
      }
      planned += Math.max(0, cost);
      fitting.push(file);
    }
    const fits = new Set(fitting.map(f => f.localPath));

    // Over quota is a soft stop on the upload, never a block on local work:
    // the edit is already on this disk, and only its journey up waits. Held
    // here so it is still held after a restart.
    for (const file of tooBig) {
      vaults.queue(abs, { vaultPath: file.vaultPath, localPath: file.localPath, size: file.size });
    }

    // Before any of it is applied: is this a sync, or an accident?
    const deletes = plan.deleteLocal.length + plan.deleteRemote.length;
    if (alarming(deletes, plan.known)) {
      vaults.writeState(abs, { paused: true });
      set(abs, {
        status: 'paused',
        total: 0,
        done: 0,
        lastError: `Paused: this sync was about to remove ${deletes} of `
          + `${plan.known} documents. Check that this vault is linked to the `
          + 'remote vault you meant, then start syncing again.',
      });
      return;
    }

    const total = plan.pull.length + fitting.length
      + plan.deleteLocal.length + plan.deleteRemote.length;
    set(abs, {
      status: total ? 'syncing' : 'idle',
      total,
      done: 0,
      skipped: found.skippedTotal || 0,
      wontFit: tooBig.length,
      pending: vaults.pending(abs).length,
    });

    let done = 0;
    const step = () => { done += 1; set(abs, { done, total }); };
    const failures = [];
    const blame = err => failures.push({
      error: err && err.message ? err.message : 'could not be synced',
    });

    // The manifest is written as the sync goes, not at the end: a sync killed
    // halfway has still recorded what it actually did, and the next one picks
    // up from there rather than re-deciding everything against a stale base.
    const note = (vaultPath, entry) => {
      if (entry) manifest.files[vaultPath] = entry;
      else delete manifest.files[vaultPath];
      vaults.writeManifest(abs, manifest);
    };

    // Down first: a document that exists only in the remote vault should be
    // here before anything on this disk is removed on the remote's word.
    let downloaded = 0;
    for (const item of plan.pull) {
      try {
        const got = await vault.pull(item.vaultPath, item.localPath);
        note(item.vaultPath, {
          hash: got.sha256,
          size: got.size,
          mtime: Date.now(),
          syncedAt: got.updatedAt,
          rev: manifest.rev + 1,
        });
        downloaded += 1;
      } catch (err) { blame(err); }
      step();
    }

    // Both sides moved: the remote copy is saved beside ours before ours goes
    // up, so the version about to be overwritten still exists on this disk.
    let conflicts = 0;
    for (const item of plan.conflict) {
      if (!fits.has(item.localPath)) continue;
      try {
        await vault.pull(item.vaultPath, conflictPath(item.localPath));
        conflicts += 1;
      } catch (err) { blame(err); }
    }

    let uploaded = 0;
    for (const item of fitting) {
      try {
        const res = await vault.push(item.localPath, item.vaultPath, {
          force: item.force,
          baseSha: item.force ? undefined : item.base,
        });
        note(item.vaultPath, {
          hash: res.file.sha256,
          size: res.file.size,
          mtime: Date.now(),
          syncedAt: res.file.updatedAt,
          rev: manifest.rev + 1,
        });
        vaults.unqueue(abs, item.vaultPath);
        if (!res.unchanged) uploaded += 1;
      } catch (err) { blame(err); }
      step();
    }

    // Deletes last, once every copy that is staying has been put where it
    // belongs on both sides.
    let removed = 0;
    for (const item of plan.deleteLocal) {
      try {
        await trash(abs, item.localPath);
        removed += 1;
      } catch (err) {
        // Already gone is still gone.
      }
      note(item.vaultPath, null);
      step();
    }
    for (const item of plan.deleteRemote) {
      try {
        await vault.remove(item.vaultPath);
        note(item.vaultPath, null);
        removed += 1;
      } catch (err) { blame(err); }
      step();
    }

    manifest.rev += 1;
    vaults.writeManifest(abs, manifest);
    const at = new Date().toISOString();
    vaults.writeState(abs, { last_synced_rev: manifest.rev, last_sync_at: at });

    set(abs, {
      uploaded,
      downloaded,
      conflicts,
      removed,
      failed: failures.length,
      pending: vaults.pending(abs).length,
      done: total,
      total,
      lastError: describeFailures(failures),
      status: 'idle',
      lastSyncAt: at,
      message: describeVault(found.skippedTotal || 0, tooBig),
    });
  } catch (err) {
    set(abs, {
      status: 'error',
      lastError: err && err.message ? err.message : 'Could not sync this vault.',
    });
  } finally {
    j.running = false;
    if (j.queued) {
      j.queued = false;
      setTimeout(() => runOnce(abs), 500);
    }
  }
}

function schedule(root) {
  const j = job(root);
  clearTimeout(j.settleTimer);
  // Editors write, rename and touch a file several times in a row; waiting a
  // moment turns that into one upload rather than four.
  j.settleTimer = setTimeout(() => runOnce(root), SETTLE_MS);
}

// ---------- watching ----------

function stopWatching(root) {
  const abs = path.resolve(root);
  const j = jobs.get(abs);
  if (!j) return;
  if (j.watcher) {
    try { j.watcher.close(); } catch (err) { /* already gone */ }
    j.watcher = null;
  }
  clearTimeout(j.settleTimer);
  clearInterval(j.rescanTimer);
  j.rescanTimer = null;
}

function startWatching(root) {
  const abs = path.resolve(root);
  stopWatching(abs);
  const j = job(abs);

  const fallback = () => {
    if (j.rescanTimer) return;
    j.rescanTimer = setInterval(() => runOnce(abs), RESCAN_MS);
    if (j.rescanTimer.unref) j.rescanTimer.unref();
  };

  try {
    j.watcher = fs.watch(abs, { recursive: true }, (_event, name) => {
      // Plume's own bookkeeping changes on every sync; reacting to it would
      // make the sync its own trigger.
      if (name && String(name).split(/[\\/]/)[0] === vaults.DIR) return;
      // Ignore churn we would never upload anyway.
      if (name && !syncable(name) && path.extname(name)) return;
      schedule(abs);
    });
    j.watcher.on('error', () => {
      // Recursive watching is not available everywhere; the timer still keeps
      // the vault in step, just less promptly.
      stopWatching(abs);
      fallback();
    });
  } catch (err) {
    fallback();
  }

  // A safety net for changes made while Plume was closed, or that the watcher
  // missed.
  fallback();
}

// ---------- the public shape ----------

/** Brings a vault under watch, or takes it out of one. */
function watch(root) {
  const abs = path.resolve(root);
  const look = readable(abs);
  if (!look.ok) {
    stopWatching(abs);
    if (look.reason === 'off') {
      set(abs, { status: 'off', message: null });
    } else {
      jobs.delete(abs);
      announce();
    }
    return;
  }

  const info = vaults.read(abs);
  set(abs, {
    name: info.name,
    prefix: look.prefix,
    lastSyncAt: info.lastSyncAt,
    pending: vaults.pending(abs).length,
  });

  if (vaults.readState(abs).paused) {
    stopWatching(abs);
    set(abs, { status: 'paused' });
    return;
  }
  if (!vault.publicState().signedIn) {
    stopWatching(abs);
    set(abs, { status: 'offline', message: 'Sign in to sync this vault.' });
    return;
  }

  startWatching(abs);
  runOnce(abs);
}

function unwatch(root) {
  const abs = path.resolve(root);
  stopWatching(abs);
  jobs.delete(abs);
  announce();
}

/**
 * Every linked vault this computer knows about, brought up to date.
 *
 * Called on launch, and whenever the account changes: signing out stops every
 * sync at once, and signing back in starts them again.
 */
function start() {
  const linked = vaults.known().filter(v => v.linked);
  // Vaults that have since been unlinked or deleted stop being watched.
  for (const abs of [...jobs.keys()]) {
    if (!linked.some(v => v.root === abs)) unwatch(abs);
  }
  for (const v of linked) watch(v.root);
  announce();
}

function stop() {
  for (const abs of [...jobs.keys()]) stopWatching(abs);
  for (const j of jobs.values()) j.state = { ...j.state, status: 'off' };
  announce();
}

function refresh() {
  start();
}

/** Runs one vault now, or every linked vault when given nothing. */
async function syncNow(root) {
  if (root) return runOnce(root);
  const linked = vaults.known().filter(v => v.linked);
  for (const v of linked) await runOnce(v.root);
  return undefined;
}

function pause(root, paused) {
  const abs = path.resolve(root);
  vaults.writeState(abs, { paused: Boolean(paused) });
  watch(abs);
  return stateFor(abs);
}

/** What a folder holds that would be synced, before anything is decided. */
async function preview(folder) {
  const found = await walk(folder, folder, { files: [], skipped: [] });
  return {
    folder,
    files: found.files.length,
    bytes: found.files.reduce((n, f) => n + f.size, 0),
    skipped: found.skipped.slice(0, 40),
    skippedTotal: found.skippedTotal || 0,
    atLimit: found.files.length >= MAX_FILES,
  };
}

module.exports = {
  SYNC_EXT,
  REFUSED_EXT,
  MAX_FILES,
  alarming,
  decide,
  localPathFor,
  vaultPathFor,
  underPrefix,
  prefixFor,
  conflictPath,
  refuse,
  start,
  stop,
  refresh,
  watch,
  unwatch,
  syncNow,
  pause,
  preview,
  publicState,
  stateFor,
  onChange,
};
