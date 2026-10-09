// Plume Vault — the sidebar panel.
//
// It lives in the sidebar beside Files and Outline rather than in a dialog:
// signing in is not an interruption, and the vault is somewhere you look
// things up while you read, not something that covers what you are reading.
//
// The panel's whole job is to say which of three things the folder on screen
// is, and offer the one next step:
//
//   loose          a folder of Markdown Plume has not been asked to claim
//   local vault    a `.plume/` folder, offline, consuming nothing
//   linked vault   connected to the account, syncing on every save
//
// Those are steps, not a ladder to be climbed. A vault that never leaves this
// computer is a finished, supported state, and the panel never nags about it.
//
// Everything that touches the network or the disk happens in the main process;
// this file only asks for actions and draws the answers.

import { el } from './util.js';

function bytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
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

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The last part of a path, for showing a folder by its name.
 *
 * Both separators. The path arrives as the operating system gave it, so on
 * Windows splitting on "/" alone leaves the whole of C:\Users\…\Notes where a
 * folder name was meant to go.
 */
export function folderName(p) {
  const given = String(p || '');
  // A root is all separator, so trimming it leaves nothing to name it by.
  // Whatever was given is then the best name there is.
  const trimmed = given.replace(/[\\/]+$/, '');
  if (!trimmed) return given;
  return trimmed.split(/[\\/]/).pop() || trimmed;
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
    this.account = null;      // who is signed in, and the quota
    this.view = null;         // the folder on screen, and the vault it is
    this.files = [];
    this.links = {};
    this.remotes = null;      // the vaults in the account
    this.loaded = false;
    this.busy = false;
    // Which folders of the tree are open, kept across a redraw so syncing a
    // document does not fold everything up again.
    this.openDirs = new Set();

    // The main process drives both; the panel just shows what they say.
    //
    // A sync reports progress many times a second, and the list of what is in
    // the account is a round trip — so the cheap local redraw happens on every
    // tick and the full reload waits until the flurry stops. Without the
    // reload the panel showed a vault as "in sync" above a list of documents
    // that was still empty.
    this.reloadTimer = null;
    this.api.onSyncChanged(() => {
      if (!this.loaded) return;
      this.refreshQuietly();
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        if (this.loaded) this.load().catch(() => {});
      }, 700);
    });
    this.api.onVaultsChanged(view => {
      this.view = view;
      if (this.loaded) this.draw();
    });
  }

  render(...nodes) {
    this.root.replaceChildren(...nodes);
  }

  /** Called whenever the panel becomes visible, and after the document changes. */
  async show({ force = false } = {}) {
    if (this.loaded && !force) {
      await this.refreshQuietly();
      return;
    }
    if (!this.loaded) this.render(el('p', { class: 'vault-note', text: 'Checking your vault…' }));
    await this.load();
  }

  /** Re-reads what is cheap and local, without going back to the network. */
  async refreshQuietly() {
    this.view = await this.api.vaults.state();
    this.account = this.view.account;
    this.draw();
  }

  async load() {
    this.view = await this.api.vaults.state();
    this.account = this.view.account;
    this.loaded = true;

    if (this.account && this.account.signedIn) {
      const res = await this.api.vault.list();
      if (res.ok) {
        this.files = res.files || [];
        this.links = res.links || {};
        if (res.account) this.account = { ...this.account, account: res.account };
      } else {
        this.files = [];
        this.draw(res.error);
        return;
      }
      const remotes = await this.api.vaults.remotes();
      this.remotes = remotes.ok ? remotes.vaults : null;
    }
    this.draw();
  }

  draw(message) {
    const parts = [];
    const signedIn = Boolean(this.account && this.account.signedIn);

    if (signedIn) parts.push(this.drawAccount());
    if (message) parts.push(el('p', { class: 'vault-error', text: message }));

    // The folder on screen comes first whether or not there is an account:
    // making a vault needs neither a network nor a sign-in, and a reader who
    // never signs in should still find the thing the panel is mostly about.
    parts.push(this.drawHere());

    if (!signedIn) {
      parts.push(this.drawAuth());
    } else {
      parts.push(this.drawRemotes());
      parts.push(this.drawFiles());
    }
    parts.push(this.drawKnown());

    this.render(...parts.filter(Boolean));
  }

  // ---------- the account ----------

  drawAccount() {
    const account = (this.account && this.account.account) || {};
    const used = account.usedBytes || 0;
    const quota = account.quotaBytes || 1;

    const section = el('section', { class: 'vault-section' });
    const head = el('div', { class: 'vault-account' });
    const who = el('div', { class: 'vault-who' });

    // One pool, across every vault. Said plainly here because "unlimited
    // vaults, 1 GB of storage" reads as a contradiction until you see that
    // the cap is on bytes in the cloud and not on how many vaults organise
    // them.
    const linked = (this.view && this.view.known ? this.view.known : []).filter(v => v.linked).length;
    who.append(
      el('b', { text: account.email || (this.account && this.account.email) || '' }),
      el('span', { text: `${bytes(used)} of ${bytes(quota)} used` }),
    );
    if (linked) {
      who.append(el('span', {
        class: 'vault-hint',
        text: `shared across ${plural(linked, 'linked vault', 'linked vaults')}`,
      }));
    }

    const out = el('button', {
      class: 'vault-btn ghost small', type: 'button', text: 'Sign out',
      title: 'Sign out of your account',
    });
    out.addEventListener('click', async () => {
      await this.api.vault.signOut();
      this.files = [];
      this.links = {};
      this.remotes = null;
      this.toast('Signed out of your account');
      await this.load();
    });
    head.append(who, out);

    const meter = el('div', { class: 'vault-meter' });
    const fill = el('i');
    const share = Math.min(100, (used / quota) * 100);
    fill.style.width = `${share.toFixed(1)}%`;
    if (share > 90) meter.classList.add('full');
    meter.append(fill);

    section.append(head, meter);

    if (share >= 100) {
      section.append(el('p', {
        class: 'vault-hint',
        text: 'Your account is full. Everything still saves to this computer — '
          + 'only the upload waits. Free space by deleting a vault from your '
          + 'account, or unlink one to stop it syncing.',
      }));
    }
    return section;
  }

  drawAuth() {
    const form = el('form', { class: 'vault-form' });

    const tabs = el('div', { class: 'vault-tabs' });
    const mk = (key, label) => {
      const b = el('button', { type: 'button', text: label });
      b.setAttribute('aria-pressed', String(this.mode === key));
      b.addEventListener('click', () => {
        this.mode = key;
        this.draw();
      });
      return b;
    };
    tabs.append(mk('signin', 'Sign in'), mk('signup', 'Create account'));

    const intro = el('p', { class: 'vault-note' });
    intro.textContent = this.mode === 'signup'
      ? 'An account lets a vault sync between your computers. Vaults are '
        + 'unlimited; the free account holds 100 MB of synced documents across all of them.'
      : 'Sign in to link a vault and sync it between your computers.';

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
      text: this.mode === 'signup' ? 'Create my account' : 'Sign in',
    });

    const section = el('section', { class: 'vault-section' });
    section.append(el('h3', { text: 'Your account' }));

    form.append(tabs, intro);
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
        submit.disabled = false;
        submit.textContent = this.mode === 'signup' ? 'Create my account' : 'Sign in';
        form.append(el('p', { class: 'vault-error', text: res.error }));
        return;
      }
      this.toast(this.mode === 'signup' ? 'Account created' : 'Signed in');
      // Signing in links nothing and syncs nothing. The vaults on this
      // computer are exactly as they were a moment ago.
      await this.load();
    });

    section.append(form);
    return section;
  }

  // ---------- the folder on screen ----------

  drawHere() {
    const view = this.view || {};
    const section = el('section', { class: 'vault-section' });
    section.append(el('h3', { text: 'This folder' }));

    if (!view.folder) {
      section.append(
        el('p', {
          class: 'vault-note',
          text: 'No folder is open. Open one to read the Markdown in it, or make a vault.',
        }),
      );
      const make = el('button', { class: 'vault-btn primary small', type: 'button', text: 'Create a vault…' });
      make.addEventListener('click', () => this.createVault(make, { choose: true }));
      section.append(el('div', { class: 'vault-row-acts' }, make));
      return section;
    }

    if (view.loose) return this.drawLoose(section, view);
    if (view.vault && !view.vault.linked) return this.drawLocal(section, view);
    return this.drawLinked(section, view);
  }

  /** A folder of Markdown that Plume has not been asked to claim. */
  drawLoose(section, view) {
    const info = el('div', { class: 'vault-current-info' });
    const title = el('b', { text: folderName(view.folder) });
    title.title = view.folder;
    info.append(title, el('span', { text: 'A folder, not a vault' }));
    section.append(info);

    section.append(
      el('p', {
        class: 'vault-note',
        text: 'You can read and write everything in here as it is. It is not a '
          + 'vault, so there are no backlinks across it, no graph, and nothing '
          + 'in it can ever sync.',
      }),
      el('p', {
        class: 'vault-hint',
        text: 'Making it a vault adds a .plume folder and indexes the Markdown '
          + 'already here. Nothing is moved, copied or uploaded.',
      }),
    );

    const make = el('button', {
      class: 'vault-btn primary small', type: 'button',
      text: `Create vault in “${folderName(view.folder)}”`,
    });
    make.title = view.folder;
    make.addEventListener('click', () => this.createVault(make));

    const other = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Another folder…' });
    other.addEventListener('click', () => this.createVault(other, { choose: true }));

    section.append(el('div', { class: 'vault-row-acts' }, make, other));
    return section;
  }

  /** A vault that exists only on this computer — a finished state. */
  drawLocal(section, view) {
    const vault = view.vault;
    const info = el('div', { class: 'vault-current-info' });
    const title = el('b', { text: vault.name });
    title.title = vault.root;
    info.append(title, el('span', { text: 'A vault on this computer' }));
    section.append(info);

    section.append(el('p', {
      class: 'vault-note',
      text: 'Everything works: notes, backlinks, search, the graph. Nothing '
        + 'leaves this computer, and it uses none of your storage.',
    }));

    const acts = el('div', { class: 'vault-row-acts' });

    const signedIn = Boolean(this.account && this.account.signedIn);
    const link = el('button', {
      class: 'vault-btn primary small', type: 'button',
      text: signedIn ? 'Link to my account' : 'Sign in to link',
      disabled: !signedIn,
      title: signedIn ? 'Sync this vault between your computers'
        : 'Sign in below first — linking is a choice you make per vault',
    });
    link.addEventListener('click', () => this.linkVault(vault.root, link));

    const rename = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Rename…' });
    rename.addEventListener('click', () => this.renameVault(vault));

    const open = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Open folder' });
    open.addEventListener('click', () => this.api.sync.reveal(vault.root));

    acts.append(link, rename, open);
    section.append(acts);
    return section;
  }

  /** A vault connected to the account. */
  drawLinked(section, view) {
    const vault = view.vault;
    const sync = view.sync || { status: 'idle' };

    const info = el('div', { class: 'vault-current-info' });
    const title = el('b', { text: vault.name });
    title.title = vault.root;
    info.append(title, el('span', { text: this.syncLine(sync) }));
    if (vault.link && vault.link.remoteName) {
      info.append(el('span', {
        class: 'vault-hint', text: `In your account as “${vault.link.remoteName}”`,
      }));
    }
    section.append(info);

    if ((sync.status === 'syncing' || sync.status === 'scanning') && sync.total) {
      const bar = el('div', { class: 'vault-meter' });
      const fill = el('i');
      fill.style.width = `${Math.min(100, (sync.done / sync.total) * 100).toFixed(0)}%`;
      bar.append(fill);
      section.append(bar);
    }

    if (sync.lastError) section.append(el('p', { class: 'vault-error', text: sync.lastError }));
    else if (sync.message) section.append(el('p', { class: 'vault-hint', text: sync.message }));

    if (sync.pending) {
      section.append(el('p', {
        class: 'vault-hint',
        text: `${plural(sync.pending, 'document is', 'documents are')} waiting for room in your `
          + 'account. They are saved here and will go up when there is space.',
      }));
    }

    const acts = el('div', { class: 'vault-row-acts' });
    const busy = sync.status === 'syncing' || sync.status === 'scanning';

    const now = el('button', {
      class: 'vault-btn primary small', type: 'button', text: 'Sync now', disabled: busy,
    });
    now.addEventListener('click', async () => {
      now.disabled = true;
      await this.api.sync.now(vault.root);
      await this.load();
    });

    const paused = sync.status === 'paused';
    const pause = el('button', {
      class: 'vault-btn ghost small', type: 'button', text: paused ? 'Resume' : 'Pause',
    });
    pause.addEventListener('click', async () => {
      await this.api.sync.pause(vault.root, !paused);
      await this.load();
    });

    const open = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Open folder' });
    open.addEventListener('click', () => this.api.sync.reveal(vault.root));

    const unlink = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Unlink' });
    unlink.addEventListener('click', () => this.unlinkVault(vault));

    acts.append(now, pause, open, unlink);
    section.append(acts);
    return section;
  }

  syncLine(sync) {
    switch (sync.status) {
      case 'scanning': return 'Looking through the vault…';
      case 'syncing': return sync.total ? `Syncing ${Math.min(sync.done + 1, sync.total)} of ${sync.total}…` : 'Syncing…';
      case 'paused': return 'Paused';
      case 'error': return 'Could not sync';
      case 'offline': return sync.message || 'Not syncing';
      case 'off': return 'Not linked';
      default:
        return sync.lastSyncAt ? `In sync · checked ${when(sync.lastSyncAt)}` : 'Linked — syncing shortly';
    }
  }

  // ---------- actions on a vault ----------

  async createVault(button, options = {}) {
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Creating…';
    const res = await this.api.vaults.create(options);
    button.disabled = false;
    button.textContent = label;

    if (!res.ok) return this.toast(res.error, 'error');
    if (res.canceled) return undefined;
    this.toast(`“${res.vault.name}” is now a vault`);
    return this.load();
  }

  async linkVault(root, button) {
    const warn = 'Link this vault to your account?\n\n'
      + 'Everything in it — notes, images and sub-folders — is uploaded and kept '
      + 'in step on every computer you sign in on. It counts against your storage.';
    if (!window.confirm(warn)) return;

    button.disabled = true;
    button.textContent = 'Linking…';
    const res = await this.api.vaults.link(root);
    button.disabled = false;

    if (!res.ok) {
      this.toast(res.error, 'error');
      await this.load();
      return;
    }
    const look = res.preview || {};
    const skipped = look.skippedTotal || 0;
    this.toast(
      `Linked · syncing ${plural(look.files || 0, 'document', 'documents')}`
      + (skipped ? ` · ${plural(skipped, 'other file', 'other files')} left alone` : ''),
    );
    await this.load();
  }

  async unlinkVault(vault) {
    const warn = `Unlink “${vault.name}” from your account?\n\n`
      + 'Nothing is deleted. The folder stays on this computer with every note '
      + 'in it, and the copy in your account stays there too — so it goes on '
      + 'using storage until you delete it from your account.';
    if (!window.confirm(warn)) return;
    const res = await this.api.vaults.unlink(vault.root);
    if (!res.ok) return this.toast(res.error, 'error');
    this.toast(`“${vault.name}” is no longer syncing`);
    return this.load();
  }

  async renameVault(vault) {
    const name = window.prompt('Name for this vault', vault.name);
    if (name === null) return undefined;
    const clean = name.trim();
    if (!clean) return this.toast('Give the vault a name', 'error');
    const res = await this.api.vaults.rename(vault.root, clean);
    if (!res.ok) return this.toast(res.error, 'error');
    // The name in the account was fixed when the vault was linked, and a
    // rename here does not move documents that are already up there.
    return this.load();
  }

  // ---------- the vaults in the account ----------

  drawRemotes() {
    const section = el('section', { class: 'vault-section' });
    section.append(el('h3', { text: 'In your account' }));

    if (!this.remotes) {
      section.append(el('p', { class: 'vault-note', text: 'Checking…' }));
      return section;
    }
    if (!this.remotes.length) {
      section.append(el('p', {
        class: 'vault-note',
        text: 'No vaults here yet. Link one on this computer and it appears here, '
          + 'ready to put on your other computers.',
      }));
      return section;
    }

    section.append(el('p', {
      class: 'vault-hint',
      text: 'Put one of these on this computer. Plume makes the folder and downloads what is in it.',
    }));

    for (const remote of this.remotes) {
      const row = el('div', { class: 'vault-row' });
      const label = el('div', { class: 'vault-row-main' });
      label.append(el('b', { text: remote.name || 'Loose documents' }));
      label.append(el('span', {
        text: `${plural(remote.documents, 'document', 'documents')} · ${bytes(remote.bytes)}`
          + (remote.onThisComputer ? ' · on this computer' : ''),
      }));

      const acts = el('div', { class: 'vault-row-acts' });
      if (!remote.onThisComputer && remote.name) {
        const clone = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Put it here' });
        clone.addEventListener('click', () => this.cloneRemote(remote.name, clone));
        acts.append(clone);
      }
      if (remote.name) {
        const del = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Delete' });
        del.addEventListener('click', () => this.deleteRemote(remote, del));
        acts.append(del);
      }

      row.append(label, acts);
      section.append(row);
    }
    return section;
  }

  async cloneRemote(name, button) {
    button.disabled = true;
    button.textContent = 'Downloading…';
    try {
      const res = await this.api.vaults.clone(name);
      if (!res || res.canceled) return;
      if (!res.ok) {
        this.toast(res.error || 'Could not put that vault here', 'error');
        return;
      }
      this.toast(`“${name}” is now in ${res.folder}`);
      await this.load();
    } finally {
      button.disabled = false;
      button.textContent = 'Put it here';
    }
  }

  async deleteRemote(remote, button) {
    const warn = `Delete “${remote.name}” from your account?\n\n`
      + `${plural(remote.documents, 'document', 'documents')} (${bytes(remote.bytes)}) are removed `
      + 'from the cloud and the space is freed. Copies on your computers are '
      + 'left exactly where they are, and stop syncing.\n\nThis cannot be undone.';
    if (!window.confirm(warn)) return;

    button.disabled = true;
    button.textContent = 'Deleting…';
    const res = await this.api.vaults.deleteRemote(remote.name);
    button.disabled = false;
    button.textContent = 'Delete';

    if (!res.ok) return this.toast(res.error, 'error');
    this.toast(`Removed ${plural(res.removed, 'document', 'documents')} from your account`);
    return this.load();
  }

  // ---------- the vaults on this computer ----------

  drawKnown() {
    const known = (this.view && this.view.known) || [];
    const here = this.view && this.view.vault ? this.view.vault.root : null;
    const others = known.filter(v => v.root !== here);
    if (!others.length) return null;

    const section = el('section', { class: 'vault-section' });
    section.append(el('h3', { text: 'Your other vaults' }));

    for (const vault of others) {
      const row = el('div', { class: 'vault-row' });
      const label = el('div', { class: 'vault-row-main' });
      const name = el('b', { text: vault.name });
      name.title = vault.root;
      label.append(name);
      label.append(el('span', {
        text: vault.linked
          ? `Linked${vault.lastSyncAt ? ` · synced ${when(vault.lastSyncAt)}` : ''}`
          : 'On this computer only',
      }));

      const open = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Open' });
      open.addEventListener('click', async () => {
        const res = await this.api.vaults.open(vault.root);
        if (!res.ok) {
          this.toast(res.error, 'error');
          await this.load();
          return;
        }
        this.toast(`Opened “${vault.name}”`);
        await this.load();
      });

      row.append(label, el('div', { class: 'vault-row-acts' }, open));
      section.append(row);
    }
    return section;
  }

  // ---------- what is actually up there ----------

  drawFiles() {
    const section = el('section', { class: 'vault-section' });

    const head = el('div', { class: 'vault-section-head' });
    head.append(el('h3', { text: 'All synced documents' }));
    if (this.files.length) {
      const graph = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Graph' });
      graph.addEventListener('click', () => this.onGraph());
      head.append(graph);
    }
    section.append(head);

    if (!this.files.length) {
      section.append(el('p', {
        class: 'vault-note',
        text: 'Nothing here yet. Link a vault and what is in it appears here.',
      }));
      return section;
    }

    section.append(this.drawTree(treeOf(this.files)));
    return section;
  }

  /**
   * The account as its folders, not as a list of paths.
   *
   * The top level of this tree is the vaults: every document in a linked vault
   * is named under that vault's name, which is what keeps two vaults holding a
   * `Notes/today.md` each from ever meeting.
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

    const open = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Save a copy' });
    open.addEventListener('click', async () => {
      open.disabled = true;
      const res = await this.api.vault.pull(file.path);
      open.disabled = false;
      if (!res.ok) this.toast(res.error, 'error');
    });

    const del = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Delete' });
    del.addEventListener('click', async () => {
      if (!window.confirm(`Delete “${file.path}” from your account? This cannot be undone.`)) return;
      const res = await this.api.vault.remove(file.path);
      if (!res.ok) return this.toast(res.error, 'error');
      this.toast('Deleted');
      return this.load();
    });

    row.append(info, el('div', { class: 'vault-row-acts' }, open, del));
    return row;
  }

  // A loose document is never pushed from here. That is not an omission: the
  // guarantee that a file outside a vault can never reach the cloud is only
  // worth having if there is no button that quietly breaks it. To sync
  // something, put it in a vault and link the vault.
}
