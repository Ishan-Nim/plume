// Sidebar: a lazy folder tree of Markdown files around the open document,
// and an outline of its headings.

import { el, pathKey, samePath, relativeSegments, dirname } from './util.js';
import { icon } from './icons.js';

export class FileTree {
  constructor({ container, title, upButton, listDir, onOpen, onOpenNew }) {
    this.container = container;
    this.title = title;
    this.upButton = upButton;
    this.listDir = listDir;
    this.onOpen = onOpen;
    this.onOpenNew = onOpenNew;
    this.root = null;
    this.parent = null;
    this.active = null;
    this.rows = new Map();      // pathKey -> row element (dirs and files)
    this.expanded = new Set();  // pathKey of expanded dirs
    this.loading = null;

    container.addEventListener('click', e => this.onClick(e));
    container.addEventListener('auxclick', e => {
      if (e.button !== 1) return;
      const row = e.target.closest('.tree-row.is-file');
      if (row) {
        e.preventDefault();
        this.onOpenNew(row.dataset.path);
      }
    });
    container.addEventListener('keydown', e => this.onKey(e));
    upButton.addEventListener('click', () => {
      if (this.parent) this.setRoot(this.parent, this.active);
    });
  }

  clear() {
    this.root = null;
    this.parent = null;
    this.active = null;
    this.rows.clear();
    this.expanded.clear();
    this.container.replaceChildren();
    this.title.textContent = '';
    this.title.title = '';
    this.upButton.disabled = true;
  }

  async show(root, activePath) {
    this.active = activePath;
    if (!this.root || !samePath(this.root, root)) {
      await this.setRoot(root, activePath);
    } else {
      await this.reveal(activePath);
    }
  }

  async setRoot(root, activePath) {
    this.root = root;
    this.expanded.clear();
    await this.renderRoot();
    if (activePath) await this.reveal(activePath);
  }

  async renderRoot() {
    const root = this.root;
    const res = await this.listDir(root);
    if (root !== this.root) return;
    this.rows.clear();
    this.parent = res.parent || null;
    this.upButton.disabled = !this.parent;
    this.title.textContent = res.name || root;
    this.title.title = root;
    if (res.error) {
      this.container.replaceChildren(el('div', { class: 'tree-empty', text: res.error }));
      return;
    }
    const list = el('div', { class: 'tree-children', role: 'group' });
    list.append(this.renderEntries(res.entries, 0));
    if (!res.entries.length) list.append(el('div', { class: 'tree-empty', text: 'No Markdown files here' }));
    this.container.replaceChildren(list);
  }

  renderEntries(entries, depth) {
    const frag = document.createDocumentFragment();
    for (const entry of entries) {
      const row = el('div', {
        class: `tree-row ${entry.dir ? 'is-dir' : 'is-file'}`,
        role: 'treeitem',
        tabindex: '-1',
        title: entry.name,
        dataset: { path: entry.path },
      });
      row.style.setProperty('--depth', depth);
      row.innerHTML = entry.dir
        ? `<span class="tree-chevron">${icon('chevron', 14)}</span>${icon('folder', 15)}`
        : `<span class="tree-chevron"></span>${icon('file', 15)}`;
      row.append(el('span', { class: 'tree-name', text: entry.dir ? entry.name : entry.name.replace(/\.(md|markdown)$/i, '') }));
      if (!entry.dir && this.active && samePath(entry.path, this.active)) row.classList.add('active');
      this.rows.set(pathKey(entry.path), row);
      const item = el('div', { class: 'tree-item' }, row);
      if (entry.dir) item.append(el('div', { class: 'tree-children', role: 'group', hidden: true }));
      frag.append(item);
    }
    return frag;
  }

  async expand(row, open = true) {
    const item = row.parentElement;
    const children = item.querySelector(':scope > .tree-children');
    if (!children) return;
    const key = pathKey(row.dataset.path);
    if (!open) {
      children.hidden = true;
      row.classList.remove('open');
      this.expanded.delete(key);
      return;
    }
    if (!children.dataset.loaded) {
      const res = await this.listDir(row.dataset.path);
      const depth = Number(row.style.getPropertyValue('--depth')) + 1;
      children.replaceChildren();
      if (res.error) {
        children.append(el('div', { class: 'tree-empty', text: res.error }));
      } else {
        children.append(this.renderEntries(res.entries, depth));
        if (!res.entries.length) {
          const empty = el('div', { class: 'tree-empty', text: 'Empty' });
          empty.style.setProperty('--depth', depth);
          children.append(empty);
        }
      }
      children.dataset.loaded = '1';
    }
    children.hidden = false;
    row.classList.add('open');
    this.expanded.add(key);
  }

  async reveal(filePath) {
    if (!this.root || !filePath) return;
    const segs = relativeSegments(this.root, dirname(filePath));
    if (segs) {
      let cur = this.root;
      for (const seg of segs) {
        cur = cur.endsWith('\\') || cur.endsWith('/') ? cur + seg : `${cur}\\${seg}`;
        const row = this.rows.get(pathKey(cur));
        if (!row) break;
        await this.expand(row, true);
      }
    }
    this.setActive(filePath);
  }

  setActive(filePath) {
    this.active = filePath;
    for (const row of this.container.querySelectorAll('.tree-row.active')) row.classList.remove('active');
    const row = filePath && this.rows.get(pathKey(filePath));
    if (row) {
      row.classList.add('active');
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  // Re-list the tree after a change on disk, keeping folders open.
  async refresh() {
    if (!this.root) return;
    const keep = new Set(this.expanded);
    const scroll = this.container.scrollTop;
    await this.renderRoot();
    for (const key of [...keep].sort((a, b) => a.length - b.length)) {
      const row = this.rows.get(key);
      if (row) await this.expand(row, true);
    }
    this.setActive(this.active);
    this.container.scrollTop = scroll;
  }

  onClick(e) {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    row.focus({ preventScroll: true });
    if (row.classList.contains('is-dir')) {
      this.expand(row, !row.classList.contains('open'));
    } else if (e.ctrlKey || e.metaKey) {
      this.onOpenNew(row.dataset.path);
    } else {
      this.onOpen(row.dataset.path);
    }
  }

  onKey(e) {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    const visible = [...this.container.querySelectorAll('.tree-row')].filter(r => r.offsetParent !== null);
    const i = visible.indexOf(row);
    if (e.key === 'ArrowDown' && visible[i + 1]) visible[i + 1].focus();
    else if (e.key === 'ArrowUp' && visible[i - 1]) visible[i - 1].focus();
    else if (e.key === 'ArrowRight' && row.classList.contains('is-dir')) this.expand(row, true);
    else if (e.key === 'ArrowLeft' && row.classList.contains('is-dir')) this.expand(row, false);
    else if (e.key === 'Enter') row.click();
    else return;
    e.preventDefault();
  }
}

export class Outline {
  constructor({ container, footer, onJump }) {
    this.container = container;
    this.footer = footer;
    this.onJump = onJump;
    this.items = [];
    this.activeId = null;
    container.addEventListener('click', e => {
      const a = e.target.closest('.outline-item');
      if (!a) return;
      e.preventDefault();
      this.onJump(a.dataset.id);
    });
  }

  clear() {
    this.items = [];
    this.container.replaceChildren();
    this.footer.textContent = '';
  }

  set(items, stats) {
    this.items = items;
    this.activeId = null;
    const min = items.reduce((m, h) => Math.min(m, h.level), 6);
    const frag = document.createDocumentFragment();
    for (const h of items) {
      const a = el('a', { class: 'outline-item', href: '#', title: h.text, dataset: { id: h.id } }, h.text);
      a.style.setProperty('--level', h.level - min);
      frag.append(a);
    }
    if (!items.length) frag.append(el('div', { class: 'tree-empty', text: 'No headings' }));
    this.container.replaceChildren(frag);
    this.footer.textContent = stats
      ? `${stats.words.toLocaleString()} words · ${stats.minutes} min read`
      : '';
  }

  highlight(id) {
    if (id === this.activeId) return;
    this.activeId = id;
    for (const a of this.container.querySelectorAll('.outline-item.active')) a.classList.remove('active');
    if (!id) return;
    const a = this.container.querySelector(`.outline-item[data-id="${CSS.escape(id)}"]`);
    if (a) {
      a.classList.add('active');
      if (this.container.offsetParent !== null) a.scrollIntoView({ block: 'nearest' });
    }
  }
}
