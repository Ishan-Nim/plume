'use strict';

// Plume Vault — the desktop half of document sync.
//
// All of it runs in the main process on purpose: the renderer stays sandboxed
// behind its Content-Security-Policy and never learns the account token. The
// renderer only ever asks for an action and gets back a plain result object.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');

// The override is a development affordance. In a packaged build it is ignored:
// anything running as this user can set an environment variable, and this is
// where the account password goes.
function resolveApi() {
  const DEFAULT = 'https://plume-md.com/api';
  const override = process.env.PLUME_VAULT_API;
  if (!override || app.isPackaged) return DEFAULT;
  try {
    const url = new URL(override);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !local) return DEFAULT;
    return override.replace(/\/+$/, '');
  } catch (err) {
    return DEFAULT;
  }
}

const API = resolveApi();
const TIMEOUT_MS = 30_000;
const MAX_PUSH_BYTES = 10 * 1024 * 1024;

const SYNCABLE = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn', '.mdtxt', '.mdtext', '.txt']);

let session = null;   // { token, email, account }
let links = null;     // { [localPath]: { vaultPath, sha256, syncedAt } }

// ---------- where state lives ----------

const sessionFile = () => path.join(app.getPath('userData'), 'vault-session.bin');
const linksFile = () => path.join(app.getPath('userData'), 'vault-links.json');

function writeAtomic(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

// The token is kept encrypted at rest wherever the OS offers it (Keychain,
// DPAPI, libsecret). Where it does not, we store nothing rather than leaving a
// bearer token in plain text on disk — the user signs in again next launch.
function saveSession() {
  try {
    if (!session) {
      fs.rmSync(sessionFile(), { force: true });
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) return;
    writeAtomic(sessionFile(), safeStorage.encryptString(JSON.stringify(session)));
  } catch {
    // Signing in again is a small price; never crash over it.
  }
}

function loadSession() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const raw = fs.readFileSync(sessionFile());
    const parsed = JSON.parse(safeStorage.decryptString(raw));
    if (parsed && typeof parsed.token === 'string' && typeof parsed.email === 'string') return parsed;
  } catch {
    // No session, or it was written by a different user or machine.
  }
  return null;
}

function saveLinks() {
  try {
    writeAtomic(linksFile(), JSON.stringify(links, null, 2));
  } catch {
    // Links are a convenience; losing them only means re-choosing a name.
  }
}

function loadLinks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(linksFile(), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      const clean = {};
      for (const [local, meta] of Object.entries(parsed)) {
        if (meta && typeof meta.vaultPath === 'string' && typeof meta.sha256 === 'string') {
          clean[local] = { vaultPath: meta.vaultPath, sha256: meta.sha256, syncedAt: meta.syncedAt || null };
        }
      }
      return clean;
    }
  } catch {
    // Starting fresh.
  }
  return {};
}

function ready() {
  if (!session) session = loadSession();
  if (!links) links = loadLinks();
}

// ---------- talking to the API ----------

/** How long the server asked us to wait, in milliseconds, within reason. */
function retryAfter(res) {
  const header = res.headers.get('retry-after');
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(60000, seconds * 1000);
  return 2000;
}

async function call(endpoint, { method = 'GET', body, json, headers = {}, auth = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const sent = { ...headers };
  if (auth && session) sent.Authorization = `Bearer ${session.token}`;
  if (json !== undefined) sent['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(API + endpoint, {
      method,
      headers: sent,
      body: json !== undefined ? JSON.stringify(json) : body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('The vault did not answer in time. Check your connection.');
    throw new Error('Could not reach the vault. Check your connection.');
  }
  clearTimeout(timer);

  if (res.status === 401 && auth) {
    session = null;
    saveSession();
    throw new Error('Your session expired. Sign in again.');
  }

  // The vault asks callers to slow down rather than refusing them outright.
  // Syncing a real notebook is hundreds of uploads in a row, so a sync that
  // treated 429 as a failure simply stopped partway through and reported a
  // number with no reason attached.
  //
  // It also says why — too many sign-ups from here, too many codes for one
  // address — and on the sign-in form that sentence is the whole answer.
  if (res.status === 429) {
    const said = (res.headers.get('content-type') || '').includes('application/json')
      ? await res.json().catch(() => ({}))
      : {};
    const err = new Error(typeof said.error === 'string' && said.error ? said.error : 'The vault asked us to slow down.');
    err.status = 429;
    err.retryAfterMs = retryAfter(res);
    throw err;
  }

  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error(data.error || `The vault refused that (${res.status}).`);
      err.status = res.status;
      err.conflict = data.conflict;
      err.usage = data.usage;
      throw err;
    }
    return data;
  }

  if (!res.ok) {
    const err = new Error(`The vault refused that (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// ---------- account ----------

function publicState() {
  ready();
  return {
    api: API,
    signedIn: Boolean(session),
    email: session ? session.email : null,
    account: session ? session.account : null,
    encrypted: safeStorage.isEncryptionAvailable(),
  };
}

/** Keeps the session the vault just handed over, from any of the ways in. */
function adopt(data) {
  if (!data || typeof data.token !== 'string' || !data.account || typeof data.account.email !== 'string') {
    throw new Error('The vault sent an answer Plume does not understand.');
  }
  session = { token: data.token, email: data.account.email, account: data.account };
  saveSession();
  return publicState();
}

/**
 * A code from an email, the way the vault wants it: six plain digits. People
 * paste "123 456" or "123-456", and typing with a Japanese input method on
 * gives full-width digits; all of those are the same code. Anything else is
 * refused here rather than spending one of the code's few attempts on it.
 */
function cleanCode(raw) {
  const code = String(raw == null ? '' : raw)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit code from the email.');
  return code;
}

const noteOf = (data) => (data && typeof data.note === 'string' ? data.note : null);

/**
 * Creating an account takes two steps, and this is the first: the vault emails
 * a code to the address. Nothing is created yet and nothing is kept here — the
 * vault hashes the password on its side, and the panel holds it only so that
 * "Resend code" can ask again.
 *
 * The answer is the same whether or not the address already has an account,
 * so it says nothing about who uses Plume. Someone who already has one gets
 * an email saying so instead of a code.
 */
async function signUpStart(email, password) {
  const data = await call('/auth/signup/start', {
    method: 'POST', json: { email: String(email).trim(), password }, auth: false,
  });
  return {
    verify: data.verify !== false,
    minutes: Number.isFinite(data.minutes) ? data.minutes : null,
    note: noteOf(data),
  };
}

/** The second step: the code from the email creates the account and signs in. */
async function signUpVerify(email, code) {
  const data = await call('/auth/signup/verify', {
    method: 'POST', json: { email: String(email).trim(), code: cleanCode(code) }, auth: false,
  });
  return adopt(data);
}

async function signIn(email, password) {
  const data = await call('/auth/login', { method: 'POST', json: { email, password }, auth: false });
  return adopt(data);
}

/**
 * Asks for a password-reset email: a code to type here, and a link that does
 * the same thing in a browser. The vault answers alike for every address, and
 * its note says so; that note is passed on as it is.
 */
async function forgot(email) {
  const data = await call('/auth/forgot', { method: 'POST', json: { email: String(email).trim() }, auth: false });
  return { note: noteOf(data) };
}

/**
 * Sets a new password with the code from that email, and signs in with it.
 * Every other device is signed out by the vault as part of the change.
 */
async function resetWithCode(email, code, password) {
  const data = await call('/auth/reset/code', {
    method: 'POST', json: { email: String(email).trim(), code: cleanCode(code), password }, auth: false,
  });
  return { state: adopt(data), note: noteOf(data) };
}

function signOut() {
  session = null;
  saveSession();
  return publicState();
}

async function refresh() {
  ready();
  if (!session) return publicState();
  const data = await call('/vault/list');
  session.account = data.account;
  saveSession();
  return { ...publicState(), files: data.files };
}

// ---------- documents ----------

function requireSession() {
  ready();
  if (!session) throw new Error('Sign in to your vault first.');
}

const MAX_DEPTH = 10;
const MAX_COLLECT = 2000;
const MAX_VAULT_PATH = 400;
const SKIP_DIR = /^[.]|^node_modules$|^__pycache__$|^[$]RECYCLE/i;

/**
 * Where a file should live in the vault.
 *
 * Keeping only the file name flattens a notebook: two documents called
 * `README` in different folders become one, and nothing in the graph can tell
 * which folder a note came from. So the path is taken relative to the folder
 * the user is syncing from, and only falls back to the bare name when the file
 * sits outside it.
 */
function suggestVaultPath(localPath, rootDir) {
  const name = path.basename(localPath);
  if (!rootDir) return name;

  const relative = path.relative(rootDir, localPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return name;

  const parts = relative.split(path.sep).filter(Boolean);
  // The server accepts twelve segments; past that, keep the deepest ones that
  // still say something useful.
  const trimmed = parts.length > 12 ? parts.slice(parts.length - 12) : parts;
  return trimmed.join('/');
}

/**
 * The only shape a vault path may take: relative, forward slashes, no step
 * outside. suggestVaultPath can never produce anything else, but a name typed
 * into the panel can, and the server is entitled to assume it cannot.
 */
function cleanVaultPath(raw) {
  const p = String(raw == null ? '' : raw).split('\\').join('/').trim();
  if (!p || p.length > MAX_VAULT_PATH) throw new Error('That is not a usable name for the vault.');
  for (let i = 0; i < p.length; i += 1) {
    const code = p.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) throw new Error('That name contains control characters.');
  }
  if (p.startsWith('/') || /^[a-z]:/i.test(p)) throw new Error('A vault name cannot be an absolute path.');

  const parts = p.split('/').filter(Boolean);
  if (!parts.length || parts.some(seg => seg === '.' || seg === '..')) {
    throw new Error('A vault name cannot step outside the vault.');
  }
  if (parts.length > 12) throw new Error('That path is nested too deeply for the vault.');
  return parts.join('/');
}

/** Every syncable document under a folder, with the vault path each would take. */
async function collectFolder(dir, rootDir, depth = 0, found = []) {
  if (depth > MAX_DEPTH || found.length >= MAX_COLLECT) return found;

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return found;
  }

  for (const entry of entries) {
    if (found.length >= MAX_COLLECT) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.test(entry.name)) continue;
      await collectFolder(full, rootDir, depth + 1, found);
    } else if (entry.isFile() && SYNCABLE.has(path.extname(entry.name).toLowerCase())) {
      found.push({ localPath: full, vaultPath: suggestVaultPath(full, rootDir) });
    }
  }
  return found;
}

/**
 * Sends several documents up, one after another rather than all at once: the
 * vault serialises writes per account anyway, and a failure partway through
 * should leave a clear account of what did and did not go.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends many documents, one at a time, slowly enough that the vault does not
 * have to ask us to stop — and waiting rather than giving up when it does.
 *
 * A notebook of a thousand documents is a thousand requests. Sent as fast as
 * the network allows, that trips the vault's own per-account limit a few
 * hundred in, and everything after it fails. Which is exactly what it looked
 * like: hundreds of documents "could not be synced", no reason given, and a
 * folder that never finished.
 */
async function pushMany(items, { force = false, onProgress } = {}) {
  requireSession();

  const done = [];
  const failed = [];
  // Comfortably under the vault's per-account ceiling, and invisible next to
  // the time an upload takes anyway.
  const SPACING_MS = 120;
  const MAX_WAITS = 5;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (onProgress) onProgress({ index: i, total: items.length, localPath: item.localPath });

    let sent = false;
    for (let attempt = 0; attempt <= MAX_WAITS && !sent; attempt += 1) {
      try {
        const result = await push(item.localPath, item.vaultPath, { force });
        done.push({ ...result, vaultPath: item.vaultPath });
        sent = true;
      } catch (err) {
        const askedToWait = err && (err.status === 429 || err.status === 409 && /too quickly/i.test(err.message || ''));
        if (askedToWait && attempt < MAX_WAITS) {
          await wait((err.retryAfterMs || 2000) * (attempt + 1));
          continue;
        }
        failed.push({
          localPath: item.localPath,
          vaultPath: item.vaultPath,
          error: err && err.message ? err.message : 'Could not sync that document.',
          status: err && err.status,
          conflict: err && err.conflict,
        });
        sent = true;
      }
    }

    if (i + 1 < items.length) await wait(SPACING_MS);
  }

  return { done, failed, account: session ? session.account : null };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function graph() {
  requireSession();
  const data = await call('/vault/graph');
  session.account = data.account;
  return { nodes: data.nodes, edges: data.edges, unresolved: data.unresolved, account: data.account };
}

async function list() {
  requireSession();
  const data = await call('/vault/list');
  session.account = data.account;
  return { files: data.files, account: data.account, links: { ...links } };
}

/**
 * Sends a local file up. When the vault copy has moved on since this machine
 * last synced, the push is refused and the conflict is handed back rather than
 * overwriting work done elsewhere.
 */
async function push(localPath, vaultPath, { force = false } = {}) {
  requireSession();

  const ext = path.extname(localPath).toLowerCase();
  if (!SYNCABLE.has(ext)) {
    throw new Error('Plume syncs Markdown and text documents.');
  }

  const stat = await fsp.stat(localPath);
  if (stat.size > MAX_PUSH_BYTES) {
    throw new Error(`That document is larger than the ${Math.round(MAX_PUSH_BYTES / 1048576)} MB limit.`);
  }

  const body = await fsp.readFile(localPath);
  const target = cleanVaultPath(vaultPath || (links[localPath] && links[localPath].vaultPath) || suggestVaultPath(localPath));
  const known = links[localPath];

  const headers = {};
  if (!force && known && known.vaultPath === target) headers['X-Plume-Base-Sha'] = known.sha256;

  const data = await call(`/vault/file?path=${encodeURIComponent(target)}`, {
    method: 'PUT',
    body,
    headers,
  });

  links[localPath] = { vaultPath: target, sha256: data.file.sha256, syncedAt: data.file.updatedAt };
  saveLinks();
  session.account = data.account;

  return { file: data.file, account: data.account, unchanged: data.unchanged, localPath };
}

/** Brings a vault document down to a local path. */
async function pull(vaultPath, destPath) {
  requireSession();
  const res = await call(`/vault/file?path=${encodeURIComponent(vaultPath)}`);
  const body = Buffer.from(await res.arrayBuffer());

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, body);

  links[destPath] = {
    vaultPath,
    sha256: res.headers.get('x-plume-sha256') || sha256(body),
    syncedAt: res.headers.get('x-plume-updated-at') || new Date().toISOString(),
  };
  saveLinks();

  return { localPath: destPath, vaultPath, size: body.length };
}

/** Saves the vault copy next to the local one so neither version is lost. */
async function saveConflictCopy(localPath, vaultPath) {
  const dir = path.dirname(localPath);
  const ext = path.extname(localPath);
  const base = path.basename(localPath, ext);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const dest = path.join(dir, `${base} (vault copy ${stamp})${ext}`);
  await pull(vaultPath, dest);
  return dest;
}

async function remove(vaultPath) {
  requireSession();
  const data = await call(`/vault/file?path=${encodeURIComponent(vaultPath)}`, { method: 'DELETE' });
  for (const [local, meta] of Object.entries(links)) {
    if (meta.vaultPath === vaultPath) delete links[local];
  }
  saveLinks();
  session.account = data.account;
  return { account: data.account };
}

function unlink(localPath) {
  ready();
  delete links[localPath];
  saveLinks();
  return { links: { ...links } };
}

/** What the renderer needs to know about the document it is showing. */
function linkFor(localPath) {
  ready();
  if (!localPath) return null;
  const meta = links[localPath];
  return meta ? { ...meta } : null;
}

function isSyncable(localPath) {
  return SYNCABLE.has(path.extname(localPath || '').toLowerCase());
}

module.exports = {
  API,
  publicState,
  signUpStart,
  signUpVerify,
  signIn,
  forgot,
  resetWithCode,
  cleanCode,
  signOut,
  refresh,
  list,
  graph,
  push,
  pull,
  saveConflictCopy,
  remove,
  unlink,
  linkFor,
  isSyncable,
  suggestVaultPath,
  cleanVaultPath,
  collectFolder,
  pushMany,
  SYNCABLE,
};
