'use strict';

// End-to-end check of live preview in the real app: click a paragraph, type
// into it where it sits, move away and see it rendered again — then save and
// confirm only that paragraph's lines changed on disk.
//
//   npx electron test/e2e/live-flow.js
//
// Env: PLUME_SHOTS (directory for screenshots), PLUME_SIZE, PLUME_THEME.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHOTS = process.env.PLUME_SHOTS || path.join(os.tmpdir(), 'plume-live-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-live-'));
app.setPath('userData', tmp);

const [w, h] = (process.env.PLUME_SIZE || '1340x880').split('x').map(Number);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: process.env.PLUME_THEME || 'light',
  bounds: { x: 40, y: 40, width: w, height: h },
  sidebar: true,
  autoUpdate: false,
  liveEdit: true,
}));

const notebook = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-live-notes-'));
const DOC = path.join(notebook, 'Notes.md');
const ORIGINAL = [
  '# Notes',
  '',
  'The first paragraph, which is **the one** to click.',
  '',
  '- a list item',
  '- another',
  '',
  'A closing paragraph.',
  '',
  // Raw HTML cannot forge a source range: the mark is per-session.
  '<p data-plume-src="0:0:1">Not Plume&rsquo;s own block.</p>',
  '',
].join('\n');
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

  // A real click, at a real point, on the text of a block — so the caret
  // placement path runs exactly as it does for a reader.
  const clickOn = (selector, where = 'middle') => run(`
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('no ' + ${JSON.stringify(selector)});
    const r = node.getBoundingClientRect();
    const x = ${where === 'start' ? 'r.left + 4' : 'r.left + Math.min(60, r.width / 2)'};
    const y = r.top + Math.min(8, r.height / 2);
    for (const type of ['mousedown', 'mouseup', 'click']) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    }
    await new Promise(r2 => setTimeout(r2, 250));
  `);

  const type = text => run(`
    const area = document.querySelector('#doc .live-edit');
    if (!area) throw new Error('nothing is open for editing');
    const at = area.selectionStart;
    area.value = area.value.slice(0, at) + ${JSON.stringify(text)} + area.value.slice(at);
    area.setSelectionRange(at + ${JSON.stringify(text)}.length, at + ${JSON.stringify(text)}.length);
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 120));
  `);

  await until('document.body.dataset.ready === "1"');
  await sleep(800);

  record('the document opens for reading', await read('!!document.querySelector("#doc h1")'));
  const openAtBoot = await read('document.querySelectorAll("#doc .live-edit").length');
  record('nothing is open for editing', openAtBoot === 0, `open: ${openAtBoot}`);
  record('blocks carry a source range', await read('document.querySelectorAll("#doc [data-plume-src]").length >= 4'));
  await shot('01-reading');

  // ---- click a paragraph ----
  await clickOn('#doc p');
  const open = await until('!!document.querySelector("#doc .live-edit")', 4000);
  record('clicking a paragraph opens that paragraph', open);
  record('it holds the Markdown of that block alone',
    (await read('document.querySelector("#doc .live-edit").value'))
      === 'The first paragraph, which is **the one** to click.',
    JSON.stringify(await read('document.querySelector("#doc .live-edit") && document.querySelector("#doc .live-edit").value')));
  record('the rendered copy steps aside', await read('!!document.querySelector("#doc .live-hidden")'));
  record('the rest of the document is still rendered',
    await read('!!document.querySelector("#doc h1") && !!document.querySelector("#doc ul")'));
  // The click lands about 60px into the line, so the caret belongs among the
  // first few words rather than at either end of the block.
  const caret = await read('document.querySelector("#doc .live-edit").selectionStart');
  record('the caret lands where the click did', caret > 2 && caret < 22, `offset ${caret}`);
  await shot('02-editing-a-block');

  // ---- type into it ----
  await type(' Typed in place.');
  record('typing marks the document unsaved',
    await read('document.querySelector(".crumb-file").classList.contains("is-dirty")'));
  record('Save becomes available', await read('!document.getElementById("btn-save").hidden'));
  record('nothing is written to disk before saving', fs.readFileSync(DOC, 'utf8') === ORIGINAL);

  // ---- move away: it renders again ----
  await run('document.querySelector("#doc .live-edit").blur();');
  const closed = await until('!document.querySelector("#doc .live-edit")', 4000);
  record('moving away closes the block', closed);
  await sleep(400);
  record('the block is rendered again, with what was typed',
    /Typed in place\./.test(await read('document.getElementById("doc").textContent') || ''));
  record('it is a paragraph again, not raw Markdown',
    !/\*\*the one\*\*/.test(await read('document.getElementById("doc").textContent') || ''));
  const stillHidden = await read('[...document.querySelectorAll("#doc .live-hidden")].map(n => n.tagName).join()');
  record('nothing is left hidden', stillHidden === '', `hidden: ${stillHidden}`);
  await shot('03-rendered-again');

  // ---- save ----
  await run('document.getElementById("btn-save").click();');
  await sleep(1200);
  const onDisk = fs.readFileSync(DOC, 'utf8');
  const LINE = 'The first paragraph, which is **the one** to click.';
  const typed = `${LINE.slice(0, caret)} Typed in place.${LINE.slice(caret)}`;
  record('saving writes that block back, at the caret',
    onDisk === ORIGINAL.replace(LINE, typed),
    JSON.stringify(onDisk.slice(0, 90)));
  record('the unsaved mark clears',
    !(await read('document.querySelector(".crumb-file").classList.contains("is-dirty")')));

  // ---- a heading opens as one line ----
  await sleep(1600);
  await clickOn('#doc h1');
  await until('!!document.querySelector("#doc .live-edit")', 4000);
  record('a heading opens as its own line',
    (await read('document.querySelector("#doc .live-edit").value')) === '# Notes',
    JSON.stringify(await read('document.querySelector("#doc .live-edit") && document.querySelector("#doc .live-edit").value')));
  record('the heading keeps its size while being typed',
    (await read('document.querySelector("#doc .live-edit").dataset.tag')) === 'h1');
  await shot('04-heading');

  // ---- a list opens whole ----
  await clickOn('#doc ul');
  await until('(document.querySelector("#doc .live-edit") || {}).value === "- a list item\\n- another"', 4000);
  record('a list opens as the whole list',
    (await read('document.querySelector("#doc .live-edit").value')) === '- a list item\n- another',
    JSON.stringify(await read('document.querySelector("#doc .live-edit") && document.querySelector("#doc .live-edit").value')));

  // Enter carries the list on.
  await run(`
    const area = document.querySelector('#doc .live-edit');
    area.setSelectionRange(area.value.length, area.value.length);
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise(r2 => setTimeout(r2, 150));
  `);
  record('Enter carries the list marker on',
    /- another\n- $/.test(await read('document.querySelector("#doc .live-edit").value') || ''),
    JSON.stringify(await read('document.querySelector("#doc .live-edit") && document.querySelector("#doc .live-edit").value')));
  await run('document.querySelector("#doc .live-edit").blur();');
  await sleep(500);

  // ---- raw HTML cannot aim a click at other lines ----
  const forged = await read(`(() => {
    const node = [...document.querySelectorAll('#doc [data-plume-src]')]
      .find(n => n.dataset.plumeSrc === '0:0:1');
    return !!node;
  })()`);
  record('a range written by the document survives sanitising', forged, 'it must simply not work');
  if (forged) {
    await run(`
      const node = [...document.querySelectorAll('#doc [data-plume-src]')].find(n => n.dataset.plumeSrc === '0:0:1');
      const r = node.getBoundingClientRect();
      for (const t of ['mousedown', 'mouseup', 'click']) {
        node.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: r.left + 20, clientY: r.top + 6, button: 0 }));
      }
      await new Promise(r2 => setTimeout(r2, 300));
    `);
    record('a forged range opens nothing', await read('!document.querySelector("#doc .live-edit")'));
  }

  // ---- clicking past the end starts a new block ----
  await run(`
    const doc = document.getElementById('doc');
    const last = doc.lastElementChild.getBoundingClientRect();
    const r = doc.getBoundingClientRect();
    const y = Math.min(last.bottom + 40, r.bottom - 10);
    for (const t of ['mousedown', 'mouseup', 'click']) {
      doc.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: r.left + r.width / 2, clientY: y, button: 0 }));
    }
    await new Promise(r2 => setTimeout(r2, 300));
  `);
  const appended = await read('!!document.querySelector("#doc .live-edit")');
  record('clicking past the end starts a new block', appended);
  if (appended) {
    record('the new block starts empty', (await read('document.querySelector("#doc .live-edit").value')) === '');
    await type('A line added at the end.');
    await run('document.querySelector("#doc .live-edit").blur();');
    await sleep(600);
    record('the new block is rendered',
      /A line added at the end\./.test(await read('document.getElementById("doc").textContent') || ''));
    await run('document.getElementById("btn-save").click();');
    await sleep(1200);
    const after = fs.readFileSync(DOC, 'utf8');
    record('it is written at the end of the file, with a blank line before it',
      /\n\nA line added at the end\.\n?$/.test(after),
      JSON.stringify(after.slice(-60)));
    record('nothing above it moved',
      after.startsWith('# Notes\n\n') && after.includes('- a list item\n- another'));
  }
  await shot('05-appended');

  // ---- an empty block that is left empty changes nothing ----
  await sleep(1600);
  const before = fs.readFileSync(DOC, 'utf8');
  await run(`
    const doc = document.getElementById('doc');
    const last = doc.lastElementChild.getBoundingClientRect();
    const r = doc.getBoundingClientRect();
    for (const t of ['mousedown', 'mouseup', 'click']) {
      doc.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: r.left + r.width / 2, clientY: Math.min(last.bottom + 40, r.bottom - 10), button: 0 }));
    }
    await new Promise(r2 => setTimeout(r2, 250));
    const area = document.querySelector('#doc .live-edit');
    if (area) area.blur();
    await new Promise(r2 => setTimeout(r2, 400));
  `);
  record('opening a new block and leaving it empty changes nothing',
    !(await read('document.querySelector(".crumb-file").classList.contains("is-dirty")'))
    && fs.readFileSync(DOC, 'utf8') === before);

  // ---- source mode still works, on the same text ----
  await clickOn('#doc p');
  await until('!!document.querySelector("#doc .live-edit")', 4000);
  await type(' Unsaved when switching.');
  await run('document.getElementById("btn-edit").click();');
  await sleep(700);
  record('Ctrl+E shows the whole file as text', await read('!document.getElementById("editor").hidden'));
  record('source mode holds what live preview typed',
    /Unsaved when switching\./.test(await read('document.getElementById("editor").value') || ''));
  record('the change is still unsaved',
    await read('document.querySelector(".crumb-file").classList.contains("is-dirty")'));
  await shot('06-source-mode');

  await run('document.getElementById("btn-edit").click();');
  await sleep(700);
  record('leaving source mode renders the unsaved text',
    await read('document.getElementById("editor").hidden')
    && /Unsaved when switching\./.test(await read('document.getElementById("doc").textContent') || ''));
  await shot('07-back-to-live');

  // ---- turning live preview off puts the reader back ----
  await run(`
    document.getElementById('btn-reading').click();
    await new Promise(r2 => setTimeout(r2, 200));
    document.getElementById('toggle-liveedit').click();
    await new Promise(r2 => setTimeout(r2, 300));
    document.body.click();
    await new Promise(r2 => setTimeout(r2, 200));
  `);
  await clickOn('#doc p');
  record('with live preview off, a click does not edit',
    await read('!document.querySelector("#doc .live-edit")'));

  await run('window.confirm = () => true;');
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
    console.error('live-flow: no window opened');
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

  fs.writeFileSync(path.join(SHOTS, 'live-report.json'), JSON.stringify({ results, logs }, null, 2));
  console.log(`\n${results.length - failures}/${results.length} checks passed — shots in ${SHOTS}`);
  app.exit(failures ? 1 : 0);
});

require('../../src/main/main.js');
