'use strict';

// End-to-end check of making notes from the sidebar in the real app: the +
// in the panel head, the + a folder shows, the name typed in the tree, and
// the three things that must never happen — a note outside the tree's folder,
// a name Windows cannot open, and an existing note replaced.
//
//   npx electron test/e2e/new-note-flow.js
//
// Env: PLUME_SHOTS (directory for screenshots), PLUME_SIZE, PLUME_THEME.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHOTS = process.env.PLUME_SHOTS || path.join(os.tmpdir(), 'plume-new-note-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-new-'));
app.setPath('userData', tmp);

const notebook = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-new-notes-'));
const DOC = path.join(notebook, 'Welcome.md');
fs.writeFileSync(DOC, '# Welcome\n\nA notebook to add to.\n');
fs.mkdirSync(path.join(notebook, 'Projects'));
fs.writeFileSync(path.join(notebook, 'Projects', 'Plume.md'), '# Plume\n');

const [w, h] = (process.env.PLUME_SIZE || '1340x880').split('x').map(Number);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: process.env.PLUME_THEME || 'light',
  bounds: { x: 40, y: 40, width: w, height: h },
  sidebar: true,
  sidebarTab: 'files',
  folder: notebook,
  autoUpdate: false,
}));

process.argv.push(DOC);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const logs = [];
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

  async function until(expr, timeout = 15000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await read(expr)) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  }

  // Types a name into the row waiting for one, then presses a key.
  const type = async (name, key = 'Enter') => run(`
    const input = document.querySelector('.tree-draft-name');
    if (!input) throw new Error('no row is waiting for a name');
    input.value = ${JSON.stringify(name)};
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
  `);

  await until('document.body.dataset.ready === "1"');
  await sleep(800);

  record('the tree is rooted on the folder', await read('!!document.querySelector(".tree-row")'));
  record('the panel head offers a new note', await read('!document.getElementById("btn-tree-new").disabled'));
  record('the panel head offers a new folder', await read('!document.getElementById("btn-tree-new-folder").disabled'));

  // ---- a note in the folder the tree is showing ----
  await run('document.getElementById("btn-tree-new").click();');
  record('clicking + asks for a name in the tree', await until('!!document.querySelector(".tree-draft-name")'));
  await shot('01-naming');

  record('nothing is on disk while the name is being typed',
    !fs.existsSync(path.join(notebook, 'Q3 review.md')));

  await type('Q3 review');
  await sleep(1600);
  const made = path.join(notebook, 'Q3 review.md');
  record('Enter writes the note', fs.existsSync(made));
  record('the new note is empty', fs.existsSync(made) && fs.readFileSync(made, 'utf8') === '');
  record('the new note opens', (await read('document.querySelector(".crumb-file").textContent')) === 'Q3 review');
  record('it opens ready to type in', await until('!document.getElementById("editor").hidden', 4000));
  record('the tree shows it',
    await read('[...document.querySelectorAll(".tree-name")].some(n => n.textContent === "Q3 review")'));
  await shot('02-made');

  // ---- Escape leaves nothing behind ----
  await run('document.getElementById("btn-tree-new").click();');
  await until('!!document.querySelector(".tree-draft-name")');
  await type('Never made', 'Escape');
  await sleep(600);
  record('Escape writes nothing', !fs.existsSync(path.join(notebook, 'Never made.md')));
  record('Escape takes the row away', await read('!document.querySelector(".tree-draft-name")'));

  // ---- a note inside a folder, from the folder's own + ----
  await run(`
    const row = [...document.querySelectorAll('.tree-row.is-dir')].find(r => r.textContent.includes('Projects'));
    row.querySelector('.tree-add').click();
  `);
  record('a folder offers a note of its own', await until('!!document.querySelector(".tree-draft-name")'));
  await type('Vault notes');
  await sleep(1600);
  record('the note lands inside that folder', fs.existsSync(path.join(notebook, 'Projects', 'Vault notes.md')));
  record('and not in the folder above it', !fs.existsSync(path.join(notebook, 'Vault notes.md')));
  await shot('03-in-folder');

  // ---- a new folder ----
  await run('document.getElementById("btn-tree-new-folder").click();');
  await until('!!document.querySelector(".tree-draft-name")');
  await type('Reading');
  await sleep(1400);
  record('a folder can be made too',
    fs.existsSync(path.join(notebook, 'Reading')) && fs.statSync(path.join(notebook, 'Reading')).isDirectory());

  // ---- a name that cannot be a file ----
  await run('document.getElementById("btn-tree-new").click();');
  await until('!!document.querySelector(".tree-draft-name")');
  await type('Q3: plan');
  await sleep(1000);
  record('a name Windows cannot open is refused',
    fs.readdirSync(notebook).every(n => !n.includes('plan')));
  record('and the refusal is said out loud',
    /cannot be empty/.test(await read('document.getElementById("toast").textContent') || ''));
  await shot('04-refused');

  // ---- an existing note is never replaced ----
  const before = fs.readFileSync(DOC, 'utf8');
  await run('document.getElementById("btn-tree-new").click();');
  await until('!!document.querySelector(".tree-draft-name")');
  await type('Welcome');
  await sleep(1000);
  record('an existing note is left alone', fs.readFileSync(DOC, 'utf8') === before);
  record('and the clash is said out loud',
    /already there/.test(await read('document.getElementById("toast").textContent') || ''));

  // ---- a name can only ever be a name ----
  const res = await read(`window.plume.createNote(${JSON.stringify(path.join(notebook, 'Projects'))}, "../../escaped")`);
  record('a name cannot climb out of its folder', !!(res && res.error), JSON.stringify(res).slice(0, 80));
  record('nothing was written above the notebook',
    !fs.existsSync(path.join(path.dirname(notebook), 'escaped.md')));
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (event, level, message) => {
    const text = typeof event === 'object' && event.message ? event.message : message;
    logs.push(String(text));
  });
});

app.whenReady().then(async () => {
  await sleep(1600);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error('new-note-flow: no window opened');
    app.exit(2);
    return;
  }
  try {
    await main(win);
  } catch (err) {
    record('the run finished without throwing', false, err && err.message);
  }

  const errors = logs.filter(l => /error|uncaught|refused|violat/i.test(l));
  record('the page logged no errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  fs.writeFileSync(path.join(SHOTS, 'new-note-report.json'), JSON.stringify({ results, logs }, null, 2));
  console.log(`\n${results.length - failures}/${results.length} checks passed — shots in ${SHOTS}`);
  app.exit(failures ? 1 : 0);
});

require('../../src/main/main.js');
