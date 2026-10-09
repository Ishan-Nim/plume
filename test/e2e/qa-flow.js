'use strict';

// A look at the whole window, at the size a real desktop gives it: boot
// maximized, open a document, edit a block, open the whole file, open the
// panels, and measure the layout at every step. Unlike capture.js this one
// really maximizes and really shows the window, because the things it is
// looking for — a viewport that does not fill the window, a panel that ends
// early — only happen at a real window size.
//
//   npx electron test/e2e/qa-flow.js [document.md]
//
// Env: PLUME_SHOTS (directory), PLUME_SIZE (the un-maximized size),
//      PLUME_THEME, PLUME_SETTINGS (JSON merged into settings).

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHOTS = process.env.PLUME_SHOTS || path.join(os.tmpdir(), 'plume-qa-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-qa-'));
app.setPath('userData', tmp);

const [w, h] = (process.env.PLUME_SIZE || '1200x820').split('x').map(Number);
let extra = {};
if (process.env.PLUME_SETTINGS) extra = JSON.parse(process.env.PLUME_SETTINGS);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: process.env.PLUME_THEME || 'dark',
  bounds: { x: 60, y: 60, width: w, height: h },
  maximized: true,
  sidebar: true,
  autoUpdate: false,
  liveEdit: true,
  ...extra,
}));

// A document with one of everything the reading view has to lay out.
const notebook = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-qa-notes-'));
const DOC = process.argv.find(a => /\.md$/i.test(a)) || path.join(notebook, 'Everything.md');
if (!fs.existsSync(DOC)) {
  fs.writeFileSync(DOC, [
    '---', 'title: Everything', 'tags: [qa, layout]', '---', '',
    '# Everything in one document', '',
    'A first paragraph with **bold**, *italic*, `code`, a [link](https://example.com)',
    'and a second line of the same paragraph.', '',
    '## A list', '',
    '- one', '- two', '  - nested', '- [ ] a task', '- [x] a finished task', '',
    '## A table', '',
    '| Column | Another |', '|---|---|', '| a | b |', '| c | d |', '',
    '## Code', '', '```js', 'const hello = () => "world";', '```', '',
    '## A callout', '', '> [!warning] Mind this', '> It is a callout with a body.', '',
    '## Maths', '', '$$ e^{i\\pi} + 1 = 0 $$', '',
    '## A quote', '', '> Something someone said.', '',
    '---', '', 'A closing paragraph, after a rule.', '',
  ].join('\n'));
}
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
    return img.getSize();
  };

  async function until(expr, timeout = 15000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await read(expr)) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  }

  // Does the page actually fill the window it was given?
  async function measure(step) {
    const page = JSON.parse(await read(`JSON.stringify({
      inner: [window.innerWidth, window.innerHeight],
      client: [document.documentElement.clientWidth, document.documentElement.clientHeight],
      body: [Math.round(document.body.getBoundingClientRect().width), Math.round(document.body.getBoundingClientRect().height)],
      layout: (() => { const r = document.querySelector('.layout').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), Math.round(r.bottom)]; })(),
      viewer: (() => { const r = document.getElementById('viewer').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), Math.round(r.bottom)]; })(),
      sidebar: (() => { const r = document.querySelector('.sidebar').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
      scrollY: window.scrollY,
    })`));
    const content = win.getContentSize();
    const zoom = wc.getZoomFactor();
    const slack = Math.abs(page.client[1] - Math.round(content[1] / zoom));
    record(`${step}: the page fills the window`, slack <= 2,
      `window ${content[0]}x${content[1]} (zoom ${zoom}), page ${page.client[0]}x${page.client[1]}`);
    record(`${step}: the layout reaches the bottom of the page`,
      Math.abs(page.layout[2] - page.client[1]) <= 2,
      `layout bottom ${page.layout[2]} of ${page.client[1]}, sidebar ${page.sidebar[1]} tall`);
    record(`${step}: nothing scrolled the page itself`, page.scrollY === 0, `scrollY ${page.scrollY}`);
    return page;
  }

  await until('document.body.dataset.ready === "1"');
  await sleep(900);

  record('the window is maximized', win.isMaximized());
  record('the document opened', await read('!!document.querySelector("#doc h1")'));
  await measure('reading');
  const size = await shot('qa-01-reading');
  record('the screenshot is the size of the window', size.height > 600, `${size.width}x${size.height}`);

  // ---- every block type rendered ----
  const blocks = JSON.parse(await read(`JSON.stringify([...document.getElementById('doc').children].map(n => n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).split(' ')[0] : '')))`));
  record('every kind of block rendered', blocks.length > 10, blocks.join(' '));
  record('each block carries a source range',
    (await read('document.querySelectorAll("#doc > [data-plume-src]").length')) >= 10,
    `${await read('document.querySelectorAll("#doc > [data-plume-src]").length')} of ${blocks.length}`);

  // ---- live preview ----
  await run(`
    const p = [...document.querySelectorAll('#doc p')].find(n => n.textContent.includes('first paragraph'));
    const r = p.getBoundingClientRect();
    for (const t of ['mousedown', 'mouseup', 'click']) {
      p.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: r.left + 40, clientY: r.top + 6, button: 0 }));
    }
    await new Promise(r2 => setTimeout(r2, 300));
  `);
  record('clicking a paragraph opens it', await read('!!document.querySelector("#doc .live-edit")'));
  const box = JSON.parse(await read(`JSON.stringify((() => {
    const a = document.querySelector('#doc .live-edit');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { h: Math.round(r.height), scrollH: a.scrollHeight, lines: a.plumeEdit.value.split('\\n').length, inView: r.top >= 0 && r.bottom <= window.innerHeight };
  })())`));
  record('the open block is no taller than its text', box && box.h <= box.scrollH + 2, JSON.stringify(box));
  record('the open block is on screen', box && box.inView, JSON.stringify(box));
  await measure('live preview');
  await shot('qa-02-live-preview');

  await run(`
    // The open block is a CodeMirror editor: select the whole of it and put
    // the new text in, which is one change rather than a silent swap of value.
    const e = document.querySelector('#doc .live-edit').plumeEdit;
    e.setSelectionRange(0, e.value.length);
    e.insert(e.value.replace('A first paragraph', 'An edited first paragraph'));
    await new Promise(r2 => setTimeout(r2, 150));
    e.blur();
    await new Promise(r2 => setTimeout(r2, 600));
  `);
  record('the edit renders back into the page',
    /An edited first paragraph/.test(await read('document.getElementById("doc").textContent') || ''));
  record('the document is marked unsaved',
    await read('document.querySelector(".crumb-file").classList.contains("is-dirty")'));
  await measure('after a live edit');
  await shot('qa-03-after-edit');

  // ---- source mode, which is where the layout was reported broken ----
  await run('document.getElementById("btn-edit").click();');
  await until('!document.getElementById("editor").hidden', 5000);
  await sleep(600);
  record('source mode shows the whole file', await read('!document.getElementById("editor").hidden'));
  const ed = JSON.parse(await read(`JSON.stringify((() => {
    const a = document.getElementById('editor');
    const r = a.getBoundingClientRect();
    const v = document.getElementById('viewer').getBoundingClientRect();
    return { h: Math.round(r.height), top: Math.round(r.top), viewerH: Math.round(v.height), fills: r.height >= v.height - 2 };
  })())`));
  record('the editor fills the reading pane', ed.fills, JSON.stringify(ed));
  await measure('source mode');
  await shot('qa-04-source-mode');

  await run('document.getElementById("btn-edit").click();');
  await sleep(700);
  record('leaving source mode renders the unsaved text',
    await read('document.getElementById("editor").hidden')
    && /An edited first paragraph/.test(await read('document.getElementById("doc").textContent') || ''));
  await measure('back from source mode');

  // ---- resizing, the other way a layout goes wrong ----
  win.unmaximize();
  await sleep(700);
  await measure('un-maximized');
  await shot('qa-05-restored');
  win.maximize();
  await sleep(700);
  await measure('re-maximized');
  await shot('qa-06-maximized-again');

  // ---- the panels ----
  await run('document.getElementById("btn-reading").click(); await new Promise(r => setTimeout(r, 300));');
  record('the reading settings open', await read('!document.getElementById("pop-reading").hidden'));
  record('live preview has a switch there', await read('!!document.getElementById("toggle-liveedit")'));
  await shot('qa-07-reading-settings');
  await run('document.body.click(); await new Promise(r => setTimeout(r, 200));');

  await run('document.getElementById("btn-more").click(); await new Promise(r => setTimeout(r, 300));');
  const menu = await read('[...document.querySelectorAll("#menu-more .menu-label")].map(n => n.textContent).join(" | ")');
  record('the menu offers Open folder', /Open folder/.test(menu || ''), menu);
  await shot('qa-08-menu');
  await run('document.body.click(); await new Promise(r => setTimeout(r, 200));');

  await run('document.getElementById("btn-find").click(); await new Promise(r => setTimeout(r, 200));');
  await run(`
    const i = document.getElementById('find-input');
    i.value = 'paragraph';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
  `);
  record('find reports matches', /[1-9]/.test(await read('document.getElementById("find-count").textContent') || ''),
    await read('document.getElementById("find-count").textContent'));
  await shot('qa-09-find');
  await run('document.getElementById("find-close").click(); await new Promise(r => setTimeout(r, 200));');

  // ---- the outline, and the welcome screen with its two buttons ----
  await run(`document.querySelector('.sidebar-tab[data-tab="outline"]').click(); await new Promise(r => setTimeout(r, 400));`);
  record('the outline lists the headings',
    (await read('document.querySelectorAll("#outline a, #outline button, #outline .outline-item").length')) >= 5,
    `${await read('document.querySelectorAll("#outline *").length')} nodes`);
  await shot('qa-10-outline');
  await measure('outline');

  record('the page logged no errors so far', logs.filter(l => /error|uncaught/i.test(l)).length === 0,
    logs.filter(l => /error|uncaught/i.test(l)).slice(0, 2).join(' | '));
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (event, level, message) => {
    const text = typeof event === 'object' && event.message ? event.message : message;
    logs.push(String(text));
  });
});

app.whenReady().then(async () => {
  await sleep(1800);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error('qa-flow: no window opened');
    app.exit(2);
    return;
  }
  try {
    await main(win);
  } catch (err) {
    record('the run finished without throwing', false, err && err.message);
  }
  fs.writeFileSync(path.join(SHOTS, 'qa-report.json'), JSON.stringify({ results, logs }, null, 2));
  console.log(`\n${results.length - failures}/${results.length} checks passed — shots in ${SHOTS}`);
  app.exit(failures ? 1 : 0);
});

require('../../src/main/main.js');
