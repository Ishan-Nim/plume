'use strict';

// End-to-end check of the whole vault flow in the real app: sign up, sync the
// open document, read the file list, draw the graph, sign out. It drives the
// actual UI rather than the IPC layer, so a button that stops being wired up
// fails this test.
//
//   set PLUME_VAULT_API=http://127.0.0.1:8098/api
//   set PLUME_SHOTS=path\to\shots
//   npx electron test/e2e/vault-flow.js
//
// Env: PLUME_VAULT_API (required — never point this at production),
//      PLUME_SHOTS (directory for screenshots), PLUME_SIZE, PLUME_THEME.

const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API = process.env.PLUME_VAULT_API;
if (!API) {
  console.error('vault-flow: PLUME_VAULT_API is required');
  process.exit(2);
}
if (/plume-md\.com/i.test(API)) {
  console.error('vault-flow: refusing to run against production');
  process.exit(2);
}

const SHOTS = process.env.PLUME_SHOTS || path.join(os.tmpdir(), 'plume-vault-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-vault-'));
app.setPath('userData', tmp);

const [w, h] = (process.env.PLUME_SIZE || '1340x880').split('x').map(Number);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: process.env.PLUME_THEME || 'light',
  bounds: { x: 40, y: 40, width: w, height: h },
  sidebar: true,
}));

// A small linked notebook to sync, so the graph has something to draw.
const notebook = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-notes-'));
const NOTES = {
  'Index.md': '# Index\n\nStart with [[Plume]] and [[Reading]].\n',
  'Plume.md': '# Plume\n\nBack to [[Index]]. See also [[Reading]].\n',
  'Reading.md': '# Reading\n\nFrom [[Index]]. Nothing links to [[Someday]] yet.\n',
};
for (const [name, body] of Object.entries(NOTES)) {
  fs.writeFileSync(path.join(notebook, name), body);
}
fs.mkdirSync(path.join(notebook, 'Projects'), { recursive: true });
fs.writeFileSync(
  path.join(notebook, 'Projects', 'Index.md'),
  ['# Project index', '', 'A second Index, under a folder.', ''].join('\n'),
);

const firstNote = path.join(notebook, 'Index.md');
process.argv.push(firstNote);

const EMAIL = `qa-${Date.now()}@plume-md.test`;
const PASSWORD = 'qa-flow-password-1';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The vault sits in a bar at the foot of the sidebar, and that bar toggles —
// so clicking it blindly a second time would close what we just opened.
const OPEN_VAULT = 'var p = document.querySelector("[data-panel=vault]");'
  + ' if (p && p.hidden) document.getElementById("vault-bar").click();';

const logs = [];
const results = [];
let failures = 0;

// Linking a vault and deleting one from the account are confirmed by the main
// process with a native dialog, which a headless run cannot click. The answers
// are recorded so the run can assert that the question was asked at all —
// that confirmation is the control, so a release that quietly dropped it
// should fail here rather than pass.
const asked = [];
dialog.showMessageBox = async (_win, options) => {
  asked.push(options.title || '');
  return { response: 0, checkboxChecked: false };
};

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main(win) {
  const wc = win.webContents;
  const run = js => wc.executeJavaScript(`(async () => { ${js} })()`);
  const read = expr => wc.executeJavaScript(`(async () => (${expr}))()`);
  const shot = async name => {
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), img.toPNG());
  };

  /** Waits for an expression to become truthy. */
  async function until(expr, { timeout = 15000, every = 150 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await read(expr)) return true;
      if (Date.now() > deadline) return false;
      await sleep(every);
    }
  }

  // ---- the document itself ----
  await until('document.body.dataset.ready === "1"');
  await sleep(600);
  record('a document opens', await read('!!document.querySelector("#doc h1")'),
    await read('document.querySelector("#doc h1") && document.querySelector("#doc h1").textContent'));
  await shot('01-document');

  // ---- the vault tab exists and is not a dialog ----
  record('the sidebar has a vault bar at the foot', await read('!!document.getElementById("vault-bar")'));
  record('no modal overlay is used', await read('!document.querySelector(".vault-overlay")'));

  await run(OPEN_VAULT);
  const gotForm = await until('!!document.getElementById("vault-email")');
  record('the sign-in form appears in place', gotForm);
  await shot('02-signin');

  if (!gotForm) return;

  // ---- create an account ----
  await run(`
    document.querySelector('.vault-tabs button:last-child').click();
  `);
  await sleep(250);
  record('the create-account mode is reachable',
    await read('document.querySelector(".vault-tabs button:last-child").getAttribute("aria-pressed") === "true"'));

  await run(`
    const email = document.getElementById('vault-email');
    const password = document.getElementById('vault-password');
    email.value = ${JSON.stringify(EMAIL)};
    password.value = ${JSON.stringify(PASSWORD)};
    email.dispatchEvent(new Event('input', { bubbles: true }));
    password.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.vault-form button[type="submit"]').click();
  `);

  const signedIn = await until('!!document.querySelector(".vault-account")', { timeout: 25000 });
  record('signing up signs you in', signedIn,
    signedIn ? await read('document.querySelector(".vault-who b").textContent') : await read('(document.querySelector(".vault-error")||{}).textContent'));
  await shot('02b-signed-in');

  if (!signedIn) return;

  record('the quota is shown', /100 MB/.test(await read('document.querySelector(".vault-who").textContent') || ''),
    await read('document.querySelector(".vault-who").textContent'));

  // ---- the folder on screen is loose, and says so ----
  //
  // This is the promise the whole model rests on, so it is checked in the UI
  // and not only in the sync tests: a folder you opened while signed in is
  // still just a folder, and the panel says so rather than offering to sync it.
  const looseShown = await until('!!document.querySelector(".vault-current-info")');
  const looseLine = await read('(document.querySelector(".vault-current-info span")||{}).textContent');
  record('an opened folder is shown as a folder, not a vault',
    looseShown && /not a vault/i.test(looseLine || ''), looseLine);
  record('a loose folder offers to become a vault',
    await read(`[...document.querySelectorAll('.vault-btn')].some(b => /^Create vault/.test(b.textContent.trim()))`));
  await shot('03-loose-folder');

  // ---- make it a vault ----
  await run(`
    const make = [...document.querySelectorAll('.vault-btn')].find(b => /^Create vault/.test(b.textContent.trim()));
    make.click();
  `);
  const becameVault = await until(
    '/on this computer/i.test((document.querySelector(".vault-current-info span")||{}).textContent || "")',
    { timeout: 20000 },
  );
  record('creating a vault is one click, and it happens in place', becameVault,
    await read('(document.querySelector(".vault-current-info span")||{}).textContent'));
  record('a new vault is on this computer only, not linked',
    await read(`[...document.querySelectorAll('.vault-btn')].some(b => b.textContent.trim() === 'Link to my account')`));
  record('the vault was made where the notes already are',
    fs.existsSync(path.join(notebook, '.plume', 'vault.json')));
  record('creating a vault moved nothing',
    fs.existsSync(path.join(notebook, 'Index.md'))
    && fs.existsSync(path.join(notebook, 'Projects', 'Index.md')));
  await shot('04-local-vault');

  // ---- link it ----
  //
  // window.confirm would block the run, so it is answered yes for this click
  // and put back afterwards. What is being tested is the wiring, not the
  // dialog — but the dialog existing at all is the point of the next check.
  const hasConfirm = await read(`(() => {
    const b = [...document.querySelectorAll('.vault-btn')].find(x => x.textContent.trim() === 'Link to my account');
    return !!b;
  })()`);
  record('linking is offered as a deliberate, separate act', hasConfirm);

  await run(`
    const was = window.confirm;
    window.confirm = () => true;
    const link = [...document.querySelectorAll('.vault-btn')].find(b => b.textContent.trim() === 'Link to my account');
    link.click();
    await new Promise(r => setTimeout(r, 400));
    window.confirm = was;
  `);

  const linked = await until(
    `[...document.querySelectorAll('.vault-btn')].some(b => b.textContent.trim() === 'Unlink')`,
    { timeout: 30000 },
  );
  record('linking a vault connects it to the account', linked,
    await read('(document.querySelector(".vault-current-info span")||{}).textContent'));

  // The renderer's own confirm is not the control — a compromised renderer is
  // exactly the case it would not survive. The main process has to ask too.
  record('linking is confirmed by the main process, not only by the panel',
    asked.some(t => /Link this vault/i.test(t)), asked.join(' | ') || '(nothing asked)');

  const synced = await until('document.querySelectorAll(".vault-tree .vault-file").length > 0', { timeout: 30000 });
  record('the vault’s documents reach the account', synced,
    synced ? await read('document.querySelector(".vault-tree .vault-file b").textContent')
      : await read('(document.querySelector(".vault-error")||{}).textContent'));

  record('the account says which vault the documents are in',
    /In your account as/.test(await read('document.querySelector(".vault-current-info").textContent') || ''),
    await read('document.querySelector(".vault-current-info").textContent'));
  await shot('05-linked-vault');

  // ---- the quota is one pool, and it says so ----
  record('the quota is shown as one pool across linked vaults',
    /shared across/.test(await read('document.querySelector(".vault-who").textContent') || ''),
    await read('document.querySelector(".vault-who").textContent'));

  // ---- the graph, which is a thing only a vault has ----
  await run(OPEN_VAULT);
  await sleep(300);
  await run(`
    const again = [...document.querySelectorAll('.vault-btn')].find(b => b.textContent.trim() === 'Graph');
    if (again) again.click();
  `);

  const graphShown = await until('!document.getElementById("graph-view").hidden', { timeout: 20000 });
  record('the graph view opens', graphShown);

  const drew = await until('!document.getElementById("graph-view-empty").hidden === false', { timeout: 20000 })
    || await until('document.getElementById("graph-view-empty").hidden === true', { timeout: 20000 });
  const meta = await read('document.getElementById("graph-view-meta").textContent');
  record('the graph has documents and links', /document/.test(meta || ''), meta);
  await sleep(1500);
  await shot('06-graph');

  record('the graph canvas painted', await read(`(() => {
    const c = document.getElementById('graph-view-canvas');
    return !!c && c.width > 0 && c.height > 0;
  })()`));

  await run('document.getElementById("graph-view-close").click();');
  await sleep(300);
  record('the graph closes again', await read('document.getElementById("graph-view").hidden'));

  // ---- signing out clears what was on screen ----
  record('sign out is a labelled button, not a bare icon',
    await read('!!document.querySelector(".vault-account .vault-btn") && document.querySelector(".vault-account .vault-btn").textContent.trim() === "Sign out"'));

  await run(`
    document.querySelector('.vault-account .vault-btn').click();
  `);
  const signedOut = await until('!!document.getElementById("vault-email")', { timeout: 15000 });
  record('signing out returns to the form', signedOut);
  record('no account details are left behind',
    await read('!document.querySelector(".vault-who")'));
  await shot('07-signed-out');
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (event, level, message) => {
    const msg = typeof event === 'object' && event.message ? event.message : message;
    logs.push(String(msg));
  });
});

app.whenReady().then(async () => {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error('vault-flow: no window opened');
    app.exit(2);
    return;
  }
  try {
    await main(win);
  } catch (err) {
    record('the run finished without throwing', false, err && err.message);
  }

  const errors = logs.filter(l => /error|uncaught|refused|violat/i.test(l));
  record('the page logged no errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  fs.writeFileSync(path.join(SHOTS, 'report.json'), JSON.stringify({ results, logs }, null, 2));
  console.log(`\n${results.length - failures}/${results.length} checks passed — shots in ${SHOTS}`);
  app.exit(failures ? 1 : 0);
});

require('../../src/main/main.js');
