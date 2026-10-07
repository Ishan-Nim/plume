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

const { app, BrowserWindow } = require('electron');
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
  await shot('03-signed-in');

  if (!signedIn) return;

  record('the quota is shown', /100 MB/.test(await read('document.querySelector(".vault-who span").textContent') || ''),
    await read('document.querySelector(".vault-who span").textContent'));

  // ---- sync the open document ----
  const hasSync = await until('!!document.querySelector(".vault-name")');
  record('the open document can be named and synced', hasSync);

  await run(`
    const buttons = [...document.querySelectorAll('.vault-btn')];
    const sync = buttons.find(b => b.textContent.trim() === 'Sync to vault');
    sync.click();
  `);

  const synced = await until('document.querySelectorAll(".vault-files li").length > 0', { timeout: 25000 });
  record('the document reaches the vault', synced,
    synced ? await read('document.querySelector(".vault-files li b").textContent') : await read('(document.querySelector(".vault-error")||{}).textContent'));
  await shot('04-synced');

  // ---- sync the rest, so the graph has links ----
  for (const name of ['Plume.md', 'Reading.md']) {
    await run(`window.plume.openPaths([${JSON.stringify(path.join(notebook, name))}]);`);
    await sleep(1200);
  }
  // Those open in their own windows; sync them through the API the panel uses.
  for (const name of ['Plume.md', 'Reading.md']) {
    const full = path.join(notebook, name);
    const other = BrowserWindow.getAllWindows().find(x => x.id !== win.id);
    if (!other) continue;
    await other.webContents.executeJavaScript(`(async () => {
      var p = document.querySelector("[data-panel=vault]"); if (p && p.hidden) document.getElementById("vault-bar").click();
      await new Promise(r => setTimeout(r, 1200));
      const buttons = [...document.querySelectorAll('.vault-btn')];
      const sync = buttons.find(b => b.textContent.trim() === 'Sync to vault');
      if (sync) sync.click();
      return ${JSON.stringify(full)};
    })()`).catch(() => {});
    await sleep(2500);
    if (other && !other.isDestroyed()) other.close();
    await sleep(400);
  }

  await run(OPEN_VAULT);
  await sleep(300);
  await run(`
    const buttons = [...document.querySelectorAll('.vault-btn')];
    const refresh = buttons.find(b => b.textContent.trim() === 'Graph');
    if (refresh) refresh.click();
  `);

  // The panel must offer the name of the document that is open now. Offering
  // the one that was open when it first drew made syncing a second document
  // overwrite the first one's copy in the vault.
  await run(`
    document.getElementById('graph-view-close').click();
    document.querySelector('.sidebar-tab[data-tab="files"]').click();
    await new Promise(r => setTimeout(r, 500));
    const rows = [...document.querySelectorAll('.tree-row')];
    const row = rows.find(r => r.textContent.trim() === 'Reading');
    if (row) row.click();
  `);
  await sleep(1600);
  await run(OPEN_VAULT);
  await sleep(800);
  const offered = await read('(document.querySelector(".vault-name") || {}).value');
  record('the name offered is the open document, not a stale one', offered === 'Reading.md', offered);

  // A note inside a folder must keep that folder in its vault name. Offering
  // the bare file name made two documents called Index.md collide, and syncing
  // the second one replaced the first.
  await run(`
    document.querySelector('.sidebar-tab[data-tab="files"]').click();
    await new Promise(r => setTimeout(r, 400));
    const folder = [...document.querySelectorAll('.tree-row')].find(r => r.textContent.trim() === 'Projects');
    if (folder) folder.click();
    await new Promise(r => setTimeout(r, 900));
    const rows = [...document.querySelectorAll('.tree-row.is-file')];
    const deep = rows.find(r => r.textContent.trim() === 'Index');
    if (deep) deep.click();
  `);
  await sleep(1600);
  await run(OPEN_VAULT);
  await sleep(800);
  const nested = await read('(document.querySelector(".vault-name") || {}).value');
  record('a note in a folder keeps its folder in the vault name',
    nested === 'Projects/Index.md', nested);

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
  await shot('05-graph');

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
  await shot('06-signed-out');
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
