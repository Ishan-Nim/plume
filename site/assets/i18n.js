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

  function normalise(html) {
    return String(html).replace(/\s+/g, ' ').trim();
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

    function apply(nodes, isBlock) {
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        if (node.closest('script, style, pre, svg, [data-no-i18n]')) continue;
        // A block holding another block is a wrapper; its children carry the text.
        if (isBlock && node.querySelector(BLOCK)) continue;
        if (!isBlock && (node.querySelector(BLOCK) || node.querySelector(INLINE))) continue;
        if (alreadyDone(node)) continue;

        var key = normalise(node.innerHTML);
        var value = dict[key];
        if (value) {
          node.innerHTML = value;
          done.push(node);
        }
      }
    }

    apply(scope.querySelectorAll(BLOCK), true);
    apply(scope.querySelectorAll(INLINE), false);
  }

  var current = 'en';
  var dictionary = null;

  function applyAll() {
    if (!dictionary) return;
    translateIn(dictionary, document.body);

    var title = dictionary[normalise(document.title)];
    if (title) document.title = title;

    var meta = document.querySelector('meta[name="description"]');
    if (meta) {
      var described = dictionary[normalise(meta.getAttribute('content'))];
      if (described) meta.setAttribute('content', described);
    }
  }

  /** For strings built in JavaScript rather than written in the page. */
  function t(text) {
    if (!dictionary) return text;
    return dictionary[normalise(text)] || text;
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
    var nav = document.querySelector('.nav-links');
    if (!nav || document.getElementById('lang-picker')) return;

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

    var toggle = nav.querySelector('.theme-toggle');
    wrap.appendChild(label);
    wrap.appendChild(select);
    if (toggle) nav.insertBefore(wrap, toggle);
    else nav.appendChild(wrap);
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
