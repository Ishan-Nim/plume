// Plume Vault — the panel behind "⋯ → Plume Vault".
//
// Everything that touches the network happens in the main process; this file
// only asks for actions and draws the answers.

import { el } from './util.js';
import { icon } from './icons.js';

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
   * @param {object} api     the preload bridge (window.plume)
   * @param {Function} toast the app's notification helper
   * @param {Function} getDoc returns the open document, or null
   */
  constructor(api, toast, getDoc) {
    this.api = api;
    this.toast = toast;
    this.getDoc = getDoc;
    this.mode = 'signin';
    this.state = null;
    this.files = [];
    this.links = {};
    this.busy = false;
    this.root = null;
  }

  // ---------- shell ----------

  build() {
    if (this.root) return this.root;

    this.body = el('div', { class: 'vault-body' });

    const close = el('button', {
      class: 'icon-btn small', type: 'button', title: 'Close', 'aria-label': 'Close',
    });
    close.innerHTML = icon('close', 16);
    close.addEventListener('click', () => this.close());

    const head = el('div', { class: 'vault-head' });
    const title = el('div', { class: 'vault-title' });
    title.append(el('b', { text: 'Plume Vault' }));
    head.append(title, close);

    const card = el('div', { class: 'vault-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Plume Vault' });
    card.append(head, this.body);

    this.root = el('div', { class: 'vault-overlay', hidden: true });
    this.root.append(card);
    this.root.addEventListener('mousedown', ev => {
      if (ev.target === this.root) this.close();
    });

    this.onKey = ev => {
      if (ev.key === 'Escape' && !this.root.hidden) {
        ev.stopPropagation();
        this.close();
      }
    };

    document.body.append(this.root);
    return this.root;
  }

  async open() {
    this.build();
    this.root.hidden = false;
    document.addEventListener('keydown', this.onKey, true);
    this.render(el('p', { class: 'vault-note', text: 'Checking your vault…' }));
    await this.load();
  }

  close() {
    if (!this.root) return;
    this.root.hidden = true;
    document.removeEventListener('keydown', this.onKey, true);
  }

  render(...nodes) {
    this.body.replaceChildren(...nodes);
  }

  async load() {
    this.state = await this.api.vault.state();
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

    const intro = el('p', { class: 'vault-note' });
    intro.textContent = this.mode === 'signup'
      ? 'A free account gives you a 100 MB vault. Your documents stay private.'
      : 'Sign in to sync documents between your computers.';

    const tabs = el('div', { class: 'vault-tabs', role: 'tablist' });
    const mk = (key, label) => {
      const b = el('button', { type: 'button', role: 'tab', text: label });
      b.setAttribute('aria-selected', String(this.mode === key));
      b.addEventListener('click', () => {
        this.mode = key;
        this.drawAuth();
      });
      return b;
    };
    tabs.append(mk('signin', 'Sign in'), mk('signup', 'Create account'));

    const email = el('input', { type: 'email', id: 'vault-email', autocomplete: 'email', placeholder: 'you@example.com', required: true });
    const password = el('input', {
      type: 'password', id: 'vault-password', placeholder: '••••••••••', required: true,
      autocomplete: this.mode === 'signup' ? 'new-password' : 'current-password',
    });

    const submit = el('button', {
      class: 'vault-btn primary', type: 'submit',
      text: this.mode === 'signup' ? 'Create my vault' : 'Sign in',
    });

    const error = el('p', { class: 'vault-error', hidden: !message, text: message || '' });

    form.append(
      tabs,
      intro,
      error,
      el('label', { for: 'vault-email', class: 'vault-label', text: 'Email' }),
      email,
      el('label', { for: 'vault-password', class: 'vault-label', text: 'Password' }),
      password,
    );
    if (this.mode === 'signup') {
      form.append(el('span', { class: 'vault-hint', text: 'At least 10 characters, with a number or symbol.' }));
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
      this.toast(this.mode === 'signup' ? 'Vault created' : 'Signed in');
      await this.load();
    });

    this.render(form);
    setTimeout(() => email.focus(), 0);
  }

  // ---------- signed in ----------

  drawVault(message) {
    const account = this.state.account || {};
    const used = account.usedBytes || 0;
    const quota = account.quotaBytes || 1;

    const who = el('div', { class: 'vault-account' });
    const left = el('div');
    left.append(
      el('b', { text: account.email || this.state.email || '' }),
      el('span', { text: `${bytes(used)} of ${bytes(quota)} used · ${this.files.length} ${this.files.length === 1 ? 'document' : 'documents'}` }),
    );
    const out = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Sign out' });
    out.addEventListener('click', async () => {
      await this.api.vault.signOut();
      this.files = [];
      this.toast('Signed out of your vault');
      await this.load();
    });
    who.append(left, out);

    const meter = el('div', { class: 'vault-meter' });
    const fill = el('i');
    fill.style.width = `${Math.min(100, (used / quota) * 100).toFixed(1)}%`;
    meter.append(fill);

    const parts = [who, meter];
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
    const row = el('div', { class: 'vault-current' });

    if (link) {
      const info = el('div', { class: 'vault-current-info' });
      info.append(
        el('b', { text: link.vaultPath }),
        el('span', { text: link.syncedAt ? `last synced ${when(link.syncedAt)}` : 'not synced yet' }),
      );

      const sync = el('button', { class: 'vault-btn primary small', type: 'button', text: 'Sync now' });
      sync.addEventListener('click', () => this.push(link.vaultPath, sync));

      const stop = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Stop syncing' });
      stop.addEventListener('click', async () => {
        const res = await this.api.vault.unlink();
        if (res.ok) {
          this.links = res.links || {};
          this.toast('This document is no longer linked to your vault');
          this.drawVault();
        }
      });

      row.append(info, el('div', { class: 'vault-current-acts' }, sync, stop));
    } else {
      const name = el('input', {
        type: 'text', class: 'vault-name', value: this.state.suggested || doc.name || '',
        'aria-label': 'Name in the vault',
      });
      const send = el('button', { class: 'vault-btn primary small', type: 'button', text: 'Sync to vault' });
      send.addEventListener('click', () => this.push(name.value.trim(), send));
      row.append(name, send);
    }

    section.append(row);
    return section;
  }

  drawFiles() {
    const section = el('section', { class: 'vault-section' });
    section.append(el('h3', { text: 'In your vault' }));

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

      const open = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Save & open' });
      open.addEventListener('click', async () => {
        open.disabled = true;
        const res = await this.api.vault.pull(file.path);
        open.disabled = false;
        if (!res.ok) return this.toast(res.error, 'error');
        if (res.canceled) return;
        this.close();
      });

      const del = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Delete' });
      del.addEventListener('click', async () => {
        if (!window.confirm(`Delete “${file.path}” from your vault? This cannot be undone.`)) return;
        const res = await this.api.vault.remove(file.path);
        if (!res.ok) return this.toast(res.error, 'error');
        this.toast('Deleted from your vault');
        await this.load();
      });

      li.append(info, el('div', { class: 'vault-file-acts' }, open, del));
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
    const box = el('div', { class: 'vault-conflict' });
    box.append(
      el('h3', { text: 'This document changed somewhere else' }),
      el('p', {
        class: 'vault-note',
        text: `The vault copy of “${vaultPath}” was updated ${when(conflict.updatedAt)}, after this computer last synced. Choose what to keep.`,
      }),
    );

    const keep = el('button', { class: 'vault-btn primary', type: 'button', text: 'Save the vault copy beside this one' });
    keep.addEventListener('click', async () => {
      keep.disabled = true;
      const res = await this.api.vault.keepBoth(vaultPath);
      keep.disabled = false;
      if (!res.ok) return this.toast(res.error, 'error');
      this.toast('Saved the vault copy next to your file');
      await this.load();
    });

    const over = el('button', { class: 'vault-btn ghost', type: 'button', text: 'Replace the vault copy with mine' });
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

    box.append(el('div', { class: 'vault-conflict-acts' }, keep, over, back));
    this.render(box);
  }
}
