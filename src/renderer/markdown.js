// Markdown → HTML. CommonMark + GFM via markdown-it, plus the Obsidian
// flavours people actually use: [[wiki links]], ![[embeds]], ==highlights==,
// callouts (handled in enhance.js), #tags, %%comments%%, image sizing.

import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import mark from 'markdown-it-mark';
import deflist from 'markdown-it-deflist';
import { full as emoji } from 'markdown-it-emoji';
import frontMatter from 'markdown-it-front-matter';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import nginx from 'highlight.js/lib/languages/nginx';
import apache from 'highlight.js/lib/languages/apache';
import http from 'highlight.js/lib/languages/http';
import dos from 'highlight.js/lib/languages/dos';
import properties from 'highlight.js/lib/languages/properties';
import protobuf from 'highlight.js/lib/languages/protobuf';
import cmake from 'highlight.js/lib/languages/cmake';
import groovy from 'highlight.js/lib/languages/groovy';
import scala from 'highlight.js/lib/languages/scala';
import dart from 'highlight.js/lib/languages/dart';
import haskell from 'highlight.js/lib/languages/haskell';
import elixir from 'highlight.js/lib/languages/elixir';
import latex from 'highlight.js/lib/languages/latex';
import x86asm from 'highlight.js/lib/languages/x86asm';
import vim from 'highlight.js/lib/languages/vim';
import { escapeHtml } from './util.js';

for (const [name, lang] of Object.entries({
  powershell, dockerfile, nginx, apache, http, dos, properties, protobuf, cmake, groovy, scala, dart,
  haskell, elixir, latex, x86asm, vim,
})) {
  hljs.registerLanguage(name, lang);
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

// Marks code blocks Plume rendered from fences. Raw HTML in a document can
// imitate the markup but cannot know this per-session value, so Copy buttons
// are only ever attached to genuine (fully escaped) code.
export const CODE_MARK = [...crypto.getRandomValues(new Uint8Array(12))]
  .map(b => b.toString(16).padStart(2, '0')).join('');

const LANG_ALIASES = {
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', ps: 'powershell', ps1: 'powershell',
  pwsh: 'powershell', yml: 'yaml', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust',
  kt: 'kotlin', cs: 'csharp', 'c#': 'csharp', 'c++': 'cpp', hpp: 'cpp', h: 'c', md: 'markdown',
  html: 'xml', xhtml: 'xml', svg: 'xml', vue: 'xml', toml: 'ini', conf: 'ini', dockerfile: 'dockerfile',
  docker: 'dockerfile', tf: 'ini', hcl: 'ini', golang: 'go', jsonc: 'json', json5: 'json',
  text: 'plaintext', txt: 'plaintext', plain: 'plaintext', proto: 'protobuf', bat: 'dos', cmd: 'dos',
  batch: 'dos', nginxconf: 'nginx', asm: 'x86asm', nasm: 'x86asm', tex: 'latex', ex: 'elixir', exs: 'elixir',
  hs: 'haskell', env: 'properties', dotenv: 'properties',
};

export function splitWiki(raw) {
  let target = String(raw).replace(/\\\|/g, '|');
  let alias = '';
  const bar = target.indexOf('|');
  if (bar >= 0) {
    alias = target.slice(bar + 1).trim();
    target = target.slice(0, bar);
  }
  return { target: target.trim(), alias };
}

export function wikiLabel(target) {
  const [page, ...rest] = target.split('#');
  const heading = rest.join('#').replace(/^\^/, '');
  const name = page.split('/').pop().replace(/\.(md|markdown)$/i, '');
  if (!name) return heading;
  return heading ? `${name} › ${heading}` : name;
}

function wikiPlugin(md) {
  function rule(state, silent) {
    const src = state.src;
    let pos = state.pos;
    let embed = false;
    if (src.charCodeAt(pos) === 0x21 /* ! */) {
      if (src.charCodeAt(pos + 1) !== 0x5b || src.charCodeAt(pos + 2) !== 0x5b) return false;
      embed = true;
      pos += 1;
    } else if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) {
      return false;
    }
    const end = src.indexOf(']]', pos + 2);
    if (end < 0) return false;
    const inner = src.slice(pos + 2, end);
    if (!inner.trim() || inner.includes('\n') || inner.includes('[[')) return false;
    if (!silent) {
      const token = state.push(embed ? 'wiki_embed' : 'wiki_link', '', 0);
      token.content = inner;
      const { target } = splitWiki(inner);
      if (target) {
        if (!state.env.wiki) state.env.wiki = new Set();
        state.env.wiki.add(target);
      }
    }
    state.pos = end + 2;
    return true;
  }

  md.inline.ruler.before('link', 'wikilink', rule);

  md.renderer.rules.wiki_link = (tokens, idx) => {
    const { target, alias } = splitWiki(tokens[idx].content);
    const label = alias || wikiLabel(target) || target;
    return `<a href="#" class="wikilink" data-wiki="${escapeHtml(target)}">${escapeHtml(label)}</a>`;
  };

  md.renderer.rules.wiki_embed = (tokens, idx) => {
    const { target, alias } = splitWiki(tokens[idx].content);
    const page = target.split('#')[0];
    if (IMAGE_RE.test(page)) {
      let attrs = '';
      let alt = page.split('/').pop();
      const size = /^(\d+)(?:x(\d+))?$/.exec(alias);
      if (size) {
        attrs += ` width="${size[1]}"`;
        if (size[2]) attrs += ` height="${size[2]}"`;
      } else if (alias) {
        alt = alias;
      }
      return `<img class="wiki-image" data-wiki-embed="${escapeHtml(target)}" alt="${escapeHtml(alt)}"${attrs}>`;
    }
    return `<span class="wiki-transclude" data-wiki-embed="${escapeHtml(target)}">` +
      `<a href="#" class="wikilink" data-wiki="${escapeHtml(target)}">${escapeHtml(alias || wikiLabel(target))}</a></span>`;
  };
}

// #tag — Obsidian tags. Must follow whitespace (or start of line) and
// contain at least one non-digit, so "#1" and "C#" stay plain text.
function tagPlugin(md) {
  const TAG_RE = /^#([\p{L}\p{N}_\-/]+)/u;
  md.inline.ruler.push('obsidian_tag', (state, silent) => {
    const { src, pos } = state;
    if (src.charCodeAt(pos) !== 0x23 /* # */) return false;
    if (pos > 0 && !/\s/.test(src[pos - 1])) return false;
    const m = TAG_RE.exec(src.slice(pos));
    if (!m || /^[\d/_-]+$/.test(m[1])) return false;
    if (!silent) {
      const token = state.push('obsidian_tag', '', 0);
      token.content = m[1];
    }
    state.pos += m[0].length;
    return true;
  });
  md.renderer.rules.obsidian_tag = (tokens, idx) =>
    `<span class="tag">#${escapeHtml(tokens[idx].content)}</span>`;
}

// An odd number of "%%" in the lines of the current block above `line`
// means a comment is still open there. While a paragraph is being read,
// state.line is its first line.
function closesInlineComment(state, line) {
  const first = state.parentType === 'paragraph' ? state.line : 0;
  let count = 0;
  for (let l = line - 1; l >= first && !state.isEmpty(l); l--) {
    const text = state.src.slice(state.bMarks[l] + state.tShift[l], state.eMarks[l]);
    count += text.split('%%').length - 1;
  }
  return count % 2 === 1;
}

// %%comment%% — hidden in Obsidian's reading view.
function commentPlugin(md) {
  md.inline.ruler.before('emphasis', 'obsidian_comment', (state, silent) => {
    const { src, pos } = state;
    if (src.charCodeAt(pos) !== 0x25 || src.charCodeAt(pos + 1) !== 0x25) return false;
    const end = src.indexOf('%%', pos + 2);
    if (end < 0) return false;
    if (!silent) state.push('obsidian_comment', '', 0);
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules.obsidian_comment = () => '';

  // A comment opened at the start of a line can span blank lines, which split
  // it into paragraphs the inline rule never sees whole. Swallow those lines
  // here; like Obsidian, an unclosed comment runs to the end of the document.
  md.block.ruler.before('fence', 'obsidian_comment_block', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (state.src.charCodeAt(start) !== 0x25 || state.src.charCodeAt(start + 1) !== 0x25) return false;
    if (state.src.slice(start + 2, max).includes('%%')) return false;
    // Asked whether this line ends the paragraph above: not when it closes
    // a comment opened inside that paragraph ("Note %%private" / "%%").
    if (silent) return !closesInlineComment(state, startLine);

    let line = startLine + 1;
    let rest = '';
    for (; line < endLine; line++) {
      const from = state.bMarks[line] + state.tShift[line];
      const to = state.eMarks[line];
      if (from < to && state.sCount[line] < state.blkIndent) break;
      const close = state.src.slice(from, to).indexOf('%%');
      if (close >= 0) {
        rest = state.src.slice(from + close + 2, to).trim();
        line++;
        break;
      }
    }
    if (rest) {
      state.push('paragraph_open', 'p', 1).map = [line - 1, line];
      const inline = state.push('inline', '', 0);
      inline.content = rest;
      inline.map = [line - 1, line];
      inline.children = [];
      state.push('paragraph_close', 'p', -1);
    }
    state.line = line;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
}

// Obsidian task states beyond [ ] and [x]: [/] in progress, [-] cancelled,
// [>] forwarded, [!] important and so on. markdown-it-task-lists leaves them
// as text; turn them into checkboxes that carry the state in data-task.
const TASK_STATE_RE = /^\[([^\s\]])\] /u;
const OPEN_TASK_STATES = new Set(['/', '>', '<', '!', '?', '*']);

function taskStatePlugin(md) {
  md.core.ruler.after('github-task-lists', 'obsidian_task_states', state => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' ||
        tokens[i - 2].type !== 'list_item_open') continue;
      const m = TASK_STATE_RE.exec(inline.content);
      const first = inline.children && inline.children[0];
      if (!m || !first || first.type !== 'text' || !first.content.startsWith(m[0])) continue;

      const task = m[1];
      const checked = OPEN_TASK_STATES.has(task) ? '' : ' checked=""';
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input class="task-list-item-checkbox"${checked} disabled="" type="checkbox" data-task="${escapeHtml(task)}">`;
      first.content = first.content.slice(m[0].length - 1);
      inline.content = inline.content.slice(m[0].length - 1);
      inline.children.unshift(box);

      const item = tokens[i - 2];
      item.attrJoin('class', 'task-list-item');
      item.attrSet('data-task', task);
      for (let j = i - 3; j >= 0; j--) {
        if (tokens[j].level === item.level - 1) {
          if (!/\bcontains-task-list\b/.test(tokens[j].attrGet('class') || '')) tokens[j].attrJoin('class', 'contains-task-list');
          break;
        }
      }
    }
  });
}

function highlightCode(code, lang) {
  const name = LANG_ALIASES[lang] || lang;
  if (name && name !== 'plaintext' && hljs.getLanguage(name)) {
    try {
      return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
    } catch {
      /* fall through */
    }
  }
  return escapeHtml(code);
}

function codeBlock(code, lang, label) {
  const cls = lang ? ` language-${escapeHtml(lang)}` : '';
  return `<div class="code-block" data-plume-code="${CODE_MARK}"><div class="code-head"><span class="code-lang">${escapeHtml(label || '')}</span></div>` +
    `<pre><code class="hljs${cls}">${highlightCode(code, lang)}</code></pre></div>\n`;
}

export function createMarkdown({ breaks = true } = {}) {
  let frontMatterRaw = null;

  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
    breaks,
  });

  md.use(frontMatter, fm => { frontMatterRaw = fm; })
    .use(footnote)
    .use(taskLists, { enabled: false })
    .use(taskStatePlugin)
    .use(mark)
    .use(deflist)
    .use(emoji, { shortcuts: {} })
    .use(texmath, {
      engine: katex,
      delimiters: 'dollars',
      katexOptions: { throwOnError: false, strict: 'ignore', output: 'htmlAndMathml', trust: false },
    })
    .use(wikiPlugin)
    .use(tagPlugin)
    .use(commentPlugin);

  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const info = token.info ? md.utils.unescapeAll(token.info).trim() : '';
    const raw = info.split(/\s+/)[0] || '';
    const lang = raw.toLowerCase();
    const code = token.content;
    if (lang === 'mermaid') {
      return `<div class="mermaid-block"><pre class="mermaid-src">${escapeHtml(code)}</pre></div>\n`;
    }
    if (lang === 'math' || lang === 'katex') {
      return `<div class="math-block">${katex.renderToString(code, {
        displayMode: true, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml',
      })}</div>\n`;
    }
    return codeBlock(code, lang, raw);
  };

  md.renderer.rules.code_block = (tokens, idx) => codeBlock(tokens[idx].content, '', '');

  // ![alt|300](img.png) and ![alt|300x200](img.png) — Obsidian image sizing.
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    let alt = self.renderInlineAsText(token.children, options, env);
    const m = /^(.*?)\|\s*(\d+)(?:\s*x\s*(\d+))?\s*$/.exec(alt);
    if (m) {
      alt = m[1].trim();
      token.attrSet('width', m[2]);
      if (m[3]) token.attrSet('height', m[3]);
    }
    const altIdx = token.attrIndex('alt');
    if (altIdx >= 0) token.attrs[altIdx][1] = alt;
    else token.attrPush(['alt', alt]);
    token.attrSet('loading', 'lazy');
    return self.renderToken(tokens, idx, options);
  };

  return {
    // docId namespaces footnote ids (fn-<docId>-1) so a transcluded note's
    // footnotes do not collide with the host's.
    render(src, { docId } = {}) {
      frontMatterRaw = null;
      const env = typeof docId === 'string' ? { docId } : {};
      const html = md.render(src, env);
      return { html, frontMatter: frontMatterRaw, wiki: env.wiki ? [...env.wiki] : [] };
    },
  };
}
