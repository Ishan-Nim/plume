// Post-processing of the sanitised document fragment: heading anchors,
// Obsidian callouts, block references, table wrappers, code-copy buttons,
// wiki-link resolution and front-matter properties. Everything here works on
// DOM nodes built by DOMPurify — no HTML strings from the document are
// re-parsed.

import { el, slugify } from './util.js';
import { icon } from './icons.js';
import { CODE_MARK } from './markdown.js';

const CALLOUTS = {
  note: ['pencil', '68, 138, 255'],
  info: ['info', '68, 138, 255'],
  todo: ['checkCircle', '68, 138, 255'],
  abstract: ['clipboard', '0, 176, 255'],
  summary: ['clipboard', '0, 176, 255'],
  tldr: ['clipboard', '0, 176, 255'],
  tip: ['flame', '0, 191, 165'],
  hint: ['flame', '0, 191, 165'],
  important: ['flame', '0, 191, 165'],
  success: ['check', '0, 200, 83'],
  check: ['check', '0, 200, 83'],
  done: ['check', '0, 200, 83'],
  question: ['help', '255, 145, 0'],
  help: ['help', '255, 145, 0'],
  faq: ['help', '255, 145, 0'],
  warning: ['alert', '255, 145, 0'],
  caution: ['alert', '255, 145, 0'],
  attention: ['alert', '255, 145, 0'],
  failure: ['xCircle', '255, 82, 82'],
  fail: ['xCircle', '255, 82, 82'],
  missing: ['xCircle', '255, 82, 82'],
  danger: ['zap', '255, 82, 82'],
  error: ['zap', '255, 82, 82'],
  bug: ['bug', '255, 82, 82'],
  example: ['list', '124, 77, 255'],
  quote: ['quote', '158, 158, 158'],
  cite: ['quote', '158, 158, 158'],
};

// [!type|metadata]± — metadata (e.g. "wide") is used by Obsidian themes.
const CALLOUT_RE = /^\s*\[!([\w-]+)(?:\|([^\]]*))?\]([+-]?)[ \t]*/;
const BLOCK_REF_RE = /\s\^([A-Za-z0-9-]+)\s*$/;
const STANDALONE_BLOCK_REF_RE = /^\^([A-Za-z0-9-]+)$/;

// Rendered text that is not reading text: MathML duplicates of KaTeX output,
// code-block chrome, raw Mermaid source and fold arrows.
const PLAIN_SKIP = '.katex-mathml, .code-head, .mermaid-src, .callout-fold';

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function plainText(node, skip = PLAIN_SKIP) {
  if (!node.querySelector(skip)) return node.textContent;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.nodeType === Node.ELEMENT_NODE && n.matches(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) text += n.data;
  }
  return text;
}

// > [!type]± Optional title
// > body…
function transformCallouts(root) {
  for (const bq of root.querySelectorAll('blockquote')) {
    const first = bq.firstElementChild;
    if (!first || first.tagName !== 'P') continue;
    const lead = first.firstChild;
    if (!lead || lead.nodeType !== Node.TEXT_NODE) continue;
    const m = CALLOUT_RE.exec(lead.data);
    if (!m) continue;

    const type = m[1].toLowerCase();
    const metadata = (m[2] || '').trim();
    const fold = m[3];
    lead.data = lead.data.slice(m[0].length);

    // The title is everything up to the first line break in that paragraph.
    const titleNodes = [];
    let node = first.firstChild;
    while (node) {
      const next = node.nextSibling;
      if (node.nodeName === 'BR') {
        node.remove();
        break;
      }
      if (node.nodeType === Node.TEXT_NODE && node.data.includes('\n')) {
        const i = node.data.indexOf('\n');
        const rest = node.data.slice(i + 1);
        node.data = node.data.slice(0, i);
        titleNodes.push(node);
        if (rest) first.insertBefore(document.createTextNode(rest), next);
        break;
      }
      titleNodes.push(node);
      node = next;
    }

    const [iconName, rgb] = CALLOUTS[type] || CALLOUTS.note;
    const titleText = el('span', { class: 'callout-title-text' });
    titleNodes.forEach(n => titleText.append(n));
    if (!titleText.textContent.trim()) titleText.textContent = capitalise(type);
    if (!first.textContent.trim() && !first.querySelector('img')) first.remove();

    const content = el('div', { class: 'callout-content' });
    while (bq.firstChild) content.append(bq.firstChild);

    const foldable = fold === '+' || fold === '-';
    const callout = el(foldable ? 'details' : 'div', { class: 'callout', dataset: { callout: type } });
    // The quote's source range belongs to the callout that replaces it, or
    // the callout could not be edited in place.
    if (bq.dataset.plumeSrc) callout.dataset.plumeSrc = bq.dataset.plumeSrc;
    if (metadata) callout.dataset.calloutMetadata = metadata;
    callout.style.setProperty('--callout', rgb);
    if (foldable && fold === '+') callout.open = true;
    const title = el(foldable ? 'summary' : 'div', { class: 'callout-title' });
    title.innerHTML = `<span class="callout-icon">${icon(iconName, 18)}</span>`;
    title.append(titleText);
    if (foldable) title.insertAdjacentHTML('beforeend', `<span class="callout-fold">${icon('down', 16)}</span>`);
    callout.append(title);
    if (content.childNodes.length) callout.append(content);
    bq.replaceWith(callout);
  }
}

// "Some paragraph ^block-id" → anchor id "^block-id", marker hidden.
// A "^block-id" paragraph of its own (Obsidian's form for tables, lists and
// quotes) names the block before it and is removed.
function transformBlockRefs(root) {
  for (const block of root.querySelectorAll('p, li')) {
    let last = block.lastChild;
    while (last && last.nodeType === Node.ELEMENT_NODE && last.tagName === 'BR') last = last.previousSibling;
    if (!last || last.nodeType !== Node.TEXT_NODE) continue;
    const m = BLOCK_REF_RE.exec(last.data);
    if (!m) continue;
    last.data = last.data.slice(0, m.index);
    if (!block.id) block.id = `^${m[1]}`;
  }
  for (const p of root.querySelectorAll('p')) {
    const m = STANDALONE_BLOCK_REF_RE.exec(p.textContent.trim());
    const target = m && p.previousElementSibling;
    if (!target) continue;
    if (!target.id) target.id = `^${m[1]}`;
    p.remove();
  }
}

// Ids used by Plume's own UI. A heading that slugs to one of them gets a
// suffix, so getElementById and #links keep reaching the document.
let appIds = null;

function reservedIds() {
  if (!appIds) {
    appIds = new Set([...document.querySelectorAll('[id]')].filter(n => !n.closest('#doc *')).map(n => n.id));
  }
  return appIds;
}

export function assignHeadingIds(root, used = new Map()) {
  const outline = [];
  const reserved = reservedIds();
  for (const h of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const text = plainText(h, `${PLAIN_SKIP}, .footnote-ref`).trim();
    const base = slugify(text) || 'section';
    const n = used.get(base) || (reserved.has(base) ? 1 : 0);
    used.set(base, n + 1);
    h.id = n ? `${base}-${n}` : base;
    outline.push({ level: Number(h.tagName[1]), text, id: h.id });
  }
  return outline;
}

function wrapTables(root) {
  for (const table of root.querySelectorAll('table')) {
    if (!table.parentElement || !table.parentElement.classList.contains('table-wrap')) {
      const wrap = el('div', { class: 'table-wrap' });
      table.replaceWith(wrap);
      wrap.append(table);
      // The wrapper is now the document's own child, so it carries the
      // source range live preview edits the table by.
      if (table.dataset.plumeSrc) {
        wrap.dataset.plumeSrc = table.dataset.plumeSrc;
        delete table.dataset.plumeSrc;
      }
    }
    const head = table.tHead;
    if (head && [...head.querySelectorAll('th, td')].every(c => !c.textContent.trim())) {
      head.classList.add('is-empty');
    }
  }
}

function addCopyButtons(root) {
  for (const head of root.querySelectorAll(`.code-block[data-plume-code="${CODE_MARK}"] > .code-head`)) {
    if (head.querySelector('.code-copy')) continue;
    const btn = el('button', { class: 'code-copy', type: 'button', title: 'Copy code', 'aria-label': 'Copy code' });
    btn.innerHTML = `${icon('copy', 14)}<span>Copy</span>`;
    head.append(btn);
  }
}

// The single non-blank child of `node`, or null.
function soleChild(node) {
  let found = null;
  for (const n of node.childNodes) {
    if (n.nodeType === Node.TEXT_NODE && !n.data.trim()) continue;
    if (found || n.nodeType !== Node.ELEMENT_NODE) return null;
    found = n;
  }
  return found;
}

// An image alone in its paragraph (or in a link that is) is shown as a
// figure; images inside running text stay inline.
function markBlockImages(root) {
  for (const img of root.querySelectorAll('p > img, p > a > img')) {
    const box = img.parentElement.tagName === 'A' ? img.parentElement : img;
    if (soleChild(box.parentElement) === box && (box === img || soleChild(box) === img)) {
      img.classList.add('img-block');
    }
  }
}

function markLinks(root) {
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^(https?:|mailto:)/i.test(href)) a.classList.add('external');
  }
}

function resolveWikiNodes(root, wikiMap) {
  for (const a of root.querySelectorAll('a.wikilink[data-wiki]')) {
    const hit = wikiMap[a.dataset.wiki];
    if (!hit) a.classList.add('unresolved');
  }
  for (const img of root.querySelectorAll('img[data-wiki-embed]')) {
    const hit = wikiMap[img.dataset.wikiEmbed];
    if (hit && hit.url) {
      img.src = hit.url;
      img.loading = 'lazy';
    } else {
      img.replaceWith(el('span', { class: 'missing-embed', text: `Missing image: ${img.dataset.wikiEmbed}` }));
    }
  }
}

const unquote = s => s.replace(/^(['"])(.*)\1$/, '$2');

// The text of a `|` (literal) or `>` (folded) block scalar.
function blockScalar(style, lines) {
  const indent = Math.min(...lines.filter(l => l.trim()).map(l => /^\s*/.exec(l)[0].length));
  const body = lines.map(l => l.slice(indent).trimEnd()).join('\n').trim();
  if (style === '|') return body;
  return body.split(/\n{2,}/).map(p => p.replace(/\n/g, ' ')).join('\n');
}

// Minimal YAML front-matter reader for display purposes only.
export function parseFrontMatter(raw) {
  const rows = [];
  let cur = null;
  let block = null;
  const endBlock = () => {
    const text = blockScalar(block.style, block.lines);
    if (text) block.row.values.push(text);
    block = null;
  };
  for (const line of String(raw).split(/\r?\n/)) {
    if (block) {
      if (!line.trim() || /^\s/.test(line)) {
        block.lines.push(line);
        continue;
      }
      endBlock();
    }
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && cur) {
      cur.values.push(unquote(item[1].trim()));
      continue;
    }
    const kv = /^([^\s:#-][^:]*):(?:\s+(.*)|\s*)$/.exec(line);
    if (kv) {
      cur = { key: kv[1].trim(), values: [] };
      const v = (kv[2] || '').trim();
      if (/^[|>][+-]?\d*$/.test(v)) {
        block = { row: cur, style: v[0], lines: [] };
      } else if (/^\[.*\]$/.test(v)) {
        const items = v.slice(1, -1).match(/(?:"[^"]*"|'[^']*'|[^,])+/g) || [];
        cur.values.push(...items.map(s => unquote(s.trim())).filter(Boolean));
      } else if (v) {
        cur.values.push(unquote(v));
      }
      rows.push(cur);
      continue;
    }
    if (cur && /^\s+\S/.test(line)) cur.values.push(line.trim());
  }
  if (block) endBlock();
  return rows;
}

function frontMatterBox(raw) {
  const rows = parseFrontMatter(raw);
  if (!rows.length) return null;
  const table = el('div', { class: 'properties-grid' });
  for (const { key, values } of rows) {
    const value = el('div', { class: 'prop-value' });
    const isTags = /^(tags?|aliases|cssclasses)$/i.test(key);
    if (isTags || values.length > 1) {
      for (const v of values) value.append(el('span', { class: isTags && /^tags?$/i.test(key) ? 'tag' : 'chip', text: isTags && /^tags?$/i.test(key) ? `#${v.replace(/^#/, '')}` : v }));
    } else {
      value.textContent = values[0] || '—';
    }
    table.append(el('div', { class: 'prop-key', text: key }), value);
  }
  return el('details', { class: 'properties', open: true },
    el('summary', { class: 'properties-title', text: 'Properties' }), table);
}

export function enhance(root, { wikiMap = {}, frontMatter = null, usedIds } = {}) {
  transformCallouts(root);
  transformBlockRefs(root);
  wrapTables(root);
  addCopyButtons(root);
  markLinks(root);
  resolveWikiNodes(root, wikiMap);
  markBlockImages(root);
  const outline = assignHeadingIds(root, usedIds);
  if (frontMatter) {
    const box = frontMatterBox(frontMatter);
    if (box) root.prepend(box);
  }
  return { outline };
}

// Rewrite relative URLs in a transcluded note so they resolve against that
// note's folder rather than the host document's.
export function rebaseUrls(root, baseUrl) {
  for (const node of root.querySelectorAll('[src], [href]')) {
    for (const attr of ['src', 'href']) {
      const v = node.getAttribute(attr);
      if (!v || v.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(v)) continue;
      try {
        node.setAttribute(attr, new URL(v, baseUrl).href);
      } catch {
        /* leave as is */
      }
    }
  }
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

// Classify each source line. Front matter and fenced code are opaque
// (`code`), so a "# comment" inside them is not a heading; a heading stands
// alone; any other line records where its block (non-blank run) starts.
function scanLines(lines) {
  const info = [];
  let i = 0;
  if (/^---\s*$/.test(lines[0])) {
    let end = 1;
    while (end < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[end])) end++;
    if (end < lines.length) for (; i <= end; i++) info.push({ code: true, start: -1 });
  }
  let fence = null;
  let start = -1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      info.push({ code: true, start });
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        fence = null;
        start = -1;
      }
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1];
      start = i;
      info.push({ code: true, start });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading || !line.trim()) {
      info.push({ code: false, start: heading ? i : -1, heading });
      start = -1;
      continue;
    }
    if (start < 0) start = i;
    info.push({ code: false, start });
  }
  return info;
}

// [first, end) of the section under the first heading in [from, to) whose
// text or slug matches `want`.
function findSection(info, want, from, to) {
  const text = want.trim().toLowerCase();
  const slug = slugify(want);
  for (let i = from; i < to; i++) {
    const h = info[i].heading;
    const title = h ? (h[2] || '').trim() : '';
    if (!h || (title.toLowerCase() !== text && (!slug || slugify(title) !== slug))) continue;
    let end = i + 1;
    while (end < to && !(info[end].heading && info[end].heading[1].length <= h[1].length)) end++;
    return [i, end];
  }
  return null;
}

// Obsidian heading paths ("Top#Setup") narrow one level at a time; if the
// path does not resolve, its last heading is looked up on its own.
function headingSection(info, hash) {
  const whole = findSection(info, hash, 0, info.length);
  const path = hash.split('#').filter(s => s.trim());
  if (whole || path.length < 2) return whole;
  let hit = [-1, info.length];
  for (const segment of path) {
    hit = findSection(info, segment, hit[0] + 1, hit[1]);
    if (!hit) return findSection(info, path[path.length - 1], 0, info.length);
  }
  return hit;
}

// The block a ^id names: the paragraph or list item it ends, or — when the
// id stands on its own line — the whole block before it (table, list, quote).
function blockSection(lines, info, id) {
  const marker = `^${id}`;
  for (let i = 0; i < lines.length; i++) {
    if (info[i].code) continue;
    const t = lines[i].trim();
    if (t === marker) {
      let e = i - 1;
      while (e >= 0 && !lines[e].trim()) e--;
      return e >= 0 && info[e].start >= 0 ? [info[e].start, e + 1] : null;
    }
    if (t.endsWith(marker) && /\s/.test(t[t.length - marker.length - 1])) {
      let s = i;
      while (s > info[i].start && !LIST_ITEM_RE.test(lines[s])) s--;
      return [s, i + 1];
    }
  }
  return null;
}

// Pull one section (by heading text, heading path or ^block id) out of a
// Markdown source; the whole source if it is not found.
export function extractSection(src, hash) {
  if (!hash) return src;
  const lines = src.split(/\r?\n/);
  const info = scanLines(lines);
  const range = hash.startsWith('^') ? blockSection(lines, info, hash.slice(1)) : headingSection(info, hash);
  return range ? lines.slice(range[0], range[1]).join('\n') : src;
}
