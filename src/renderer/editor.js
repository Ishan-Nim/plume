// Editing.
//
// Plume is a reader first, so editing is a mode you turn on rather than the
// state you are always in. The raw Markdown goes into a plain textarea — no
// hidden rich-text model, no transformation on the way in or out, so what you
// save is exactly what you typed.
//
// The rules that matter:
//   · nothing is written to disk until you ask
//   · an unsaved change is never thrown away silently
//   · while there are unsaved changes, a file changed elsewhere does not
//     overwrite them — you are told, and you choose

import { el } from './util.js';

export class Editor {
  /**
   * @param {object} options
   * @param {HTMLElement} options.host     where the textarea goes
   * @param {object} options.api           the preload bridge
   * @param {Function} options.toast       the notification helper
   * @param {Function} options.onModeChange called with true when editing starts
   * @param {Function} options.onSaved     called after a successful save
   */
  constructor({ host, api, toast, onModeChange, onSaved }) {
    this.host = host;
    this.api = api;
    this.toast = toast;
    this.onModeChange = onModeChange || (() => {});
    this.onSaved = onSaved || (() => {});

    this.editing = false;
    this.dirty = false;
    this.original = '';
    this.path = null;
    this.pendingExternal = null;

    this.area = el('textarea', {
      class: 'editor',
      id: 'editor',
      spellcheck: 'false',
      autocapitalize: 'off',
      autocomplete: 'off',
      'aria-label': 'Edit this document',
      hidden: true,
    });

    this.area.addEventListener('input', () => this.touched());
    this.area.addEventListener('keydown', ev => this.onKey(ev));
    this.host.append(this.area);
  }

  // ---------- state ----------

  touched() {
    const dirty = this.area.value !== this.original;
    if (dirty === this.dirty) return;
    this.dirty = dirty;
    this.onModeChange(this.editing, this.dirty);
  }

  /** True when there is unsaved work that would be lost. */
  get hasUnsaved() {
    return this.editing && this.dirty;
  }

  // ---------- turning it on and off ----------

  start(doc) {
    this.path = doc.path;
    this.original = doc.content;
    this.area.value = doc.content;
    this.dirty = false;
    this.editing = true;
    this.area.hidden = false;
    document.body.classList.add('is-editing');
    this.onModeChange(true, false);
    // Put the caret where the reader was looking, near enough: the top.
    this.area.focus({ preventScroll: true });
    this.area.setSelectionRange(0, 0);
    this.area.scrollTop = 0;
  }

  /**
   * Leaves edit mode. Returns false when the reader said no to losing work, so
   * the caller knows nothing happened.
   */
  stop({ force = false } = {}) {
    if (this.hasUnsaved && !force) {
      const leave = window.confirm(
        'This document has changes that have not been saved.\n\n'
        + 'Leave edit mode and lose them?',
      );
      if (!leave) return false;
    }
    this.editing = false;
    this.dirty = false;
    this.area.hidden = true;
    this.area.value = '';
    this.original = '';
    document.body.classList.remove('is-editing');
    this.onModeChange(false, false);
    return true;
  }

  /** The current text, for rendering a preview or for the caller to save. */
  get value() {
    return this.area.value;
  }

  // ---------- saving ----------

  async save() {
    if (!this.editing) return false;
    if (!this.dirty) {
      this.toast('Nothing to save');
      return true;
    }

    const content = this.area.value;
    const res = await this.api.saveDoc(content);

    if (!res || res.error) {
      this.toast(`Could not save: ${(res && res.error) || 'unknown problem'}`, 'error');
      return false;
    }

    // Anything typed while the write was in flight stays unsaved rather than
    // being quietly marked clean.
    this.original = content;
    this.touched();
    this.onSaved(content);
    this.toast('Saved');
    return true;
  }

  // ---------- keys ----------

  onKey(ev) {
    const mod = ev.ctrlKey || ev.metaKey;

    if (mod && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      this.save();
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.stop();
      return;
    }

    // Tab indents rather than leaving the document — in a Markdown editor that
    // is what the key is for.
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const { selectionStart: start, selectionEnd: end, value } = this.area;

      if (start === end && !ev.shiftKey) {
        this.area.setRangeText('  ', start, end, 'end');
      } else {
        const from = value.lastIndexOf('\n', start - 1) + 1;
        const block = value.slice(from, end);
        const shifted = ev.shiftKey
          ? block.replace(/^ {1,2}/gm, '')
          : block.replace(/^/gm, '  ');
        this.area.setRangeText(shifted, from, end, 'select');
      }
      this.touched();
      return;
    }

    // Enter continues a list, the way every Markdown editor does.
    if (ev.key === 'Enter' && !ev.shiftKey && !mod) {
      const { selectionStart: start, value } = this.area;
      if (start !== this.area.selectionEnd) return;
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const line = value.slice(lineStart, start);
      const marker = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+\[[ xX]\])?\s+/.exec(line);
      if (!marker) return;

      // A marker with nothing after it means the list is finished.
      if (line.length === marker[0].length) {
        ev.preventDefault();
        this.area.setRangeText('\n', lineStart, start, 'end');
        this.touched();
        return;
      }

      ev.preventDefault();
      const indent = marker[1];
      const box = marker[5] ? ' [ ]' : '';
      const next = marker[2]
        ? `${indent}${marker[2]}${box} `
        : `${indent}${parseInt(marker[3], 10) + 1}${marker[4]}${box} `;
      this.area.setRangeText(`\n${next}`, start, start, 'end');
      this.touched();
    }
  }

  // ---------- the file changing underneath ----------

  /**
   * Something else wrote to this document. With no unsaved work the caller
   * reloads as usual; with unsaved work nothing is overwritten — the change is
   * held and the reader decides.
   */
  externalChange(content) {
    if (!this.editing) return 'reload';
    if (!this.dirty) {
      this.original = content;
      this.area.value = content;
      return 'handled';
    }
    this.pendingExternal = content;
    return 'conflict';
  }

  takeExternal() {
    const content = this.pendingExternal;
    this.pendingExternal = null;
    if (content === null || content === undefined) return false;
    this.original = content;
    this.area.value = content;
    this.dirty = false;
    this.onModeChange(true, false);
    return true;
  }

  keepMine() {
    this.pendingExternal = null;
    // Still different from disk, so still unsaved.
    this.dirty = true;
    this.onModeChange(true, true);
  }
}
