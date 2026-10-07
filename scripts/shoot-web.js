'use strict';

// Captures the website screenshots the documentation uses: the web vault,
// its graph and the API tokens panel, plus the public pages.
//
//   set PLUME_SITE=http://localhost:3001
//   set PLUME_SHOTS=docs\screenshots
//   npx electron scripts/shoot-web.js
//
// Point it at a site serving a vault of your own, never production: it signs
// up an account and creates a token.
//
// Electron's Windows binary is a GUI process, so nothing it prints reaches the
// console that started it. Everything is logged to a file beside the shots.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Configured through the environment rather than argv: Electron takes a
// URL-shaped command-line argument for itself and never starts the script.
const SITE = String(process.env.PLUME_SITE || 'http://localhost:3001').replace(/\/+$/, '');
const SHOTS = process.env.PLUME_SHOTS || path.join(__dirname, '..', 'docs', 'screenshots');
const LOG = path.join(SHOTS, 'shoot-web.log');

fs.mkdirSync(SHOTS, { recursive: true });
fs.writeFileSync(LOG, `shoot-web ${new Date().toISOString()}\nsite: ${SITE}\n`);

function say(line) {
  fs.appendFileSync(LOG, String(line) + '\n');
}

if (/plume-md\.com/i.test(SITE)) {
  say('refusing to run against production');
  process.exit(2);
}

const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'plume-web-shots-')));

const EMAIL = 'you-' + Date.now() + '@example.com';
const PASSWORD = 'a-good-long-password-1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NOTES = {
  'Index.md': '# Index\n\nStart at [[Projects/Plume]] and [[Reading/Books]].\n',
  'Projects/Plume.md': '# Plume\n\nFrom [[Index]]. See also [[Reading/Books]].\n',
  'Projects/Vault.md': '# Vault\n\nPart of [[Projects/Plume]]. Linked from [[Index]].\n',
  'Reading/Books.md': '# Books\n\nBack to [[Index]]. Mentions [[Reading/Markdown]].\n',
  'Reading/Markdown.md': '# Markdown\n\nFrom [[Reading/Books]] and [[Projects/Plume]].\n',
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1340,
    height: 900,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });

  const run = (js) => win.webContents.executeJavaScript('(async () => { ' + js + ' })()');
  const read = (expr) => win.webContents.executeJavaScript('(async () => (' + expr + '))()');

  async function until(expr, timeout) {
    const deadline = Date.now() + (timeout || 20000);
    for (;;) {
      if (await read(expr)) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  }

  async function shoot(name) {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOTS, name + '.png'), img.toPNG());
    say('  ' + name + '.png');
  }

  try {
    // ---- the public pages ----
    for (const page of [['/', 'web-home'], ['/download.html', 'web-download'], ['/docs.html', 'web-docs']]) {
      await win.loadURL(SITE + page[0]);
      await sleep(1700);
      await shoot(page[1]);
    }

    // ---- the vault, signed out ----
    await win.loadURL(SITE + '/app.html');
    await sleep(1400);
    await shoot('web-signin');

    // ---- create an account ----
    await run(
      "document.getElementById('tab-signup').click();"
      + "document.getElementById('email').value = " + JSON.stringify(EMAIL) + ';'
      + "document.getElementById('password').value = " + JSON.stringify(PASSWORD) + ';'
      + "document.getElementById('auth-submit').click();",
    );
    if (!(await until('!document.getElementById("vault").hidden', 30000))) {
      throw new Error('could not sign up: ' + (await read('(document.getElementById("gate-msg")||{}).textContent')));
    }
    await sleep(1200);
    say('signed up as ' + EMAIL);

    // ---- a small linked notebook, so nothing on screen is empty ----
    for (const name of Object.keys(NOTES)) {
      await run(
        "await fetch('/api/vault/file?path=' + encodeURIComponent(" + JSON.stringify(name) + '), {'
        + "method: 'PUT',"
        + "headers: { Authorization: 'Bearer ' + localStorage.getItem('plume-vault-token') },"
        + 'body: ' + JSON.stringify(NOTES[name]) + ','
        + '});',
      );
    }
    await run("document.getElementById('refresh').click();");
    await sleep(3000);

    await run('window.scrollTo(0, 0);');
    await sleep(500);
    await shoot('web-vault');

    // ---- the graph ----
    // Let the graph settle before moving to it; scrolling while the force
    // simulation is still running has the page jump back under the capture.
    await sleep(2600);
    const graphTop = await read(
      '(() => { const el = document.querySelector(".graph-panel");'
      + ' return el ? Math.round(el.getBoundingClientRect().top + window.scrollY - 20) : -1; })()',
    );
    await run('window.scrollTo({ top: ' + graphTop + ', behavior: "instant" });');
    await sleep(900);
    say('graph panel at ' + graphTop + ', scrolled to ' + (await read('Math.round(window.scrollY)')));
    await shoot('web-graph');

    // ---- API tokens ----
    await run(
      "document.getElementById('tok-name').value = 'Claude Code on my laptop';"
      + "document.getElementById('tok-form').querySelector('button[type=\"submit\"]').click();",
    );
    await until('document.getElementById("tok-reveal").classList.contains("show")', 20000);
    await sleep(900);

    const made = await read('document.getElementById("tok-reveal").classList.contains("show")');
    say('token created: ' + made);
    // Never ship a screenshot of a real credential, even a disposable one.
    await run('document.getElementById("tok-value").textContent = "plm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";');
    const tokTop = await read(
      '(() => { const el = document.getElementById("tok-form");'
      + ' return el ? Math.round(el.getBoundingClientRect().top + window.scrollY - 170) : -1; })()',
    );
    await run('window.scrollTo({ top: ' + tokTop + ', behavior: "instant" });');
    await sleep(700);
    say('token form at ' + tokTop + ', scrolled to ' + (await read('Math.round(window.scrollY)')));
    await shoot('web-tokens');

    say('done');
    app.exit(0);
  } catch (err) {
    say('failed: ' + (err && err.stack ? err.stack : err));
    app.exit(1);
  }
});
