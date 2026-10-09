// Plume Vault — the sidebar panel.
//
// It lives in the sidebar beside Files and Outline rather than in a dialog:
// signing in is not an interruption, and the vault is somewhere you look
// things up while you read, not something that covers what you are reading.
//
// Everything that touches the network happens in the main process; this file
// only asks for actions and draws the answers.

import { el } from './util.js';

function bytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
}

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} d ago`;
  return d.toLocaleDateString();
}

/** The vault's paths as a tree of folders, so it can be read as a folder. */
function treeOf(files) {
  const root = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = String(file.path).split('/').filter(Boolean);
    let node = root;
    for (const segment of parts.slice(0, -1)) {
      if (!node.folders.has(segment)) node.folders.set(segment, { folders: new Map(), files: [] });
      node = node.folders.get(segment);
    }
    node.files.push(file);
  }
  return root;
}

/** Documents anywhere below a folder, which is what its count should say. */
function countFiles(node) {
  let total = node.files.length;
  for (const child of node.folders.values()) total += countFiles(child);
  return total;
}

export class Vault {
  /**
   * @param {HTMLElement} root   the sidebar panel to draw into
   * @param {object} api         the preload bridge (window.plume)
   * @param {Function} toast     the app's notification helper
   * @param {Function} getDoc    returns the open document, or null
   * @param {Function} onGraph   asked to show the graph of these documents
   */
  constructor(root, api, toast, getDoc, onGraph, getRoot) {
    this.root = root;
    this.api = api;
    this.toast = toast;
    this.getDoc = getDoc;
    this.onGraph = onGraph;
    this.getRoot = getRoot || (() => null);

    this.mode = 'signin';
    this.state = null;
    this.files = [];
    this.links = {};
    this.loaded = false;
    this.busy = false;
    // Which folders of the vault tree are open, kept across a redraw of the
    // panel so syncing a document does not fold everything up again.
    this.openDirs = new Set();
    this.sync = null;

    // The main process drives the folder sync; the panel just shows what it says.
    this.api.onSyncChanged(state => {
      this.sync = state;
      if (this.loaded && this.state && this.state.signedIn) this.drawVault();
    });
  }

  render(...nodes) {
    this.root.replaceChildren(...nodes);
  }

  /** Called whenever the panel becomes visible, and after the document changes. */
  async show({ force = false } = {}) {
    if (this.loaded && !force) {
      // Already drawn: just refresh the part that depends on the open document.
      if (this.state && this.state.signedIn) this.drawVault();
      return;
    }
    if (!this.loaded) this.render(el('p', { class: 'vault-note', text: 'Checking your vault…' }));
    await this.load();
  }

  async load() {
    this.state = await this.api.vault.state(this.getRoot());
    this.sync = await this.api.sync.state();
    this.loaded = true;

    if (!this.state.signedIn) {
      this.drawAuth();
      return;
    }
    const res = await this.api.vault.list();
    if (!res.ok) {
      this.files = [];
      this.drawVault(res.error);
      return;
    }
    this.files = res.files || [];
    this.links = res.links || {};
    if (res.account) this.state.account = res.account;
    this.drawVault();
  }

  // ---------- signed out ----------

  drawAuth(message) {
    const form = el('form', { class: 'vault-form' });

    const tabs = el('div', { class: 'vault-tabs' });
    const mk = (key, label) => {
      const b = el('button', { type: 'button', text: label });
      b.setAttribute('aria-pressed', String(this.mode === key));
      b.addEventListener('click', () => {
        this.mode = key;
        this.drawAuth();
      });
      return b;
    };
    tabs.append(mk('signin', 'Sign in'), mk('signup', 'Create account'));

    const intro = el('p', { class: 'vault-note' });
    intro.textContent = this.mode === 'signup'
      ? 'A free account gives you a 100 MB vault for syncing documents between your computers.'
      : 'Sign in to sync documents between your computers.';

    const email = el('input', {
      type: 'email', id: 'vault-email', autocomplete: 'email',
      placeholder: 'you@example.com', required: true,
    });
    const password = el('input', {
      type: 'password', id: 'vault-password', placeholder: '••••••••••', required: true,
      autocomplete: this.mode === 'signup' ? 'new-password' : 'current-password',
      'aria-describedby': this.mode === 'signup' ? 'vault-pw-hint' : null,
    });

    const submit = el('button', {
      class: 'vault-btn primary', type: 'submit',
      text: this.mode === 'signup' ? 'Create my vault' : 'Sign in',
    });

    form.append(tabs, intro);
    if (message) form.append(el('p', { class: 'vault-error', text: message }));
    form.append(
      el('label', { for: 'vault-email', class: 'vault-label', text: 'Email' }),
      email,
      el('label', { for: 'vault-password', class: 'vault-label', text: 'Password' }),
      password,
    );
    if (this.mode === 'signup') {
      form.append(el('span', {
        class: 'vault-hint', id: 'vault-pw-hint',
        text: 'At least 10 characters, with a number or symbol.',
      }));
    }
    form.append(submit);

    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      if (this.busy) return;
      this.busy = true;
      submit.disabled = true;
      submit.textContent = this.mode === 'signup' ? 'Creating…' : 'Signing in…';

      const call = this.mode === 'signup' ? this.api.vault.signUp : this.api.vault.signIn;
      const res = await call(email.value.trim(), password.value);

      this.busy = false;
      if (!res.ok) {
        this.drawAuth(res.error);
        return;
      }
      this.toast(this.mode === 'signup' ? 'Vault created' : 'Signed in to your vault');
      await this.load();
    });

    this.render(form);
  }

  // ---------- signed in ----------

  drawVault(message) {
    const account = this.state.account || {};
    const used = account.usedBytes || 0;
    const quota = account.quotaBytes || 1;

    const head = el('div', { class: 'vault-account' });
    const who = el('div', { class: 'vault-who' });
    who.append(
      el('b', { text: account.email || this.state.email || '' }),
      el('span', { text: `${bytes(used)} of ${bytes(quota)} · ${this.files.length} ${this.files.length === 1 ? 'document' : 'documents'}` }),
    );
    const menu = el('button', {
      class: 'vault-btn ghost small', type: 'button', text: 'Sign out',
      title: 'Sign out of your vault',
    });
    menu.addEventListener('click', async () => {
      await this.api.vault.signOut();
      this.files = [];
      this.links = {};
      this.toast('Signed out of your vault');
      await this.load();
    });
    head.append(who, menu);

    const meter = el('div', { class: 'vault-meter' });
    const fill = el('i');
    fill.style.width = `${Math.min(100, (used / quota) * 100).toFixed(1)}%`;
    meter.append(fill);

    const parts = [head, meter];
    if (message) parts.push(el('p', { class: 'vault-error', text: message }));
    parts.push(this.drawFolder(), this.drawCurrent(), this.drawFiles());

    this.render(...parts);
  }


  /**
   * The folder kept in step with the vault. This is the part that runs on its
   * own: everything else in the panel is a one-off action.
   */
  drawFolder() {
    const section = el('section', { class: 'vault-section' });
    const head = el('div', { class: 'vault-section-head' });
    head.append(el('h3', { text: 'Synced folder' }));
    section.append(head);

    const sync = this.sync || { status: 'off', folder: null };

    if (!sync.folder) {
      section.append(
        el('p', {
          class: 'vault-note',
          text: 'Your notes live on this computer. Sync a folder and Plume keeps '
            + 'everything in it — notes, images and sub-folders — in your vault too, '
            + 'so another computer can have the same folder.',
        }),
        el('p', {
          class: 'vault-hint',
          text: 'Only documents and images are uploaded. Programs, installers and archives are never sent.',
        }),
      );

      const acts = el('div', { class: 'vault-row-acts' });

      // The folder already open is almost always the one meant, so it is
      // offered by name — but offered. Signing in syncs nothing on its own:
      // the copy on this disk is the real one, and connecting it to the
      // cloud is a thing somebody decides about a folder they can see.
      const candidate = sync.candidate;
      if (candidate) {
        const name = candidate.replace(/[\/]+$/, '').split(/[\/]/).pop() || candidate;
        const useOpen = el('button', {
          class: 'vault-btn primary small', type: 'button', text: `Sync “${name}”`,
        });
        useOpen.title = candidate;
        useOpen.addEventListener('click', () => this.adoptFolder(useOpen));
        acts.append(useOpen);
      }

      const choose = el('button', {
        class: candidate ? 'vault-btn ghost small' : 'vault-btn primary small',
        type: 'button',
        text: candidate ? 'Another folder…' : 'Choose a folder…',
      });
      choose.addEventListener('click', () => this.chooseFolder(choose));
      acts.append(choose);
      section.append(acts);

      // On a second computer there is nothing to choose yet: the notebooks
      // are already in the vault, and what is wanted is to put one here.
      const existing = el('div', { class: 'vault-existing' });
      section.append(existing);
      this.drawNotebooks(existing).catch(() => {});
      return section;
    }

    const others = el('div', { class: 'vault-existing' });

    const name = sync.folder.replace(/[\/]+$/, '').split(/[\/]/).pop() || sync.folder;
    const info = el('div', { class: 'vault-current-info' });
    const title = el('b', { text: name });
    title.title = sync.folder;
    info.append(title, el('span', { text: this.syncLine(sync) }));
    // Which notebook of the vault this folder is, so it is clear that another
    // folder would be another notebook rather than the same one.
    if (sync.prefix) {
      info.append(el('span', { class: 'vault-hint', text: `In your vault as ${sync.prefix}` }));
    }
    section.append(info);

    if (sync.status === 'syncing' && sync.total) {
      const bar = el('div', { class: 'vault-meter' });
      const fill = el('i');
      fill.style.width = `${Math.min(100, (sync.done / sync.total) * 100).toFixed(0)}%`;
      bar.append(fill);
      section.append(bar);
    }

    if (sync.lastError) section.append(el('p', { class: 'vault-error', text: sync.lastError }));
    else if (sync.message) section.append(el('p', { class: 'vault-hint', text: sync.message }));

    const acts = el('div', { class: 'vault-row-acts' });

    const now = el('button', {
      class: 'vault-btn primary small', type: 'button', text: 'Sync now',
      disabled: sync.status === 'syncing' || sync.status === 'scanning',
    });
    now.addEventListener('click', async () => {
      now.disabled = true;
      await this.api.sync.now();
      await this.load();
    });

    const paused = sync.status === 'paused';
    const pause = el('button', {
      class: 'vault-btn ghost small', type: 'button', text: paused ? 'Resume' : 'Pause',
    });
    pause.addEventListener('click', async () => {
      await this.api.sync.pause(!paused);
      await this.load();
    });

    const open = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Open folder' });
    open.addEventListener('click', () => this.api.sync.reveal());

    // Changing which folder syncs is a different act from stopping, and it
    // is the one somebody with more than one project does often. Without a
    // button of its own it is Stop followed by Choose, and Stop reads like
    // breaking something rather than moving to the next project.
    const change = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Change folder…' });
    change.addEventListener('click', () => this.chooseFolder(change));

    const forget = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Stop' });
    forget.addEventListener('click', async () => {
      const warning = 'Stop syncing this folder?\n\n'
        + 'Nothing is deleted: the folder stays on your computer, and what is '
        + 'already in your vault stays in your vault.';
      if (!window.confirm(warning)) return;
      await this.api.sync.forget();
      this.toast('This folder is no longer synced');
      await this.load();
    });

    acts.append(now, pause, open, change, forget);
    section.append(acts);

    // The other notebooks in the vault, so moving between projects is
    // choosing one here rather than finding its folder on disk again.
    section.append(others);
    this.drawNotebooks(others, sync.prefix || '').catch(() => {});
    return section;
  }

  syncLine(sync) {
    switch (sync.status) {
      case 'scanning': return 'Looking through the folder…';
      case 'syncing': return sync.total ? `Syncing ${Math.min(sync.done + 1, sync.total)} of ${sync.total}…` : 'Syncing…';
      case 'paused': return 'Paused';
      case 'error': return 'Could not sync';
      case 'off': return sync.message || 'Not syncing';
      default:
        return sync.lastSyncAt ? `Up to date · checked ${when(sync.lastSyncAt)}` : 'Up to date';
    }
  }

  /**
   * The notebooks already in the vault, each with a way to put it on this
   * computer. Plume makes the folder and brings the documents down; from then
   * on it is the open folder and the vault, like one chosen here.
   */
  async drawNotebooks(host, openName = null) {
    const res = await this.api.vault.notebooks();
    if (!res || !res.ok || !res.notebooks) return;
    // The one being synced is already on screen above; what is useful here is
    // the others.
    const books = res.notebooks.filter(b => openName === null || b.name !== openName);
    if (!books.length) return;

    host.append(el('h4', {
      class: 'vault-sub',
      text: openName === null ? 'Already in your vault' : 'Other notebooks in your vault',
    }));
    host.append(el('p', {
      class: 'vault-hint',
      text: 'Put one of these on this computer. Plume makes the folder and downloads what is in it.',
    }));

    for (const book of books) {
      const row = el('div', { class: 'vault-row' });
      const label = el('div', { class: 'vault-row-main' });
      label.append(el('b', { text: book.name || 'Your vault' }));
      label.append(el('span', {
        text: `${book.documents} document${book.documents === 1 ? '' : 's'}`,
      }));
      const open = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Open here' });
      open.addEventListener('click', () => this.openNotebook(book.name, open));
      row.append(label, el('div', { class: 'vault-row-acts' }, open));
      host.append(row);
    }
  }

  async openNotebook(name, button) {
    button.disabled = true;
    button.textContent = 'Downloading…';
    try {
      const res = await this.api.vault.openNotebook(name);
      if (!res || res.canceled) return;
      if (!res.ok) {
        this.toast(res.error || 'Could not open that notebook', 'error');
        return;
      }
      this.toast(`${name || 'Your vault'} is now in ${res.folder}`);
    } catch (err) {
      this.toast('Could not open that notebook', 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Open here';
    }
  }

  /** Starts syncing the folder that is already open. */
  async adoptFolder(button) {
    button.disabled = true;
    const res = await this.api.sync.adopt();
    button.disabled = false;
    if (!res.ok) return this.toast(res.error, 'error');

    const look = res.preview || {};
    const skipped = look.skippedTotal || 0;
    this.toast(
      `Syncing ${look.files || 0} document${look.files === 1 ? '' : 's'}`
      + (skipped ? ` · ${skipped} other file${skipped === 1 ? '' : 's'} left alone` : ''),
    );
    await this.load();
  }

  async chooseFolder(button) {
    button.disabled = true;
    const res = await this.api.sync.choose();
    button.disabled = false;
    if (!res.ok) return this.toast(res.error, 'error');
    if (res.canceled) return;

    const look = res.preview || {};
    const skipped = look.skippedTotal || 0;
    this.toast(
      `Syncing ${look.files || 0} document${look.files === 1 ? '' : 's'}`
      + (skipped ? ` · ${skipped} other file${skipped === 1 ? '' : 's'} left alone` : ''),
    );
    await this.load();
  }

  /** The "this document" block: push it up, or show that it is already linked. */
  drawCurrent() {
    const doc = this.getDoc();
    const section = el('section', { class: 'vault-section' });
    section.append(el('h3', { text: 'This document' }));

    if (!doc) {
      section.append(el('p', { class: 'vault-note', text: 'Open a document to sync it.' }));
      return section;
    }

    const link = this.links[doc.path];

    if (link) {
      const info = el('div', { class: 'vault-current-info' });
      info.append(
        el('b', { text: link.vaultPath }),
        el('span', { text: link.syncedAt ? `synced ${when(link.syncedAt)}` : 'not synced yet' }),
      );

      const sync = el('button', { class: 'vault-btn primary small', type: 'button', text: 'Sync now' });
      sync.addEventListener('click', () => this.push(link.vaultPath, sync));

      const stop = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Unlink' });
      stop.addEventListener('click', async () => {
        const res = await this.api.vault.unlink();
        if (res.ok) {
          this.links = res.links || {};
          this.toast('This document is no longer linked to your vault');
          this.drawVault();
        }
      });

      section.append(info, el('div', { class: 'vault-row-acts' }, sync, stop));
    } else {
      const name = el('input', {
        type: 'text', class: 'vault-name',
        value: doc.name || '',
        'aria-label': 'Name in the vault',
      });
      const send = el('button', { class: 'vault-btn primary small', type: 'button', text: 'Sync to vault' });
      send.addEventListener('click', () => this.push(name.value.trim(), send));
      section.append(name, el('div', { class: 'vault-row-acts' }, send));
    }

    return section;
  }

  drawFiles() {
    const section = el('section', { class: 'vault-section' });

    const head = el('div', { class: 'vault-section-head' });
    head.append(el('h3', { text: 'In your vault' }));
    if (this.files.length) {
      const graph = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Graph' });
      graph.addEventListener('click', () => this.onGraph());
      head.append(graph);
    }
    section.append(head);

    if (!this.files.length) {
      section.append(el('p', { class: 'vault-note', text: 'Nothing here yet. Sync a document to get started.' }));
      return section;
    }

    section.append(this.drawTree(treeOf(this.files)));
    return section;
  }

  /**
   * The vault as its folders, not as a list of paths.
   *
   * A flat list was readable when a vault held a handful of documents pushed
   * one at a time. A synced folder puts its whole shape up there — notebooks,
   * sub-folders, a Journal with a year in it — and then every row reads
   * `Journal/2026/today.md` and two notes called `today` are told apart by
   * squinting at a prefix. Folders fold; what is inside them is indented.
   */
  drawTree(node, trail = '') {
    const list = el('ul', { class: 'vault-tree' });

    for (const [name, child] of [...node.folders.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const path = trail ? `${trail}/${name}` : name;
      const box = el('details', { class: 'vault-dir' });
      // Which folders are open survives a reload of the panel, so syncing a
      // document does not close everything the reader had opened.
      if (this.openDirs.has(path)) box.open = true;
      box.addEventListener('toggle', () => {
        if (box.open) this.openDirs.add(path);
        else this.openDirs.delete(path);
      });

      const count = countFiles(child);
      box.append(el('summary', {},
        el('span', { class: 'vault-dir-name', text: name }),
        el('span', { class: 'vault-dir-count', text: `${count}` }),
      ));
      box.append(this.drawTree(child, path));
      list.append(el('li', {}, box));
    }

    for (const file of node.files) {
      list.append(el('li', {}, this.drawFileRow(file)));
    }
    return list;
  }

  drawFileRow(file) {
    const row = el('div', { class: 'vault-file' });
    const info = el('div', { class: 'vault-file-info' });
    info.append(
      el('b', { text: file.path.split('/').pop() }),
      el('span', { text: `${bytes(file.size)} · ${when(file.updatedAt)}` }),
    );
    // The full name is still what identifies it, so it is still reachable.
    info.title = file.path;

    const open = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Open' });
    open.addEventListener('click', async () => {
      open.disabled = true;
      const res = await this.api.vault.pull(file.path);
      open.disabled = false;
      if (!res.ok) this.toast(res.error, 'error');
    });

    const del = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Delete' });
    del.addEventListener('click', async () => {
      if (!window.confirm(`Delete “${file.path}” from your vault? This cannot be undone.`)) return;
      const res = await this.api.vault.remove(file.path);
      if (!res.ok) return this.toast(res.error, 'error');
      this.toast('Deleted from your vault');
      await this.load();
    });

    row.append(info, el('div', { class: 'vault-row-acts' }, open, del));
    return row;
  }

  // ---------- pushing ----------

  async push(vaultPath, button) {
    if (!vaultPath) return this.toast('Give the document a name first', 'error');

    // Syncing a document for the first time under a name something else
    // already uses would replace that other document. The server cannot catch
    // this — there is no revision to compare against — so ask here.
    const doc = this.getDoc();
    const alreadyLinked = doc && this.links[doc.path];
    const taken = this.files.some(f => f.path === vaultPath);
    if (!alreadyLinked && taken) {
      const ok = window.confirm(
        `Your vault already has a document called “${vaultPath}”. `
        + 'Syncing will replace it. Use a different name to keep both.',
      );
      if (!ok) return;
    }
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Syncing…';

    const res = await this.api.vault.push(vaultPath);

    button.disabled = false;
    button.textContent = label;

    if (res.ok) {
      this.toast(res.unchanged ? 'Already up to date' : `Synced ${res.file.path}`);
      await this.load();
      return;
    }

    if (res.status === 409 && res.conflict) {
      this.drawConflict(vaultPath, res.conflict);
      return;
    }
    this.toast(res.error, 'error');
  }

  /**
   * The vault copy changed on another machine. Neither version is thrown away
   * without the user saying so.
   */
  drawConflict(vaultPath, conflict) {
    const box = el('section', { class: 'vault-section vault-conflict' });
    box.append(
      el('h3', { text: 'Changed somewhere else' }),
      el('p', {
        class: 'vault-note',
        text: `The vault copy of “${vaultPath}” was updated ${when(conflict.updatedAt)}, after this computer last synced. Choose what to keep.`,
      }),
    );

    const keep = el('button', { class: 'vault-btn primary small', type: 'button', text: 'Save the vault copy beside mine' });
    keep.addEventListener('click', async () => {
      keep.disabled = true;
      const res = await this.api.vault.keepBoth(vaultPath);
      keep.disabled = false;
      if (!res.ok) return this.toast(res.error, 'error');
      this.toast('Saved the vault copy next to your file');
      await this.load();
    });

    const over = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Replace the vault copy' });
    over.addEventListener('click', async () => {
      over.disabled = true;
      const res = await this.api.vault.push(vaultPath, { force: true });
      over.disabled = false;
      if (!res.ok) return this.toast(res.error, 'error');
      this.toast('Vault updated');
      await this.load();
    });

    const back = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Cancel' });
    back.addEventListener('click', () => this.drawVault());

    box.append(el('div', { class: 'vault-stack' }, keep, over, back));
    this.render(box);
  }
}
