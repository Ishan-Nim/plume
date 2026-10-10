'use strict';

// End-to-end check of Plume on the web, in a real browser window.
//
//   node scripts/build.js
//   node scripts/dev-server-memory.js   (in the plume-vault repository)
//   PLUME_VAULT_API=http://127.0.0.1:8098/api npx electron test/e2e/web-flow.js
//
// It signs up, puts a vault's worth of documents into the account through the
// API, and then does the rest through the page itself: the vaults are listed,
// a note opens and renders, a wiki link goes to the note it names, an edit
// saves, and a reload shows what was saved. The page is the thing under test,
// so nothing below reaches past it into the bundle.
//
// Env: PLUME_VAULT_API (required — never production), PLUME_SHOTS, PLUME_SIZE.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API = process.env.PLUME_VAULT_API;
if (!API) {
  console.error('web-flow: PLUME_VAULT_API is required');
  process.exit(2);
}
if (/plume-md\.com/i.test(API)) {
  console.error('web-flow: refusing to run against production');
  process.exit(2);
}
const ORIGIN = API.replace(/\/api\/?$/, '');

const SHOTS = process.env.PLUME_SHOTS || path.join(os.tmpdir(), 'plume-web-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-web-'));
app.setPath('userData', tmp);

const [w, h] = (process.env.PLUME_SIZE || '1340x880').split('x').map(Number);

const EMAIL = `web-${Date.now()}@plume-md.test`;
const PASSWORD = 'web-flow-password-1';
const VAULT = 'Field Notes';

const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0;
const failures = [];
const logs = [];

function record(what, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${what}${detail ? `  — ${detail}` : ''}`);
  } else {
    failures.push(`${what}${detail ? `  — ${detail}` : ''}`);
    console.log(`FAIL  ${what}${detail ? `  — ${detail}` : ''}`);
  }
}

async function post(pathname, body, token) {
  const res = await fetch(API + pathname, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function put(docPath, text, token) {
  const res = await fetch(`${API}/vault/file?path=${encodeURIComponent(docPath)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/markdown', Authorization: `Bearer ${token}` },
    body: text,
  });
  return res.status;
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (event, level, message) => {
    const text = typeof event === 'object' && event.message ? event.message : message;
    logs.push(String(text));
  });
});

app.whenReady().then(async () => {
  // ---- an account with some notes in it, made through the API ------------
  // The same endpoint the desktop app signs up with, so this test needs no
  // mailbox. The server closes it with SIGNUP_REQUIRES_CODE=1; if that is set,
  // make the account by hand and pass its token in PLUME_TOKEN.
  let token = process.env.PLUME_TOKEN || null;
  if (!token) {
    const made = await post('/auth/signup', { email: EMAIL, password: PASSWORD });
    token = made.body && made.body.token;
    if (!token) {
      const login = await post('/auth/login', { email: EMAIL, password: PASSWORD });
      token = login.body && login.body.token;
    }
    if (!token) {
      console.error('web-flow: could not create an account —',
        (made.body && made.body.error) || made.status);
    }
  }

  record('an account can be made to test against', Boolean(token));
  if (!token) { app.exit(1); return; }

  await put(`${VAULT}/Index.md`, [
    '# Index',
    '',
    'Start at [[Plume]].',
    '',
    '## What renders',
    '',
    '| Feature | Looks like |',
    '| --- | --- |',
    '| Highlights | ==important bits== |',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '- [ ] a task',
    '- [x] a finished one',
    '',
  ].join('\n'), token);
  await put(`${VAULT}/Plume.md`, '# Plume\n\nBack to [[Index]].\n', token);
  await put(`${VAULT}/Journal/Monday.md`, '# Monday\n\nA note in a folder.\n', token);

  // ---- the page ----------------------------------------------------------
  const win = new BrowserWindow({
    width: w, height: h, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const wc = win.webContents;
  const run = js => wc.executeJavaScript(`(async () => { ${js} })()`);
  const read = js => wc.executeJavaScript(js);
  const shot = async name => {
    await sleep(400);
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), (await wc.capturePage()).toPNG());
  };
  const until = async (expr, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await read(expr).catch(() => false)) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  try {
    // The token is where the account page leaves it; this is a signed-in visit.
    await wc.loadURL(`${ORIGIN}/app.html`);
    await run(`localStorage.setItem('plume-vault-token', ${JSON.stringify(token)});`);

    await wc.loadURL(`${ORIGIN}/notes.html`);
    record('the web view loads', await until('document.readyState === "complete"'));
    record('and signs itself in rather than bouncing to the account page',
      await until('!document.body.classList.contains("w-booting")', 20000),
      await read('location.pathname'));

    record('the account is named, with its quota',
      await until('/@/.test(document.getElementById("w-who").textContent)')
      && /of/.test(await read('document.getElementById("w-quota").textContent')),
      await read('document.getElementById("w-quota").textContent'));

    record('the cloud vault is listed',
      (await read('[...document.querySelectorAll(".w-vault b")].map(e => e.textContent).join(",")'))
        .includes(VAULT),
      await read('[...document.querySelectorAll(".w-vault b")].map(e => e.textContent).join(",")'));

    record('its documents are in the tree',
      (await read('document.querySelectorAll("#w-tree .w-file").length')) >= 2,
      `${await read('document.querySelectorAll("#w-tree .w-file").length')} files at the top level`);
    record('and a folder inside it is a folder',
      (await read('document.querySelectorAll("#w-tree .w-folder").length')) >= 1);
    await shot('web-01-signed-in');

    // ---- reading ---------------------------------------------------------
    await run(`
      const row = [...document.querySelectorAll('#w-tree .w-file')]
        .find(b => b.textContent.trim() === 'Index');
      if (row) row.click();
    `);
    record('a note opens', await until('!document.getElementById("w-doc").hidden'));
    record('and is rendered, not shown as text',
      (await read('document.querySelectorAll("#w-article h1, #w-article h2").length')) >= 2,
      `${await read('document.querySelectorAll("#w-article *").length')} nodes`);
    record('tables render', (await read('document.querySelectorAll("#w-article table").length')) >= 1);
    record('code is highlighted',
      (await read('document.querySelectorAll("#w-article .hljs, #w-article pre code").length')) >= 1);
    record('task lists render as checkboxes',
      (await read('document.querySelectorAll("#w-article input[type=checkbox]").length')) >= 2);
    record('highlights render', (await read('document.querySelectorAll("#w-article mark").length')) >= 1);
    record('the breadcrumb says where the note is',
      /Index/.test(await read('document.getElementById("w-crumb").textContent')),
      await read('document.getElementById("w-crumb").textContent'));
    record('the word count is shown',
      /word/.test(await read('document.getElementById("w-stats").textContent')),
      await read('document.getElementById("w-stats").textContent'));
    await shot('web-02-reading');

    // ---- a wiki link goes somewhere --------------------------------------
    record('a wiki link is a link', (await read('document.querySelectorAll("#w-article a.wikilink").length')) >= 1);
    await run(`
      const a = document.querySelector('#w-article a.wikilink');
      if (a) a.click();
    `);
    record('and follows to the note it names',
      await until('/Plume/.test(document.getElementById("w-crumb").textContent)'),
      await read('document.getElementById("w-crumb").textContent'));

    // ---- a note in a folder ----------------------------------------------
    await run(`
      const f = document.querySelector('#w-tree .w-folder');
      if (f) f.open = true;
      await new Promise(r => setTimeout(r, 200));
      const row = [...document.querySelectorAll('#w-tree .w-file')].find(b => /Monday/.test(b.textContent));
      if (row) row.click();
    `);
    record('a note inside a folder opens',
      await until('/Monday/.test(document.getElementById("w-crumb").textContent)'));

    // ---- searching -------------------------------------------------------
    await run(`
      const s = document.getElementById('w-search');
      s.value = 'plume';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await sleep(400);
    record('search narrows the list',
      (await read('document.querySelectorAll("#w-tree .w-file").length')) === 1,
      `${await read('document.querySelectorAll("#w-tree .w-file").length')} match`);
    await run(`
      const s = document.getElementById('w-search');
      s.value = '';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await sleep(300);

    // ---- editing and saving ----------------------------------------------
    await run(`
      const row = [...document.querySelectorAll('#w-tree .w-file')].find(b => b.textContent.trim() === 'Plume');
      if (row) row.click();
    `);
    await until('/Plume/.test(document.getElementById("w-crumb").textContent)');

    await run("document.getElementById('w-edit').click();");
    record('Edit shows the Markdown source',
      await until('!document.getElementById("w-editor").hidden')
      && /# Plume/.test(await read('document.getElementById("w-editor").value')));
    await shot('web-03-editing');

    const ADDED = 'A line typed in the browser.';
    await run(`
      const t = document.getElementById('w-editor');
      t.value = t.value + '\\n${ADDED}\\n';
      t.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    record('an unsaved change offers Save', await until('!document.getElementById("w-save").hidden'));

    await run("document.getElementById('w-save').click();");
    record('saving reports success',
      await until('/Saved/.test(document.getElementById("w-toast").textContent)', 20000),
      await read('document.getElementById("w-toast").textContent'));

    // The account is the proof, not the page.
    const check = await fetch(`${API}/vault/file?path=${encodeURIComponent(`${VAULT}/Plume.md`)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const stored = await check.text();
    record('and the account really has the new text', stored.includes(ADDED));

    // ---- a link straight to a document -----------------------------------
    await wc.loadURL(`${ORIGIN}/notes.html#${encodeURIComponent(`${VAULT}/Journal/Monday.md`)}`);
    record('a link to a note opens that note',
      await until('/Monday/.test(document.getElementById("w-crumb").textContent)', 20000),
      await read('document.getElementById("w-crumb").textContent'));
    await shot('web-04-deep-link');

    const bad = logs.filter(l => /uncaught|TypeError|ReferenceError|Cannot read/i.test(l));
    record('the page logged no errors', bad.length === 0, bad.slice(0, 2).join(' | '));

    console.log('');
    if (failures.length) {
      console.log(`${pass} passed, ${failures.length} FAILED`);
      for (const f of failures) console.log(`  FAIL  ${f}`);
      app.exit(1);
      return;
    }
    console.log(`${pass}/${pass} checks passed — shots in ${SHOTS}`);
    app.exit(0);
  } catch (err) {
    console.error('web-flow threw:', err);
    app.exit(2);
  }
});
