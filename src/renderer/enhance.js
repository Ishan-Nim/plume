// Post-processing of the sanitised document fragment: heading anchors,
// Obsidian callouts, block references, table wrappers, code-copy buttons,
// wiki-link resolution and front-matter properties. Everything here works on
// DOM nodes built by DOMPurify — no HTML strings from the document are
// re-parsed.

import { el, slugify } from './util.js';
import { icon } from './icons.js';

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

const CALLOUT_RE = /^\s*\[!([\w-]+)\]([+-]?)[ \t]*/;
const BLOCK_REF_RE = /\s\^([A-Za-z0-9-]+)\s*$/;

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
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
    const fold = m[2];
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
}

export function assignHeadingIds(root, used = new Map()) {
  const outline = [];
  for (const h of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const text = h.textContent.trim();
    const base = slugify(text) || 'section';
    const n = used.get(base) || 0;
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
    }
    const head = table.tHead;
    if (head && [...head.querySelectorAll('th, td')].every(c => !c.textContent.trim())) {
      head.classList.add('is-empty');
    }
  }
}

function addCopyButtons(root) {
  for (const head of root.querySelectorAll('.code-head')) {
    if (head.querySelector('.code-copy')) continue;
    const btn = el('button', { class: 'code-copy', type: 'button', title: 'Copy code', 'aria-label': 'Copy code' });
    btn.innerHTML = `${icon('copy', 14)}<span>Copy</span>`;
    head.append(btn);
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

// Minimal YAML front-matter reader for display purposes only.
export function parseFrontMatter(raw) {
  const rows = [];
  let cur = null;
  const unquote = s => s.replace(/^(['"])(.*)\1$/, '$2');
  for (const line of String(raw).split(/\r?\n/)) {
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
      if (/^\[.*\]$/.test(v)) {
        cur.values.push(...v.slice(1, -1).split(',').map(s => unquote(s.trim())).filter(Boolean));
      } else if (v && v !== '|' && v !== '>') {
        cur.values.push(unquote(v));
      }
      rows.push(cur);
      continue;
    }
    if (cur && /^\s+\S/.test(line)) cur.values.push(line.trim());
  }
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

// Pull one section (by heading text or ^block id) out of a Markdown source.
export function extractSection(src, hash) {
  if (!hash) return src;
  const lines = src.split(/\r?\n/);
  if (hash.startsWith('^')) {
    const id = hash.slice(1);
    const line = lines.find(l => new RegExp(`\\s\\^${id.replace(/[-]/g, '\\-')}\\s*$`).test(l));
    return line || src;
  }
  const want = hash.trim().toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    if (start < 0) {
      if (m[2].trim().toLowerCase() === want || slugify(m[2]) === slugify(want)) {
        start = i;
        level = m[1].length;
      }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join('\n');
    }
  }
  return start >= 0 ? lines.slice(start).join('\n') : src;
}
