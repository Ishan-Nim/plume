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

export class Vault {
  /**
   * @param {HTMLElement} root   the sidebar panel to draw into
   * @param {object} api         the preload bridge (window.plume)
   * @param {Function} toast     the app's notification helper
   * @param {Function} getDoc    returns the open document, or null
   * @param {Function} onGraph   asked to show the graph of these documents
   */
  constructor(root, api, toast, getDoc, onGraph) {
    this.root = root;
    this.api = api;
    this.toast = toast;
    this.getDoc = getDoc;
    this.onGraph = onGraph;

    this.mode = 'signin';
    this.state = null;
    this.files = [];
    this.links = {};
    this.loaded = false;
    this.busy = false;
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
    this.state = await this.api.vault.state();
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
    parts.push(this.drawCurrent(), this.drawFiles());

    this.render(...parts);
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
        value: this.state.suggested || doc.name || '',
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

    const list = el('ul', { class: 'vault-files' });
    for (const file of this.files) {
      const li = el('li');
      const info = el('div', { class: 'vault-file-info' });
      info.append(
        el('b', { text: file.path }),
        el('span', { text: `${bytes(file.size)} · ${when(file.updatedAt)}` }),
      );

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

      li.append(info, el('div', { class: 'vault-row-acts' }, open, del));
      list.append(li);
    }

    section.append(list);
    return section;
  }

  // ---------- pushing ----------

  async push(vaultPath, button) {
    if (!vaultPath) return this.toast('Give the document a name first', 'error');
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
