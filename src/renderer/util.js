// Small shared helpers for the renderer.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ESC[c]);
}

// GitHub-compatible heading slug, Unicode-aware so Japanese headings work.
export function slugify(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
    .replace(/\s/g, '-');
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Path helpers. Paths come from the main process already absolute and
// normalised; we only need to split and compare them.
export function splitPath(p) {
  return String(p).split(/[\\/]+/).filter(Boolean);
}

export function basename(p) {
  const parts = splitPath(p);
  return parts.length ? parts[parts.length - 1] : p;
}

export function dirname(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (i <= 0) return s;
  const d = s.slice(0, i);
  return /^[A-Za-z]:$/.test(d) ? `${d}\\` : d;
}

const caseInsensitive = navigator.userAgent.includes('Windows');

export function pathKey(p) {
  const s = String(p).replace(/[\\/]+$/, '');
  return caseInsensitive ? s.toLowerCase() : s;
}

export function samePath(a, b) {
  return !!a && !!b && pathKey(a) === pathKey(b);
}

// Is `child` inside `parent` (or equal)? Returns the relative segments, or null.
export function relativeSegments(parent, child) {
  const p = splitPath(parent);
  const c = splitPath(child);
  if (c.length < p.length) return null;
  for (let i = 0; i < p.length; i++) {
    const a = caseInsensitive ? p[i].toLowerCase() : p[i];
    const b = caseInsensitive ? c[i].toLowerCase() : c[i];
    if (a !== b) return null;
  }
  return c.slice(p.length);
}

export function joinPath(dir, name, sep = '\\') {
  return dir.endsWith('\\') || dir.endsWith('/') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

// Reading statistics: Latin words + CJK characters, for an honest estimate
// on Japanese documents too.
export function readingStats(text) {
  const cjk = (text.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g) || []).length;
  const latin = (text.replace(/[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g, ' ')
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  const minutes = Math.max(1, Math.round(latin / 230 + cjk / 500));
  return { words: latin + cjk, minutes };
}
