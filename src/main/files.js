'use strict';

// File-system helpers for the main process: reading documents, listing
// folders for the sidebar, finding an Obsidian vault root and resolving
// Obsidian-style [[wiki links]]. Pure Node, no Electron, so it is unit-testable.

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const MD_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn', '.mdtxt', '.mdtext']);
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
function isAmbiguousWindowsName(abs) {
  const rest = abs.slice(path.win32.parse(abs).root.length);
  return rest.includes(':') || /[. ]$/.test(path.win32.basename(abs));
}

function isOpenableFromLink(abs) {
  return !isAmbiguousWindowsName(abs) && OPENABLE_EXTS.has(path.extname(abs).toLowerCase());
}

function isMarkdown(p) {
  return MD_EXTS.has(path.extname(p).toLowerCase());
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
// BOMs, and falls back to Shift_JIS for legacy Japanese files that are not
// valid UTF-8.
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
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('shift_jis').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
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
// Obsidian vault detection

const vaultCache = new Map(); // dir -> { root, at }

async function findVaultRoot(dir) {
  const start = path.resolve(dir);
  const hit = vaultCache.get(norm(start));
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.root;
  let cur = start;
  let root = null;
  for (let i = 0; i < 40; i++) {
    if (await isDir(path.join(cur, '.obsidian'))) {
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

// ---------------------------------------------------------------------------
// Wiki link resolution

const indexCache = new Map(); // norm(root) -> { at, map: Map<lowerBasename, string[]> }

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

async function getIndex(root, maxDepth) {
  const key = `${norm(root)}|${maxDepth}`;
  const hit = indexCache.get(key);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.map;
  const map = await buildIndex(root, maxDepth);
  indexCache.set(key, { at: Date.now(), map });
  return map;
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
  for (const c of candidates) {
    const hits = index.get(path.basename(c).toLowerCase());
    if (!hits) continue;
    const suffix = norm(`/${c}`);
    const matches = hits.filter(h => norm(h.replace(/\\/g, '/')).endsWith(suffix));
    if (!matches.length) continue;
    matches.sort((a, b) => relDepth(fromDir, a) - relDepth(fromDir, b) || a.length - b.length);
    return { path: matches[0], hash, isMarkdown: isMarkdown(matches[0]) };
  }
  return null;
}

function clearCaches() {
  vaultCache.clear();
  indexCache.clear();
}

module.exports = {
  MD_EXTS,
  OPENABLE_EXTS,
  isAmbiguousWindowsName,
  isOpenableFromLink,
  IMAGE_EXTS,
  MAX_DOC_BYTES,
  isMarkdown,
  isImage,
  isWithin,
  samePath,
  decode,
  readDocument,
  isFile,
  listDir,
  findVaultRoot,
  parseWikiTarget,
  resolveWiki,
  clearCaches,
};
