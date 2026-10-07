'use strict';

// Folder sync: one folder on this computer, kept in step with the vault.
//
// Pick a folder once and, while you are signed in, everything inside it that
// Plume can read goes up and stays up to date — keeping the folder structure,
// so a notebook arrives in the vault with the same shape it has on disk.
//
// Only documents and images are ever uploaded. Programs, installers, archives
// and anything else are not merely skipped by accident: they are refused by an
// allow-list, so a folder that happens to contain an .exe or a .zip syncs its
// notes and leaves the rest alone.

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
const MAX_DEPTH = 10;
const SKIP_DIR = /^[.]|^node_modules$|^__pycache__$|^\$RECYCLE/i;

const SETTLE_MS = 1500;     // wait for an editor to finish writing
const RESCAN_MS = 5 * 60 * 1000;

let state = {
  status: 'off',            // off | idle | scanning | syncing | error | paused
  folder: null,
  message: null,
  total: 0,
  done: 0,
  uploaded: 0,
  skipped: 0,
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
      out.skipped.push({ localPath: full, reason: why });
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
  return { ...state };
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

    const found = await walk(folder, folder, { files: [], skipped: [] });

    // Only send what actually differs from what the vault already holds.
    const changed = [];
    for (const file of found.files) {
      const link = vault.linkFor(file.localPath);
      if (link && link.vaultPath === file.vaultPath) {
        let sha;
        try {
          sha = await sha256Of(file.localPath);
        } catch (err) {
          continue;
        }
        if (sha === link.sha256) continue;
      }
      changed.push({ localPath: file.localPath, vaultPath: file.vaultPath });
    }

    set({
      status: changed.length ? 'syncing' : 'idle',
      total: changed.length,
      done: 0,
      skipped: found.skipped.length,
    });

    if (changed.length) {
      const result = await vault.pushMany(changed, {
        onProgress: ({ index, total }) => set({ done: index, total }),
      });
      set({
        uploaded: result.done.filter(r => !r.unchanged).length,
        failed: result.failed.length,
        done: changed.length,
        lastError: result.failed.length
          ? `${result.failed.length} document${result.failed.length === 1 ? '' : 's'} could not be synced`
          : null,
      });
    } else {
      set({ uploaded: 0, failed: 0 });
    }

    set({
      status: 'idle',
      folder,
      lastSyncAt: new Date().toISOString(),
      message: found.skipped.length
        ? `${found.skipped.length} file${found.skipped.length === 1 ? '' : 's'} left alone — only documents and images are uploaded`
        : null,
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
    skippedTotal: found.skipped.length,
    atLimit: found.files.length >= MAX_FILES,
  };
}

module.exports = {
  SYNC_EXT,
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
