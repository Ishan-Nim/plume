/* Plume — plume-md.com */
(function () {
  'use strict';

  // The one place the released version lives. Bump it when a release ships.
  var VERSION = '1.3.0';
  var REPO = 'https://github.com/Ishan-Nim/plume';
  // Through the counter, which redirects to the release asset.
  var BASE = '/api/download?file=';

  var FILES = {
    win: 'Plume-Setup-' + VERSION + '.exe',
    macArm: 'Plume-' + VERSION + '-mac-arm64.dmg',
    macArmZip: 'Plume-' + VERSION + '-mac-arm64.zip',
    macIntel: 'Plume-' + VERSION + '-mac-x64.dmg',
    macIntelZip: 'Plume-' + VERSION + '-mac-x64.zip',
    appimage: 'Plume-' + VERSION + '-linux-x86_64.AppImage',
    deb: 'Plume-' + VERSION + '-linux-amd64.deb'
  };

  // ---------- theme ----------

  var root = document.documentElement;
  try {
    var saved = localStorage.getItem('plume-theme');
    if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  } catch (e) { /* private mode */ }

  function currentTheme() {
    var set = root.getAttribute('data-theme');
    if (set) return set;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.theme-toggle');
    if (!btn) return;
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('plume-theme', next); } catch (e) { /* ignore */ }
  });

  // ---------- palette ----------
  //
  // A recolouring on top of light or dark, not a replacement for it: the
  // toggle above still works inside every palette. The page-head script has
  // already applied the stored one, so this only has to agree with it.

  var PALETTES = ['plume', 'starless', 'greenwood', 'commit', 'lapis'];

  function applyPalette(name) {
    if (PALETTES.indexOf(name) < 0) name = 'plume';
    if (name === 'plume') root.removeAttribute('data-palette');
    else root.setAttribute('data-palette', name);
    try { localStorage.setItem('plume-palette', name); } catch (e) { /* ignore */ }
  }

  var picker = document.getElementById('palette-picker');
  if (picker) {
    picker.value = root.getAttribute('data-palette') || 'plume';
    picker.addEventListener('change', function () { applyPalette(picker.value); });
  }

  // ---------- the hero film ----------
  //
  // preload="none" in the markup, so the page costs nothing extra to anybody
  // who never scrolls to it. It starts when it is actually on screen, and not
  // at all for a reader who has asked their system for less motion — they keep
  // the poster, which is the film's own first frame.

  // Every film on the page — the hero and the how-to clips in the docs — gets
  // the same treatment: nothing loads until it is on screen, nothing plays for
  // a reader who has asked for less motion, and a browser that refuses to
  // autoplay gets controls rather than a frame that looks broken.

  var quiet = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var films = [].slice.call(document.querySelectorAll('video.film'));

  if (films.length && !quiet) {
    films.forEach(function (film) {
      var settled = false;

      var attempt = function () {
        film.preload = 'auto';
        var playing = film.play();
        if (!playing || !playing.then) { settled = true; return; }
        playing.then(function () {
          settled = true;
          film.controls = false;
          film.classList.remove('needs-a-press');
        }).catch(function () {
          if (settled) return;
          film.controls = true;
          film.classList.add('needs-a-press');
        });
      };

      film.addEventListener('click', function () { if (film.paused) attempt(); });
      film._attempt = attempt;

      if ('IntersectionObserver' in window) {
        var watcher = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            attempt();
            watcher.disconnect();
          });
        }, { threshold: 0.25 });
        watcher.observe(film);
      } else {
        attempt();
      }
    });

    // The first gesture anywhere is the permission those browsers wanted.
    var onGesture = function () {
      films.forEach(function (f) { if (f.paused && f._attempt) f._attempt(); });
    };
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (type) {
      document.addEventListener(type, onGesture, { passive: true });
    });
  }

  // ---------- header shadow ----------

  var header = document.querySelector('.site-header');
  if (header) {
    var onScroll = function () {
      header.classList.toggle('scrolled', window.scrollY > 8);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // ---------- which system is this? ----------

  function detect() {
    var ua = navigator.userAgent || '';
    var plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    var s = (plat + ' ' + ua).toLowerCase();

    if (/android/.test(s)) return 'other';
    if (/iphone|ipad|ipod/.test(s)) return 'other';
    if (/win/.test(s)) return 'win';
    if (/mac/.test(s)) return 'mac';
    if (/linux|x11|cros/.test(s)) return 'linux';
    return 'other';
  }

  var os = detect();

  var LABEL = {
    win: 'Download for Windows',
    mac: 'Download for macOS',
    linux: 'Download for Linux',
    other: 'Download Plume'
  };

  var HREF = {
    win: BASE + FILES.win,
    mac: BASE + FILES.macArm,
    linux: BASE + FILES.appimage,
    other: 'download.html'
  };

  // Hero / CTA buttons that should follow the visitor's system.
  Array.prototype.forEach.call(document.querySelectorAll('[data-auto-download]'), function (el) {
    var label = el.querySelector('[data-label]');
    if (label) label.textContent = LABEL[os];
    if (os === 'other') return;
    // Keep these pointing at the download page: it carries the install notes,
    // and the page highlights the right build anyway.
    el.setAttribute('href', 'download.html#' + os);
  });

  // ---------- download page: the big card ----------

  var card = document.getElementById('dl-primary');
  if (card) {
    var ICONS = {
      win: '<svg class="os-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 5.6l7.3-1v7.1H3V5.6zm0 12.8l7.3 1v-7H3v6zM11.4 4.4L21 3v8.7h-9.6V4.4zm0 15.2L21 21v-8.6h-9.6v7.2z"/></svg>',
      mac: '<svg class="os-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.3 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.2-2.8.9-3.5.9s-1.8-.8-3-.8c-1.5 0-2.9.9-3.7 2.3-1.6 2.7-.4 6.8 1.1 9 .8 1.1 1.7 2.3 2.9 2.2 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.8-2.2.9-1.2 1.3-2.5 1.3-2.5s-2.5-1-2.5-3.6zM14 5.6c.6-.8 1.1-1.9 1-3-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.8-1 2.9 1.2.0 2.2-.6 2.9-1.4z"/></svg>',
      linux: '<svg class="os-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c-2.2 0-3.6 1.8-3.5 4.2.1 1.6-.1 2.4-.8 3.5C6.4 11.6 5.6 13 5.6 14.6c0 .7.2 1.3.5 1.8-.5.5-.9 1.1-.9 1.8 0 1.4 1.6 1.7 3.2 2 1 .2 1.8.6 2.4 1 .4.3.8.4 1.2.4s.8-.1 1.2-.4c.6-.4 1.4-.8 2.4-1 1.6-.3 3.2-.6 3.2-2 0-.7-.4-1.3-.9-1.8.3-.5.5-1.1.5-1.8 0-1.6-.8-3-2.1-4.9-.7-1.1-.9-1.9-.8-3.5C15.6 3.8 14.2 2 12 2zm-1.5 3.2c.4 0 .7.5.7 1s-.3 1-.7 1-.7-.5-.7-1 .3-1 .7-1zm3 0c.4 0 .7.5.7 1s-.3 1-.7 1-.7-.5-.7-1 .3-1 .7-1zM12 8.3c.9 0 2 .6 2 1 0 .3-.3.5-.7.8-.4.3-.9.6-1.3.6s-.9-.3-1.3-.6c-.4-.3-.7-.5-.7-.8 0-.4 1.1-1 2-1z"/></svg>',
      other: '<svg class="os-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>'
    };

    var COPY = {
      win: {
        h: 'Plume for Windows',
        meta: 'Windows 10 or 11, 64-bit &middot; ' + FILES.win,
        href: BASE + FILES.win,
        btn: 'Download the installer',
        alt: 'On a Mac or Linux instead? <a href="#mac">macOS</a> &middot; <a href="#linux">Linux</a>'
      },
      mac: {
        h: 'Plume for macOS',
        meta: 'Apple silicon (M1 and later) &middot; ' + FILES.macArm,
        href: BASE + FILES.macArm,
        btn: 'Download for Apple silicon',
        alt: 'Got an Intel Mac? <a href="' + BASE + FILES.macIntel + '">Download the Intel build</a> &middot; <a href="#mac">all macOS files</a>'
      },
      linux: {
        h: 'Plume for Linux',
        meta: 'x86-64 &middot; ' + FILES.appimage,
        href: BASE + FILES.appimage,
        btn: 'Download the AppImage',
        alt: 'Debian or Ubuntu? <a href="' + BASE + FILES.deb + '">Download the .deb</a> &middot; <a href="#linux">all Linux files</a>'
      },
      other: {
        h: 'Pick your system',
        meta: 'Plume ' + VERSION + ' runs on Windows, macOS and Linux',
        href: '#win',
        btn: 'See all downloads',
        alt: '<a href="#win">Windows</a> &middot; <a href="#mac">macOS</a> &middot; <a href="#linux">Linux</a>'
      }
    };

    var c = COPY[os];
    card.innerHTML =
      ICONS[os] +
      '<h2>' + c.h + '</h2>' +
      '<p class="meta">' + c.meta + '</p>' +
      '<a class="btn btn-primary btn-lg btn-block" href="' + c.href + '"' +
        (os === 'other' ? '' : ' download') + '>' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>' +
        c.btn +
      '</a>' +
      '<p class="dl-alt">' + c.alt + '</p>';
  }

  // Stamp the version wherever the page asks for it.
  Array.prototype.forEach.call(document.querySelectorAll('[data-version]'), function (el) {
    el.textContent = VERSION;
  });

  // ---------- live counters ----------
  //
  // Drawn only once the real numbers arrive, so the page never shows a made-up
  // figure, and never a zero that is really "not loaded yet".

  var counters = document.getElementById('counters');
  if (counters) {
    fetch('/api/stats')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || data.ok === false) return;
        var any = false;
        Array.prototype.forEach.call(counters.querySelectorAll('[data-count]'), function (el) {
          var value = data[el.getAttribute('data-count')];
          if (typeof value !== 'number') return;
          el.textContent = value.toLocaleString();
          any = true;
        });
        if (!any) return;
        counters.hidden = false;
        requestAnimationFrame(function () { counters.classList.add('ready'); });
      })
      .catch(function () { /* the page is fine without them */ });
  }

  // ---------- am I signed in? ----------
  //
  // The marketing pages do not talk to the API, but they can see whether a
  // session exists, which is all that is needed to offer the way back in — and
  // the way out.

  var account = document.getElementById('nav-account');
  var signout = document.getElementById('nav-signout');
  if (account) {
    var signedIn = false;
    try { signedIn = Boolean(localStorage.getItem('plume-vault-token')); } catch (e) { /* private mode */ }

    if (signedIn) {
      account.textContent = 'My vault';
      if (signout) {
        signout.hidden = false;
        signout.addEventListener('click', function () {
          try { localStorage.removeItem('plume-vault-token'); } catch (e) { /* ignore */ }
          account.textContent = 'Sign in';
          signout.hidden = true;
        });
      }
    }
  }
})();
