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

// The vault will not send a second code to an address within a minute of the
// first, so "Resend code" waits that long too rather than pretending to send.
const RESEND_SECONDS = 60;
const PASSWORD_HINT = 'At least 10 characters, with a number or symbol.';
const CODE_PROBLEM = 'Enter the 6-digit code from the email.';

/**
 * Six digits out of whatever was typed or pasted: "123 456", "123-456",
 * full-width digits from a Japanese input method, or the whole line copied out
 * of the email. The main process checks again; this only keeps the box tidy.
 */
export function codeDigits(raw) {
  const squeezed = String(raw == null ? '' : raw)
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s-]/g, '');
  const run = /(?<!\d)\d{6}(?!\d)/.exec(squeezed);
  return run ? run[0] : squeezed.replace(/\D/g, '').slice(0, 6);
}

/** Whole seconds until another code may be asked for. */
export function resendWait(sentAt, now = Date.now()) {
  if (!Number.isFinite(sentAt)) return 0;
  return Math.max(0, Math.ceil((sentAt + RESEND_SECONDS * 1000 - now) / 1000));
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
    // How far each tab has got, so switching tabs and back does not lose a
    // code that is already on its way:
    //   signup  null, or { email, password, note, minutes, sentAt } once sent
    //   reset   null, { stage: 'email' }, or { stage: 'code', email, note, sentAt }
    // The password is only here for "Resend code", and goes when the step does.
    this.flow = { signup: null, reset: null };
    this.draft = { email: '' };
    this.notice = null;
    this.state = null;
    this.files = [];
    this.links = {};
    this.loaded = false;
    this.busy = false;
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

  /**
   * @param {object} [options]
   * @param {string} [options.notice]  something the vault said that should stay
   *   on screen until the next reload, such as "every other device was signed out"
   */
  async load({ notice = null } = {}) {
    this.notice = notice;
    this.state = await this.api.vault.state(this.getRoot());
    this.sync = await this.api.sync.state();
    this.loaded = true;

    if (!this.state.signedIn) {
      this.drawAuth();
      return;
    }
    // Signed in: nothing typed into the signed-out forms is wanted any more.
    this.flow = { signup: null, reset: null };
    this.draft = { email: '' };
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
  //
  // Five small forms behind two tabs. "Sign in" also leads to "forgot
  // password" and then to the code that sets a new one; "Create account" leads
  // to the code that finishes creating it. Every code arrives by email, and the
  // vault answers the same whether or not an address has an account, so these
  // forms pass its sentences on rather than guessing at what happened.

  drawAuth(message) {
    if (this.mode === 'signup' && this.flow.signup) return this.drawSignUpCode(message);
    if (this.mode === 'signin' && this.flow.reset) {
      return this.flow.reset.stage === 'code' ? this.drawResetCode(message) : this.drawForgot(message);
    }
    return this.drawCredentials(message);
  }

  /**
   * What every signed-out form shares: the two tabs, a line saying what this
   * step is for, and the error line. That line is on the page from the start,
   * empty: a live region has to exist before it changes for a screen reader to
   * announce the change.
   */
  authForm(intro, message) {
    const form = el('form', { class: 'vault-form' });

    const tabs = el('div', { class: 'vault-tabs' });
    const mk = (key, label) => {
      const b = el('button', { type: 'button', text: label });
      b.setAttribute('aria-pressed', String(this.mode === key));
      b.addEventListener('click', () => {
        if (this.busy) return;
        // The tab you are on leads back to its first form; the other one
        // picks up where it was left.
        if (this.mode === key) this.flow[key === 'signup' ? 'signup' : 'reset'] = null;
        this.mode = key;
        this.drawAuth();
      });
      return b;
    };
    tabs.append(mk('signin', 'Sign in'), mk('signup', 'Create account'));

    const error = el('p', { class: 'vault-error', role: 'alert', text: message || '' });
    form.append(tabs, el('p', { class: 'vault-note', text: intro }), error);
    return { form, error };
  }

  /** Puts a sentence in a form's error line, and the cursor where it can be fixed. */
  say(error, text, field) {
    error.textContent = text || 'The vault is not available.';
    if (field) field.focus();
  }

  /**
   * Runs one request from a form: its button says what is happening, and a
   * second press while it runs does nothing. Resolves to the main process's
   * answer, or null when another request was already running.
   */
  async attempt(button, busyLabel, ask) {
    if (this.busy) return null;
    this.busy = true;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
    try {
      return await ask();
    } finally {
      this.busy = false;
      button.disabled = false;
      button.textContent = label;
    }
  }

  /** The address box, remembering what was typed from one step to the next. */
  emailInput() {
    const input = el('input', {
      type: 'email', id: 'vault-email', autocomplete: 'email',
      placeholder: 'you@example.com', required: true, value: this.draft.email || null,
    });
    input.addEventListener('input', () => { this.draft.email = input.value.trim(); });
    return input;
  }

  passwordInput(fresh) {
    return el('input', {
      type: 'password', id: 'vault-password', placeholder: '••••••••••', required: true,
      autocomplete: fresh ? 'new-password' : 'current-password',
      'aria-describedby': fresh ? 'vault-pw-hint' : null,
    });
  }

  /**
   * The box a code from an email goes in. One field rather than six: it takes
   * a paste in one go, the system can fill it from the message, and a screen
   * reader announces it as what it is.
   */
  codeInput() {
    const input = el('input', {
      type: 'text', id: 'vault-code', class: 'vault-code',
      inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6',
      placeholder: '6 digits', required: true, spellcheck: 'false',
      'aria-describedby': 'vault-code-hint',
    });
    const tidy = () => {
      const clean = codeDigits(input.value);
      if (clean !== input.value) input.value = clean;
    };
    // Rewriting the box mid-composition would break an input method's word.
    input.addEventListener('input', ev => { if (!ev.isComposing) tidy(); });
    input.addEventListener('compositionend', tidy);
    // maxlength would cut a pasted "123 456" to "123 45" before tidy saw it.
    input.addEventListener('paste', ev => {
      const text = ev.clipboardData ? ev.clipboardData.getData('text') : '';
      if (!text) return;
      ev.preventDefault();
      input.value = codeDigits(text);
    });
    return input;
  }

  /** Where to look for the code, under the box it goes in. */
  codeHint(flow) {
    const life = flow.minutes ? ` The code works for ${flow.minutes} minutes.` : '';
    return el('span', {
      class: 'vault-hint', id: 'vault-code-hint',
      text: `Look in the inbox for ${flow.email}, and in spam if it is not there after a minute.${life}`,
    });
  }

  /**
   * "Resend code". It waits out the minute in which the vault would ignore a
   * second request anyway, and counts down so the wait does not look broken.
   * Each button owns its countdown and stops it once the form is gone.
   */
  resendButton(flow, ask, error, status) {
    const button = el('button', { class: 'vault-btn ghost small', type: 'button' });

    const paint = () => {
      const left = resendWait(flow.sentAt);
      button.disabled = left > 0;
      button.textContent = left > 0 ? `Resend code (${left})` : 'Resend code';
      return left;
    };
    const arm = () => {
      if (!paint()) return;
      const timer = setInterval(() => {
        if (!button.isConnected || !paint()) clearInterval(timer);
      }, 1000);
    };

    button.addEventListener('click', async () => {
      const res = await this.attempt(button, 'Sending…', ask);
      if (!res) return;
      if (!res.ok) {
        paint();
        return this.say(error, res.error);
      }
      flow.sentAt = Date.now();
      if (res.note) flow.note = res.note;
      error.textContent = '';
      status.textContent = 'Sent again. Only the newest code works.';
      arm();
    });

    arm();
    return button;
  }

  /** Sign in, or the first step of creating an account. */
  drawCredentials(message) {
    const signup = this.mode === 'signup';
    const { form, error } = this.authForm(signup
      ? 'A free account gives you a 100 MB vault for syncing documents between your computers.'
      : 'Sign in to sync documents between your computers.', message);

    const email = this.emailInput();
    const password = this.passwordInput(signup);
    const submit = el('button', {
      class: 'vault-btn primary', type: 'submit',
      text: signup ? 'Create my vault' : 'Sign in',
    });

    form.append(
      el('label', { for: 'vault-email', class: 'vault-label', text: 'Email' }),
      email,
      el('label', { for: 'vault-password', class: 'vault-label', text: 'Password' }),
      password,
    );
    if (signup) form.append(el('span', { class: 'vault-hint', id: 'vault-pw-hint', text: PASSWORD_HINT }));
    form.append(submit);

    if (!signup) {
      const forgot = el('button', { class: 'vault-link', type: 'button', text: 'Forgot password?' });
      forgot.addEventListener('click', () => {
        if (this.busy) return;
        this.draft.email = email.value.trim();
        this.flow.reset = { stage: 'email' };
        this.drawAuth();
      });
      form.append(forgot);
    }

    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const address = email.value.trim();
      const secret = password.value;
      const res = await this.attempt(submit, signup ? 'Sending a code…' : 'Signing in…', () => (signup
        ? this.api.vault.signUpStart(address, secret)
        : this.api.vault.signIn(address, secret)));
      if (!res) return;
      if (!res.ok) return this.say(error, res.error, signup ? null : password);

      if (signup) {
        this.flow.signup = {
          email: address, password: secret, note: res.note, minutes: res.minutes, sentAt: Date.now(),
        };
        this.drawAuth();
        return;
      }
      this.toast('Signed in to your vault');
      await this.load();
    });

    this.render(form);
  }

  /** The second step of creating an account: the code from the email. */
  drawSignUpCode(message) {
    const flow = this.flow.signup;
    const { form, error } = this.authForm(
      flow.note || 'We sent a 6-digit code to that address. Enter it to finish creating your vault.',
      message,
    );
    const status = el('p', { class: 'vault-status', role: 'status' });

    const code = this.codeInput();
    const submit = el('button', { class: 'vault-btn primary', type: 'submit', text: 'Create my vault' });
    const resend = this.resendButton(flow, () => this.api.vault.signUpStart(flow.email, flow.password), error, status);
    const other = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Use a different email' });

    form.append(
      el('label', { for: 'vault-code', class: 'vault-label', text: 'Code from the email' }),
      code,
      this.codeHint(flow),
      submit,
      el('div', { class: 'vault-row-acts' }, resend, other),
      status,
    );

    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const digits = codeDigits(code.value);
      if (digits.length !== 6) return this.say(error, CODE_PROBLEM, code);

      const res = await this.attempt(submit, 'Checking…', () => this.api.vault.signUpVerify(flow.email, digits));
      if (!res) return;
      if (!res.ok) {
        if (res.status === 409) {
          // The account exists after all — made on another computer while
          // this code was on its way, most likely. Signing in is the way on.
          this.flow.signup = null;
          this.draft.email = flow.email;
          this.mode = 'signin';
          this.drawAuth(res.error);
          return;
        }
        code.value = '';
        return this.say(error, res.error, code);
      }
      this.flow.signup = null;
      this.toast('Vault created');
      await this.load();
    });

    other.addEventListener('click', () => {
      if (this.busy) return;
      this.draft.email = flow.email;
      this.flow.signup = null;
      this.drawAuth();
      const box = this.root.querySelector('#vault-email');
      if (box) box.focus();
    });

    this.render(form);
    code.focus();
  }

  /** "Forgot password?": which address to send the code to. */
  drawForgot(message) {
    const { form, error } = this.authForm(
      'Enter the address you signed up with. Plume will email you a 6-digit code for choosing a new password.',
      message,
    );

    const email = this.emailInput();
    const submit = el('button', { class: 'vault-btn primary', type: 'submit', text: 'Email me a code' });
    const back = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Back to sign in' });

    form.append(
      el('label', { for: 'vault-email', class: 'vault-label', text: 'Email' }),
      email,
      submit,
      el('div', { class: 'vault-row-acts' }, back),
    );

    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const address = email.value.trim();
      const res = await this.attempt(submit, 'Sending…', () => this.api.vault.forgot(address));
      if (!res) return;
      if (!res.ok) return this.say(error, res.error, email);
      this.flow.reset = { stage: 'code', email: address, note: res.note, sentAt: Date.now() };
      this.drawAuth();
    });

    back.addEventListener('click', () => {
      if (this.busy) return;
      this.flow.reset = null;
      this.drawAuth();
    });

    this.render(form);
    email.focus();
  }

  /** The code from the reset email, and the new password it unlocks. */
  drawResetCode(message) {
    const flow = this.flow.reset;
    const { form, error } = this.authForm(
      flow.note || 'If there is an account for that address, a 6-digit code and a link are on their way.',
      message,
    );
    const status = el('p', { class: 'vault-status', role: 'status' });

    const code = this.codeInput();
    const password = this.passwordInput(true);
    const submit = el('button', { class: 'vault-btn primary', type: 'submit', text: 'Set password and sign in' });
    const resend = this.resendButton(flow, () => this.api.vault.forgot(flow.email), error, status);
    const other = el('button', { class: 'vault-btn ghost small', type: 'button', text: 'Use a different email' });

    form.append(
      el('label', { for: 'vault-code', class: 'vault-label', text: 'Code from the email' }),
      code,
      this.codeHint(flow),
      el('label', { for: 'vault-password', class: 'vault-label', text: 'New password' }),
      password,
      el('span', { class: 'vault-hint', id: 'vault-pw-hint', text: PASSWORD_HINT }),
      submit,
      el('div', { class: 'vault-row-acts' }, resend, other),
      status,
    );

    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const digits = codeDigits(code.value);
      if (digits.length !== 6) return this.say(error, CODE_PROBLEM, code);

      const res = await this.attempt(submit, 'Saving…', () => (
        this.api.vault.resetWithCode(flow.email, digits, password.value)
      ));
      if (!res) return;
      if (!res.ok) {
        // The vault checks the password before it spends the code, so a
        // password it would not take leaves the code good: keep it, and put
        // the cursor on the password instead.
        if (/\bcode\b/i.test(res.error || '')) {
          code.value = '';
          return this.say(error, res.error, code);
        }
        return this.say(error, res.error, password);
      }
      this.flow.reset = null;
      this.toast('New password set');
      await this.load({ notice: res.note });
    });

    other.addEventListener('click', () => {
      if (this.busy) return;
      this.draft.email = flow.email;
      this.flow.reset = { stage: 'email' };
      this.drawAuth();
    });

    this.render(form);
    code.focus();
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
    if (this.notice) parts.push(el('p', { class: 'vault-status', role: 'status', text: this.notice }));
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
          text: 'Choose one folder and Plume keeps everything in it — notes, images and sub-folders — in your vault, by itself.',
        }),
        el('p', {
          class: 'vault-hint',
          text: 'Only documents and images are uploaded. Programs, installers and archives are never sent.',
        }),
      );
      const choose = el('button', { class: 'vault-btn primary small', type: 'button', text: 'Choose a folder…' });
      choose.addEventListener('click', () => this.chooseFolder(choose));
      section.append(el('div', { class: 'vault-row-acts' }, choose));
      return section;
    }

    const name = sync.folder.replace(/[\/]+$/, '').split(/[\/]/).pop() || sync.folder;
    const info = el('div', { class: 'vault-current-info' });
    const title = el('b', { text: name });
    title.title = sync.folder;
    info.append(title, el('span', { text: this.syncLine(sync) }));
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

    acts.append(now, pause, open, forget);
    section.append(acts);
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
