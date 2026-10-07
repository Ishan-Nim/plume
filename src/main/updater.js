'use strict';

// Updates.
//
// Plume is not code-signed, so it cannot use a signing-based update mechanism
// and must not simply download and run whatever an HTTP response hands it.
// Instead every release publishes SHA256SUMS.txt alongside the installers, and
// this refuses to run anything whose hash is not in that file. The hashes come
// from the same GitHub release over HTTPS, which is not a defence against
// GitHub itself — but it is a complete defence against a corrupted or
// truncated download, and against a redirect that swaps the file underneath.
//
// Nothing is ever installed without the user agreeing to it.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, shell } = require('electron');

const REPO = 'Ishan-Nim/plume';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_HOST = 'github.com';
const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`;

const TIMEOUT_MS = 20_000;
const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;

// Windows installs in place. macOS cannot: Squirrel refuses to update an app
// that is not signed, and pretending otherwise would fail silently after a
// long download. Linux packages belong to the package manager. On those, an
// update is an invitation to the download page rather than an install.
const CAN_INSTALL = process.platform === 'win32';

let checking = false;
let found = null;      // { version, notes, url, size }
let downloaded = null; // path to a verified installer

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

/** Only ever a release asset of this repository, over HTTPS. */
function trusted(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && (parsed.hostname === DOWNLOAD_HOST || parsed.hostname === `objects.${DOWNLOAD_HOST}`)
      && parsed.pathname.startsWith(`/${REPO}/releases/download/`);
  } catch (err) {
    return false;
  }
}

/**
 * Asks GitHub what the newest release is. Returns null when this is already
 * the newest, so a quiet check costs the caller nothing.
 */
async function check({ force = false } = {}) {
  if (checking) return found;
  checking = true;
  try {
    const release = await getJSON(LATEST);
    const version = String(release.tag_name || '').replace(/^v/, '');
    if (!version || compare(version, app.getVersion()) <= 0) {
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

async function fetchTrusted(url) {
  if (!trusted(url)) throw new Error('That download is not from the Plume releases.');
  const res = await fetch(url, {
    headers: { 'user-agent': `Plume/${app.getVersion()}` },
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  return res;
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

/**
 * Downloads the installer and checks it against the published hash. The file
 * is only kept if it matches; a mismatch is deleted and reported.
 */
async function download(onProgress) {
  if (!found || !found.installable) throw new Error('There is no update to install.');

  const name = installerName(found.version);
  const want = await expectedHash(found.sumsUrl, name);

  const dest = path.join(app.getPath('temp'), `plume-update-${found.version}.exe`);
  const res = await fetchTrusted(found.url);

  const total = Number(res.headers.get('content-length')) || found.size || 0;
  if (total > MAX_INSTALLER_BYTES) throw new Error('That installer is implausibly large.');

  const hash = crypto.createHash('sha256');
  const handle = await fsp.open(dest, 'w');
  let read = 0;

  try {
    for await (const chunk of res.body) {
      read += chunk.length;
      if (read > MAX_INSTALLER_BYTES) throw new Error('That installer is implausibly large.');
      hash.update(chunk);
      await handle.write(chunk);
      if (onProgress && total) onProgress({ read, total, percent: Math.round((read / total) * 100) });
    }
  } finally {
    await handle.close();
  }

  const got = hash.digest('hex');
  if (got !== want) {
    await fsp.rm(dest, { force: true });
    throw new Error('The download did not match the published checksum, so it was discarded.');
  }

  downloaded = dest;
  return { path: dest, version: found.version, bytes: read };
}

/**
 * Hands the verified installer to Windows and steps aside. The installer needs
 * Plume closed to replace it, so the app quits once the handoff succeeds.
 */
async function install() {
  if (!downloaded || !fs.existsSync(downloaded)) throw new Error('Download the update first.');

  const problem = await shell.openPath(downloaded);
  if (problem) throw new Error(problem);

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

module.exports = { check, download, install, openReleasePage, state, compare, trusted };
