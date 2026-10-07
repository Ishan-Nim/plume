'use strict';

// End-to-end check of editing in the real app: turn on edit mode, type, save,
// and confirm the bytes on disk actually changed — then that leaving edit mode
// renders what was saved rather than what was there before.
//
//   npx electron test/e2e/edit-flow.js
//
// Env: PLUME_SHOTS (directory for screenshots), PLUME_SIZE, PLUME_THEME.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHOTS = process.env.PLUME_SHOTS || path.join(os.tmpdir(), 'plume-edit-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-edit-'));
app.setPath('userData', tmp);

const [w, h] = (process.env.PLUME_SIZE || '1340x880').split('x').map(Number);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: process.env.PLUME_THEME || 'light',
  bounds: { x: 40, y: 40, width: w, height: h },
  sidebar: true,
  autoUpdate: false,
}));

const notebook = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-edit-notes-'));
const DOC = path.join(notebook, 'Notes.md');
const ORIGINAL = ['# Notes', '', 'The first line.', ''].join('\n');
fs.writeFileSync(DOC, ORIGINAL);
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

  await until('document.body.dataset.ready === "1"');
  await sleep(700);

  record('the document opens for reading', await read('!!document.querySelector("#doc h1")'));
  record('an Edit button is offered', await read('!!document.getElementById("btn-edit")'));
  record('Save is hidden until editing', await read('document.getElementById("btn-save").hidden'));
  await shot('01-reading');

  // ---- turn editing on ----
  await run('document.getElementById("btn-edit").click();');
  const editing = await until('!document.getElementById("editor").hidden');
  record('editing shows the raw Markdown', editing);

  const loaded = await read('document.getElementById("editor").value');
  record('the editor holds exactly what is on disk', loaded === fs.readFileSync(DOC, 'utf8'),
    JSON.stringify((loaded || '').slice(0, 24)));
  record('the rendered document steps aside', await read('document.body.classList.contains("is-editing")'));
  await shot('02-editing');

  // ---- type ----
  const EDITED = ORIGINAL + '\nA line typed inside Plume.\n';
  await run(`
    const area = document.getElementById('editor');
    area.value = ${JSON.stringify(EDITED)};
    area.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await sleep(300);

  record('an unsaved change is marked', await read('document.querySelector(".crumb-file").classList.contains("is-dirty")'));
  record('Save becomes available', await read('!document.getElementById("btn-save").disabled'));

  // ---- nothing is written before asking ----
  record('nothing is written to disk before saving', fs.readFileSync(DOC, 'utf8') === ORIGINAL);

  // ---- save ----
  await run('document.getElementById("btn-save").click();');
  await sleep(1200);

  const onDisk = fs.readFileSync(DOC, 'utf8');
  record('saving writes the file', onDisk === EDITED,
    onDisk === EDITED ? `${onDisk.length} bytes` : JSON.stringify(onDisk.slice(0, 40)));
  record('the unsaved mark clears', !(await read('document.querySelector(".crumb-file").classList.contains("is-dirty")')));
  await shot('03-saved');

  // ---- saving must not make the watcher reload over the editor ----
  await sleep(1500);
  record('the editor is still open after saving', await read('!document.getElementById("editor").hidden'));
  record('the editor still holds the saved text', (await read('document.getElementById("editor").value')) === EDITED);

  // ---- back to reading ----
  await run('document.getElementById("btn-edit").click();');
  await sleep(900);
  record('leaving edit mode returns to the document', await read('document.getElementById("editor").hidden'));

  const rendered = await read('document.getElementById("doc").textContent');
  record('the reader shows what was saved', /A line typed inside Plume/.test(rendered || ''));
  await shot('04-back-to-reading');

  // ---- a change on disk while editing must not be lost ----
  await run('document.getElementById("btn-edit").click();');
  await until('!document.getElementById("editor").hidden');
  await run(`
    const area = document.getElementById('editor');
    area.value = ${JSON.stringify(EDITED + '\nTyped here, unsaved.\n')};
    area.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await sleep(400);

  // Answer the conflict prompt with "keep mine".
  await run('window.confirm = () => false;');
  fs.writeFileSync(DOC, ORIGINAL + '\nWritten by something else.\n');
  await sleep(2500);

  const kept = await read('document.getElementById("editor").value');
  record('a change on disk does not overwrite unsaved work',
    /Typed here, unsaved/.test(kept || ''), JSON.stringify((kept || '').slice(-30)));

  await run('window.confirm = () => true;');
  await sleep(200);
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
    console.error('edit-flow: no window opened');
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

  fs.writeFileSync(path.join(SHOTS, 'edit-report.json'), JSON.stringify({ results, logs }, null, 2));
  console.log(`\n${results.length - failures}/${results.length} checks passed — shots in ${SHOTS}`);
  app.exit(failures ? 1 : 0);
});

require('../../src/main/main.js');
