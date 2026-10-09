'use strict';

// End-to-end check of organising notes from the sidebar in the real app:
// renaming, moving by drag, deleting to the trash — and the thing that makes
// renaming worth having, which is that every [[link]] pointing at the note
// follows it.
//
//   npx electron test/e2e/organise-flow.js
//
// Env: PLUME_SHOTS (directory for screenshots), PLUME_SIZE, PLUME_THEME.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHOTS = process.env.PLUME_SHOTS || path.join(os.tmpdir(), 'plume-organise-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-org-'));
app.setPath('userData', tmp);

const notebook = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-org-notes-'));
const DOC = path.join(notebook, 'Welcome.md');
fs.writeFileSync(DOC, [
  '# Welcome',
  '',
  'The work is in [[Plan]], also written as [the plan](Plan.md).',
  'An embed: ![[Plan]]',
  'Something else: [[Planning]]',
  '',
].join('\n'));
fs.writeFileSync(path.join(notebook, 'Plan.md'), '# Plan\n\nBack to [[Welcome]].\n');
fs.writeFileSync(path.join(notebook, 'Planning.md'), '# Planning\n');
fs.mkdirSync(path.join(notebook, 'Projects'));
fs.writeFileSync(path.join(notebook, 'Projects', 'Plume.md'), '# Plume\n\nSee [[Plan#Later|the plan]].\n');

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
const read = p => fs.readFileSync(p, 'utf8');

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main(win) {
  const wc = win.webContents;
  const run = js => wc.executeJavaScript(`(async () => { ${js} })()`);
  const peek = expr => wc.executeJavaScript(`(async () => (${expr}))()`);
  const shot = async name => {
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), img.toPNG());
  };

  async function until(expr, timeout = 15000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await peek(expr)) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  }

  // Right-clicks the row whose name is `name` and clicks an item in the menu.
  const menu = async (name, item) => {
    await run(`
      const row = [...document.querySelectorAll('.tree-row')]
        .find(r => r.querySelector('.tree-name') && r.querySelector('.tree-name').textContent === ${JSON.stringify(name)});
      if (!row) throw new Error('no row called ' + ${JSON.stringify(name)});
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 140, clientY: 300 }));
    `);
    await until('!document.getElementById("menu-tree").hidden');
    await run(`
      const btn = [...document.querySelectorAll('#menu-tree .menu-item')]
        .find(b => b.textContent.includes(${JSON.stringify(item)}));
      if (!btn) throw new Error('no menu item ' + ${JSON.stringify(item)});
      btn.click();
    `);
  };

  const type = async (name, key = 'Enter') => run(`
    const input = document.querySelector('.tree-draft-name');
    if (!input) throw new Error('nothing is waiting for a name');
    input.value = ${JSON.stringify(name)};
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
  `);

  await until('document.body.dataset.ready === "1"');
  await sleep(800);
  await run('window.confirm = () => true;');

  // ---- the menu ----
  await menu('Plan', 'Rename');
  record('a row has a menu with Rename in it', await peek('!!document.querySelector(".tree-renaming")'));
  record('the name is there to be edited', (await peek('document.querySelector(".tree-draft-name").value')) === 'Plan');
  record('the row being renamed looks like a field',
    await peek('getComputedStyle(document.querySelector(".tree-renaming")).boxShadow.includes("rgb")'),
    await peek('getComputedStyle(document.querySelector(".tree-renaming")).boxShadow'));
  await shot('01-renaming');

  // ---- renaming rewrites the links ----
  await type('Roadmap');
  await sleep(1800);
  record('the file is renamed on disk', fs.existsSync(path.join(notebook, 'Roadmap.md')));
  record('the old name is gone', !fs.existsSync(path.join(notebook, 'Plan.md')));

  const welcome = read(DOC);
  record('a wiki link follows the note', welcome.includes('[[Roadmap]]'), welcome.split('\n')[2]);
  record('a Markdown link follows the note', welcome.includes('(Roadmap.md)'));
  record('an embed follows the note', welcome.includes('![[Roadmap]]'));
  record('a different note of a similar name is untouched', welcome.includes('[[Planning]]'));
  record('a link in another folder follows too, alias and heading intact',
    read(path.join(notebook, 'Projects', 'Plume.md')).includes('[[Roadmap#Later|the plan]]'),
    read(path.join(notebook, 'Projects', 'Plume.md')).trim().split('\n').pop());
  record('the note that moved keeps its own links',
    read(path.join(notebook, 'Roadmap.md')).includes('[[Welcome]]'));
  record('how many links were rewritten is reported',
    /link/.test(await peek('document.getElementById("toast").textContent') || ''),
    await peek('document.getElementById("toast").textContent'));
  await shot('02-renamed');

  // ---- renaming the open document takes the window with it ----
  await menu('Welcome', 'Rename');
  await type('Start here');
  await sleep(1800);
  record('the open document can be renamed', fs.existsSync(path.join(notebook, 'Start here.md')));
  record('the window follows it', (await peek('document.querySelector(".crumb-file").textContent')) === 'Start here');
  record('and it is still readable', await peek('!!document.querySelector("#doc h1")'));
  record('the link to it from elsewhere was rewritten',
    read(path.join(notebook, 'Roadmap.md')).includes('[[Start here]]'));

  // ---- a name that cannot be a file is refused, and nothing moves ----
  await menu('Roadmap', 'Rename');
  await type('Q3: plan');
  await sleep(900);
  record('a name Windows cannot open is refused', fs.existsSync(path.join(notebook, 'Roadmap.md')));
  record('and the refusal is said out loud',
    /cannot be empty/.test(await peek('document.getElementById("toast").textContent') || ''));

  // ---- a name already taken is refused ----
  await menu('Roadmap', 'Rename');
  await type('Planning');
  await sleep(900);
  record('an existing note is not overwritten by a rename',
    fs.existsSync(path.join(notebook, 'Roadmap.md')) && read(path.join(notebook, 'Planning.md')) === '# Planning\n');
  record('and the clash is said out loud',
    /already there/.test(await peek('document.getElementById("toast").textContent') || ''));

  // ---- moving by dragging onto a folder ----
  await run(`
    const rows = [...document.querySelectorAll('.tree-row')];
    const note = rows.find(r => r.querySelector('.tree-name') && r.querySelector('.tree-name').textContent === 'Roadmap');
    const folder = rows.find(r => r.querySelector('.tree-name') && r.querySelector('.tree-name').textContent === 'Projects');
    const data = new DataTransfer();
    note.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
    folder.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    folder.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  `);
  await sleep(1800);
  record('dragging a note onto a folder moves it',
    fs.existsSync(path.join(notebook, 'Projects', 'Roadmap.md')));
  record('and it is no longer where it was', !fs.existsSync(path.join(notebook, 'Roadmap.md')));
  record('the links to it were rewritten for its new home',
    read(path.join(notebook, 'Start here.md')).includes('Projects/Roadmap'),
    read(path.join(notebook, 'Start here.md')).split('\n')[2]);
  await shot('03-moved');

  // ---- a folder cannot be dropped inside itself ----
  const before = fs.existsSync(path.join(notebook, 'Projects'));
  const res = await peek(`window.plume.moveNote(${JSON.stringify(path.join(notebook, 'Projects'))}, ${JSON.stringify(path.join(notebook, 'Projects'))}, ${JSON.stringify(notebook)})`);
  record('a folder cannot be moved into itself', before && fs.existsSync(path.join(notebook, 'Projects')),
    JSON.stringify(res).slice(0, 60));

  // ---- deleting goes to the trash, after asking ----
  await menu('Planning', 'Move to trash');
  await sleep(1500);
  record('a note can be deleted', !fs.existsSync(path.join(notebook, 'Planning.md')));
  record('the tree stops showing it',
    !(await peek('[...document.querySelectorAll(".tree-name")].some(n => n.textContent === "Planning")')));
  record('links to a deleted note are left alone, not rewritten',
    read(path.join(notebook, 'Start here.md')).includes('[[Planning]]'));
  await shot('04-trashed');
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
    console.error('organise-flow: no window opened');
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

  fs.writeFileSync(path.join(SHOTS, 'organise-report.json'), JSON.stringify({ results, logs }, null, 2));
  console.log(`\n${results.length - failures}/${results.length} checks passed — shots in ${SHOTS}`);
  app.exit(failures ? 1 : 0);
});

require('../../src/main/main.js');
