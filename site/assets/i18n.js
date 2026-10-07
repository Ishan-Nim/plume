/* Plume — translations for plume-md.com.
 *
 * Keys are the English text itself, so the pages carry no translation markup:
 * whatever English a page shows is what gets looked up. A string whose wording
 * changes simply falls back to English instead of showing a stale translation.
 *
 * Block elements are replaced whole, inline markup included, so a sentence with
 * a <code> or a link in it stays one sentence in every language.
 */
(function () {
  'use strict';

  var STORE = 'plume-lang';

  // Only languages with a complete dictionary belong here.
  var LANGS = {
    en: 'English',
    ja: '日本語',
    zh: '简体中文',
    ko: '한국어',
    hi: 'हिन्दी',
    es: 'Español',
    fr: 'Français',
    de: 'Deutsch',
    pt: 'Português',
    ru: 'Русский',
  };

  // What a browser might report, mapped to what we actually have.
  var ALIASES = {
    'zh-cn': 'zh', 'zh-sg': 'zh', 'zh-hans': 'zh', 'zh-tw': 'zh', 'zh-hk': 'zh', 'zh-hant': 'zh',
    'pt-br': 'pt', 'pt-pt': 'pt',
    'es-419': 'es', 'es-mx': 'es', 'es-es': 'es',
  };

  var root = document.documentElement;

  function normaliseTag(tag) {
    var lower = String(tag || '').toLowerCase();
    if (ALIASES[lower]) return ALIASES[lower];
    if (LANGS[lower]) return lower;
    var base = lower.split('-')[0];
    if (ALIASES[base]) return ALIASES[base];
    return LANGS[base] ? base : null;
  }

  /** ?lang= wins, then a stored choice, then what the browser asks for. */
  function pick() {
    var fromUrl = null;
    try {
      fromUrl = normaliseTag(new URLSearchParams(location.search).get('lang'));
    } catch (e) { /* very old browser */ }
    if (fromUrl) return fromUrl;

    var stored = null;
    try {
      stored = normaliseTag(localStorage.getItem(STORE));
    } catch (e) { /* private mode */ }
    if (stored) return stored;

    var wanted = navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || 'en'];
    for (var i = 0; i < wanted.length; i += 1) {
      var hit = normaliseTag(wanted[i]);
      if (hit) return hit;
    }
    return 'en';
  }

  // An icon carries no words, and a release number is not a translation: both
  // are taken out of the key so one dictionary entry keeps working across
  // releases and so a key matches what scripts/i18n-extract.js wrote.
  function icons(html) { return String(html).match(/<svg[\s\S]*?<\/svg>/gi) || []; }
  function versions(html) { return String(html).match(/\d+\.\d+\.\d+(?:\.\d+)?/g) || []; }

  function normalise(html) {
    return String(html)
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      // The DOM writes a valueless attribute as name=""; the source writes the
      // bare name. Collapse both so a key built either way is the same key.
      .replace(/=""/g, '')
      .replace(/\d+\.\d+\.\d+(?:\.\d+)?/g, '{v}')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Puts back what normalise() took out, using the English the page shows. */
  function restore(value, source) {
    var found = versions(source);
    var i = 0;
    var filled = String(value).replace(/\{v\}/g, function () {
      return found.length ? (found[i++] || found[found.length - 1]) : '{v}';
    });
    // Every icon on this site leads its phrase, so they go back at the front.
    return icons(source).join('') + filled;
  }

  // The same elements the extractor collects, in the same order.
  var BLOCK = 'p,li,h1,h2,h3,h4,figcaption,td,th,label,summary,option,blockquote';
  var INLINE = 'a,button,span,b';

  function translateIn(dict, scope) {
    var done = [];

    function alreadyDone(node) {
      for (var i = 0; i < done.length; i += 1) {
        if (done[i] !== node && done[i].contains(node)) return true;
      }
      return false;
    }

    function apply(nodes) {
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        if (node.closest('script, style, pre, svg, [data-no-i18n]')) continue;
        // A node holding a block element is a wrapper; its children carry the
        // text. Inline children are not a reason to skip: a sentence like
        // "<b>Saved.</b> Nothing else changed." is one string, and refusing to
        // look it up left every such sentence in English in all nine languages.
        if (node.querySelector(BLOCK)) continue;
        if (alreadyDone(node)) continue;

        var html = node.innerHTML;
        var value = dict[normalise(html)];
        if (value) {
          node.innerHTML = restore(value, html);
          done.push(node);
        }
      }
    }

    // Blocks first, so a whole sentence wins over a fragment inside it.
    apply(scope.querySelectorAll(BLOCK));
    apply(scope.querySelectorAll(INLINE));
  }

  var current = 'en';
  var dictionary = null;

  function applyAll() {
    if (!dictionary) return;
    translateIn(dictionary, document.body);

    var title = dictionary[normalise(document.title)];
    if (title) document.title = restore(title, document.title);

    var meta = document.querySelector('meta[name="description"]');
    if (meta) {
      var said = meta.getAttribute('content');
      var described = dictionary[normalise(said)];
      if (described) meta.setAttribute('content', restore(described, said));
    }
  }

  /** For strings built in JavaScript rather than written in the page. */
  function t(text) {
    if (!dictionary) return text;
    var value = dictionary[normalise(text)];
    return value ? restore(value, text) : text;
  }

  function reveal() {
    root.classList.remove('i18n-pending');
  }

  async function load(lang) {
    if (lang === 'en') {
      dictionary = null;
      current = 'en';
      root.setAttribute('lang', 'en');
      reveal();
      return;
    }
    try {
      var res = await fetch('/assets/i18n/' + lang + '.json', { cache: 'force-cache' });
      if (!res.ok) throw new Error('missing');
      dictionary = await res.json();
      current = lang;
      root.setAttribute('lang', lang);
      applyAll();
    } catch (err) {
      // A missing or broken dictionary must never leave a blank page.
      dictionary = null;
      current = 'en';
      root.setAttribute('lang', 'en');
    }
    reveal();
  }

  // ---------- the picker ----------

  function buildPicker() {
    // The picker lives in the footer, beside the theme toggle: both are things
    // you set once, and the header is for getting somewhere.
    var host = document.getElementById('foot-controls') || document.querySelector('.nav-links');
    if (!host || document.getElementById('lang-picker')) return;

    var wrap = document.createElement('div');
    wrap.className = 'lang-wrap';

    var label = document.createElement('label');
    label.className = 'sr-only';
    label.setAttribute('for', 'lang-picker');
    label.textContent = 'Language';

    var select = document.createElement('select');
    select.id = 'lang-picker';
    select.className = 'lang-picker';
    select.setAttribute('aria-label', 'Language');
    // Never translated: a language is always named in its own language.
    select.setAttribute('data-no-i18n', '');

    Object.keys(LANGS).forEach(function (code) {
      var option = document.createElement('option');
      option.value = code;
      option.textContent = LANGS[code];
      if (code === current) option.selected = true;
      select.appendChild(option);
    });

    select.addEventListener('change', function () {
      var next = select.value;
      try { localStorage.setItem(STORE, next); } catch (e) { /* ignore */ }
      // A reload is the honest way to put every string back: a page that has
      // already been translated no longer holds the English to look up.
      var url = new URL(location.href);
      if (next === 'en') url.searchParams.delete('lang');
      else url.searchParams.set('lang', next);
      location.href = url.toString();
    });

    var toggle = host.querySelector('.theme-toggle');
    wrap.appendChild(label);
    wrap.appendChild(select);
    if (toggle) host.insertBefore(wrap, toggle);
    else host.appendChild(wrap);
  }

  // ---------- start ----------

  var chosen = pick();
  current = chosen;

  window.plumeI18n = {
    languages: LANGS,
    get language() { return current; },
    t: t,
    apply: applyAll,
  };

  function start() {
    buildPicker();
    load(chosen);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // However badly things go, the page becomes visible.
  setTimeout(reveal, 2500);
})();
