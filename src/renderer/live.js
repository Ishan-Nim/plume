// Live preview — editing without leaving the page you are reading.
//
// The document stays rendered. Click a paragraph and that paragraph alone
// becomes the Markdown it was written as; move away and it is a paragraph
// again. Nothing else on the page changes shape, so the text you were reading
// does not move under you.
//
// How a block knows which lines are its own: markdown.js stamps every
// top-level block with the half-open line range it came from
// (data-plume-src). Editing a block therefore only ever replaces those lines,
// and the rest of the file is passed through untouched — including anything
// Plume does not render at all.
//
// The rules of editing are still the editor's: the text goes into the same
// buffer source mode uses, so the unsaved mark, Ctrl+S, and the handling of a
// file that changes on disk are the same in both.

import { el } from './util.js';
import { srcRange } from './markdown.js';
import { BlockEditor } from './blockedit.js';
import {
  splitLines, lineEnding, sourceOffset, clickedTextOffset, blockText,
} from './mdkeys.js';

// Blocks whose rendered form is the whole point of them: a stray click must
// not replace a diagram with its source.
const NOT_EDITABLE = '.mermaid-block, .math-block, .properties, .footnotes';

// Things that are controls or someone else's text, not a place to type.
const NOT_FROM = 'a, button, summary, input, .code-copy, .code-head, .wiki-transclude';

export class LivePreview {
  /**
   * @param {object} options
   * @param {HTMLElement} options.host      the rendered document (#doc)
   * @param {HTMLElement} options.scroller  the pane it scrolls in
   * @param {Function} options.read         the document's text, as it stands
   * @param {Function} options.write        hand back changed text
   * @param {Function} options.rerender     render the document from that text
   * @param {Function} options.enabled      whether clicks should edit at all
   */
  constructor({ host, scroller, read, write, rerender, enabled }) {
    this.host = host;
    this.scroller = scroller;
    this.read = read;
    this.write = write;
    this.rerender = rerender;
    this.enabled = enabled || (() => true);

    this.area = null;
    this.block = null;
    this.from = 0;
    this.to = 0;
    this.src = '';
    this.text = '';
    this.before = [];
    this.after = [];
    this.eol = '\n';
    this.temporary = false;
    this.busy = false;
    // A close started by losing focus runs while the click that caused it is
    // still being delivered; whoever comes next waits for it.
    this.closing = null;
  }

  get active() {
    return !!this.area;
  }

  // ---------- finding the block a click means ----------

  /** The top-level blocks of the document, in order, editable or not. */
  blocks() {
    return [...this.host.children].filter(n => n.dataset && srcRange(n.dataset.plumeSrc));
  }

  editableFrom(target) {
    if (!target || !target.closest) return null;
    if (target.closest(NOT_FROM)) return null;
    const block = target.closest('[data-plume-src]');
    if (!block || block.parentElement !== this.host) return null;
    if (block.matches(NOT_EDITABLE) || !srcRange(block.dataset.plumeSrc)) return null;
    return block;
  }

  blockFrom(line) {
    for (const block of this.blocks()) {
      const range = srcRange(block.dataset.plumeSrc);
      if (range && range[0] === line) return block;
    }
    return null;
  }

  // A click in the document's own padding: beside a block, or past the end of
  // the document — where a reader expects to be able to keep writing.
  paddingTarget(ev) {
    const blocks = this.blocks().filter(b => !b.matches(NOT_EDITABLE));
    if (!blocks.length) return 'append';
    const last = blocks[blocks.length - 1].getBoundingClientRect();
    if (ev.clientY > last.bottom) return 'append';
    for (const block of blocks) {
      const r = block.getBoundingClientRect();
      if (ev.clientY >= r.top && ev.clientY <= r.bottom) return block;
    }
    return null;
  }

  /**
   * Offered every click on the document before anything else looks at it.
   * @returns {boolean} true when the click became an edit.
   */
  click(ev) {
    if (!this.enabled()) return false;
    if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return false;
    // A drag that selected text, or a double-click that selected a word, is a
    // reader's gesture; leave the selection alone.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && String(selection).trim()) return false;

    let block = this.editableFrom(ev.target);
    let offset = block ? clickedTextOffset(block, ev.clientX, ev.clientY) : null;

    if (!block && ev.target === this.host) {
      const target = this.paddingTarget(ev);
      if (target === 'append') {
        this.append().catch(console.error);
        return true;
      }
      block = target;
    }
    if (!block) return false;

    const range = srcRange(block.dataset.plumeSrc);
    this.openAt({ from: range[0], offset }).catch(console.error);
    return true;
  }

  // ---------- opening and closing ----------

  /**
   * Edits the block that starts at source line `from`, closing whatever was
   * open first. `offset` is where in the rendered text the caret should land;
   * null puts it at the end of the block.
   */
  async openAt(want) {
    if (this.busy) return false;
    this.busy = true;
    try {
      // The click that asked for this block may well be the same click that
      // closed the last one, and that close is already under way.
      const closed = await this.close();
      let target = want;
      // Lines moved: a block below the one just edited starts elsewhere now.
      if (closed && closed.delta && target.from >= closed.to) {
        target = { ...target, from: target.from + closed.delta };
      }
      const block = this.blockFrom(target.from);
      return block ? this.begin(block, target.offset) : false;
    } finally {
      this.busy = false;
    }
  }

  begin(block, offset) {
    const range = srcRange(block.dataset.plumeSrc);
    if (!range) return false;
    const text = this.read();
    const lines = splitLines(text);
    const from = range[0];
    const to = Math.min(range[1], lines.length);
    if (from >= lines.length) return false;
    const src = lines.slice(from, to).join('\n');
    const rendered = blockText(block);
    this.mount(block, { src, from, to, lines, text, temporary: false });
    const caret = offset == null ? src.length : sourceOffset(src, rendered, offset);
    this.area.setSelectionRange(caret, caret);
    return true;
  }

  /** Starts a new, empty block at the end of the document. */
  async append() {
    if (this.busy) return false;
    this.busy = true;
    try {
      await this.close();
      const text = this.read();
      const lines = splitLines(text);
      // A blank line between the last block and the new one, or the two would
      // be read as a single paragraph.
      if (lines.length && lines[lines.length - 1].trim()) lines.push('');
      const at = lines.length;
      const block = el('p', { class: 'live-new' });
      this.host.append(block);
      this.mount(block, { src: '', from: at, to: at, lines, text, temporary: true });
      return true;
    } finally {
      this.busy = false;
    }
  }

  // Puts an editor where the block is and hands it the block's Markdown.
  mount(block, { src, from, to, lines, text, temporary }) {
    const area = new BlockEditor({
      text: src,
      tag: block.tagName.toLowerCase(),
      isCode: block.classList.contains('code-block'),
      onInput: value => this.write(this.compose(value)),
      onKey: ev => this.onKey(ev),
      // Moving away is how you go back to reading — including by clicking
      // somewhere else entirely.
      //
      // Only while this is still the block being edited. Losing focus is
      // reported after the event that caused it, so when the cause was a click
      // on another block, that click has already closed this one and opened
      // the next by the time this runs — and closing again would shut the
      // block the reader just asked for.
      onBlur: () => {
        if (this.area === area) this.close().catch(console.error);
      },
    });

    block.classList.add('live-hidden');
    block.insertAdjacentElement('beforebegin', area.dom);

    this.area = area;
    this.block = block;
    this.from = from;
    this.to = to;
    this.src = src;
    this.text = text;
    this.before = lines.slice(0, from);
    this.after = lines.slice(to);
    this.eol = lineEnding(text);
    this.temporary = temporary;
    document.body.classList.add('is-live-editing');

    area.focus();
    area.dom.scrollIntoView({ block: 'nearest' });
  }

  /** The whole document with the block being edited as it now stands. */
  compose(value) {
    return [...this.before, ...splitLines(value), ...this.after].join(this.eol);
  }

  /**
   * Back to reading. Returns what moved — the range that was edited and how
   * many lines it grew or shrank by — so a caller that already knows where
   * another block was can find it again.
   */
  close(options) {
    if (!this.area) return this.closing || Promise.resolve(null);
    const done = this.finish(options);
    this.closing = done;
    // Only until it settles: the next close must not resolve from this one.
    done.catch(() => {}).then(() => {
      if (this.closing === done) this.closing = null;
    });
    return done;
  }

  async finish({ render = true } = {}) {
    const area = this.area;
    const { block, from, to, src, text, temporary } = this;
    const value = area.value;
    const changed = value !== src;

    this.area = null;
    this.block = null;
    document.body.classList.remove('is-live-editing');
    area.dom.remove();
    area.destroy();
    // On a change the whole document is rendered again, so the stale copy of
    // this block stays hidden until it is replaced rather than flashing back.
    if (temporary) block.remove();
    else if (!changed) block.classList.remove('live-hidden');

    if (!changed) {
      // Typed and then undone by hand: the document is as it was, and must be
      // handed back as it was rather than left with the stray blank lines an
      // emptied block leaves behind.
      if (this.read() !== text) this.write(text);
      return { from, to, delta: 0 };
    }
    const delta = splitLines(value).length - (to - from);
    if (render) await this.rerender();
    return { from, to, delta };
  }

  /** Drops an open block editor without keeping what it held. */
  discard() {
    const area = this.area;
    if (!area) return;
    const { block, temporary } = this;
    this.area = null;
    this.block = null;
    document.body.classList.remove('is-live-editing');
    area.dom.remove();
    area.destroy();
    if (temporary) block.remove();
    else block.classList.remove('live-hidden');
  }

  // ---------- keys ----------

  onKey(ev) {
    const area = this.area;
    if (!area) return;
    const mod = ev.ctrlKey || ev.metaKey;

    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      this.close().then(() => this.scroller.focus({ preventScroll: true })).catch(console.error);
      return;
    }

    // Arrow keys carry on into the next block, the way they would if the
    // whole document were one editor. Whether the caret can still move inside
    // this block is a question only the browser can answer — soft-wrapped
    // lines make counting newlines useless — so let it try, then look.
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(ev.key)) {
      if (mod || ev.shiftKey || ev.altKey || area.selectionStart !== area.selectionEnd) return;
      const was = area.selectionStart;
      const back = ev.key === 'ArrowUp' || ev.key === 'ArrowLeft';
      setTimeout(() => {
        if (this.area !== area || area.selectionStart !== was) return;
        this.toNeighbour(back ? -1 : 1).catch(console.error);
      }, 0);
      return;
    }

    // Everything else — Enter carrying a list on, Tab indenting, undo — is
    // CodeMirror's, and reaches this.write through the editor's own change
    // listener rather than from here.
  }

  async toNeighbour(dir) {
    const blocks = this.blocks().filter(b => !b.matches(NOT_EDITABLE));
    const i = blocks.indexOf(this.block);
    const next = i >= 0 ? blocks[i + dir] : null;
    if (!next) {
      // Past the last block, start a new one rather than stopping dead.
      if (dir > 0 && i === blocks.length - 1) await this.append();
      return;
    }
    const range = srcRange(next.dataset.plumeSrc);
    if (!range) return;
    await this.openAt({ from: range[0], offset: dir < 0 ? Infinity : 0 });
  }
}
