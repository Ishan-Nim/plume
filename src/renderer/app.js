// Plume renderer: wires the UI, renders documents and handles navigation.

import DOMPurify from 'dompurify';
import { createMarkdown, splitWiki, wikiLabel, CODE_MARK } from './markdown.js';
import { enhance, rebaseUrls, extractSection, plainText } from './enhance.js';
import { Finder } from './find.js';
import { FileTree, Outline } from './sidebar.js';
import { Vault } from './vault.js';
import { Graph } from './graph.js';
import { Updates } from './updates.js';
import { Editor } from './editor.js';
import { icon, LOGO } from './icons.js';
import { el, debounce, basename, dirname, samePath, readingStats, slugify, relativeSegments } from './util.js';

const api = window.plume;
const $ = sel => document.querySelector(sel);
const root = document.documentElement;
const body = document.body;

// Resolved before any <base> is set, so vendor assets always load from the app.
const MERMAID_URL = new URL('vendor/mermaid.min.js', location.href).href;

const FONT_MIN = 12;
const FONT_MAX = 28;

// Above this many characters the document is laid out lazily (see .is-large).
const LARGE_DOC_CHARS = 250000;

// What a drop is allowed to open: Markdown, the text types of the Open
// dialog, and files with no extension (README, LICENSE). The main process
// refuses binary content behind any of these names.
const DROP_DOC_RE = /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext|rmd|qmd|txt|text|log)$/i;

function isDroppableDoc(p) {
  const name = basename(p);
  return DROP_DOC_RE.test(name) || !name.slice(1).includes('.');
}

const state = {
  settings: null,
  info: null,
  doc: null,
  back: [],
  forward: [],
  renderSeq: 0,
  wikiMap: {},
  outline: [],
  headingEls: new Map(),
  mdCache: new Map(),
  defaultStatus: null,
};

const ui = {
  viewer: $('#viewer'),
  article: $('#doc'),
  welcome: $('#welcome'),
  crumbDir: $('#crumb-dir'),
  crumbFile: $('#crumb-file'),
  title: $('#title'),
  back: $('#btn-back'),
  forward: $('#btn-forward'),
  banner: $('#banner'),
  toast: $('#toast'),
  status: $('#link-status'),
  lightbox: $('#lightbox'),
  readingPop: $('#pop-reading'),
  moreMenu: $('#menu-more'),
};

// ---------------------------------------------------------------------------
// Sanitising

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.nodeName === 'INPUT') {
    node.setAttribute('type', 'checkbox');
    node.setAttribute('disabled', '');
    node.removeAttribute('name');
  }
  if (node.nodeName === 'A') node.removeAttribute('target');
  // Plume sets data-from on transcluded links itself, after sanitising.
  node.removeAttribute('data-from');
  if (node.style && node.hasAttribute('style')) confineStyle(node.style);
});

// Inline styles must not escape the reading pane (fake title bars, overlays),
// stack above Plume's code blocks, or turn the page into a window drag
// region. The parsed declaration is checked, not the raw text, so comments,
// escapes and var() cannot sneak past.
const SAFE_POSITIONS = new Set(['', 'static', 'relative', 'absolute']);

function confineStyle(style) {
  if (!SAFE_POSITIONS.has(style.position)) style.removeProperty('position');
  style.removeProperty('z-index');
  style.removeProperty('-webkit-app-region');
  style.removeProperty('app-region');
}

// Attributes that open an element in the browser's top layer, above the
// whole window and outside #doc's containment, with no script at all.
const TOP_LAYER_ATTRS = ['popover', 'popovertarget', 'popovertargetaction', 'commandfor', 'command', 'interestfor'];

const PURIFY_CONFIG = {
  FORBID_TAGS: ['style', 'script', 'form', 'button', 'textarea', 'select', 'option', 'iframe', 'frame',
    'frameset', 'object', 'embed', 'link', 'meta', 'base', 'noscript', 'template', 'dialog', 'portal'],
  FORBID_ATTR: ['autofocus', 'formaction', 'action', ...TOP_LAYER_ATTRS],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  RETURN_DOM_FRAGMENT: true,
};

function sanitize(html) {
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

function getMarkdown() {
  const breaks = state.settings ? state.settings.lineBreaks : true;
  if (!state.mdCache.has(breaks)) state.mdCache.set(breaks, createMarkdown({ breaks }));
  return state.mdCache.get(breaks);
}

// ---------------------------------------------------------------------------
// Theme & settings

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function resolveTheme() {
  const pref = state.settings ? state.settings.theme : 'system';
  const dark = pref === 'dark' || (pref === 'system' && darkQuery.matches);
  const next = dark ? 'dark' : 'light';
  if (root.dataset.theme !== next) {
    root.dataset.theme = next;
    rerenderMermaid();
  }
}

darkQuery.addEventListener('change', resolveTheme);

function applySettings(s) {
  const prev = state.settings;
  state.settings = s;
  resolveTheme();
  root.style.setProperty('--content-size', `${s.fontSize}px`);
  root.style.setProperty('--sidebar-w', `${s.sidebarWidth}px`);
  root.dataset.width = s.width;
  root.dataset.font = s.font;
  body.classList.toggle('sidebar-hidden', !s.sidebar);
  showSidebarTab(s.sidebarTab);
  syncReadingControls();
  renderRecent();
  if (prev && prev.lineBreaks !== s.lineBreaks && state.doc) renderDoc({ keepScroll: true }).catch(console.error);
}

async function updateSettings(patch) {
  const next = await api.setSettings(patch);
  applySettings(next);
}

// ---------------------------------------------------------------------------
// Documents

function setBase(url) {
  let base = document.querySelector('base');
  if (!base) {
    base = document.createElement('base');
    document.head.prepend(base);
  }
  base.href = url;
}

// Where the reader is: scrollTop, plus the top-level block at the top of the
// pane and how far into it. Large documents lay out lazily (.is-large), so
// after a re-render the blocks above the viewport only have an estimated
// height and the same scrollTop shows other text; the block is still right.
function readingPosition() {
  const pos = { scroll: ui.viewer.scrollTop, anchor: null };
  const blocks = ui.article.children;
  if (!blocks.length || !ui.article.offsetParent) return pos;
  // A hidden block has an empty rect; it counts as ending where the visible
  // block before it ends, which keeps the search below in order.
  const bottomAt = i => {
    for (let j = i; j >= 0; j--) {
      const r = blocks[j].getBoundingClientRect();
      if (r.width || r.height) return r.bottom;
    }
    return -Infinity;
  };
  const top = ui.viewer.getBoundingClientRect().top;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bottomAt(mid) > top) hi = mid;
    else lo = mid + 1;
  }
  pos.anchor = {
    index: lo,
    offset: blocks[lo].getBoundingClientRect().top - top,
    large: ui.article.classList.contains('is-large'),
  };
  return pos;
}

function restorePosition(pos) {
  const large = ui.article.classList.contains('is-large');
  const anchor = pos.anchor;
  const block = anchor && (large || anchor.large) ? ui.article.children[anchor.index] : null;
  if (!block) {
    ui.viewer.scrollTop = pos.scroll;
    return;
  }
  // Lay the block out for real: with its placeholder height, a reader deep
  // inside a long table or list would land past it.
  if (large) block.style.contentVisibility = 'visible';
  ui.viewer.scrollTop += block.getBoundingClientRect().top - ui.viewer.getBoundingClientRect().top - anchor.offset;
}

async function openDoc(p, { push = true, hash = '', position = null } = {}) {
  // Navigating away mid-edit used to leave the editor open on one document
  // while the window moved to another, so the next save wrote the first
  // document's text over the second. Asked once, here, rather than at each
  // of the six places that open something.
  if (!mayLeaveDocument()) return false;
  const res = await api.loadDoc(p);
  if (res.error) {
    toast(`Couldn’t open ${basename(p)}: ${res.error}`, 'error');
    if (!state.doc) renderRecent();
    return false;
  }
  if (push && state.doc && !samePath(state.doc.path, res.path)) {
    pushHistory({ path: state.doc.path, ...readingPosition() });
  }
  state.doc = res;
  hideBanner();
  setBase(res.dirUrl);
  body.classList.remove('is-welcome');
  document.title = `${res.name} — Plume`;
  updateTitlebar();
  updateNavButtons();
  try {
    // Start at the top even when a hash is given: a missing target must not
    // leave the previous document's scroll offset behind.
    await renderDoc({ position: position || { scroll: 0, anchor: null } });
    if (hash) scrollToTarget(hash, { flash: true });
  } catch (err) {
    console.error(err);
  }
  fileTree.show(res.vaultRoot || res.dir, res.path).catch(() => {});
  ui.viewer.focus({ preventScroll: true });
  return true;
}

// `position` (from readingPosition) is where to put the reader; keepScroll
// keeps them where they are.
async function renderDoc({ position = null, keepScroll = false } = {}) {
  const doc = state.doc;
  if (!doc) return;
  const seq = ++state.renderSeq;

  let out;
  try {
    out = getMarkdown().render(doc.content);
  } catch (err) {
    console.error(err);
    out = { html: `<pre>${doc.content.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`, wiki: [], frontMatter: null };
  }

  let wikiMap = {};
  if (out.wiki.length) {
    try {
      wikiMap = await api.resolveWiki(doc.path, out.wiki);
    } catch {
      wikiMap = {};
    }
  }
  if (seq !== state.renderSeq || doc !== state.doc) return;

  const frag = sanitize(out.html);
  const usedIds = new Map();
  const { outline } = enhance(frag, { wikiMap, frontMatter: out.frontMatter, usedIds });
  useCachedMermaid(frag);
  const previous = keepScroll ? readingPosition() : null;
  ui.article.classList.toggle('is-large', doc.content.length > LARGE_DOC_CHARS);
  ui.article.replaceChildren(frag);
  state.wikiMap = wikiMap;
  state.outline = outline;
  state.headingEls = headingElements(ui.article);
  state.usedIds = usedIds;

  outlineView.set(outline, readingStats(plainText(ui.article)));
  if (previous || position) restorePosition(previous || position);
  trackActiveHeading();
  if (finder.isOpen) finder.search({ keepPosition: true });

  await Promise.all([renderTransclusions(ui.article, doc, seq, 0), renderMermaid(seq)]);
  if (seq !== state.renderSeq) return;
  // The first Mermaid pass collected its blocks before any transcluded note
  // arrived; this one picks up the diagrams inside them.
  await renderMermaid(seq);
  if (seq !== state.renderSeq) return;
  if (finder.isOpen && ui.article.querySelector('.wiki-transclude.loaded')) finder.search({ keepPosition: true });
  if (previous) restorePosition(previous);
}

// Map heading ids to the document's own heading elements, so an id shared
// with the app chrome (a heading called "Outline") never resolves to it.
function headingElements(container) {
  const map = new Map();
  for (const h of container.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (h.id && !map.has(h.id)) map.set(h.id, h);
  }
  return map;
}

let transclusionCounter = 0;

async function renderTransclusions(container, fromDoc, seq, depth) {
  const spans = [...container.querySelectorAll('.wiki-transclude[data-wiki-embed]:not([data-done])')];
  for (const span of spans) {
    span.dataset.done = '1';
    if (depth >= 2 || seq !== state.renderSeq) continue;
    // One broken embed must not stop the others, the file tree or boot.
    try {
      await renderTransclusion(span, fromDoc, seq, depth);
    } catch (err) {
      console.error(err);
    }
  }
}

async function renderTransclusion(span, fromDoc, seq, depth) {
  const target = span.dataset.wikiEmbed;
  let hit = depth === 0 ? state.wikiMap[target] : null;
  if (depth > 0) {
    try {
      hit = (await api.resolveWiki(fromDoc.path, [target]))[target];
    } catch {
      hit = null;
    }
  }
  if (!hit || !hit.isMarkdown || samePath(hit.path, state.doc.path) && !hit.hash) return;
  const note = await api.readNote(hit.path);
  if (note.error || seq !== state.renderSeq) return;
  // A docId per embed keeps its footnote ids apart from the host's.
  const out = getMarkdown().render(extractSection(note.content, hit.hash), { docId: `t${++transclusionCounter}` });
  const frag = sanitize(out.html);
  let innerMap = {};
  if (out.wiki.length) {
    try {
      innerMap = await api.resolveWiki(note.path, out.wiki);
    } catch {
      innerMap = {};
    }
  }
  if (seq !== state.renderSeq) return;
  enhance(frag, { wikiMap: innerMap, usedIds: state.usedIds });
  rebaseUrls(frag, note.dirUrl);
  useCachedMermaid(frag);
  const wikiTarget = splitWiki(target).target;
  const header = el('div', { class: 'transclusion-head' });
  header.innerHTML = icon('file', 14);
  header.append(el('a', { href: '#', class: 'wikilink', dataset: { wiki: wikiTarget, from: fromDoc.path } }, wikiLabel(wikiTarget)));
  const box = el('div', { class: 'transclusion' }, header, el('div', { class: 'transclusion-body' }, frag));
  span.replaceChildren(box);
  span.classList.add('loaded');
  for (const a of box.querySelectorAll('a.wikilink[data-wiki]')) {
    if (!a.dataset.from) a.dataset.from = note.path;
  }
  await renderTransclusions(box, note, seq, depth + 1);
}

// ---------------------------------------------------------------------------
// Mermaid (loaded on demand — it is large)

let mermaidLoader = null;
let mermaidApi = null;

function loadMermaid() {
  if (!mermaidLoader) {
    mermaidLoader = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = MERMAID_URL;
      s.onload = () => {
        mermaidApi = globalThis.mermaid;
        if (mermaidApi && typeof mermaidApi.render === 'function') resolve(mermaidApi);
        else reject(new Error('Mermaid failed to initialise'));
      };
      s.onerror = () => reject(new Error('Mermaid failed to load'));
      document.head.append(s);
    }).catch(err => {
      mermaidLoader = null;
      throw err;
    });
  }
  return mermaidLoader;
}

let mermaidCounter = 0;
let mermaidRun = 0;
// Set to 'light' while printing: paper is white in every theme.
let paperTheme = null;

// Rendered diagrams by theme, font and source. Live reload reuses them, so
// unchanged diagrams do not collapse and shift the reading position.
const MERMAID_CACHE_MAX = 100;
const mermaidCache = new Map();

function mermaidTheme() {
  return paperTheme || root.dataset.theme;
}

function mermaidConfig() {
  return `${mermaidTheme()}|${root.dataset.font}`;
}

function mermaidKey(block, config = mermaidConfig()) {
  const src = block.querySelector('.mermaid-src');
  return src ? `${config}\n${src.textContent}` : '';
}

function rememberMermaid(key, id, svg) {
  mermaidCache.delete(key);
  mermaidCache.set(key, { id, svg });
  if (mermaidCache.size > MERMAID_CACHE_MAX) mermaidCache.delete(mermaidCache.keys().next().value);
}

// Mermaid sanitises its own labels, but more loosely than Plume does the
// document: it keeps buttons, dialogs and popover attributes, which can lay
// an element over the whole window, and inline styles skip confineStyle.
function cleanMermaidSvg(holder) {
  for (const node of holder.querySelectorAll('button, dialog, input, select, textarea, form')) node.remove();
  for (const node of holder.querySelectorAll(TOP_LAYER_ATTRS.map(a => `[${a}]`).join(', '))) {
    for (const attr of TOP_LAYER_ATTRS) node.removeAttribute(attr);
  }
  for (const node of holder.querySelectorAll('[style]')) confineStyle(node.style);
}

function setMermaidSvg(block, svg) {
  block.querySelector('.mermaid-svg')?.remove();
  block.querySelector('.mermaid-msg')?.remove();
  const holder = el('div', { class: 'mermaid-svg' });
  holder.innerHTML = svg;
  cleanMermaidSvg(holder);
  block.append(holder);
  block.classList.remove('has-error');
  block.dataset.done = '1';
}

function useCachedMermaid(container) {
  for (const block of container.querySelectorAll('.mermaid-block:not([data-done])')) {
    const hit = mermaidCache.get(mermaidKey(block));
    if (!hit) continue;
    // Fresh ids, so the same diagram can appear twice on one page.
    const id = `plume-mermaid-${++mermaidCounter}`;
    setMermaidSvg(block, hit.svg.replace(new RegExp(`${hit.id}(?!\\d)`, 'g'), id));
  }
}

async function renderMermaid(seq) {
  useCachedMermaid(ui.article);
  const blocks = [...ui.article.querySelectorAll('.mermaid-block:not([data-done])')];
  if (!blocks.length) return;
  // A newer pass (theme change) takes over every block not yet rendered.
  const run = ++mermaidRun;
  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch (err) {
    for (const b of blocks) showMermaidError(b, err);
    return;
  }
  if (run !== mermaidRun) return;
  const config = mermaidConfig();
  const dark = mermaidTheme() === 'dark';
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    fontFamily: getComputedStyle(ui.article).fontFamily,
  });
  for (const block of blocks) {
    if (seq !== state.renderSeq || run !== mermaidRun) return;
    const src = block.querySelector('.mermaid-src');
    if (!src) continue;
    const key = mermaidKey(block, config);
    const id = `plume-mermaid-${++mermaidCounter}`;
    try {
      const { svg } = await mermaid.render(id, src.textContent);
      if (seq !== state.renderSeq || run !== mermaidRun) return;
      setMermaidSvg(block, svg);
      rememberMermaid(key, id, svg);
    } catch (err) {
      showMermaidError(block, err);
    } finally {
      // Mermaid leaves a temporary container behind on failure. The rendered
      // SVG carries the same id, so only remove nodes outside the document.
      for (const stray of [document.getElementById(`d${id}`), document.getElementById(id)]) {
        if (stray && !ui.article.contains(stray)) stray.remove();
      }
    }
  }
}

function showMermaidError(block, err) {
  block.classList.add('has-error');
  block.dataset.done = '1';
  block.querySelector('.mermaid-msg')?.remove();
  const msg = String((err && err.message) || err || 'Unknown error').split('\n')[0];
  block.prepend(el('div', { class: 'mermaid-msg', text: `Diagram could not be rendered — ${msg}` }));
}

function rerenderMermaid() {
  if (!state.doc || !mermaidApi) return Promise.resolve();
  // Includes blocks still waiting in a running pass, which then hands over.
  const blocks = ui.article.querySelectorAll('.mermaid-block');
  if (!blocks.length) return Promise.resolve();
  for (const b of blocks) delete b.dataset.done;
  // Stop a running pass even when the cache serves every block and no new
  // pass starts: switching back before it finishes must not leave it drawing
  // the other theme over the cached diagrams.
  mermaidRun++;
  return renderMermaid(state.renderSeq);
}

// Print and PDF: Mermaid bakes its theme into the SVG, so dark diagrams are
// redrawn in the light theme for the paper (from the cache after the first
// time) and switched back afterwards.
async function onPaper(action) {
  const swap = root.dataset.theme === 'dark' && !!ui.article.querySelector('.mermaid-block');
  if (swap) {
    paperTheme = 'light';
    await rerenderMermaid();
  }
  try {
    return await action();
  } finally {
    if (swap) {
      paperTheme = null;
      rerenderMermaid();
    }
  }
}

function printDoc() {
  if (state.doc) onPaper(() => api.print()).catch(console.error);
}

// ---------------------------------------------------------------------------
// Navigation

function updateNavButtons() {
  ui.back.disabled = !state.back.length;
  ui.forward.disabled = !state.forward.length;
}

function pushHistory(entry) {
  state.back.push(entry);
  if (state.back.length > 100) state.back.shift();
  state.forward = [];
}

// Jumps inside the open document are recorded too, so Back returns to the
// reading position as it does in a browser.
function jumpInPage(hash) {
  const position = readingPosition();
  if (!scrollToTarget(hash, { flash: true })) return;
  pushHistory({ path: state.doc.path, ...position });
  updateNavButtons();
}

async function goBack() {
  const prev = state.back.pop();
  if (!prev) return;
  const here = state.doc && { path: state.doc.path, ...readingPosition() };
  if (here) state.forward.push(here);
  if (here && samePath(prev.path, here.path)) {
    restorePosition(prev);
  } else {
    const ok = await openDoc(prev.path, { push: false, position: prev });
    if (!ok && here) state.forward.pop();
  }
  updateNavButtons();
}

async function goForward() {
  const next = state.forward.pop();
  if (!next) return;
  const here = state.doc && { path: state.doc.path, ...readingPosition() };
  if (here) state.back.push(here);
  if (here && samePath(next.path, here.path)) {
    restorePosition(next);
  } else {
    const ok = await openDoc(next.path, { push: false, position: next });
    if (!ok && here) state.back.pop();
  }
  updateNavButtons();
}

// The element with this id inside the document. A heading can share an id
// with the app chrome (say "Outline"), so the window-wide lookup alone is not enough.
function docElementById(id) {
  const node = document.getElementById(id);
  if (node && ui.article.contains(node)) return node;
  return ui.article.querySelector(`[id="${CSS.escape(id)}"]`);
}

function findTarget(hash) {
  return hash ? findDecodedTarget(decodeSafe(hash)) : null;
}

function findDecodedTarget(id) {
  const byId = docElementById(id);
  if (byId) return byId;
  if (id.startsWith('^')) return null;
  const named = ui.article.querySelector(`a[name="${CSS.escape(id)}"]`);
  if (named) return named;
  const slug = slugify(id);
  const bySlug = slug && docElementById(slug);
  if (bySlug) return bySlug;
  const want = id.trim().toLowerCase();
  const byText = [...ui.article.querySelectorAll('h1, h2, h3, h4, h5, h6')]
    .find(h => plainText(h).trim().toLowerCase() === want);
  if (byText) return byText;
  // Obsidian heading paths, [[Note#Heading#Subheading]], name the last heading.
  const segs = id.split('#').filter(Boolean);
  return segs.length > 1 ? findDecodedTarget(segs[segs.length - 1]) : null;
}

function scrollToTarget(hash, { flash = false } = {}) {
  const target = findTarget(hash);
  if (!target) {
    // '#' and '#top' mean the top of the page unless something has that id.
    const id = decodeSafe(hash || '');
    if (id === '' || id.toLowerCase() === 'top') {
      ui.viewer.scrollTop = 0;
      return true;
    }
    toast(`Section not found: ${hash}`);
    return false;
  }
  let node = target.parentElement;
  while (node && node !== ui.article) {
    if (node.tagName === 'DETAILS' && !node.open) node.open = true;
    node = node.parentElement;
  }
  target.scrollIntoView({ block: 'start' });
  if (flash) {
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  }
  return true;
}

async function followWiki(target, fromPath) {
  const from = fromPath || state.doc.path;
  let hit = !fromPath || samePath(fromPath, state.doc.path) ? state.wikiMap[target] : undefined;
  if (hit === undefined) {
    try {
      hit = (await api.resolveWiki(from, [target]))[target];
    } catch {
      hit = null;
    }
  }
  if (!hit) {
    toast(`No note named “${target.split('#')[0] || target}”`);
    return;
  }
  if (hit.isMarkdown) {
    if (samePath(hit.path, state.doc.path)) jumpInPage(hit.hash);
    else openDoc(hit.path, { hash: hit.hash });
  } else {
    api.openFile(hit.path);
  }
}

async function followLink(a, { newWindow = false } = {}) {
  if (a.classList.contains('wikilink')) {
    const target = a.dataset.wiki;
    if (newWindow) {
      const hit = (await api.resolveWiki(a.dataset.from || state.doc.path, [target]))[target];
      if (hit && hit.isMarkdown) api.openPaths([hit.path]);
      return;
    }
    followWiki(target, a.dataset.from);
    return;
  }
  const raw = a.getAttribute('href') || '';
  if (!raw) return;
  if (raw.startsWith('#')) {
    jumpInPage(raw.slice(1));
    return;
  }
  const url = a.href;
  if (/^(https?:|mailto:)/i.test(url)) {
    api.openExternal(url);
    return;
  }
  if (!/^file:/i.test(url)) {
    toast('This kind of link is not supported');
    return;
  }
  const r = await api.resolveLink(url);
  if (r.kind === 'md') {
    if (newWindow) api.openPaths([r.path]);
    else if (state.doc && samePath(r.path, state.doc.path)) {
      if (r.hash) jumpInPage(r.hash);
    } else openDoc(r.path, { hash: r.hash });
  } else if (r.kind === 'file' || r.kind === 'dir') {
    api.openFile(r.path);
  } else if (r.kind === 'missing') {
    toast(`Not found: ${basename(r.path)}`, 'error');
  } else if (r.kind === 'blocked') {
    toast('Plume does not open links to other computers', 'error');
  }
}

// ---------------------------------------------------------------------------
// Outline tracking

let headingTicking = false;

function trackActiveHeading() {
  if (headingTicking) return;
  headingTicking = true;
  requestAnimationFrame(() => {
    headingTicking = false;
    if (!state.outline.length) return outlineView.highlight(null);
    const top = ui.viewer.getBoundingClientRect().top + 90;
    let active = state.outline[0].id;
    for (const h of state.outline) {
      const node = state.headingEls.get(h.id);
      if (!node) continue;
      if (node.getBoundingClientRect().top <= top) active = h.id;
      else break;
    }
    outlineView.highlight(active);
  });
}

// ---------------------------------------------------------------------------
// Chrome: title bar, sidebar, welcome screen

function updateTitlebar() {
  const doc = state.doc;
  if (!doc) {
    ui.crumbDir.textContent = '';
    ui.crumbFile.textContent = 'Plume';
    ui.title.title = '';
    body.classList.add('no-doc');
    return;
  }
  body.classList.remove('no-doc');
  const base = doc.vaultRoot || dirname(doc.dir);
  const segs = relativeSegments(base, doc.dir);
  const label = doc.vaultRoot
    ? [doc.vaultName, ...(segs || [])].join(' / ')
    : basename(doc.dir);
  ui.crumbDir.textContent = label;
  ui.crumbFile.textContent = doc.name.replace(/\.(md|markdown)$/i, '');
  ui.title.title = doc.path;
}

function showSidebarTab(tab) {
  if (tab === 'vault') vault().show();
  else lastDocTab = tab;
  for (const btn of document.querySelectorAll('.sidebar-tab')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
    btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
  }
  for (const panel of document.querySelectorAll('.sidebar-panel')) {
    panel.hidden = panel.dataset.panel !== tab;
  }
}

function toggleSidebar(force) {
  const show = typeof force === 'boolean' ? force : !state.settings.sidebar;
  updateSettings({ sidebar: show });
}

function renderRecent() {
  const list = $('#recent-list');
  if (!list || !state.settings) return;
  const recent = state.settings.recent || [];
  list.replaceChildren();
  $('#recent').hidden = !recent.length;
  for (const p of recent) {
    const item = el('li', { class: 'recent-item' });
    const open = el('button', { class: 'recent-open', type: 'button', title: p });
    open.innerHTML = icon('file', 16);
    open.append(
      el('span', { class: 'recent-name', text: basename(p).replace(/\.(md|markdown)$/i, '') }),
      el('span', { class: 'recent-dir', text: dirname(p) }),
    );
    open.addEventListener('click', () => openDoc(p));
    const remove = el('button', { class: 'recent-remove icon-btn', type: 'button', title: 'Remove from list', 'aria-label': 'Remove from list' });
    remove.innerHTML = icon('close', 14);
    remove.addEventListener('click', async () => applySettings(await api.removeRecent(p)));
    item.append(open, remove);
    list.append(item);
  }
}

async function showWelcome() {
  state.doc = null;
  body.classList.add('is-welcome');
  document.title = 'Plume';
  updateTitlebar();
  renderRecent();
  fileTree.clear();
  outlineView.clear();
  try {
    state.defaultStatus = await api.defaultStatus();
  } catch {
    state.defaultStatus = null;
  }
  $('#default-banner').hidden = !(state.defaultStatus && state.defaultStatus.supported && !state.defaultStatus.isDefault);
}

// ---------------------------------------------------------------------------
// Popovers & menus

let openPopover = null;

function closePopover() {
  if (!openPopover) return;
  openPopover.pop.hidden = true;
  openPopover.button.classList.remove('pressed');
  openPopover.button.setAttribute('aria-expanded', 'false');
  openPopover = null;
}

function togglePopover(button, pop) {
  if (openPopover && openPopover.pop === pop) return closePopover();
  closePopover();
  if (pop === ui.moreMenu) buildMoreMenu();
  pop.hidden = false;
  const r = button.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  button.classList.add('pressed');
  button.setAttribute('aria-expanded', 'true');
  openPopover = { button, pop };
  const first = pop.querySelector('button:not([disabled])');
  if (first && pop === ui.moreMenu) first.focus({ preventScroll: true });
}

document.addEventListener('pointerdown', e => {
  if (!openPopover) return;
  if (openPopover.pop.contains(e.target) || openPopover.button.contains(e.target)) return;
  closePopover();
});

function syncReadingControls() {
  const s = state.settings;
  if (!s) return;
  for (const btn of ui.readingPop.querySelectorAll('[data-set]')) {
    const [key, value] = btn.dataset.set.split(':');
    btn.classList.toggle('active', String(s[key]) === value);
    btn.setAttribute('aria-pressed', String(String(s[key]) === value));
  }
  $('#font-size-value').textContent = `${s.fontSize}px`;
  const lb = $('#toggle-linebreaks');
  lb.setAttribute('aria-checked', String(s.lineBreaks));
  lb.classList.toggle('on', s.lineBreaks);
}

function setFontSize(size) {
  const next = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(size)));
  if (next !== state.settings.fontSize) updateSettings({ fontSize: next });
}

function isMac() {
  return !!state.info && state.info.platform === 'darwin';
}

// 'Ctrl+O' → '⌘O' on macOS, where the key handler also accepts Cmd.
function shortcutLabel(text) {
  return isMac() ? text.replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥') : text;
}

// index.html is written for Windows; adjust its hints elsewhere.
function localiseChrome() {
  if (!state.info || state.info.platform === 'win32') return;
  const auto = document.querySelector('[data-set="theme:system"]');
  if (auto) auto.title = isMac() ? 'Follow macOS' : 'Follow the system theme';
  if (!isMac()) return;
  for (const node of document.querySelectorAll('[title*="Ctrl+"], [title*="Alt+"]')) {
    node.title = shortcutLabel(node.title);
  }
  for (const kbd of document.querySelectorAll('#welcome kbd')) kbd.textContent = kbd.textContent.replace(/^Ctrl\s+/, '⌘');
}

function menuItem(label, iconName, action, { shortcut = '', disabled = false } = {}) {
  const btn = el('button', { class: 'menu-item', type: 'button', role: 'menuitem', disabled });
  btn.innerHTML = icon(iconName, 16);
  btn.append(el('span', { class: 'menu-label', text: label }));
  if (shortcut) btn.append(el('kbd', { text: shortcutLabel(shortcut) }));
  btn.addEventListener('click', () => {
    closePopover();
    action();
  });
  return btn;
}

function buildMoreMenu() {
  const hasDoc = !!state.doc;
  const sep = () => el('div', { class: 'menu-sep', role: 'separator' });
  const items = [
    menuItem('Open file…', 'folderOpen', openDialog, { shortcut: 'Ctrl+O' }),
    menuItem('New window', 'window', () => api.newWindow(), { shortcut: 'Ctrl+N' }),
    menuItem('Reload', 'refresh', reloadDoc, { shortcut: 'F5', disabled: !hasDoc }),
    sep(),
    menuItem('Open in editor', 'pencil', openInEditor, { shortcut: 'Ctrl+E', disabled: !hasDoc }),
  ];
  if (hasDoc && state.doc.vaultRoot) {
    items.push(menuItem('Open in Obsidian', 'gem', () => api.openInObsidian(state.doc.path)));
  }
  const win = !!state.info && state.info.platform === 'win32';
  if (win) {
    items.push(menuItem('Open with…', 'openWith', () => api.openWith(state.doc.path), { disabled: !hasDoc }));
  }
  items.push(
    menuItem(isMac() ? 'Show in Finder' : 'Show in folder', 'folder', () => api.showInFolder(state.doc.path), { disabled: !hasDoc }),
    menuItem('Copy file path', 'link', copyPath, { disabled: !hasDoc }),
    sep(),
    menuItem('Print…', 'printer', printDoc, { shortcut: 'Ctrl+P', disabled: !hasDoc }),
    menuItem('Export as PDF…', 'fileDown', exportPdf, { disabled: !hasDoc }),
    sep(),
    menuItem('Full screen', 'maximize', () => api.toggleFullscreen(), { shortcut: 'F11' }),
  );
  if (win && state.info.packaged) {
    items.push(menuItem('Make Plume the default for .md', 'star', () => api.openDefaultApps()));
  }
  items.push(
    sep(),
    menuItem('Plume Vault…', 'cloud', openVault),
    menuItem('About Plume', 'info', () => api.about()),
  );
  ui.moreMenu.replaceChildren(...items);
}

// ---------------------------------------------------------------------------
// Editing

let editor = null;

function markDirty(editing, dirty) {
  $('#btn-edit').setAttribute('aria-pressed', String(editing));
  $('#btn-edit').title = editing ? 'Stop editing (Esc)' : 'Edit (Ctrl+E)';
  $('#btn-save').hidden = !editing;
  $('#btn-save').disabled = !dirty;
  ui.crumbFile.classList.toggle('is-dirty', dirty);
}

function toggleEdit() {
  if (!state.doc) return;
  if (!editor) {
    editor = new Editor({
      host: ui.viewer,
      api,
      toast,
      onModeChange: markDirty,
      onSaved: content => {
        // Keep the rendered copy in step, so leaving edit mode shows what was
        // just written rather than what was there before.
        state.doc = { ...state.doc, content };
      },
    });
  }
  if (editor.editing) {
    if (!editor.stop()) return;
    renderDoc({ keepScroll: true }).catch(console.error);
    return;
  }
  editor.start(state.doc);
}

function saveDoc() {
  if (editor && editor.editing) editor.save();
}

/** True when leaving now would lose work, after asking. */
function mayLeaveDocument() {
  if (!editor || !editor.hasUnsaved) return true;
  return editor.stop();
}

// ---------------------------------------------------------------------------
// Plume Vault

let vaultPanel = null;
let graphView = null;

function currentDoc() {
  if (!state.doc) return null;
  // The name offered for the vault keeps the folders between the tree root and
  // the document. Offering the bare file name made every README.md in a
  // notebook collide, so syncing one replaced another.
  const root = fileTree.root || state.doc.vaultRoot;
  const parts = root ? relativeSegments(root, state.doc.path) : null;
  const name = parts && parts.length ? parts.join('/') : basename(state.doc.path);
  return { path: state.doc.path, name };
}

function vault() {
  if (!vaultPanel) {
    vaultPanel = new Vault($('#vault-panel'), api, toast, currentDoc, showGraph,
      () => fileTree.root || (state.doc && state.doc.vaultRoot) || null);
  }
  return vaultPanel;
}

// The menu item does not open a dialog: it shows the sidebar on the Vault tab,
// where signing in lives permanently.
let lastDocTab = 'files';
let lastVaultState = null;
let lastSyncState = null;

function openVault() {
  updateSettings({ sidebar: true, sidebarTab: 'vault' });
}

function toggleVault() {
  const showing = state.settings && state.settings.sidebarTab === 'vault';
  updateSettings({ sidebar: true, sidebarTab: showing ? lastDocTab : 'vault' });
}

/** Keeps the bar at the foot of the sidebar saying something true. */
function paintVaultBar(sync, account) {
  const title = $('#vault-bar-title');
  const status = $('#vault-bar-status');
  if (!title || !status) return;

  $('#vault-bar').setAttribute('aria-expanded',
    String(Boolean(state.settings && state.settings.sidebarTab === 'vault')));

  if (!account || !account.signedIn) {
    title.textContent = 'Plume Vault';
    status.textContent = 'Sign in to sync';
    return;
  }

  title.textContent = account.email || 'Plume Vault';

  if (!sync || !sync.folder) {
    status.textContent = 'No folder synced';
    return;
  }
  switch (sync.status) {
    case 'scanning':
      status.textContent = 'Checking the folder…';
      break;
    case 'syncing':
      status.textContent = sync.total ? `Syncing ${Math.min(sync.done + 1, sync.total)} of ${sync.total}…` : 'Syncing…';
      break;
    case 'paused':
      status.textContent = 'Sync paused';
      break;
    case 'error':
      status.textContent = sync.lastError || 'Sync problem';
      break;
    default:
      status.textContent = 'Folder up to date';
  }
}

// ---------------------------------------------------------------------------
// The vault graph, shown as a view over the document rather than in a dialog.

function closeGraph() {
  $('#graph-view').hidden = true;
  if (graphView) graphView.destroy();
}

async function showGraph() {
  const view = $('#graph-view');
  const empty = $('#graph-view-empty');
  const canvas = $('#graph-view-canvas');

  view.hidden = false;
  empty.hidden = false;
  empty.textContent = 'Reading your vault…';
  $('#graph-view-meta').textContent = '';

  const res = await api.vault.graph();
  if (!res.ok) {
    empty.textContent = res.error;
    return;
  }
  if (!res.nodes.length) {
    empty.textContent = 'Sync some documents and the links between them appear here.';
    return;
  }
  empty.hidden = true;

  const linked = res.nodes.filter(n => n.links).length;
  $('#graph-view-meta').textContent =
    `${res.nodes.length} ${res.nodes.length === 1 ? 'document' : 'documents'} · ` +
    `${res.edges.length} ${res.edges.length === 1 ? 'link' : 'links'} · ` +
    `${res.nodes.length - linked} unlinked`;

  const tip = $('#graph-view-tip');
  if (!graphView) {
    graphView = new Graph(canvas, {
      onHover: node => {
        if (!node) {
          tip.classList.remove('show');
          return;
        }
        tip.replaceChildren(
          el('b', { text: node.path }),
          el('span', { text: `${node.links} ${node.links === 1 ? 'link' : 'links'}` }),
        );
        tip.classList.add('show');
      },
      onOpen: node => api.vault.pull(node.path),
    });
    window.addEventListener('resize', () => {
      if (graphView && !$('#graph-view').hidden) graphView.resize();
    });
  }

  graphView.setData(res.nodes, res.edges);
  graphView.resize();
  setTimeout(() => {
    if (graphView && !view.hidden) graphView.fit();
  }, 900);
}

// ---------------------------------------------------------------------------
// Actions

// Any further files picked in the dialog open in their own windows (main).
async function openDialog() {
  const [first] = await api.openDialog();
  if (first) await openDoc(first);
}

async function reloadDoc() {
  if (!state.doc) return;
  const position = readingPosition();
  const res = await api.loadDoc(state.doc.path);
  if (res.error) {
    toast(res.error, 'error');
    return;
  }
  state.doc = res;
  hideBanner();
  await renderDoc({ position });
}

async function openInEditor() {
  if (!state.doc) return;
  const name = await api.openInEditor(state.doc.path);
  if (name) toast(`Opening in ${name}…`);
}

async function copyPath() {
  if (!state.doc) return;
  await api.copyText(state.doc.path);
  toast('File path copied');
}

async function exportPdf() {
  if (!state.doc) return;
  let out;
  try {
    out = await onPaper(() => api.exportPdf());
  } catch (err) {
    console.error(err);
    return toast('Couldn’t export the PDF', 'error');
  }
  if (typeof out === 'string') toast(`Saved ${basename(out)}`);
  else if (out && out.error) toast(`Couldn’t export the PDF: ${out.error}`, 'error');
}

// ---------------------------------------------------------------------------
// Feedback

let toastTimer = null;

function toast(message, kind = 'info') {
  ui.toast.textContent = message;
  ui.toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.className = 'toast'; }, kind === 'error' ? 4000 : 2200);
}

// Raw HTML can lay a decoy over a genuine code block, so the toast says what
// was really copied: the first line, and how many more follow.
function copiedSummary(text) {
  const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!lines.length) return 'Copied';
  const first = lines[0].length > 100 ? `${lines[0].slice(0, 99)}…` : lines[0];
  const more = lines.length - 1;
  return `Copied: ${first}${more ? ` (+${more} more line${more > 1 ? 's' : ''})` : ''}`;
}

function showBanner(message) {
  ui.banner.querySelector('.banner-text').textContent = message;
  ui.banner.hidden = false;
}

function hideBanner() {
  ui.banner.hidden = true;
}

function openLightbox(img) {
  const big = ui.lightbox.querySelector('img');
  big.src = img.currentSrc || img.src;
  big.alt = img.alt || '';
  ui.lightbox.querySelector('.lightbox-caption').textContent = img.alt || '';
  ui.lightbox.hidden = false;
}

function closeLightbox() {
  ui.lightbox.hidden = true;
  ui.lightbox.querySelector('img').removeAttribute('src');
}

// ---------------------------------------------------------------------------
// Wiring

const finder = new Finder({
  bar: $('#findbar'),
  input: $('#find-input'),
  count: $('#find-count'),
  root: ui.article,
  scroller: ui.viewer,
});

const fileTree = new FileTree({
  container: $('#tree'),
  title: $('#tree-title'),
  upButton: $('#btn-tree-up'),
  listDir: dir => api.listDir(dir),
  onOpen: p => {
    if (!state.doc || !samePath(p, state.doc.path)) openDoc(p);
  },
  onOpenNew: p => api.openPaths([p]),
});

const outlineView = new Outline({
  container: $('#outline'),
  footer: $('#outline-footer'),
  onJump: id => scrollToTarget(id),
});

function injectIcons() {
  for (const node of document.querySelectorAll('[data-icon]')) {
    node.insertAdjacentHTML('afterbegin', icon(node.dataset.icon, Number(node.dataset.size) || 16));
  }
  for (const node of document.querySelectorAll('[data-logo]')) node.innerHTML = LOGO;
}

function wireUi() {
  $('#btn-sidebar').addEventListener('click', () => toggleSidebar());
  ui.back.addEventListener('click', goBack);
  ui.forward.addEventListener('click', goForward);
  $('#btn-find').addEventListener('click', () => (finder.isOpen ? finder.close() : finder.open()));
  $('#btn-reading').addEventListener('click', e => togglePopover(e.currentTarget, ui.readingPop));
  $('#btn-more').addEventListener('click', e => togglePopover(e.currentTarget, ui.moreMenu));
  $('#btn-welcome-open').addEventListener('click', openDialog);
  $('#btn-default').addEventListener('click', () => api.openDefaultApps());
  $('#btn-tree-refresh').addEventListener('click', () => fileTree.refresh());
  $('#banner-close').addEventListener('click', hideBanner);

  new Updates(api, toast);

  $('#btn-edit').addEventListener('click', toggleEdit);
  $('#btn-save').addEventListener('click', saveDoc);

  $('#vault-bar').addEventListener('click', toggleVault);
  api.onSyncChanged(sync => {
    lastSyncState = sync;
    paintVaultBar(sync, lastVaultState);
  });
  api.onVaultChanged(account => {
    lastVaultState = account;
    paintVaultBar(lastSyncState, account);
  });

  $('#graph-view-close').addEventListener('click', closeGraph);
  $('#graph-view-fit').addEventListener('click', () => graphView && graphView.fit());
  $('#graph-view-shake').addEventListener('click', () => graphView && graphView.nudge());

  for (const tab of document.querySelectorAll('.sidebar-tab')) {
    tab.addEventListener('click', () => updateSettings({ sidebarTab: tab.dataset.tab }));
  }

  // Reading popover controls.
  ui.readingPop.addEventListener('click', e => {
    const btn = e.target.closest('[data-set]');
    if (btn) {
      const [key, value] = btn.dataset.set.split(':');
      updateSettings({ [key]: value });
    }
  });
  $('#font-smaller').addEventListener('click', () => setFontSize(state.settings.fontSize - 1));
  $('#font-larger').addEventListener('click', () => setFontSize(state.settings.fontSize + 1));
  $('#font-size-value').addEventListener('click', () => setFontSize(16));
  $('#toggle-linebreaks').addEventListener('click', () => updateSettings({ lineBreaks: !state.settings.lineBreaks }));

  // Find bar.
  const input = $('#find-input');
  input.addEventListener('input', debounce(() => finder.search(), 120));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finder.step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finder.close();
      ui.viewer.focus({ preventScroll: true });
    }
  });
  $('#find-prev').addEventListener('click', () => finder.step(-1));
  $('#find-next').addEventListener('click', () => finder.step(1));
  $('#find-close').addEventListener('click', () => finder.close());

  // Document interactions.
  ui.article.addEventListener('click', async e => {
    // Only Plume's own button on a block Plume rendered (DOMPurify forbids
    // <button>, and the mark is secret), never a look-alike built in raw HTML.
    const copy = e.target.closest('.code-copy');
    if (copy && copy.tagName === 'BUTTON' && copy.closest('.code-block')?.dataset.plumeCode === CODE_MARK) {
      const code = copy.closest('.code-block').querySelector('pre code');
      const text = code ? code.textContent : '';
      await api.copyText(text);
      toast(copiedSummary(text));
      copy.classList.add('copied');
      copy.querySelector('span').textContent = 'Copied';
      setTimeout(() => {
        copy.classList.remove('copied');
        copy.querySelector('span').textContent = 'Copy';
      }, 1400);
      return;
    }
    const a = e.target.closest('a');
    if (a) {
      e.preventDefault();
      followLink(a, { newWindow: e.ctrlKey || e.metaKey || e.shiftKey });
      return;
    }
    const img = e.target.closest('img');
    if (img && !img.closest('.mermaid-svg')) openLightbox(img);
  });
  ui.article.addEventListener('auxclick', e => {
    if (e.button !== 1) return;
    const a = e.target.closest('a');
    if (a) {
      e.preventDefault();
      followLink(a, { newWindow: true });
    }
  });
  ui.article.addEventListener('mouseover', e => {
    const a = e.target.closest('a');
    if (!a) return;
    const text = a.classList.contains('wikilink') ? a.dataset.wiki : (a.getAttribute('href') || '');
    if (!text || text === '#') return;
    ui.status.textContent = text.startsWith('#') ? text : decodeSafe(text);
    ui.status.classList.add('show');
  });
  ui.article.addEventListener('mouseout', e => {
    if (e.target.closest('a')) ui.status.classList.remove('show');
  });
  // Broken images: replace with a readable placeholder.
  ui.article.addEventListener('error', e => {
    const img = e.target;
    if (img.tagName !== 'IMG' || img.dataset.broken) return;
    img.dataset.broken = '1';
    const label = img.getAttribute('alt') || img.getAttribute('src') || 'image';
    const ph = el('span', { class: 'missing-embed', title: decodeSafe(img.getAttribute('src') || '') });
    ph.innerHTML = icon('image', 15);
    ph.append(el('span', { text: `Image not found: ${label}` }));
    img.replaceWith(ph);
  }, true);

  ui.viewer.addEventListener('scroll', trackActiveHeading, { passive: true });
  ui.viewer.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setFontSize(state.settings.fontSize + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  ui.lightbox.addEventListener('click', closeLightbox);

  // Sidebar resizer.
  const resizer = $('#sidebar-resizer');
  resizer.addEventListener('pointerdown', e => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    body.classList.add('resizing');
    const move = ev => {
      const w = Math.max(180, Math.min(520, Math.round(ev.clientX)));
      root.style.setProperty('--sidebar-w', `${w}px`);
    };
    const up = ev => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      body.classList.remove('resizing');
      const w = Math.max(180, Math.min(520, Math.round(ev.clientX)));
      updateSettings({ sidebarWidth: w });
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
  });
  resizer.addEventListener('dblclick', () => updateSettings({ sidebarWidth: 260 }));
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function wireKeys() {
  window.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;

    if (key === 'Escape') {
      if (!ui.lightbox.hidden) return closeLightbox();
      if (openPopover) return closePopover();
      if (finder.isOpen) {
        finder.close();
        return ui.viewer.focus({ preventScroll: true });
      }
      return;
    }
    if (ctrl && e.shiftKey && lower === 'i') return api.toggleDevTools();
    if (ctrl && !e.altKey && (key === '+' || key === '=')) {
      e.preventDefault();
      return setFontSize(state.settings.fontSize + 1);
    }
    if (ctrl && !e.shiftKey && !e.altKey) {
      // On macOS the File menu owns these, so one press never acts twice.
      if (isMac() && e.metaKey && (lower === 'o' || lower === 'n' || lower === 'w')) return;
      const handled = {
        o: openDialog,
        n: () => api.newWindow(),
        w: () => api.closeWindow(),
        f: () => finder.open(),
        g: () => (finder.isOpen ? finder.step(1) : finder.open()),
        r: reloadDoc,
        e: () => (e.shiftKey ? openInEditor() : toggleEdit()),
        s: saveDoc,
        p: printDoc,
        '\\': () => toggleSidebar(),
        '=': () => setFontSize(state.settings.fontSize + 1),
        '+': () => setFontSize(state.settings.fontSize + 1),
        '-': () => setFontSize(state.settings.fontSize - 1),
        0: () => setFontSize(16),
      }[lower];
      if (handled) {
        e.preventDefault();
        handled();
      }
      return;
    }
    if (ctrl && e.shiftKey && lower === 'g') {
      e.preventDefault();
      return finder.isOpen ? finder.step(-1) : finder.open();
    }
    if (key === 'F3') {
      e.preventDefault();
      return finder.isOpen ? finder.step(e.shiftKey ? -1 : 1) : finder.open();
    }
    if (key === 'F5') {
      e.preventDefault();
      return reloadDoc();
    }
    if (key === 'F11') {
      e.preventDefault();
      return api.toggleFullscreen();
    }
    if (e.altKey && key === 'ArrowLeft') {
      e.preventDefault();
      return goBack();
    }
    if (e.altKey && key === 'ArrowRight') {
      e.preventDefault();
      return goForward();
    }
    if (key === 'BrowserBack') return goBack();
    if (key === 'BrowserForward') return goForward();
  });

  // Mouse side buttons.
  window.addEventListener('mouseup', e => {
    if (e.button === 3) {
      e.preventDefault();
      goBack();
    } else if (e.button === 4) {
      e.preventDefault();
      goForward();
    }
  });
}

function wireDragDrop() {
  let depth = 0;
  window.addEventListener('dragenter', e => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    depth++;
    body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) body.classList.remove('dragging');
  });
  window.addEventListener('dragover', e => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', async e => {
    e.preventDefault();
    depth = 0;
    body.classList.remove('dragging');
    const paths = [...(e.dataTransfer ? e.dataTransfer.files : [])].map(f => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const docs = paths.filter(isDroppableDoc);
    if (!docs.length) {
      toast('Plume opens Markdown files');
      return;
    }
    const [first, ...rest] = docs;
    await openDoc(first);
    if (rest.length) api.openPaths(rest);
  });
}

const refreshTree = debounce(() => fileTree.refresh(), 400);

function wireIpc() {
  api.onSettings(s => applySettings(s));
  api.onOpenPath(p => openDoc(p));
  api.onCommand(cmd => {
    if (cmd === 'back') goBack();
    else if (cmd === 'forward') goForward();
    else if (cmd === 'open') openDialog();
  });
  api.onDocChanged(({ path, content }) => {
    if (!state.doc || !samePath(path, state.doc.path)) return;

    if (editor && editor.editing) {
      const outcome = editor.externalChange(content);
      if (outcome === 'handled') {
        state.doc = { ...state.doc, content };
        return;
      }
      if (outcome === 'conflict') {
        // Someone else wrote to this file while it was being edited here.
        // Nothing is overwritten without being asked.
        const takeTheirs = window.confirm(
          ['This document changed on disk while you were editing it.', '',
            'OK to load the version from disk and lose your changes,',
            'or Cancel to keep editing yours.'].join('\n'),
        );
        if (takeTheirs) {
          editor.takeExternal();
          state.doc = { ...state.doc, content };
        } else {
          editor.keepMine();
        }
        return;
      }
    }

    state.doc = { ...state.doc, content };
    hideBanner();
    renderDoc({ keepScroll: true }).catch(console.error);
    body.classList.remove('just-updated');
    void body.offsetWidth;
    body.classList.add('just-updated');
  });
  api.onDocMissing(({ path }) => {
    if (state.doc && samePath(path, state.doc.path)) {
      showBanner('This file was moved or deleted. You are viewing the last saved version.');
    }
  });
  api.onDirChanged(dir => {
    if (fileTree.root && (relativeSegments(fileTree.root, dir) || samePath(fileTree.root, dir))) refreshTree();
  });
}

async function boot() {
  injectIcons();
  wireUi();
  wireKeys();
  wireDragDrop();
  wireIpc();
  const info = await api.init();
  state.info = info;
  body.classList.toggle('platform-win', info.platform === 'win32');
  body.classList.toggle('platform-mac', info.platform === 'darwin');
  body.classList.toggle('platform-linux', info.platform !== 'win32' && info.platform !== 'darwin');
  localiseChrome();
  applySettings(info.settings);
  if (info.initialPath) {
    const ok = await openDoc(info.initialPath, { push: false });
    if (!ok) await showWelcome();
  } else {
    await showWelcome();
  }
  body.classList.remove('booting');
  body.dataset.ready = '1';
}

boot().catch(err => {
  console.error(err);
  body.classList.remove('booting');
});
