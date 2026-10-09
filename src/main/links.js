'use strict';

// Rewriting the links that point at a note when that note is renamed or moved.
//
// This is the half of renaming that makes renaming worth having. Obsidian does
// it, and a vault where renaming a note quietly breaks every reference to it is
// a vault people stop renaming things in.
//
// Pure string work, no file system, so every case below is pinned by tests:
// a vault is somebody's writing and this edits all of it at once.

const path = require('node:path');

const MD_LINK_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn', '.mdtxt', '.mdtext']);

function stripMdExt(name) {
  const ext = path.extname(name);
  return MD_LINK_EXTS.has(ext.toLowerCase()) ? name.slice(0, -ext.length) : name;
}

function lower(s) {
  return String(s).toLowerCase();
}

/**
 * Splits `[[Note#Heading|Alias]]` the way Obsidian reads it, keeping the
 * pieces so they can be put back exactly as they were found — including
 * whether the pipe was escaped, which it is inside a table.
 */
function splitWiki(inner) {
  const pipe = /\\?\|/.exec(inner);
  let rest = inner;
  let alias = null;
  let escapedPipe = false;
  if (pipe) {
    rest = inner.slice(0, pipe.index);
    alias = inner.slice(pipe.index + pipe[0].length);
    escapedPipe = pipe[0].length === 2;
  }
  let hash = null;
  const h = rest.indexOf('#');
  if (h >= 0) {
    hash = rest.slice(h + 1);
    rest = rest.slice(0, h);
  }
  return { target: rest, hash, alias, escapedPipe };
}

function joinWiki({ target, hash, alias, escapedPipe }) {
  let out = target;
  if (hash !== null) out += `#${hash}`;
  if (alias !== null) out += `${escapedPipe ? '\\|' : '|'}${alias}`;
  return out;
}

// The vault-relative path a wiki target points at, as segments, ignoring the
// leading slash some people write and the Markdown extension others do.
function wikiSegments(target) {
  return target.replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean);
}

/**
 * True when a wiki target names this file.
 *
 * Obsidian resolves `[[Note]]` by file name wherever it lives, so a bare name
 * that matches is a hit; a target with folders in it only matches when those
 * folders are the end of the file's own path. That keeps `[[archive/Plan]]`
 * from being rewritten when `work/Plan.md` is the note being renamed.
 */
function wikiPointsAt(target, relPath) {
  const want = wikiSegments(target);
  if (!want.length) return false;
  const have = relPath.split('/');
  const last = want.length - 1;
  if (lower(stripMdExt(want[last])) !== lower(stripMdExt(have[have.length - 1]))) return false;
  for (let i = 1; i <= last; i++) {
    const mine = have[have.length - 1 - i];
    if (mine === undefined || lower(mine) !== lower(want[last - i])) return false;
  }
  return true;
}

// What a wiki target becomes: the same shape it had — bare name, or name with
// as many folders as the author wrote — pointing at the note's new home.
function wikiReplacement(target, newRel, { keepExtension }) {
  const want = wikiSegments(target);
  const have = newRel.split('/');
  const depth = Math.min(want.length, have.length);
  const kept = have.slice(have.length - depth);
  kept[kept.length - 1] = keepExtension ? kept[kept.length - 1] : stripMdExt(kept[kept.length - 1]);
  const prefix = target.startsWith('/') ? '/' : '';
  return prefix + kept.join('/');
}

function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// `](path)` targets: a Markdown link or image, which is a path relative to the
// document it is written in. When the caller says where that document lives,
// the path is resolved and has to be the renamed file exactly — otherwise all
// that can be told is that the file names match.
function mdPointsAt(href, fromRel, docDir) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return false;
  const clean = decode(href).replace(/\\/g, '/');
  if (!clean) return false;
  if (docDir !== null && docDir !== undefined) {
    const resolved = path.posix.normalize(path.posix.join(docDir, clean)).replace(/^\.\//, '');
    return lower(resolved) === lower(fromRel);
  }
  const want = clean.split('/').filter(seg => seg && seg !== '.');
  return want.length > 0 && lower(want[want.length - 1]) === lower(fromRel.split('/').pop());
}

/**
 * Rewrites every link in `text` that points at `fromRel` so that it points at
 * `toRel` instead. Both are vault-relative paths with forward slashes.
 *
 * `docRel` is where this text itself lives in the vault. It is worth giving:
 * an ordinary Markdown link is relative to the document holding it, so
 * without it a `](Plan.md)` in one folder cannot be told from one in another.
 *
 * Returns `{ text, count }`. `count` is links changed, not files.
 */
function rewriteLinks(text, fromRel, toRel, docRel = null) {
  if (typeof text !== 'string' || !fromRel || !toRel || fromRel === toRel) {
    return { text, count: 0 };
  }
  const docDir = docRel === null ? null : path.posix.dirname(docRel).replace(/^\.$/, '');
  let count = 0;

  // [[wiki]] and ![[embeds]]
  let out = text.replace(/(!?)\[\[([^[\]]+)\]\]/g, (whole, bang, inner) => {
    const parts = splitWiki(inner);
    if (!wikiPointsAt(parts.target, fromRel)) return whole;
    const keepExtension = MD_LINK_EXTS.has(path.extname(parts.target).toLowerCase());
    const target = wikiReplacement(parts.target, toRel, { keepExtension });
    if (target === parts.target) return whole;
    count++;
    return `${bang}[[${joinWiki({ ...parts, target })}]]`;
  });

  // [text](path) and ![alt](path), including <angled> targets and titles.
  out = out.replace(/\]\(\s*(<[^>]*>|[^()\s]+)((?:\s+"[^"]*")?\s*)\)/g, (whole, raw, tail) => {
    const angled = raw.startsWith('<') && raw.endsWith('>');
    const href = angled ? raw.slice(1, -1) : raw;
    const hash = href.indexOf('#');
    const base = hash >= 0 ? href.slice(0, hash) : href;
    const suffix = hash >= 0 ? href.slice(hash) : '';
    if (!mdPointsAt(base, fromRel, docDir)) return whole;
    // With a document to be relative to, the link is rebuilt from it the way
    // an editor would write it; without one, only the file name is replaced
    // and whatever route the author wrote to get there is left alone.
    const segs = docDir === null
      ? decode(base).replace(/\\/g, '/').split('/')
      : (path.posix.relative(docDir, toRel) || toRel).split('/');
    segs[segs.length - 1] = toRel.split('/').pop();
    // Inside <angle brackets> a space is allowed, so the path stays readable;
    // a bare target has to be encoded or the link ends at the first space.
    const next = angled
      ? segs.join('/')
      : segs.map(seg => encodeURIComponent(seg).replace(/%2F/gi, '/')).join('/');
    count++;
    const target = `${next}${suffix}`;
    return `](${angled || /[\s()]/.test(target) ? `<${target}>` : target}${tail})`;
  });

  return { text: out, count };
}

module.exports = {
  rewriteLinks,
  wikiPointsAt,
  splitWiki,
  stripMdExt,
};
