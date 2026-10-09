'use strict';

// Folder sync: one folder on this computer, kept in step with the vault.
//
// Pick a folder once and, while you are signed in, it and the vault are the
// same notebook: what you write here goes up, what was written on another
// machine or in the web vault comes down, and a document deleted on one side
// goes on the other. The folder is the vault, the way a Dropbox folder is the
// Dropbox.
//
// Only documents and images are ever uploaded. Programs, installers, archives
// and anything else are not merely skipped by accident: they are refused by an
// allow-list, so a folder that happens to contain an .exe or a .zip syncs its
// notes and leaves the rest alone.
//
// What makes this a sync rather than an overwrite is that every document is
// judged on three things, not two: the copy here, the copy in the vault, and
// `base` — what this machine last saw of that document, which vault.js keeps
// in its links file. Without the third, "these two differ" cannot be told
// apart from "one of them changed", and one side always loses silently.
//
// Nothing is ever destroyed to settle a disagreement. When both sides moved,
// both are kept: the vault's copy is saved alongside the local one as a
// conflict copy, and the local one goes up. A delete is only ever carried
// across for a document that was synced and then left alone — an edit always
// beats a delete.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const vault = require('./vault');
const settings = require('./settings');

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
// Where a document goes when the vault says it was deleted elsewhere. Hidden,
// so SKIP_DIR above keeps it out of the walk and nothing in it goes back up.
const TRASH_DIR = '.plume-trash';

const SETTLE_MS = 1500;     // wait for an editor to finish writing

// A sync that would remove this many documents, and this much of what is
// there, stops and says so instead of doing it.
//
// Deleting is the only thing here that syncing again cannot undo, and the
// ways it goes wrong are not small ones: a folder pointed at the wrong
// notebook, a drive that has not finished mounting, a notebook name that got
// out of step with the folder it belongs to. Every one of those looks from in
// here exactly like "they deleted everything", and the right answer to a sync
// that wants to delete everything is to stop and let a person look at it.
const DELETE_ALARM_COUNT = 10;
const DELETE_ALARM_SHARE = 0.34;
const RESCAN_MS = 5 * 60 * 1000;

let state = {
  status: 'off',            // off | idle | scanning | syncing | error | paused
  folder: null,
  message: null,
  total: 0,
  done: 0,
  uploaded: 0,
  downloaded: 0,
  conflicts: 0,
  removed: 0,
  skipped: 0,
  wontFit: 0,
  failed: 0,
  lastSyncAt: null,
  lastError: null,
};

let watcher = null;
let settleTimer = null;
let rescanTimer = null;
let running = false;
let queued = false;
let listeners = [];

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
      // files.length, so a folder of nothing but non-syncable files — a photo
      // archive, a Steam library — kept neither of them and allocated one
      // object per file, on every rescan, for files it would never send.
      out.skippedTotal = (out.skippedTotal || 0) + 1;
      if (out.skipped.length < MAX_SKIPPED_LISTED) out.skipped.push({ localPath: full, reason: why });
      continue;
    }
    out.files.push({
      localPath: full,
      vaultPath: vault.suggestVaultPath(full, root),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
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

function publicState() {
  // The prefix is settings', not this module's, but it is half of what the
  // panel has to say — "this folder, as that notebook" — so it travels with
  // the rest rather than being fetched separately and arriving out of step.
  return { ...state, prefix: settings.get().vaultPrefix || '' };
}

function announce() {
  for (const fn of listeners) {
    try {
      fn(publicState());
    } catch (err) { /* a dead window must not stop the sync */ }
  }
}

function set(patch) {
  state = { ...state, ...patch };
  announce();
}

function onChange(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter(x => x !== fn); };
}

// ---------- what will fit, and what went wrong ----------

/**
 * Bytes left in the vault, or null when we cannot tell. A folder is routinely
 * much larger than a vault — a 1.45 GB notebook holding 3 MB of Markdown is
 * normal, because only documents and images are ever sent — but a notebook
 * that really does hold more than 100 MB of documents should be told so once,
 * not discovered one refused upload at a time.
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

/** The standing note under the folder: what is deliberately left behind. */
function describeFolder(skipped, tooBig) {
  const parts = [];
  if (tooBig && tooBig.length) {
    const bytes = tooBig.reduce((n, f) => n + (f.size || 0), 0);
    parts.push(`${plural(tooBig.length, 'document is', 'documents are')} waiting on space — `
      + `${mb(bytes)} more than your vault holds`);
  }
  if (skipped) {
    parts.push(`${plural(skipped, 'file', 'files')} left alone — only documents and images are uploaded`);
  }
  return parts.length ? parts.join('. ') : null;
}

// ---------- deciding what happens to each document ----------

// ---------- which folder of the vault this folder is ----------

// A vault holds more than one notebook. Each synced folder occupies a folder
// of its own inside it, named after the folder on disk, so changing which
// folder syncs adds a second notebook to the vault rather than merging two
// into one — and the one you stopped syncing is still there, under its name.
//
// An account that was already syncing before this existed has no prefix, and
// keeps none: its documents sit at the top of the vault where it put them,
// and giving it one now would re-upload the whole notebook under a new name.

/** A folder name the vault will accept, from a folder name on disk. */
function prefixFor(folder) {
  const base = path.basename(folder || '').replace(/[\\/]+/g, ' ').trim();
  const clean = [...base].filter(ch => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('').replace(/^[.]+/, '').trim();
  return clean.slice(0, 120) || 'Notes';
}

/** The name a local file takes in the vault, under this folder's prefix. */
function vaultPathFor(localPath, folder, prefix) {
  const relative = vault.suggestVaultPath(localPath, folder);
  if (!prefix) return relative;
  const parts = [prefix, ...relative.split('/')].filter(Boolean);
  // The vault accepts twelve segments. The prefix is the one that must
  // survive trimming, because it is what says which notebook this is.
  if (parts.length <= 12) return parts.join('/');
  return [parts[0], ...parts.slice(parts.length - 11)].join('/');
}

/** Whether a document in the vault belongs to the folder being synced. */
function underPrefix(vaultPath, prefix) {
  if (!prefix) return true;
  return vaultPath === prefix || vaultPath.startsWith(`${prefix}/`);
}

/** Where a vault path lives inside the folder. */
function localPathFor(folder, vaultPath, prefix) {
  let parts = String(vaultPath).split('/').filter(Boolean);
  if (prefix && parts[0] === prefix) parts = parts.slice(1);
  return path.join(folder, ...parts);
}

/**
 * What should happen to one document, given the copy here, the copy in the
 * vault, and `base` — what this machine last saw of it.
 *
 * `base` is the whole reason this is a sync. With only two sides you can see
 * that they differ but not which one moved, so one of them always loses.
 */
function decide(local, remote, base) {
  if (local && !remote) {
    // Synced once and untouched since, so the vault's delete is the newer
    // fact and it goes here too. Edited here since, and the edit wins: work
    // that exists is never thrown away to honour a delete somewhere else.
    if (base && base.sha256 === local.sha256) return 'delete-local';
    // A stale base against a vault copy that is gone would be refused as a
    // conflict, so this one goes up as new.
    return base ? 'push-force' : 'push';
  }
  if (!local && remote) {
    // Known here once and now missing: deleted on this machine. Never seen
    // here at all: it is simply new, and comes down.
    return base ? 'delete-remote' : 'pull';
  }
  if (local.sha256 === remote.sha256) return 'none';
  if (base && base.sha256 === local.sha256) return 'pull';    // only the vault moved
  if (base && base.sha256 === remote.sha256) return 'push';   // only this machine moved
  // Both moved since the last sync — or neither was ever synced here and they
  // disagree, which is what signing in on a folder that already has a vault
  // looks like. Keep both.
  return 'conflict';
}

/**
 * Reads both sides and works out the whole job before doing any of it, so an
 * interrupted sync has not half-applied a plan made from a folder that has
 * since moved on.
 */
async function planSync(folder) {
  const prefix = settings.get().vaultPrefix || '';
  const found = await walk(folder, folder, { files: [], skipped: [] });

  const here = new Map();
  for (const file of found.files) {
    file.vaultPath = vaultPathFor(file.localPath, folder, prefix);
    here.set(file.vaultPath, file);
  }

  // Only this folder's own part of the vault. Another notebook synced from
  // another machine is none of this folder's business, and must not be
  // pulled into it or deleted because it is not here.
  const listing = await vault.list();
  const there = new Map();
  for (const file of listing.files || []) {
    if (underPrefix(file.path, prefix)) there.set(file.path, file);
  }

  const plan = {
    rising: [], pull: [], deleteLocal: [], deleteRemote: [], conflict: [],
    // Everything either side holds, changed or not. The alarm below is about
    // the share of a notebook a sync would remove, and documents it is
    // leaving alone never reach the lists above.
    known: Math.max(here.size, there.size),
  };

  for (const vaultPath of new Set([...here.keys(), ...there.keys()])) {
    const local = here.get(vaultPath) || null;
    const remote = there.get(vaultPath) || null;
    const localPath = local ? local.localPath : localPathFor(folder, vaultPath, prefix);
    const link = vault.linkFor(localPath);
    const base = link && link.vaultPath === vaultPath ? link : null;

    if (local && (remote || base)) {
      // A file not written since it was last synced, against a vault copy
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
  return { plan, found };
}

/**
 * Takes a document out of the folder because the vault says it is gone.
 *
 * Moved, not deleted. Everything else here is recoverable — a conflict keeps
 * both copies, an edit beats a delete — and this is the one place where
 * something on this disk disappears because of something that happened
 * somewhere else. If that is ever wrong, for any reason, the file is still
 * here. The folder is hidden, so the walk skips it and nothing in it is
 * uploaded again.
 */
async function trash(folder, localPath) {
  const bin = path.join(folder, TRASH_DIR, new Date().toISOString().slice(0, 10));
  const relative = path.relative(folder, localPath);
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
 * Whether a plan is removing enough of a notebook to be an accident rather
 * than an intention. Both have to be true: ten documents is nothing out of a
 * thousand, and a third of a notebook is nothing out of three.
 */
function alarming(deletes, known) {
  return deletes >= DELETE_ALARM_COUNT && deletes >= known * DELETE_ALARM_SHARE;
}

// ---------- the sync itself ----------

async function runOnce() {
  const folder = settings.get().vaultFolder;
  if (!folder) return;
  if (!vault.publicState().signedIn) {
    set({ status: 'off', message: 'Sign in to sync this folder.' });
    return;
  }
  if (settings.get().syncPaused) {
    set({ status: 'paused', message: null });
    return;
  }
  if (running) {
    queued = true;
    return;
  }

  running = true;
  set({ status: 'scanning', message: null, done: 0, total: 0, lastError: null });

  try {
    if (!fs.existsSync(folder)) {
      throw Object.assign(new Error('That folder is no longer there.'), { gone: true });
    }

    const { plan, found } = await planSync(folder);

    // What will actually fit. Only what goes up costs anything: a folder can
    // hold far more than a vault does, and sending documents until the server
    // starts refusing them is a slow way to find that out.
    const room = roomLeft();
    const fitting = [];
    const tooBig = [];
    let planned = 0;
    for (const file of plan.rising) {
      const already = vault.linkFor(file.localPath);
      const cost = file.size - (already ? already.size || 0 : 0);
      if (room !== null && planned + cost > room) {
        tooBig.push(file);
        continue;
      }
      planned += Math.max(0, cost);
      fitting.push(file);
    }
    const fits = new Set(fitting.map(f => f.localPath));

    // Before any of it is applied: is this a sync, or an accident?
    const deletes = plan.deleteLocal.length + plan.deleteRemote.length;
    if (alarming(deletes, plan.known)) {
      settings.update({ syncPaused: true });
      set({
        status: 'paused',
        total: 0,
        done: 0,
        lastError: `Paused: this sync was about to remove ${deletes} of `
          + `${plan.known} documents. Check that the folder and the notebook `
          + 'are the ones you meant, then start syncing again.',
      });
      return;
    }

    const total = plan.pull.length + fitting.length
      + plan.deleteLocal.length + plan.deleteRemote.length;
    set({
      status: total ? 'syncing' : 'idle',
      total,
      done: 0,
      skipped: found.skippedTotal || 0,
      wontFit: tooBig.length,
    });

    let done = 0;
    const step = () => { done += 1; set({ done, total }); };
    const failures = [];
    const blame = err => failures.push({
      error: err && err.message ? err.message : 'could not be synced',
    });

    // Down first: a document that exists only in the vault should be here
    // before anything on this disk is removed on the vault's word.
    let downloaded = 0;
    for (const item of plan.pull) {
      try {
        await vault.pull(item.vaultPath, item.localPath);
        downloaded += 1;
      } catch (err) { blame(err); }
      step();
    }

    // Both sides moved: the vault's copy is saved beside ours before ours
    // goes up, so the version about to be overwritten still exists.
    let conflicts = 0;
    for (const item of plan.conflict) {
      if (!fits.has(item.localPath)) continue;
      try {
        await vault.saveConflictCopy(item.localPath, item.vaultPath);
        conflicts += 1;
      } catch (err) { blame(err); }
    }

    let uploaded = 0;
    for (const item of fitting) {
      try {
        const res = await vault.push(item.localPath, item.vaultPath, { force: item.force });
        if (!res.unchanged) uploaded += 1;
      } catch (err) { blame(err); }
      step();
    }

    // Deletes last, once every copy that is staying has been put where it
    // belongs on both sides.
    let removed = 0;
    for (const item of plan.deleteLocal) {
      try {
        await trash(folder, item.localPath);
        removed += 1;
      } catch (err) {
        // Already gone is still gone.
      }
      vault.unlink(item.localPath);
      step();
    }
    for (const item of plan.deleteRemote) {
      try {
        await vault.remove(item.vaultPath);
        removed += 1;
      } catch (err) { blame(err); }
      step();
    }

    set({
      uploaded,
      downloaded,
      conflicts,
      removed,
      failed: failures.length,
      done: total,
      total,
      lastError: describeFailures(failures),
    });

    set({
      status: 'idle',
      folder,
      lastSyncAt: new Date().toISOString(),
      message: describeFolder(found.skippedTotal || 0, tooBig),
    });
  } catch (err) {
    set({
      status: 'error',
      lastError: err && err.message ? err.message : 'Could not sync that folder.',
    });
  } finally {
    running = false;
    if (queued) {
      queued = false;
      setTimeout(runOnce, 500);
    }
  }
}

function schedule() {
  clearTimeout(settleTimer);
  // Editors write, rename and touch a file several times in a row; waiting a
  // moment turns that into one upload rather than four.
  settleTimer = setTimeout(runOnce, SETTLE_MS);
}

// ---------- watching ----------

function stopWatching() {
  if (watcher) {
    try { watcher.close(); } catch (err) { /* already gone */ }
    watcher = null;
  }
  clearTimeout(settleTimer);
  clearInterval(rescanTimer);
  rescanTimer = null;
}

function startWatching(folder) {
  stopWatching();
  try {
    watcher = fs.watch(folder, { recursive: true }, (_event, name) => {
      // Ignore churn we would never upload anyway.
      if (name && !syncable(name) && path.extname(name)) return;
      schedule();
    });
    watcher.on('error', () => {
      // Recursive watching is not available everywhere; the timer below still
      // keeps the folder in step, just less promptly.
      stopWatching();
      rescanTimer = setInterval(runOnce, RESCAN_MS);
      if (rescanTimer.unref) rescanTimer.unref();
    });
  } catch (err) {
    rescanTimer = setInterval(runOnce, RESCAN_MS);
    if (rescanTimer.unref) rescanTimer.unref();
  }

  // A safety net for changes made while Plume was closed, or that the
  // watcher missed.
  if (!rescanTimer) {
    rescanTimer = setInterval(runOnce, RESCAN_MS);
    if (rescanTimer.unref) rescanTimer.unref();
  }
}

// ---------- the public shape ----------

function start() {
  const { vaultFolder, syncPaused } = settings.get();
  if (!vaultFolder) {
    stopWatching();
    set({ status: 'off', folder: null, message: null });
    return;
  }
  set({ folder: vaultFolder });

  if (syncPaused) {
    stopWatching();
    set({ status: 'paused' });
    return;
  }
  if (!vault.publicState().signedIn) {
    stopWatching();
    set({ status: 'off', message: 'Sign in to sync this folder.' });
    return;
  }

  startWatching(vaultFolder);
  runOnce();
}

function stop() {
  stopWatching();
  set({ status: 'off', folder: settings.get().vaultFolder || null });
}

/** Called when the folder, the pause switch or the account changes. */
function refresh() {
  start();
}

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
  alarming,
  decide,
  localPathFor,
  vaultPathFor,
  underPrefix,
  prefixFor,
  REFUSED_EXT,
  MAX_FILES,
  start,
  stop,
  refresh,
  syncNow: runOnce,
  preview,
  publicState,
  onChange,
  refuse,
};
