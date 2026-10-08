// The Git sync panel.
//
// One folder, one remote, and a button. Everything it says comes from the real
// repository — branch, what has changed, what is ahead or behind — because the
// whole point of driving the system git is that this never has to guess.
//
// Credentials are never asked for here. If git cannot authenticate it says so,
// and the fix is the same one that would fix it in a terminal.

import { el } from './util.js';

export class GitPanel {
  constructor(api, toast) {
    this.api = api;
    this.toast = toast;
    this.state = null;
    this.busy = false;

    this.root = el('div', { class: 'git-panel' });
    this.api.onGitChanged(payload => {
      this.state = payload;
      if (payload.lastResult && payload.automatic && !payload.lastResult.ok) {
        this.toast(`Git sync: ${payload.lastResult.error}`, 'error');
      }
      this.render();
    });
  }

  async open() {
    this.state = await this.api.git.state();
    this.render();
    return this.root;
  }

  async act(what, fn) {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      const result = await fn();
      if (result && result.ok === false && result.error) this.toast(result.error, 'error');
      else if (what === 'sync') {
        this.toast(result.pulled || result.pushed ? 'Synced with the remote.' : 'Already up to date.', 'ok');
      }
      this.state = await this.api.git.state();
    } catch (err) {
      this.toast(err.message, 'error');
    } finally {
      this.busy = false;
      this.render();
    }
  }

  render() {
    const s = this.state;
    const rows = [];
    const row = (...kids) => el('div', { class: 'git-row' }, ...kids);

    if (!s) {
      this.root.replaceChildren(el('p', { class: 'git-note', text: 'Looking…' }));
      return;
    }

    // Part of having an account. The main process refuses these calls too;
    // this is only what it looks like.
    if (s.locked) {
      const open = el('button', { class: 'vault-btn primary small', type: 'button', text: 'Open Plume Vault' });
      open.addEventListener('click', () => {
        this.onOpenVault && this.onOpenVault();
      });
      this.root.replaceChildren(
        el('p', { class: 'git-note', text: s.reason || 'Sign in to Plume Vault to use Git sync.' }),
        el('div', { class: 'git-row' }, open),
      );
      return;
    }

    if (s.available && !s.available.ok) {
      this.root.replaceChildren(
        el('p', { class: 'git-note', text: s.available.reason }),
        el('p', { class: 'git-note', text: 'Plume uses the Git already on your machine rather than its own, so your credentials and keys keep working as they do in a terminal. Install Git and open this again.' }),
      );
      return;
    }

    // ---- no folder yet ----
    if (!s.folder) {
      const choose = el('button', { class: 'vault-btn primary small', type: 'button', text: 'Choose a folder…' });
      choose.addEventListener('click', () => this.act('choose', () => this.api.git.choose()));
      this.root.replaceChildren(
        el('p', { class: 'git-note', text: 'Keep a folder of notes in a Git repository: pull what changed elsewhere, commit what changed here, push.' }),
        row(choose),
      );
      return;
    }

    rows.push(el('div', { class: 'git-path', text: s.folder }));

    // ---- a folder, but no repository in it ----
    if (!s.repo) {
      const input = el('input', {
        class: 'git-input', type: 'text', spellcheck: 'false',
        placeholder: 'https://github.com/you/notes.git',
        'aria-label': 'Git remote address',
      });
      const connect = el('button', { class: 'vault-btn primary small', type: 'button', text: 'Connect' });
      connect.addEventListener('click', () => {
        const remote = input.value.trim();
        if (!remote) { this.toast('Type the address of the repository.', 'error'); input.focus(); return; }
        this.act('connect', () => this.api.git.connect(remote));
      });
      const forget = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Choose another' });
      forget.addEventListener('click', () => this.act('forget', () => this.api.git.forget()));

      rows.push(
        el('p', { class: 'git-note', text: s.reason || 'That folder is not a Git repository yet.' }),
        input,
        row(connect, forget),
      );
      this.root.replaceChildren(...rows);
      return;
    }

    // ---- connected ----
    const bits = [`on ${s.branch || 'no branch'}`];
    if (s.ahead) bits.push(`${s.ahead} to push`);
    if (s.behind) bits.push(`${s.behind} to pull`);
    bits.push(s.dirty ? `${s.changed.length} changed` : 'nothing changed');

    rows.push(
      el('div', { class: 'git-remote', text: s.remote || 'no remote' }),
      el('div', { class: 'git-note', text: bits.join(' · ') }),
    );
    if (s.lastCommit) rows.push(el('div', { class: 'git-note dim', text: s.lastCommit }));

    const now = el('button', {
      class: 'vault-btn primary small', type: 'button',
      text: this.busy ? 'Syncing…' : 'Sync now', disabled: this.busy,
    });
    now.addEventListener('click', () => this.act('sync', () => this.api.git.sync()));

    const forget = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Stop' });
    forget.addEventListener('click', () => this.act('forget', () => this.api.git.forget()));
    rows.push(row(now, forget));

    this.root.replaceChildren(...rows);
  }
}
