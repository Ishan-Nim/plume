'use strict';

// Captures the app screenshots the documentation uses, from the real app:
// the reading view, the vault panel signed out and signed in, the synced
// folder, the notebooks a second computer would be offered, and the graph.
//
//   set PLUME_VAULT_API=http://127.0.0.1:8098/api
//   set PLUME_SHOTS=docs\screenshots
//   npx electron scripts/shoot-app.js
//
// Point PLUME_VAULT_API at a vault of your own, never production: this signs
// up an account and syncs the demo notebook into it.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The vault shots need somewhere to sign up; the reading shots do not. Without
// an API only the local ones are taken, which is what you want after a change
// to how a document renders.
const API = process.env.PLUME_VAULT_API;
if (API && /plume-md\.com/i.test(API)) {
  console.error('shoot-app: PLUME_VAULT_API must be a vault of your own, never production');
  process.exit(2);
}
const VAULT_SHOTS = Boolean(API);

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.PLUME_SHOTS || path.join(ROOT, 'docs', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-shots-'));
app.setPath('userData', tmp);

const [w, h] = (process.env.PLUME_SIZE || '1380x880').split('x').map(Number);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'light',
  bounds: { x: 40, y: 40, width: w, height: h },
  sidebar: true,
  sidebarWidth: 280,
}));

// A copy of the demo notebook, so syncing does not touch the repository.
const notebook = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-demo-'));
fs.cpSync(path.join(ROOT, 'docs', process.env.PLUME_NOTEBOOK || 'demo-notebook'), notebook, { recursive: true });
const opener = path.join(notebook, process.env.PLUME_OPEN || 'A field guide to Plume.md');
process.argv.push(opener);

const EMAIL = `you-${Date.now()}@example.com`;
const PASSWORD = 'a-good-long-password-1';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Show windows without stealing focus or flashing on the desktop.
BrowserWindow.prototype.show = function show() {
  this.setOpacity(0);
  this.setSkipTaskbar(true);
  this.showInactive();
};
BrowserWindow.prototype.maximize = function maximize() {};

async function shoot(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), img.toPNG());
  console.log(`  ${name}.png`);
}

async function main(win) {
  const wc = win.webContents;
  const run = js => wc.executeJavaScript(`(async () => { ${js} })()`);
  const read = expr => wc.executeJavaScript(`(async () => (${expr}))()`);

  async function until(expr, timeout = 20000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await read(expr)) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  }

  await until('document.body.dataset.ready === "1"');
  await sleep(1200);

  // ---- reading ----
  await shoot(win, 'reading-light');

  await run(`window.plume.setSettings({ theme: 'dark' });`);
  await sleep(900);
  await shoot(win, 'reading-dark');
  await run(`window.plume.setSettings({ theme: 'light' });`);
  await sleep(700);

  await run(`document.querySelector('.sidebar-tab[data-tab="outline"]').click();`);
  await sleep(500);
  await shoot(win, 'outline');
  await run(`document.querySelector('.sidebar-tab[data-tab="files"]').click();`);
  await sleep(400);

  // ---- editing ----
  await run("document.getElementById('btn-edit').click();");
  await sleep(900);
  await shoot(win, 'editing');
  await run("document.getElementById('btn-edit').click();");
  await sleep(700);

  if (!VAULT_SHOTS) {
    console.log('\n(no PLUME_VAULT_API — the vault and graph shots were skipped)');
    return;
  }

  // ---- the vault, signed out ----
  await run(`var p = document.querySelector("[data-panel=vault]"); if (p && p.hidden) document.getElementById("vault-bar").click();`);
  await until('!!document.getElementById("vault-email")');
  await sleep(500);
  await shoot(win, 'vault-signin');

  // ---- sign up ----
  await run(`
    document.querySelector('.vault-tabs button:last-child').click();
    await new Promise(r => setTimeout(r, 200));
    const email = document.getElementById('vault-email');
    const password = document.getElementById('vault-password');
    email.value = ${JSON.stringify(EMAIL)};
    password.value = ${JSON.stringify(PASSWORD)};
    document.querySelector('.vault-form button[type="submit"]').click();
  `);
  if (!(await until('!!document.querySelector(".vault-account")', 30000))) {
    throw new Error('could not sign up');
  }
  await sleep(600);

  // ---- sync a few notes so the graph has something to draw ----
  const notes = fs.readdirSync(notebook).filter(n => n.endsWith('.md'));

  // Navigate the way a reader does — through the file tree — so the app's own
  // state follows along. Calling the IPC directly would move the document
  // without telling the renderer, and every sync would send the same file.
  for (const note of notes) {
    const name = path.basename(note, path.extname(note));
    await run(`
      document.querySelector('.sidebar-tab[data-tab="files"]').click();
      await new Promise(r => setTimeout(r, 400));
      const rows = [...document.querySelectorAll('.tree-row')];
      const row = rows.find(r => r.textContent.trim() === ${JSON.stringify(name)});
      if (row) row.click();
    `);
    await sleep(1400);
    await run(`var p = document.querySelector("[data-panel=vault]"); if (p && p.hidden) document.getElementById("vault-bar").click();`);
    await sleep(700);
    await run(`
      const sync = [...document.querySelectorAll('.vault-btn')]
        .find(b => b.textContent.trim() === 'Sync to vault');
      if (sync) sync.click();
    `);
    await sleep(2400);
  }

  await run(`
    document.querySelector('.sidebar-tab[data-tab="files"]').click();
    await new Promise(r => setTimeout(r, 400));
    const rows = [...document.querySelectorAll('.tree-row')];
    const row = rows.find(r => r.textContent.trim() === 'A field guide to Plume');
    if (row) row.click();
  `);
  await sleep(1500);
  await run(`var p = document.querySelector("[data-panel=vault]"); if (p && p.hidden) document.getElementById("vault-bar").click();`);
  await sleep(900);
  await shoot(win, 'vault-synced');

  // ---- the graph ----
  await run(`
    const graph = [...document.querySelectorAll('.vault-btn')].find(b => b.textContent.trim() === 'Graph');
    if (graph) graph.click();
  `);
  await until('!document.getElementById("graph-view").hidden', 25000);
  await sleep(3500);
  await run(`document.getElementById('graph-view-fit').click();`);
  await sleep(1200);
  await shoot(win, 'vault-graph');
  await run(`document.getElementById('graph-view-close').click();`);
  await sleep(900);

  // ---- the folder, synced ----
  //
  // The vault is the folder you are working in, so this is the shot that
  // matters most: which folder, which notebook of the vault it is, and that
  // it is up to date. The folder is set here rather than through the page —
  // it is not one of the settings a renderer may change, for the same reason
  // a web page cannot choose which folder of yours an app syncs.
  const settings = require('../src/main/settings');
  const sync = require('../src/main/sync');
  settings.update({
    folder: notebook,
    vaultFolder: notebook,
    vaultPrefix: sync.prefixFor(notebook),
  });
  sync.refresh();
  await sleep(1200);
  await sync.syncNow();

  wc.reload();
  await until('document.body.dataset.ready === "1"', 20000);
  await sleep(1400);
  await run(`
    var p = document.querySelector("[data-panel=vault]");
    if (p && p.hidden) document.getElementById("vault-bar").click();
  `);
  await until('!!document.querySelector(".vault-current-info")', 12000);
  await sleep(900);
  await shoot(win, 'vault-folder');

  // ---- what a second computer is offered ----
  //
  // The same account with no folder on this machine: the notebooks already in
  // the vault, each with a way to put it here.
  settings.update({ vaultFolder: null, vaultPrefix: null, folder: null });
  sync.refresh();
  wc.reload();
  await until('document.body.dataset.ready === "1"', 20000);
  await sleep(1400);
  await run(`
    var p = document.querySelector("[data-panel=vault]");
    if (p && p.hidden) document.getElementById("vault-bar").click();
  `);
  await until('!!document.querySelector(".vault-existing .vault-row")', 12000);
  await sleep(900);
  await shoot(win, 'vault-notebooks');

  console.log(`\naccount used: ${EMAIL}`);
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', () => {});
});

app.whenReady().then(async () => {
  await sleep(1800);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error('shoot-app: no window');
    app.exit(2);
    return;
  }
  try {
    await main(win);
    console.log('\ndone');
    app.exit(0);
  } catch (err) {
    console.error('shoot-app failed:', err && err.message);
    app.exit(1);
  }
});

require('../src/main/main.js');
