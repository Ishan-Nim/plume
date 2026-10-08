'use strict';

// Updates.
//
// Plume is not code-signed, so it cannot rely on a signing-based update
// mechanism and must not run whatever an HTTP response hands it. Every release
// publishes SHA256SUMS.txt alongside the installers, and nothing runs unless
// its hash is in that file.
//
// What that does and does not protect against, plainly:
//   · a corrupted or truncated download — yes
//   · a redirect that swaps the file underneath — yes; every hop is checked,
//     and the bytes are hashed anyway
//   · an attacker who can rewrite what a predictable temp path contains after
//     it was verified — yes; the file is re-hashed immediately before it is
//     handed to the system, and it lives in a directory nobody can pre-create
//   · an attacker who controls GitHub, or who holds a certificate the system
//     trusts and can rewrite both the installer and the sums file — NO. The
//     checksums come from the same place as the binary. Only signing the
//     manifest with an offline key closes that, and that is worth doing.
//
// Nothing is downloaded or installed without the user asking for it.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, shell } = require('electron');

// Where releases come from, newest home first.
//
// Two entries, not one, because the repository moved and an update must survive
// that in both directions. A copy of Plume built before the move asks GitHub
// about the old path; GitHub redirects, and answers with asset URLs under the
// new one. A client that trusts only the path it was built with would reject
// its own update and quietly stop updating for ever — which is exactly what
// hardcoding a single owner would have done here.
//
// It stays an allowlist: two names, both ours, checked exactly. Nothing is
// taken from the response and trusted because the response said so.
const REPOS = ['Plume-MD/plume', 'Ishan-Nim/plume'];
const REPO = REPOS[0];
const LATEST = REPOS.map((r) => `https://api.github.com/repos/${r}/releases/latest`);
const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`;

// Where a release asset may actually come from, including the hosts GitHub
// redirects asset downloads to.
const ASSET_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

const VERSION_RE = /^\d{1,5}(\.\d{1,5}){0,3}(-[0-9A-Za-z.-]{1,32})?$/;

const TIMEOUT_MS = 20_000;
const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;
const MAX_HOPS = 5;

// Windows installs in place. macOS cannot: an unsigned app is not allowed to
// replace itself, and pretending otherwise would fail after a long download.
// Linux packages belong to the package manager.
const CAN_INSTALL = process.platform === 'win32';

let checking = false;
let downloading = false;
let installing = false;
let swept = false;
let found = null;        // { version, page, installable, url, sumsUrl, size }
let downloaded = null;   // { path, dir, sha256 }

function installerName(version) {
  return `Plume-Setup-${version}.exe`;
}

/** -1, 0 or 1, comparing dotted numeric versions. Pre-release tags are ignored. */
function compare(a, b) {
  const parse = v => String(v).replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The first URL of a download: a release asset of this repository, over HTTPS. */
function trusted(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== 'github.com') return false;
    return REPOS.some((repo) => parsed.pathname.startsWith(`/${repo}/releases/download/`));
  } catch (err) {
    return false;
  }
}

/** Any later hop in that download. Checked per hop rather than delegated. */
function trustedHop(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ASSET_HOSTS.has(parsed.hostname);
  } catch (err) {
    return false;
  }
}

async function getJSON(url) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': `Plume/${app.getVersion()}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Update check failed (${res.status}).`);
  return res.json();
}

/**
 * Asks GitHub what the newest release is. Returns null when this is already
 * the newest, so a quiet check costs the caller nothing.
 */
async function check({ force = false } = {}) {
  if (checking) return found;
  checking = true;
  if (!swept) {
    swept = true;
    await sweep();
  }
  try {
    // The first that answers. After the move both work, because GitHub
    // redirects the old one; before it, only the old one exists.
    let release = null;
    let lastError = null;
    for (const endpoint of LATEST) {
      try {
        release = await getJSON(endpoint);
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!release) throw lastError || new Error('Update check failed.');
    const version = String(release.tag_name || '').replace(/^v/, '');

    // A tag becomes part of a file name and a path. Anything that is not a
    // version is not a release as far as this is concerned.
    if (!VERSION_RE.test(version) || compare(version, app.getVersion()) <= 0) {
      found = null;
      return null;
    }

    const assets = Array.isArray(release.assets) ? release.assets : [];
    const installer = assets.find(a => a.name === installerName(version));
    const sums = assets.find(a => a.name === 'SHA256SUMS.txt');

    found = {
      version,
      notes: String(release.body || '').slice(0, 20000),
      page: release.html_url || RELEASE_PAGE,
      // An install is only offered when there is something to verify it with.
      installable: Boolean(CAN_INSTALL && installer && sums
        && trusted(installer.browser_download_url) && trusted(sums.browser_download_url)),
      url: installer ? installer.browser_download_url : null,
      sumsUrl: sums ? sums.browser_download_url : null,
      size: installer ? installer.size : 0,
    };
    return found;
  } catch (err) {
    if (force) throw err;
    return null;
  } finally {
    checking = false;
  }
}

/** Follows redirects by hand, so every hop is checked rather than trusted. */
async function fetchTrusted(url) {
  if (!trusted(url)) throw new Error('That download is not from the Plume releases.');

  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const res = await fetch(current, {
      headers: { 'user-agent': `Plume/${app.getVersion()}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });

    if (res.status < 300 || res.status > 399) {
      if (!res.ok) throw new Error(`Download failed (${res.status}).`);
      return res;
    }

    const location = res.headers.get('location');
    if (!location) throw new Error('That download redirected to nowhere.');
    const next = new URL(location, current).href;
    if (!trustedHop(next)) throw new Error('That download was redirected away from GitHub.');
    current = next;
  }
  throw new Error('That download redirected too many times.');
}

/** The hash the release says this file should have. */
async function expectedHash(sumsUrl, name) {
  const res = await fetchTrusted(sumsUrl);
  const text = await res.text();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (match && match[2] === name) return match[1].toLowerCase();
  }
  throw new Error('The release does not list a checksum for that installer.');
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function discard() {
  if (!downloaded) return;
  await fsp.rm(downloaded.dir, { recursive: true, force: true }).catch(() => {});
  downloaded = null;
}

/**
 * Downloads the installer and checks it against the published hash.
 *
 * It goes into a directory created fresh for it, opened with a flag that fails
 * if anything is already there — a predictable name in the shared temp folder
 * can be pre-created, as a file to be swapped later or as a link pointing
 * somewhere else entirely.
 */
async function download(onProgress) {
  if (!found || !found.installable) throw new Error('There is no update to install.');
  // Two downloads at once would be two writers and, worse, the second one's
  // discard() would delete the first one's installer — including one that has
  // already been handed to the system to run.
  if (downloading) throw new Error('That update is already downloading.');
  if (installing) throw new Error('That update is already installing.');

  downloading = true;
  try {
    return await fetchInstaller(onProgress);
  } finally {
    downloading = false;
  }
}

async function fetchInstaller(onProgress) {
  const name = installerName(found.version);
  const want = await expectedHash(found.sumsUrl, name);

  await discard();
  const dir = await fsp.mkdtemp(path.join(app.getPath('temp'), 'plume-update-'));
  const dest = path.join(dir, name);
  const res = await fetchTrusted(found.url);

  const total = Number(res.headers.get('content-length')) || found.size || 0;
  if (total > MAX_INSTALLER_BYTES) throw new Error('That installer is implausibly large.');

  const hash = crypto.createHash('sha256');
  const handle = await fsp.open(dest, 'wx');
  let read = 0;

  try {
    for await (const chunk of res.body) {
      read += chunk.length;
      if (read > MAX_INSTALLER_BYTES) throw new Error('That installer is implausibly large.');
      hash.update(chunk);
      await handle.write(chunk);
      if (onProgress && total) onProgress({ read, total, percent: Math.round((read / total) * 100) });
    }
  } catch (err) {
    await handle.close().catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  await handle.close();

  if (hash.digest('hex') !== want) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error('The download did not match the published checksum, so it was discarded.');
  }

  downloaded = { path: dest, dir, sha256: want };
  return { path: dest, version: found.version, bytes: read };
}

/**
 * Hands the verified installer to the system and steps aside.
 *
 * The file is hashed again first. Verifying at download time and running at
 * install time are different moments — minutes apart, with the user in
 * between — and what runs must be what was checked, not merely something with
 * the same name.
 */
async function install() {
  if (!downloaded) throw new Error('Download the update first.');

  let actual;
  try {
    actual = await hashFile(downloaded.path);
  } catch (err) {
    await discard();
    throw new Error('The downloaded update is no longer there. Download it again.');
  }

  if (actual !== downloaded.sha256) {
    await discard();
    throw new Error('The downloaded update changed on disk, so it was discarded. Download it again.');
  }

  const target = downloaded.path;
  installing = true;
  const problem = await shell.openPath(target);
  if (problem) {
    installing = false;
    throw new Error(problem);
  }

  setTimeout(() => app.quit(), 800);
  return true;
}

function openReleasePage() {
  return shell.openExternal(found ? found.page : RELEASE_PAGE);
}

function state() {
  return {
    current: app.getVersion(),
    canInstall: CAN_INSTALL,
    update: found,
    ready: Boolean(downloaded),
  };
}

// Leaving an installer behind is leaving something executable in a temp folder.
//
// Except when we are quitting *because* that installer is starting: Windows
// has an elevation prompt in front of the user and has not read the file yet.
// Deleting it there is what turns an install into a download that never
// sticks. It is swept up on the next check instead.
app.on('will-quit', () => {
  if (downloaded && !installing) fs.rmSync(downloaded.dir, { recursive: true, force: true });
});

/** Clears installers left behind by an update that quit to run one. */
async function sweep() {
  const temp = app.getPath('temp');
  let entries;
  try {
    entries = await fsp.readdir(temp);
  } catch (err) {
    return;
  }
  const mine = downloaded ? path.basename(downloaded.dir) : null;
  for (const entry of entries) {
    if (!entry.startsWith('plume-update-') || entry === mine) continue;
    await fsp.rm(path.join(temp, entry), { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  check, download, install, openReleasePage, state, compare, trusted, trustedHop, discard,
};
