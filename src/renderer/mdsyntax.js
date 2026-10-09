// Markdown syntax that gets out of the way.
//
// While you are editing a block, the markers that make the formatting —
// `**`, `_`, `#`, the `(url)` half of a link — are hidden, and the text they
// mark is shown the way it will be read. Put the caret inside one and the
// markers come back, so there is something to edit. Move away and they go
// again. This is the behaviour Obsidian calls Live Preview.
//
// Nothing here changes the document. CodeMirror's text is the Markdown you
// typed, exactly; these are decorations over it, which is why the buffer live
// preview writes back is still the file as written. Hiding is a `replace`
// decoration with no widget — the characters are still there, still selectable
// by dragging through them, and still saved.
//
// What counts as "inside" differs by construct, because that is what reading
// wants. For something inline — bold, a link — it is the construct itself, so
// passing the caret over a bold word reveals that word's asterisks and no
// others. For a heading it is the whole line, because a `#` at the start of a
// line you are typing on should not flicker as the caret crosses the text.

import { Decoration, ViewPlugin } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

// The marker nodes @lezer/markdown produces, and the construct each belongs
// to. A marker is hidden unless the caret is within its construct.
//
//   hide    the marker node types to take out of the line
//   cls     a class for the text the construct marks, so it reads as what it
//           will become
//   atMark  reveal only when the caret is in the marker itself, rather than
//           anywhere in the construct — see below
const CONSTRUCTS = {
  StrongEmphasis: { hide: ['EmphasisMark'], cls: 'cm-md-strong' },
  Emphasis: { hide: ['EmphasisMark'], cls: 'cm-md-em' },
  Strikethrough: { hide: ['StrikethroughMark'], cls: 'cm-md-strike' },
  InlineCode: { hide: ['CodeMark'], cls: 'cm-md-code' },
  // The text of a link is what a reader sees; the URL and the brackets are
  // plumbing. Hiding `URL` leaves `[text](url)` showing as `text`.
  Link: { hide: ['LinkMark', 'URL', 'LinkTitle'], cls: 'cm-md-link' },
  Image: { hide: ['LinkMark', 'URL', 'LinkTitle'], cls: 'cm-md-link' },
};

// A heading's `#` is a special case of its own. Live preview opens one block
// at a time, and a heading is a single line, so "reveal while the caret is in
// this construct" would mean the `#` is always back the moment you click the
// heading — which is the one thing this is meant to stop. So a heading reveals
// its `#` only when the caret is in the `#` itself: type the words and it
// stays a heading with no marker, click to the far left and the marker is
// there to change the level with.
for (let level = 1; level <= 6; level += 1) {
  CONSTRUCTS[`ATXHeading${level}`] = {
    hide: ['HeaderMark'],
    cls: `cm-md-h${level}`,
    atMark: true,
  };
}

/** Does any part of the selection touch [from, to]? Touching an end counts. */
function selectionTouches(state, from, to) {
  return state.selection.ranges.some(r => r.from <= to && r.to >= from);
}

/**
 * A heading's `#` is followed by a space that belongs to the syntax just as
 * much: hiding `#` alone would indent the text by one character.
 */
function withTrailingSpace(doc, from, to) {
  let end = to;
  const line = doc.lineAt(from);
  while (end < line.to && doc.sliceString(end, end + 1) === ' ') end += 1;
  return end;
}

function build(view) {
  const { state } = view;
  const decorations = [];
  const tree = syntaxTree(state);

  // Only what is on screen. A block editor is small, so this is nearly always
  // the whole of it, but a long fenced block need not be walked in full.
  for (const { from: viewFrom, to: viewTo } of view.visibleRanges) {
    tree.iterate({
      from: viewFrom,
      to: viewTo,
      enter: node => {
        const construct = CONSTRUCTS[node.name];
        if (!construct) return;

        if (construct.cls) {
          decorations.push(Decoration.mark({ class: construct.cls }).range(node.from, node.to));
        }

        // This construct's own markers — not those of anything nested inside
        // it, which are that construct's business and may need to stay.
        const marks = [];
        const inner = node.node.cursor();
        if (inner.firstChild()) {
          do {
            if (!construct.hide.includes(inner.name)) continue;
            const to = construct.atMark
              ? withTrailingSpace(state.doc, inner.from, inner.to)
              : inner.to;
            if (to > inner.from) marks.push([inner.from, to]);
          } while (inner.nextSibling());
        }
        if (!marks.length) return;

        const reveal = construct.atMark
          ? marks.some(([from, to]) => selectionTouches(state, from, to))
          : selectionTouches(state, node.from, node.to);
        if (reveal) return;

        for (const [from, to] of marks) {
          decorations.push(Decoration.replace({}).range(from, to));
        }
      },
    });
  }

  // Sorted on the way in: a construct's own mark decoration and the replace
  // decorations inside it share a start position, and the order they were
  // found in is not the order a range set wants them.
  return Decoration.set(decorations, true);
}

export const liveSyntax = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = build(view);
    }

    update(update) {
      // The caret moving is the whole point, so a selection change rebuilds
      // just as a document change does.
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = build(update.view);
      }
    }
  },
  // Deliberately not atomic. Arrowing into where a hidden `**` sits reveals
  // the construct and puts the caret between the asterisks, which is what you
  // want when you are stepping into a word to change it — and what Obsidian
  // does. Making the hidden ranges atomic would skip the caret past them.
  { decorations: plugin => plugin.decorations },
);
