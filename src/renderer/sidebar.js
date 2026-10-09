// Sidebar: a lazy folder tree of Markdown files around the open document,
// and an outline of its headings.

import { el, pathKey, samePath, relativeSegments, dirname, joinPath } from './util.js';
import { icon } from './icons.js';

export class FileTree {
  constructor({ container, title, upButton, newButton, newFolderButton,
    listDir, createNote, createFolder, onOpen, onOpenNew, onCreate, onError }) {
    this.container = container;
    this.title = title;
    this.upButton = upButton;
    this.newButton = newButton;
    this.newFolderButton = newFolderButton;
    this.listDir = listDir;
    this.createNote = createNote;
    this.createFolder = createFolder;
    this.onOpen = onOpen;
    this.onOpenNew = onOpenNew;
    this.onCreate = onCreate;
    this.onError = onError || (() => {});
    this.root = null;
    this.parent = null;
    this.active = null;
    this.rows = new Map();      // pathKey -> row element (dirs and files)
    this.expanded = new Set();  // pathKey of expanded dirs
    this.draft = null;          // the row being named, if any
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
    if (newButton) newButton.addEventListener('click', () => this.newEntry(this.root));
    if (newFolderButton) newFolderButton.addEventListener('click', () => this.newEntry(this.root, 'folder'));
  }

  clear() {
    this.cancelDraft();
    this.root = null;
    this.parent = null;
    this.active = null;
    this.rows.clear();
    this.expanded.clear();
    this.container.replaceChildren();
    this.title.textContent = '';
    this.title.title = '';
    this.upButton.disabled = true;
    this.setCanCreate(false);
  }

  setCanCreate(on) {
    if (this.newButton) this.newButton.disabled = !on;
    if (this.newFolderButton) this.newFolderButton.disabled = !on;
  }

  async show(root, activePath) {
    this.active = activePath;
    // A file already inside the tree (say, a click into a subfolder of a
    // plain folder) is revealed in place rather than re-rooting the tree.
    const dir = dirname(activePath);
    if (this.root && (samePath(this.root, root) || relativeSegments(this.root, dir))) {
      await this.reveal(activePath);
      // The tree leaves out dot-folders and node_modules. A file in one has
      // no row, so show its own folder instead (a vault root stays put).
      if (samePath(this.root, root) || samePath(this.root, dir) || this.rows.has(pathKey(dir))) return;
    }
    await this.setRoot(root, activePath);
  }

  async setRoot(root, activePath) {
    this.cancelDraft();
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
    this.setCanCreate(!res.error);
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
      // A folder carries its own way of starting a note inside it, the way
      // Obsidian's file explorer does, so no folder needs to be opened first.
      if (entry.dir) {
        row.append(el('button', {
          class: 'tree-add',
          type: 'button',
          tabindex: '-1',
          title: `New note in ${entry.name}`,
          'aria-label': `New note in ${entry.name}`,
          html: icon('plus', 14),
        }));
      }
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
        cur = joinPath(cur, seg);
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
    // A name being typed is taken off the tree before it is rebuilt and put
    // back afterwards, so a save elsewhere does not swallow it.
    const draft = this.draft && { dir: this.draft.dir, kind: this.draft.kind, value: this.draft.input.value };
    this.cancelDraft();
    const keep = new Set(this.expanded);
    const scroll = this.container.scrollTop;
    await this.renderRoot();
    for (const key of [...keep].sort((a, b) => a.length - b.length)) {
      const row = this.rows.get(key);
      if (row) await this.expand(row, true);
    }
    this.setActive(this.active);
    this.container.scrollTop = scroll;
    if (draft) {
      await this.newEntry(draft.dir, draft.kind);
      if (this.draft) this.draft.input.value = draft.value;
    }
  }

  /**
   * Names a new note — or folder — in the tree itself, where it will appear,
   * rather than in a dialog box. Enter creates it, Escape leaves nothing
   * behind, and a note is opened as soon as it exists.
   */
  async newEntry(dir, kind = 'note') {
    if (!dir || !this.createNote) return;
    this.cancelDraft();
    let children = this.container.querySelector(':scope > .tree-children');
    let depth = 0;
    if (!samePath(dir, this.root)) {
      const parentRow = this.rows.get(pathKey(dir));
      if (!parentRow) return;
      await this.expand(parentRow, true);
      children = parentRow.parentElement.querySelector(':scope > .tree-children');
      depth = Number(parentRow.style.getPropertyValue('--depth')) + 1;
    }
    if (!children) return;

    const folderWanted = kind === 'folder';
    const row = el('div', {
      class: `tree-row tree-draft ${folderWanted ? 'is-dir' : 'is-file'}`,
      html: `<span class="tree-chevron"></span>${icon(folderWanted ? 'folder' : 'file', 15)}`,
    });
    row.style.setProperty('--depth', depth);
    const input = el('input', {
      type: 'text',
      class: 'tree-draft-name',
      placeholder: folderWanted ? 'Folder name' : 'Note name',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': folderWanted ? 'Name for the new folder' : 'Name for the new note',
    });
    row.append(input);
    const item = el('div', { class: 'tree-item' }, row);
    children.hidden = false;
    children.prepend(item);
    this.draft = { dir, kind, item, input };
    input.focus();

    const finish = async commit => {
      if (!this.draft || this.draft.item !== item) return;
      const typed = input.value.trim();
      this.cancelDraft();
      if (!commit || !typed) return;
      const res = folderWanted ? await this.createFolder(dir, typed) : await this.createNote(dir, typed);
      if (!res || res.error) {
        this.onError((res && res.error) || 'Nothing was created.');
        return;
      }
      await this.refresh();
      if (res.folder) {
        const made = this.rows.get(pathKey(res.path));
        if (made) await this.expand(made, true);
      } else {
        // A note that has only just been made has nothing to read, so it is
        // handed over as new: the window opens it ready to type in.
        (this.onCreate || this.onOpen)(res.path);
      }
    };

    input.addEventListener('keydown', e => {
      // Arrows and Enter belong to the name here, not to the tree around it.
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    // Clicking away keeps what was typed, the way renaming in a file manager does.
    input.addEventListener('blur', () => finish(true));
  }

  cancelDraft() {
    if (!this.draft) return;
    const { item } = this.draft;
    this.draft = null;
    item.remove();
  }

  onClick(e) {
    const add = e.target.closest('.tree-add');
    if (add) {
      const dirRow = add.closest('.tree-row');
      if (dirRow) this.newEntry(dirRow.dataset.path);
      return;
    }
    const row = e.target.closest('.tree-row');
    if (!row || row.classList.contains('tree-draft')) return;
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
