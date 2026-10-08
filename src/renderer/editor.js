// Editing.
//
// Plume keeps one buffer per open document: the raw Markdown, in a plain
// textarea — no hidden rich-text model, no transformation on the way in or
// out, so what you save is exactly what you typed. Two things write into it:
//
//   · live preview (live.js), a block at a time, with the document rendered
//   · source mode, the whole file as text, which is this textarea on show
//
// Because it is the same buffer, the unsaved mark, Ctrl+S and the handling of
// a file that changes on disk work the same whichever way you are typing, and
// switching between them loses nothing.
//
// The rules that matter:
//   · nothing is written to disk until you ask
//   · an unsaved change is never thrown away silently
//   · while there are unsaved changes, a file changed elsewhere does not
//     overwrite them — you are told, and you choose

import { el } from './util.js';
import { markdownKeys } from './mdkeys.js';

export class Editor {
  /**
   * @param {object} options
   * @param {HTMLElement} options.host     where the textarea goes
   * @param {object} options.api           the preload bridge
   * @param {Function} options.toast       the notification helper
   * @param {Function} options.onModeChange called with (sourceMode, dirty)
   * @param {Function} options.onSaved     called after a successful save
   * @param {Function} options.onHide      called when source mode is left
   */
  constructor({ host, api, toast, onModeChange, onSaved, onHide }) {
    this.host = host;
    this.api = api;
    this.toast = toast;
    this.onModeChange = onModeChange || (() => {});
    this.onSaved = onSaved || (() => {});
    this.onHide = onHide || (() => {});

    // A buffer is open (either way of editing), and the big textarea is on
    // show (source mode). The second implies the first.
    this.editing = false;
    this.source = false;
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
    this.onModeChange(this.source, this.dirty);
  }

  /** True when there is unsaved work that would be lost. */
  get hasUnsaved() {
    return this.editing && this.dirty;
  }

  /** The current text, for rendering the document or for saving it. */
  get value() {
    return this.area.value;
  }

  /** Text typed elsewhere — live preview — for this same document. */
  setValue(text) {
    if (!this.editing || text === this.area.value) return;
    this.area.value = text;
    this.touched();
  }

  // ---------- turning it on and off ----------

  /** Opens a buffer on `doc` without showing it: live preview types here. */
  open(doc) {
    if (this.editing && this.path === doc.path) return;
    this.path = doc.path;
    this.original = doc.content;
    this.area.value = doc.content;
    this.dirty = false;
    this.editing = true;
    this.onModeChange(this.source, false);
  }

  /** Points an open buffer at another document, with nothing unsaved. */
  retarget(doc) {
    if (!this.editing) return;
    this.path = doc.path;
    this.original = doc.content;
    this.area.value = doc.content;
    this.dirty = false;
    this.pendingExternal = null;
    this.onModeChange(this.source, false);
  }

  /** Shows the whole document as text (source mode). */
  start(doc) {
    this.open(doc);
    this.source = true;
    this.area.hidden = false;
    document.body.classList.add('is-editing');
    this.onModeChange(true, this.dirty);
    // Put the caret where the reader was looking, near enough: the top.
    this.area.focus({ preventScroll: true });
    this.area.setSelectionRange(0, 0);
    this.area.scrollTop = 0;
  }

  /**
   * Hides the source textarea and goes back to the rendered document. The
   * buffer stays, so unsaved text is not lost — the document is rendered from
   * it, and the unsaved mark says why it does not match the file yet.
   */
  hide() {
    if (!this.source) return;
    this.source = false;
    this.area.hidden = true;
    document.body.classList.remove('is-editing');
    this.onModeChange(false, this.dirty);
    this.onHide();
  }

  /**
   * Closes the buffer altogether. Returns false when the reader said no to
   * losing work, so the caller knows nothing happened.
   */
  stop({ force = false } = {}) {
    if (this.hasUnsaved && !force) {
      const leave = window.confirm(
        'This document has changes that have not been saved.\n\n'
        + 'Close it and lose them?',
      );
      if (!leave) return false;
    }
    this.editing = false;
    this.source = false;
    this.dirty = false;
    this.area.hidden = true;
    this.area.value = '';
    this.original = '';
    this.pendingExternal = null;
    document.body.classList.remove('is-editing');
    this.onModeChange(false, false);
    return true;
  }

  // ---------- saving ----------

  async save() {
    if (!this.editing) return false;
    if (!this.dirty) {
      this.toast('Nothing to save');
      return true;
    }

    const content = this.area.value;
    // The path this editing session started on, not whatever the window has
    // navigated to since. The main process refuses the write if they disagree.
    const res = await this.api.saveDoc(this.path, content);

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
      // Back to the rendered document, keeping the text: in source mode Esc
      // is a way of looking at the document, not of throwing work away.
      this.hide();
      return;
    }
    if (markdownKeys(this.area, ev)) this.touched();
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
    this.onModeChange(this.source, false);
    return true;
  }

  keepMine() {
    this.pendingExternal = null;
    // Still different from disk, so still unsaved.
    this.dirty = true;
    this.onModeChange(this.source, true);
  }
}
