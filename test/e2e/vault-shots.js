'use strict';

// The screenshots the documentation uses, taken from the real app.
//
//   set PLUME_VAULT_API=http://127.0.0.1:8098/api
//   set PLUME_SHOTS=site\assets\shots
//   npx electron test/e2e/vault-shots.js
//
// It builds two vaults on disk, signs up, links one of them, and photographs
// each state the vault model has: the chooser a new install opens on, a loose
// folder, a local-only vault, a linked one, and the switcher.
//
// Never point this at production: it creates an account.

const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API = process.env.PLUME_VAULT_API;
if (!API) {
  console.error('vault-shots: PLUME_VAULT_API is required');
  process.exit(2);
}
if (/plume-md\.com/i.test(API)) {
  console.error('vault-shots: refusing to run against production');
  process.exit(2);
}

const SHOTS = process.env.PLUME_SHOTS || path.join(os.tmpdir(), 'plume-vault-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-shots-'));
app.setPath('userData', tmp);
process.env.PLUME_USER_DATA = tmp;

const [w, h] = (process.env.PLUME_SIZE || '1340x880').split('x').map(Number);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: process.env.PLUME_THEME || 'light',
  bounds: { x: 40, y: 40, width: w, height: h },
  sidebar: true,
}));

// Two notebooks, so the switcher has something to switch between and the
// account has more than one vault to show.
function notebook(label, notes) {
  const dir = path.join(tmp, label);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(notes)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return dir;
}

const FIELD = notebook('Field Notes', {
  'Index.md': '# Index\n\nStart with [[Plume]] and [[Reading]].\n',
  'Plume.md': '# Plume\n\nBack to [[Index]]. See also [[Reading]].\n',
  'Reading.md': '# Reading\n\nFrom [[Index]]. Nothing links to [[Someday]] yet.\n',
  'Journal/2026-10-09.md': '# Thursday\n\nA note in a folder.\n',
});
const WORK = notebook('Work', {
  'Index.md': '# Work\n\nA second vault, with a note called [[Index]] of its own.\n',
});

const EMAIL = `shots-${Date.now()}@plume-md.test`;
const PASSWORD = 'shots-flow-password-1';

const sleep = ms => new Promise(r => setTimeout(r, ms));
// The vault bar lists the vaults now; the account panel is a tab of the
// sidebar, so it is asked for as one.
const OPEN_VAULT = 'window.plume.setSettings({ sidebar: true, sidebarTab: "vault" });'
  + ' await new Promise(r => setTimeout(r, 400));';

// Linking is confirmed by the main process with a native dialog, which this
// run cannot click. Answered yes so the shots reach the linked state.
dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });

const taken = [];

app.whenReady().then(async () => {
  await sleep(1800);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error('vault-shots: no window opened');
    app.exit(2);
    return;
  }
  const wc = win.webContents;
  const run = js => wc.executeJavaScript(`(async () => { ${js} })()`);
  const shot = async name => {
    await sleep(500);
    const img = await wc.capturePage();
    const file = path.join(SHOTS, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    taken.push(name);
    console.log(`  ${name}.png`);
  };

  try {
    await run('await new Promise(r => setTimeout(r, 400));');

    // 1. What a fresh install opens on: the chooser.
    await shot('vault-chooser');

    // 1b. And the screen behind its Create button, which asks for a name
    //     before it asks for a place.
    await run(`
      document.getElementById('btn-welcome-vault').click();
      await new Promise(r => setTimeout(r, 500));
      const n = document.getElementById('maker-name');
      n.value = 'Field Notes';
      n.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
    `);
    await shot('vault-maker');
    await run(`
      document.getElementById('btn-maker-back').click();
      await new Promise(r => setTimeout(r, 300));
    `);

    // 2. A folder, opened and left loose.
    await run(`
      window.plume.setSettings({ folder: ${JSON.stringify(FIELD)} });
      await new Promise(r => setTimeout(r, 300));
      window.plume.openPaths([${JSON.stringify(path.join(FIELD, 'Index.md'))}]);
    `);
    await sleep(1800);
    const doc = BrowserWindow.getAllWindows().find(x => x.id !== win.id) || win;
    const run2 = js => doc.webContents.executeJavaScript(`(async () => { ${js} })()`);
    const shot2 = async name => {
      await sleep(500);
      const img = await doc.webContents.capturePage();
      fs.writeFileSync(path.join(SHOTS, `${name}.png`), img.toPNG());
      taken.push(name);
      console.log(`  ${name}.png`);
    };

    await run2(OPEN_VAULT);
    await sleep(900);
    await shot2('vault-loose');

    // 2b. The sign-in form, in the sidebar rather than over the document.
    await shot2('vault-signin');

    // 3. Signed in, so the account section is real.
    await run2(`
      document.querySelector('.vault-tabs button:last-child').click();
      await new Promise(r => setTimeout(r, 250));
      const email = document.getElementById('vault-email');
      const password = document.getElementById('vault-password');
      email.value = ${JSON.stringify(EMAIL)};
      password.value = ${JSON.stringify(PASSWORD)};
      email.dispatchEvent(new Event('input', { bubbles: true }));
      password.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.vault-form button[type="submit"]').click();
    `);
    await sleep(4000);

    // 4. A vault on this computer and nowhere else.
    await run2(`
      const make = [...document.querySelectorAll('.vault-btn')].find(b => /^Create vault/.test(b.textContent.trim()));
      if (make) make.click();
    `);
    await sleep(2500);
    await shot2('vault-local');

    // 5. Linked, and syncing.
    await run2(`
      const was = window.confirm;
      window.confirm = () => true;
      const link = [...document.querySelectorAll('.vault-btn')].find(b => b.textContent.trim() === 'Link to my account');
      if (link) link.click();
      await new Promise(r => setTimeout(r, 400));
      window.confirm = was;
    `);
    await sleep(7000);
    await shot2('vault-linked');

    // 6. A second vault, so the switcher and the account list have two.
    const vaults = require('../../src/main/vaults');
    vaults.create(WORK, { name: 'Work' });
    await sleep(600);

    await run2(`
      document.getElementById('vault-bar').click();
    `);
    await sleep(900);
    await shot2('vault-switcher');

    await run2('document.body.click(); await new Promise(r => setTimeout(r, 300));');

    // 7. The graph, which is a thing only a vault has.
    await run2(`
      const graph = [...document.querySelectorAll('.vault-btn')].find(b => b.textContent.trim() === 'Graph');
      if (graph) graph.click();
    `);
    await sleep(3500);
    await shot2('vault-graph');
    await run2('document.getElementById("graph-view-close").click();');
  } catch (err) {
    console.error('vault-shots:', err && err.stack ? err.stack : err);
  }

  console.log(`\n${taken.length} shots in ${SHOTS}`);
  app.exit(0);
});

require('../../src/main/main.js');
