// The thing you actually type into during live preview: one block of the
// document, as CodeMirror.
//
// This used to be a plain textarea, and most of live.js still reads as though
// it were — it asks for `value`, `selectionStart`, `setSelectionRange`. That
// is deliberate. A textarea cannot style part of its contents, which is the
// one thing live preview needs in order to hide `**` while showing the word
// bold, so the surface had to change; how live.js drives it did not need to.
// Everything below is that small surface, and nothing above this file knows
// which editor is underneath.
//
// What CodeMirror buys, beyond decorations: a selection model that survives
// text being restyled under it, undo that understands the edits, and — the
// reason it is a library rather than a contenteditable of our own — input
// method composition that works. Typing Japanese into a hand-rolled
// contenteditable is where that approach goes wrong.
//
// The document CodeMirror holds is the block's Markdown, unchanged. Plume's
// rule that what you save is exactly what you typed is not bent here: the
// hiding is decoration over the text, never a rewrite of it.

import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { EditorState, Prec, EditorSelection } from '@codemirror/state';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { liveSyntax } from './mdsyntax.js';

// Plume's own look. CodeMirror styles itself through here rather than through
// styles.css for the parts it owns — the rest is ordinary CSS on .live-edit.
const look = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'inherit', font: 'inherit' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { padding: '0', font: 'inherit', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0' },
  '.cm-scroller': { font: 'inherit', lineHeight: 'inherit', overflow: 'visible' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection)',
  },
});

export class BlockEditor {
  /**
   * @param {object} options
   * @param {string} options.text      the block's Markdown
   * @param {string} options.tag       the rendered block's tag, for sizing
   * @param {boolean} options.isCode   a fenced block, set in a mono face
   * @param {Function} options.onInput called after every change, with the text
   * @param {Function} options.onKey   offered each keydown before CodeMirror
   * @param {Function} options.onBlur  called when focus leaves
   */
  constructor({ text, tag, isCode, onInput, onKey, onBlur }) {
    this.onKey = onKey || (() => {});

    this.view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          // GFM, so strikethrough and task lists parse the way the rendered
          // document reads them.
          markdown({ base: markdownLanguage }),
          liveSyntax,
          look,
          // Through the facet, not classList: CodeMirror rewrites the wrapper's
          // className whenever it recomputes its attributes — gaining focus is
          // enough — so a class put there from outside disappears on the first
          // click, taking the block's styling with it.
          EditorView.editorAttributes.of({
            class: isCode ? 'live-edit is-code' : 'live-edit',
            'data-tag': tag,
            'aria-label': 'Edit this block',
          }),
          // Escape and the arrow keys belong to live.js: they close the block
          // or move to the next one, and must be seen before CodeMirror's own
          // bindings treat them as movement within this block.
          Prec.highest(EditorView.domEventHandlers({
            keydown: ev => {
              this.onKey(ev);
              return ev.defaultPrevented;
            },
            // Losing focus ends the edit, and it has to end now rather than a
            // tick later. Clicking straight from one block to another blurs
            // this one on mousedown and opens the next on the click: if this
            // editor were still standing in between, the next block would be
            // measured through a layout that is about to change, and the
            // caret would land somewhere other than where it was clicked.
            //
            // Safe to tear down from here because a DOM blur is not a
            // CodeMirror transaction — doing this from a state effect, which
            // is, leaves the view half-way through its own update.
            blur: () => {
              onBlur();
              return false;
            },
          })),
          // Enter carries a list on and Backspace unmakes a marker, the way
          // every Markdown editor does. This is the same behaviour mdkeys.js
          // hand-rolls for source mode, which keeps its own copy.
          keymap.of([...markdownKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
          EditorView.updateListener.of(update => {
            if (update.docChanged) onInput(this.value);
          }),
        ],
      }),
    });

    this.dom = this.view.dom;
    // A property rather than an attribute, so CodeMirror's rewriting of the
    // element leaves it alone. The end-to-end run drives the open block from
    // outside the bundle, and a textarea's `value` and `selectionStart` are no
    // longer there to reach for; this is that handle.
    this.dom.plumeEdit = this;
  }

  // ---------- the part live.js talks to ----------

  get value() {
    return this.view.state.doc.toString();
  }

  get selectionStart() {
    return this.view.state.selection.main.from;
  }

  get selectionEnd() {
    return this.view.state.selection.main.to;
  }

  /** `Infinity` means the end, as it does on a textarea. */
  setSelectionRange(from, to) {
    const end = this.view.state.doc.length;
    const anchor = Math.max(0, Math.min(end, from));
    const head = Math.max(0, Math.min(end, to == null ? from : to));
    this.view.dispatch({
      selection: EditorSelection.single(anchor, head),
      scrollIntoView: true,
    });
  }

  focus() {
    this.view.focus();
  }

  blur() {
    this.view.contentDOM.blur();
  }

  /** Puts `text` in at the caret, as typing it would. */
  insert(text) {
    const at = this.selectionStart;
    this.view.dispatch({
      changes: { from: at, to: this.selectionEnd, insert: text },
      selection: { anchor: at + text.length },
    });
  }

  destroy() {
    this.view.destroy();
  }
}
