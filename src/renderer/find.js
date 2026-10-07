// In-document search using the CSS Custom Highlight API: matches are painted
// without touching the DOM, so live reload, selection and copy stay intact.

const BLOCK_SELECTOR = 'p, li, td, th, h1, h2, h3, h4, h5, h6, pre, dt, dd, figcaption, summary, .callout-title, .prop-value, .prop-key';
const SKIP_SELECTOR = '.katex-mathml, .mermaid-src, .code-head, script, style';
const MAX_MATCHES = 5000;

export class Finder {
  constructor({ bar, input, count, root, scroller }) {
    this.bar = bar;
    this.input = input;
    this.count = count;
    this.root = root;
    this.scroller = scroller;
    this.ranges = [];
    this.index = -1;
    this.supported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
  }

  get isOpen() {
    return !this.bar.hidden;
  }

  open() {
    this.bar.hidden = false;
    const selected = String(window.getSelection() || '').trim();
    if (selected && selected.length < 200 && !selected.includes('\n')) this.input.value = selected;
    this.input.focus();
    this.input.select();
    if (this.input.value) this.search();
  }

  close() {
    this.bar.hidden = true;
    this.clear();
  }

  clear() {
    this.ranges = [];
    this.index = -1;
    if (this.supported) {
      CSS.highlights.delete('plume-find');
      CSS.highlights.delete('plume-find-current');
    }
    this.count.textContent = '';
    this.bar.classList.remove('no-match');
  }

  collectGroups() {
    const groups = [];
    let current = null;
    const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        if (!node.data) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const block = node.parentElement.closest(BLOCK_SELECTOR) || node.parentElement;
      if (!current || current.block !== block) {
        current = { block, nodes: [], starts: [], text: '' };
        groups.push(current);
      }
      current.nodes.push(node);
      current.starts.push(current.text.length);
      current.text += node.data;
    }
    return groups;
  }

  static locate(group, offset) {
    // Last node whose start is <= offset.
    let lo = 0;
    let hi = group.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (group.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { node: group.nodes[lo], offset: offset - group.starts[lo] };
  }

  search({ keepPosition = false } = {}) {
    const query = this.input.value;
    const previous = this.index;
    this.ranges = [];
    this.index = -1;
    if (!this.supported || !query) {
      this.clear();
      return;
    }
    const needle = query.toLowerCase();
    outer: for (const group of this.collectGroups()) {
      const hay = group.text.toLowerCase();
      if (hay.length !== group.text.length) continue; // case-folding changed length; skip safely
      let at = hay.indexOf(needle);
      while (at >= 0) {
        const start = Finder.locate(group, at);
        const end = Finder.locate(group, at + needle.length - 1);
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset + 1);
        this.ranges.push(range);
        if (this.ranges.length >= MAX_MATCHES) break outer;
        at = hay.indexOf(needle, at + needle.length);
      }
    }
    CSS.highlights.set('plume-find', new Highlight(...this.ranges));
    if (!this.ranges.length) {
      CSS.highlights.delete('plume-find-current');
      this.count.textContent = 'No results';
      this.bar.classList.add('no-match');
      return;
    }
    this.bar.classList.remove('no-match');
    if (keepPosition && previous >= 0) {
      this.index = Math.min(previous, this.ranges.length - 1);
      this.show(false);
    } else {
      this.index = this.firstVisible();
      this.show(true);
    }
  }

  firstVisible() {
    const top = this.scroller.getBoundingClientRect().top;
    const i = this.ranges.findIndex(r => r.getBoundingClientRect().bottom >= top + 8);
    return i >= 0 ? i : 0;
  }

  step(delta) {
    if (!this.ranges.length) {
      if (this.input.value) this.search();
      return;
    }
    this.index = (this.index + delta + this.ranges.length) % this.ranges.length;
    this.show(true);
  }

  show(scroll) {
    const range = this.ranges[this.index];
    if (!range) return;
    CSS.highlights.set('plume-find-current', new Highlight(range));
    this.count.textContent = `${this.index + 1} of ${this.ranges.length}${this.ranges.length >= MAX_MATCHES ? '+' : ''}`;
    // Open any collapsed callout/details that hides the match.
    let node = range.startContainer.parentElement;
    while (node && node !== this.root) {
      if (node.tagName === 'DETAILS' && !node.open) node.open = true;
      node = node.parentElement;
    }
    if (!scroll) return;
    const rect = range.getBoundingClientRect();
    const view = this.scroller.getBoundingClientRect();
    if (rect.top < view.top + 60 || rect.bottom > view.bottom - 40) {
      this.scroller.scrollBy({ top: rect.top - view.top - view.height / 3, behavior: 'auto' });
    }
  }
}
