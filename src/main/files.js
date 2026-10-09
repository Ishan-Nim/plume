'use strict';

// File-system helpers for the main process: reading documents, listing
// folders for the sidebar, finding an Obsidian vault root and resolving
// Obsidian-style [[wiki links]]. Pure Node, no Electron, so it is unit-testable.

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const MD_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn', '.mdtxt', '.mdtext']);
// R Markdown and Quarto: shown as documents, but not treated as notes.
const MD_LIKE_EXTS = new Set(['.rmd', '.qmd']);
const TEXT_EXTS = new Set(['.txt', '.text', '.log']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif', '.ico']);
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', '__pycache__']);

const MAX_DOC_BYTES = 25 * 1024 * 1024;
const INDEX_TTL_MS = 10_000;
const INDEX_MAX_FILES = 50_000;
const INDEX_MAX_DEPTH = 12;
const NO_VAULT_MAX_DEPTH = 3;

const isWin = process.platform === 'win32';

// File types a link inside a document may open in their default app. This is
// an allowlist: programs, scripts, shortcuts, HTML/SVG and anything unknown
// are only ever revealed in File Explorer, never launched.
const OPENABLE_EXTS = new Set(['.pdf', '.txt', '.log', '.csv', '.tsv', '.json', '.yaml', '.yml',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.mp3', '.wav', '.ogg', '.flac', '.m4a',
  '.mp4', '.mov', '.webm', '.mkv', '.avi', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
  '.odt', '.ods', '.odp', '.rtf', '.epub']);

// Windows drops trailing dots/spaces and reads "name:stream" as an NTFS
// alternate data stream, so "run.cmd." or "run.cmd::$DATA" would get past an
// extension check yet still launch run.cmd. Such names are never opened.
// Elsewhere ':' and trailing dots are ordinary file-name characters.
function isAmbiguousWindowsName(abs, platform = process.platform) {
  if (platform !== 'win32') return false;
  const rest = abs.slice(path.win32.parse(abs).root.length);
  return rest.includes(':') || /[. ]$/.test(path.win32.basename(abs));
}

function isOpenableFromLink(abs, platform = process.platform) {
  return !isAmbiguousWindowsName(abs, platform) && OPENABLE_EXTS.has(path.extname(abs).toLowerCase());
}

// A folder a link may open in the file manager. On macOS an app, plug-in or
// other bundle is a folder too, and opening it launches it; on Windows a
// folder named "name.{CLSID}" opens as a shell object, not as a folder.
function isPlainFolder(abs, platform = process.platform) {
  const ext = path.extname(abs);
  if (platform === 'darwin') return !ext && !fs.existsSync(path.join(abs, 'Contents', 'Info.plist'));
  if (platform === 'win32') return !/^\.\{.*\}$/.test(ext);
  return true;
}

// The lower-case server of a Windows network path (\\server\share\…), '' for
// another device-namespace path (\\.\pipe\…), or null for a local path.
function uncHost(p, platform = process.platform) {
  if (platform !== 'win32' || typeof p !== 'string' || !/^[\\/]{2}/.test(p)) return null;
  const [first, second = '', third = ''] = p.slice(2).split(/[\\/]+/);
  if (first !== '?' && first !== '.') return first.toLowerCase();
  if (/^[a-z]:$/i.test(second)) return null;
  return second.toUpperCase() === 'UNC' ? third.toLowerCase() : '';
}

// True when `p` is on another computer than the open document. Windows signs
// in to any \\server it touches with the user's NTLM credentials, so paths a
// document points at must stay local or on the document's own server.
function isForeignUnc(p, docPath, platform = process.platform) {
  const host = uncHost(p, platform);
  if (host === null) return false;
  return !host || host !== uncHost(docPath, platform);
}

function isMarkdown(p) {
  return MD_EXTS.has(path.extname(p).toLowerCase());
}

// Files Plume displays as documents: Markdown, plain text and files with no
// extension at all (README, LICENSE, CHANGELOG). Binary content behind such a
// name is refused when the file is read.
function isViewable(p) {
  const ext = path.extname(p).toLowerCase();
  return !ext || MD_EXTS.has(ext) || MD_LIKE_EXTS.has(ext) || TEXT_EXTS.has(ext);
}

// Text never contains NUL bytes, except UTF-16, which starts with a BOM.
function looksBinary(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false;
  return buf.subarray(0, 8192).includes(0);
}

function isImage(p) {
  return IMAGE_EXTS.has(path.extname(p).toLowerCase());
}

function norm(p) {
  return isWin ? p.toLowerCase() : p;
}

function samePath(a, b) {
  return norm(path.resolve(a)) === norm(path.resolve(b));
}

// True when `child` is `parent` or lives somewhere below it.
function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// Decode a document buffer. Handles UTF-8 (with or without BOM) and UTF-16
// BOMs. Legacy files that are not valid UTF-8 are tried as Shift_JIS (old
// Japanese files), then read as Windows-1252, which accepts any byte. A
// lenient Shift_JIS decode would swallow the ASCII letter after each accented
// Windows-1252 character.
const LEGACY_DECODERS = [['utf-8', true], ['shift_jis', true], ['windows-1252', false]];

function decode(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8', 3);
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }
  for (const [encoding, fatal] of LEGACY_DECODERS) {
    try {
      return new TextDecoder(encoding, { fatal }).decode(buf);
    } catch { /* not this encoding */ }
  }
  return buf.toString('latin1');
}

async function readDocument(p) {
  const abs = path.resolve(p);
  const st = await fsp.stat(abs);
  if (!st.isFile()) {
    const err = new Error('Not a file');
    err.code = 'ENOTFILE';
    throw err;
  }
  if (st.size > MAX_DOC_BYTES) {
    const err = new Error(`File is too large to display (${(st.size / 1048576).toFixed(1)} MB)`);
    err.code = 'ETOOBIG';
    throw err;
  }
  const buf = await fsp.readFile(abs);
  if (looksBinary(buf)) {
    const err = new Error('It is not a text file.');
    err.code = 'EBINARY';
    throw err;
  }
  return { path: abs, content: decode(buf), mtimeMs: st.mtimeMs, size: st.size };
}

async function isFile(p) {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

async function listDir(dir) {
  const abs = path.resolve(dir);
  const dirents = await fsp.readdir(abs, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    if (d.name.startsWith('.') || SKIP_DIRS.has(d.name.toLowerCase())) continue;
    const full = path.join(abs, d.name);
    let dirLike = d.isDirectory();
    let fileLike = d.isFile();
    if (d.isSymbolicLink()) {
      try {
        const st = await fsp.stat(full);
        dirLike = st.isDirectory();
        fileLike = st.isFile();
      } catch {
        continue;
      }
    }
    if (dirLike) entries.push({ name: d.name, path: full, dir: true });
    else if (fileLike && isMarkdown(d.name)) entries.push({ name: d.name, path: full, dir: false });
  }
  entries.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1));
  const parent = path.dirname(abs);
  return {
    dir: abs,
    name: path.basename(abs) || abs,
    parent: parent !== abs ? parent : null,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Vault detection
//
// A folder is a vault if it holds a `.plume/` directory — Plume's own mark,
// written only when somebody asks for it. `.obsidian/` counts too: a vault
// made in Obsidian is a vault, and wiki links and the graph should work the
// moment it is opened rather than after being claimed a second time.
//
// This answers "which root do links resolve against", which is a different
// and broader question than "which vault does sync own this file" — that one
// is vaults.js, and it only ever says yes to `.plume/`.

const VAULT_MARKS = ['.plume', '.obsidian'];

const vaultCache = new Map(); // dir -> { root, at }

async function findVaultRoot(dir) {
  const start = path.resolve(dir);
  const hit = vaultCache.get(norm(start));
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.root;
  let cur = start;
  let root = null;
  for (let i = 0; i < 40; i++) {
    let found = false;
    for (const mark of VAULT_MARKS) {
      if (await isDir(path.join(cur, mark))) {
        found = true;
        break;
      }
    }
    if (found) {
      root = cur;
      break;
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  vaultCache.set(norm(start), { root, at: Date.now() });
  return root;
}

/** Forgets what is cached about a folder, after one becomes a vault. */
function forgetVaultRoot() {
  vaultCache.clear();
}

// ---------------------------------------------------------------------------
// Wiki link resolution

// `${norm(root)}|${maxDepth}` -> { at, map: Map<lowerBasename, string[]>|null, building: Promise|null }
const indexCache = new Map();

async function buildIndex(root, maxDepth) {
  const map = new Map();
  let count = 0;
  const queue = [[root, 0]];
  while (queue.length && count < INDEX_MAX_FILES) {
    const [dir, depth] = queue.shift();
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (d.name.startsWith('.') || SKIP_DIRS.has(d.name.toLowerCase())) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (depth < maxDepth) queue.push([full, depth + 1]);
      } else if (d.isFile()) {
        const key = d.name.toLowerCase();
        const list = map.get(key);
        if (list) list.push(full);
        else map.set(key, [full]);
        if (++count >= INDEX_MAX_FILES) break;
      }
    }
  }
  return map;
}

// The file-name index of a folder tree, as { map, fresh }. Walking a large
// vault takes a while, and wiki links resolve on every render, so an expired
// index is still served at once while a new walk runs; `fresh` is then that
// walk's promise. Concurrent callers share one walk, and only the very first
// lookup waits for it.
async function getIndex(root, maxDepth) {
  const key = `${norm(root)}|${maxDepth}`;
  let entry = indexCache.get(key);
  if (!entry) {
    entry = { at: 0, map: null, building: null };
    indexCache.set(key, entry);
  }
  if (!entry.building && Date.now() - entry.at >= INDEX_TTL_MS) {
    entry.building = buildIndex(root, maxDepth)
      .then(map => {
        entry.map = map;
        entry.at = Date.now();
        return map;
      }, () => entry.map || new Map())
      .finally(() => { entry.building = null; });
  }
  if (entry.map) return { map: entry.map, fresh: entry.building };
  return { map: await entry.building, fresh: null };
}

// The closest file in the index whose path ends with one of `candidates`.
// Obsidian matches names case-insensitively on every platform.
function findInIndex(map, candidates, fromDir) {
  for (const c of candidates) {
    const hits = map.get(path.basename(c).toLowerCase());
    if (!hits) continue;
    const suffix = `/${c}`.toLowerCase();
    const matches = hits.filter(h => h.replace(/\\/g, '/').toLowerCase().endsWith(suffix));
    if (!matches.length) continue;
    matches.sort((a, b) => relDepth(fromDir, a) - relDepth(fromDir, b) || a.length - b.length);
    return matches[0];
  }
  return null;
}

// Split "Note#Heading|Alias" into its parts.
function parseWikiTarget(raw) {
  let target = String(raw).replace(/\\\|/g, '|');
  let alias = '';
  const bar = target.indexOf('|');
  if (bar >= 0) {
    alias = target.slice(bar + 1).trim();
    target = target.slice(0, bar);
  }
  let hash = '';
  const h = target.indexOf('#');
  if (h >= 0) {
    hash = target.slice(h + 1).trim();
    target = target.slice(0, h);
  }
  return { target: target.trim(), hash, alias };
}

function relDepth(from, to) {
  return path.relative(from, to).split(/[\\/]/).length;
}

async function resolveWiki(fromFile, raw) {
  const { target, hash } = parseWikiTarget(raw);
  const fromDir = path.dirname(path.resolve(fromFile));
  if (!target) return { path: path.resolve(fromFile), hash, isMarkdown: true };

  const clean = target.replace(/\\/g, '/').replace(/^\/+/, '');
  const candidates = isMarkdown(clean) ? [clean] : [`${clean}.md`, clean];
  const vault = await findVaultRoot(fromDir);
  const root = vault || fromDir;

  for (const c of candidates) {
    // 1. Relative to the current note, 2. relative to the vault root.
    for (const base of [fromDir, root]) {
      const p = path.resolve(base, c);
      if (await isFile(p)) return { path: p, hash, isMarkdown: isMarkdown(p) };
    }
  }

  // 3. Anywhere in the vault by file name (Obsidian's "shortest path" links).
  const index = await getIndex(root, vault ? INDEX_MAX_DEPTH : NO_VAULT_MAX_DEPTH);
  let hit = findInIndex(index.map, candidates, fromDir);
  // An expired index may not know a note created or renamed since: on a miss
  // or a vanished file, wait for the walk already running and look again.
  if (index.fresh && !(hit && await isFile(hit))) {
    hit = findInIndex(await index.fresh, candidates, fromDir);
  }
  return hit ? { path: hit, hash, isMarkdown: isMarkdown(hit) } : null;
}

/**
 * Every Markdown file under `root`, for a change that has to touch all of
 * them — rewriting the links that point at a note being renamed. Same walk as
 * the wiki index: dot-folders and node_modules are left out, and it stops at
 * the same depth and file count rather than walking a whole disk.
 */
async function walkMarkdown(root, { max = INDEX_MAX_FILES, maxDepth = INDEX_MAX_DEPTH } = {}) {
  const out = [];
  const queue = [[path.resolve(root), 0]];
  while (queue.length && out.length < max) {
    const [dir, depth] = queue.shift();
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (d.name.startsWith('.') || SKIP_DIRS.has(d.name.toLowerCase())) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (depth < maxDepth) queue.push([full, depth + 1]);
      } else if (d.isFile() && isMarkdown(d.name)) {
        out.push(full);
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

function clearCaches() {
  vaultCache.clear();
  indexCache.clear();
}

/**
 * What Plume will write back to disk.
 *
 * Deliberately narrower than what it will open. Viewing a file must not be
 * enough to make it writable: a shell profile, a .bashrc, a .bat on the PATH
 * or an editor config are all plain text, and overwriting one of them turns a
 * flaw in the renderer into code that runs as the user. A file with no
 * extension at all — which is most dotfiles — is never savable.
 */
const SAVABLE_EXTS = new Set([...MD_EXTS, ...MD_LIKE_EXTS, ...TEXT_EXTS]);

function isSavable(p) {
  const ext = path.extname(p).toLowerCase();
  return Boolean(ext) && SAVABLE_EXTS.has(ext);
}

// Device names Windows still reserves: a file called CON.md cannot be opened
// there, and nor can one whose name ends in a dot or a space.
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * True when a file name is a Windows device rather than a file. Opening
 * `CON.md` for writing reaches the console, not the disk, on every Windows
 * release there has ever been.
 */
function isWindowsDeviceName(name) {
  const base = String(name || '');
  return WIN_RESERVED.test(base.slice(0, base.length - path.extname(base).length));
}

/**
 * One name typed into the sidebar, cleaned up, or null when that text cannot
 * be a file or folder name.
 *
 * Windows' rules are applied on every platform on purpose: a note named
 * "Q3: plan" would be fine on Linux and then arrive unopenable on the Windows
 * machine syncing the same vault. Only the name is decided here — never the
 * folder it goes in, which the tree supplies.
 */
function safeSegment(raw) {
  if (typeof raw !== 'string') return null;
  // Windows drops trailing dots and spaces, so they come off here rather
  // than leaving a name on disk that is not the one the user typed.
  const typed = raw.trim().replace(/[. ]+$/, '');
  if (!typed || typed.length > 120) return null;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(typed)) return null;
  if (typed.startsWith('.')) return null;  // the tree never lists dot-files
  return typed;
}

// The file name a new note is written under: what the user typed, with `.md`
// added unless they named a Markdown extension themselves.
function noteFileName(raw) {
  const typed = safeSegment(raw);
  if (!typed) return null;
  const name = isMarkdown(typed) ? typed : `${typed}.md`;
  if (WIN_RESERVED.test(name.slice(0, name.length - path.extname(name).length))) return null;
  return name;
}

function folderName(raw) {
  const typed = safeSegment(raw);
  return typed && !WIN_RESERVED.test(typed) ? typed : null;
}

module.exports = {
  MD_EXTS,
  SAVABLE_EXTS,
  isSavable,
  noteFileName,
  folderName,
  MD_LIKE_EXTS,
  OPENABLE_EXTS,
  isAmbiguousWindowsName,
  isOpenableFromLink,
  isPlainFolder,
  uncHost,
  isForeignUnc,
  IMAGE_EXTS,
  MAX_DOC_BYTES,
  isMarkdown,
  isViewable,
  isImage,
  isWithin,
  samePath,
  decode,
  readDocument,
  isFile,
  isDir,
  listDir,
  walkMarkdown,
  forgetVaultRoot,
  isWindowsDeviceName,
  findVaultRoot,
  parseWikiTarget,
  resolveWiki,
  clearCaches,
};
