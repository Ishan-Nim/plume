// Markdown-aware typing for source mode's textarea: Tab indents, Enter
// carries a list on.
//
// Live preview used to share this. It is CodeMirror now, and gets the same
// two behaviours from markdownKeymap and indentWithTab instead — so this is
// source mode's alone, and the rest of the file (splitting lines, mapping a
// rendered offset back to the Markdown behind it) is still shared by both.

/**
 * Handles Tab and Enter in a Markdown textarea.
 * @returns {boolean} true when the key was dealt with and the caller should
 *   treat the text as changed.
 */
export function markdownKeys(area, ev) {
  const mod = ev.ctrlKey || ev.metaKey;

  // Tab indents rather than leaving the document — in a Markdown editor that
  // is what the key is for.
  if (ev.key === 'Tab') {
    ev.preventDefault();
    const { selectionStart: start, selectionEnd: end, value } = area;

    if (start === end && !ev.shiftKey) {
      area.setRangeText('  ', start, end, 'end');
    } else {
      const from = value.lastIndexOf('\n', start - 1) + 1;
      const block = value.slice(from, end);
      const shifted = ev.shiftKey
        ? block.replace(/^ {1,2}/gm, '')
        : block.replace(/^/gm, '  ');
      area.setRangeText(shifted, from, end, 'select');
    }
    return true;
  }

  // Enter continues a list, the way every Markdown editor does.
  if (ev.key === 'Enter' && !ev.shiftKey && !mod) {
    const { selectionStart: start, value } = area;
    if (start !== area.selectionEnd) return false;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const line = value.slice(lineStart, start);
    const marker = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+\[[ xX]\])?\s+/.exec(line);
    if (!marker) return false;

    // A marker with nothing after it means the list is finished.
    if (line.length === marker[0].length) {
      ev.preventDefault();
      area.setRangeText('\n', lineStart, start, 'end');
      return true;
    }

    ev.preventDefault();
    const indent = marker[1];
    const box = marker[5] ? ' [ ]' : '';
    const next = marker[2]
      ? `${indent}${marker[2]}${box} `
      : `${indent}${parseInt(marker[3], 10) + 1}${marker[4]}${box} `;
    area.setRangeText(`\n${next}`, start, start, 'end');
    return true;
  }

  return false;
}

// Documents are read and written with the line endings they already have, so
// splitting and joining are a pair.
export function splitLines(text) {
  return String(text).split(/\r?\n/);
}

export function lineEnding(text) {
  return String(text).includes('\r\n') ? '\r\n' : '\n';
}

/** Replaces lines [from, to) of `text` with `replacement`. */
export function spliceLines(text, from, to, replacement) {
  const eol = lineEnding(text);
  const lines = splitLines(text);
  const body = replacement === null ? [] : splitLines(replacement);
  return [...lines.slice(0, from), ...body, ...lines.slice(to)].join(eol);
}

// Where a rendered character sits in the Markdown that produced it.
//
// Rendered text is very nearly a subsequence of its source — "**bold**" loses
// the stars, "[label](url)" loses all but the label — so matching the two
// character by character, and letting the source run ahead over whatever did
// not survive rendering, lands the caret on the word that was clicked.
// Whitespace matches whitespace, because a line break in the source arrives
// as a space in the rendering. Where the guess is wrong it is only imprecise:
// the caret lands elsewhere in the same block, never in another one.
const SPACE = /\s/;

function same(a, b) {
  return a === b || (SPACE.test(a) && SPACE.test(b));
}

export function sourceOffset(src, text, textOffset) {
  const want = Math.max(0, Math.min(textOffset, text.length));
  // The end of the rendered text means the end of the block, past whatever
  // markup closes it.
  if (want >= text.length) return src.length;

  let j = 0;
  for (let i = 0; i < want; i++) {
    let k = j;
    while (k < src.length && !same(src[k], text[i])) k++;
    // A rendered character with no source of its own (a checkbox, an emoji
    // shortcut) leaves the source where it was rather than at the end.
    if (k >= src.length) continue;
    j = k + 1;
  }
  // Settle on the character that was actually clicked, rather than on the
  // markup in front of it.
  let k = j;
  while (k < src.length && !same(src[k], text[want])) k++;
  return k < src.length ? k : j;
}

// Rendered text that no source character corresponds to: the MathML copy of
// KaTeX output, code-block chrome, raw Mermaid source, fold arrows. Same
// reasoning as PLAIN_SKIP in enhance.js; both offsets below must agree about
// it, so the two functions share one walker.
const SKIP = '.katex-mathml, .code-head, .mermaid-src, .callout-fold';

function textWalker(block) {
  return document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.nodeType === Node.ELEMENT_NODE && n.matches(SKIP)
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT),
  });
}

/** The reading text of a block, as sourceOffset expects to be given it. */
export function blockText(block) {
  const walker = textWalker(block);
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) text += n.data;
  }
  return text;
}

/**
 * The offset, within blockText(block), of the caret position a click landed
 * on — or null when the point is not over text of this block.
 */
export function clickedTextOffset(block, x, y) {
  let node = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) {
      node = pos.offsetNode;
      offset = pos.offset;
    }
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !block.contains(node)) return null;

  const walker = textWalker(block);
  let total = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === node) return total + Math.min(offset, n.data.length);
    if (n.nodeType === Node.TEXT_NODE) total += n.data.length;
  }
  return null;
}
