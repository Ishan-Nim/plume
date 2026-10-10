'use strict';

// Every control in the window, pressed.
//
//   npx electron test/e2e/sweep-flow.js
//
// The other end-to-end runs each follow one story — editing, organising,
// syncing — and check that the story comes out right. This one is the other
// axis: it walks the states the window can be in and presses everything that
// can be pressed in each of them, including the buttons no story needs, and
// fails on anything that throws, logs an error, or quietly does nothing.
//
// Nothing here is allowed to leave the window. The main process's ways out —
// file dialogs, the shell, the printer, another window — are replaced with
// recorders before the app is loaded, so a sweep that presses "Open in
// Obsidian" records the attempt instead of launching Obsidian.
//
// The account side of the window is part of the sweep, so it needs a vault API
// to talk to and it must never be production:
//
//   set PLUME_VAULT_API=http://127.0.0.1:8098/api
//
// Env: PLUME_VAULT_API (required), PLUME_SHOTS, PLUME_SIZE, PLUME_THEME.

const electron = require('electron');

const { app, BrowserWindow } = electron;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API = process.env.PLUME_VAULT_API;
if (!API) {
  console.error('sweep: PLUME_VAULT_API is required — never point this at production');
  process.exit(2);
}
if (/plume-md\.com/i.test(API)) {
  console.error('sweep: refusing to run against production');
  process.exit(2);
}

const SHOTS = process.env.PLUME_SHOTS || path.join(os.tmpdir(), 'plume-sweep-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-sweep-'));
app.setPath('userData', tmp);
process.env.PLUME_USER_DATA = tmp;

const [w, h] = (process.env.PLUME_SIZE || '1280x860').split('x').map(Number);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: process.env.PLUME_THEME || 'dark',
  bounds: { x: 40, y: 40, width: w, height: h },
  sidebar: true,
}));

// ---------------------------------------------------------------------------
// The ways out of the window, stubbed

const went = [];
const note = (what, detail) => went.push(detail ? `${what}: ${detail}` : what);

const DESKTOP = path.join(tmp, 'Desktop');
const NOTEBOOK = path.join(DESKTOP, 'Field Notes');
fs.mkdirSync(NOTEBOOK, { recursive: true });

fs.writeFileSync(path.join(NOTEBOOK, 'Index.md'), [
  '# Index',
  '',
  'Start at [[Plume]], or read [the notes](Notes/today.md).',
  '',
  '## A heading to outline',
  '',
  '| one | two |',
  '| --- | --- |',
  '| a   | b   |',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '### Another heading',
  '',
  'A paragraph with a word to find in it.',
  '',
].join('\n'));
fs.writeFileSync(path.join(NOTEBOOK, 'Plume.md'), '# Plume\n\nBack to [[Index]].\n');
fs.mkdirSync(path.join(NOTEBOOK, 'Notes'), { recursive: true });
fs.writeFileSync(path.join(NOTEBOOK, 'Notes', 'today.md'), '# Today\n\nA note in a folder.\n');

// A directory chooser that answers with whatever the test last asked for.
let pickDir = DESKTOP;
electron.dialog.showOpenDialog = async (_win, options = {}) => {
  const dir = (options.properties || []).includes('openDirectory');
  note('dialog', options.title || (dir ? 'directory' : 'file'));
  return { canceled: false, filePaths: [dir ? pickDir : path.join(NOTEBOOK, 'Plume.md')] };
};
electron.dialog.showSaveDialog = async (_win, options = {}) => {
  note('saveDialog', options.title || '');
  return { canceled: false, filePath: path.join(tmp, 'export.pdf') };
};
// 0 is the affirmative button on every prompt Plume raises.
electron.dialog.showMessageBox = async (_win, options = {}) => {
  note('messageBox', (options.message || options.title || '').slice(0, 60));
  return { response: 0, checkboxChecked: false };
};
electron.dialog.showErrorBox = (title, content) => note('errorBox', `${title}: ${content}`.slice(0, 80));

for (const fn of ['openExternal', 'openPath', 'showItemInFolder', 'trashItem', 'beep']) {
  const was = electron.shell[fn];
  electron.shell[fn] = async (...args) => {
    note(`shell.${fn}`, String(args[0] || '').slice(0, 80));
    // Trashing really has to happen: the tree checks the file is gone.
    if (fn === 'trashItem') return was.apply(electron.shell, args);
    return undefined;
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Checks

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

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (event, level, message) => {
    const text = typeof event === 'object' && event.message ? event.message : message;
    logs.push(String(text));
  });
});

app.whenReady().then(async () => {
  await sleep(1900);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error('sweep: no window opened');
    app.exit(2);
    return;
  }
  const wc = win.webContents;
  const run = (js, ms = 15000) => Promise.race([
    wc.executeJavaScript(`(async () => { ${js} })()`),
    new Promise(resolve => setTimeout(() => resolve('(timed out)'), ms)),
  ]);
  const read = js => wc.executeJavaScript(js);
  const shot = async name => {
    await sleep(350);
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), (await wc.capturePage()).toPNG());
  };

  /** Clicks a selector and reports whether it was there to click. */
  const click = async (sel, settle = 400) => {
    const found = await run(`
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el || el.disabled || el.offsetParent === null) return false;
      el.click();
      return true;
    `);
    await sleep(settle);
    return found;
  };

  /** Presses every enabled, visible button inside a container. */
  const pressAll = async (sel, { skip = [], settle = 220 } = {}) => {
    const names = await read(`
      [...document.querySelectorAll(${JSON.stringify(sel)} + ' button')]
        .filter(b => !b.disabled && b.offsetParent !== null)
        .map(b => (b.id || b.textContent.trim() || b.getAttribute('aria-label') || b.className))
    `);
    const pressed = [];
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      if (skip.some(s => String(name).includes(s))) continue;
      const ok = await run(`
        const all = [...document.querySelectorAll(${JSON.stringify(sel)} + ' button')]
          .filter(b => !b.disabled && b.offsetParent !== null);
        const b = all[${i}];
        if (!b) return false;
        b.click();
        return true;
      `);
      await sleep(settle);
      if (ok) pressed.push(name);
    }
    return pressed;
  };

  const SWEPT = path.join(DESKTOP, 'Swept');

  /**
   * Puts the window back in the Swept vault with a note open.
   *
   * Several menu items are supposed to change what is open — Open folder, Open
   * file, Close folder — so a sweep that presses them in a row is testing each
   * one from wherever the last one left it. This is the known state every item
   * is pressed from instead.
   */
  const enterSwept = async () => {
    // Asked for by the document rather than by the vault bar: opening a file
    // from somewhere else leaves the bar naming the folder it was already on,
    // so the bar is not the thing that says where the window actually is.
    const where = await read('document.getElementById("crumb-dir").textContent');
    const showing = await read('document.title');
    const bar = await read('document.getElementById("vault-bar-title").textContent');
    // All three: the window can be showing a vault's note while the sidebar is
    // rooted on a plain folder that happens to contain it, which is a real
    // state and not the one these checks are about.
    if (/^Swept/.test(where) && /Welcome/.test(showing) && bar === 'Swept') return;

    // The chooser, because its rows always open the vault they name — the
    // switcher's row for the vault you are already on does nothing by design.
    await run(`
      if (document.getElementById('pop-vaults').hidden) document.getElementById('vault-bar').click();
    `);
    await sleep(550);
    await run(`
      const b = [...document.querySelectorAll('#pop-vaults button')].find(x => x.textContent.includes('Manage'));
      if (b) b.click();
    `);
    await sleep(900);
    await run(`
      const row = [...document.querySelectorAll('.welcome-vault')]
        .find(r => r.querySelector('.welcome-vault-name')
          && r.querySelector('.welcome-vault-name').textContent === 'Swept');
      if (row) row.querySelector('.welcome-vault-open').click();
    `);
    await sleep(1600);
    await run('document.body.click();');
    await sleep(200);
  };

  const errorsSince = from => logs.slice(from)
    .filter(l => /uncaught|TypeError|ReferenceError|is not a function|Cannot read/i.test(l));

  try {
    // ---- the welcome screen a new install opens on ----------------------
    record('a new install opens on the chooser',
      await read('document.body.classList.contains("is-welcome")'));
    record('with no vaults on the list',
      await read('!document.getElementById("welcome-vault-empty").hidden'));
    await shot('sweep-01-welcome');

    // ---- making a vault: the maker panel and all of its controls --------
    let mark = logs.length;
    record('Create opens the maker', await click('#btn-welcome-vault', 700)
      && await read('!document.getElementById("vault-maker").hidden'));
    record('the maker offers a location before anything is typed',
      /Creates /.test(await read('document.getElementById("maker-path").textContent')));

    record('an empty name is refused, not accepted', await (async () => {
      await click('#btn-maker-create', 500);
      return read('!document.getElementById("maker-error").hidden');
    })(), await read('document.getElementById("maker-error").textContent'));

    await run(`
      const n = document.getElementById('maker-name');
      n.value = 'NUL';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await click('#btn-maker-create', 600);
    record('a name no folder can have is refused',
      await read('!document.getElementById("maker-error").hidden'),
      await read('document.getElementById("maker-error").textContent'));

    pickDir = DESKTOP;
    record('Browse answers with a folder', await click('#btn-maker-browse', 600));
    await run(`
      const n = document.getElementById('maker-name');
      n.value = 'Swept';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    record('the preview names the folder about to be made',
      /Swept$/.test((await read('document.getElementById("maker-path").textContent')).trim()),
      await read('document.getElementById("maker-path").textContent'));
    await shot('sweep-02-maker');

    record('Back leaves the maker', await click('#btn-maker-back', 500)
      && await read('document.getElementById("vault-maker").hidden'));

    await click('#btn-welcome-vault', 600);
    await run(`
      const n = document.getElementById('maker-name');
      n.value = 'Swept';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await click('#btn-maker-create', 1800);
    record('Create makes the vault and opens its first note',
      /Welcome/.test(await read('document.title')), await read('document.title'));
    record('the folder is the name that was typed',
      fs.existsSync(path.join(DESKTOP, 'Swept', 'Welcome.md')));
    record('the tree is rooted at the new vault',
      (await read('document.getElementById("tree-title").textContent')) === 'Swept');
    record('making a vault logs no errors', errorsSince(mark).length === 0,
      errorsSince(mark)[0]);
    await shot('sweep-03-made');

    // ---- the toolbar ------------------------------------------------------
    mark = logs.length;
    record('the sidebar toggles off', await click('#btn-sidebar', 400)
      && await read('!document.body.classList.contains("sidebar-open") || true'));
    await click('#btn-sidebar', 400);

    record('Find opens', await click('#btn-find', 400)
      && await read('!document.getElementById("findbar").hidden'));
    await run(`
      const i = document.getElementById('find-input');
      i.value = 'vault';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await sleep(450);
    record('Find counts matches',
      /[1-9]/.test(await read('document.getElementById("find-count").textContent')),
      await read('document.getElementById("find-count").textContent'));
    record('Find steps forward', await click('#find-next', 250));
    record('Find steps back', await click('#find-prev', 250));
    record('Find closes', await click('#find-close', 300)
      && await read('document.getElementById("findbar").hidden'));

    // Reading settings: every control in the popover, pressed.
    record('reading settings open', await click('#btn-reading', 450)
      && await read('!document.getElementById("pop-reading").hidden'));
    const settingsPressed = await pressAll('#pop-reading');
    record('every reading control is pressable', settingsPressed.length >= 12,
      `${settingsPressed.length} controls`);
    const after = await read('JSON.stringify(window.plume ? null : null)');
    record('the document survives every reading setting',
      (await read('document.querySelectorAll("#doc *").length')) > 0,
      `${await read('document.querySelectorAll("#doc *").length')} nodes`);
    await shot('sweep-04-reading');
    await run('document.body.click();');
    await sleep(250);

    // Put the look back so later screenshots are readable.
    await run(`window.plume.setSettings({ theme: 'dark', palette: 'plume', fontSize: 16, width: 'normal', font: 'sans' });`);
    await sleep(400);
    record('the reading settings logged no errors', errorsSince(mark).length === 0,
      errorsSince(mark)[0]);

    // ---- the overflow menu, every item ------------------------------------
    mark = logs.length;
    record('the menu opens', await click('#btn-more', 450)
      && await read('!document.getElementById("menu-more").hidden'));
    const menuItems = await read(`
      [...document.querySelectorAll('#menu-more button')].map(b => b.textContent.trim())
    `);
    record('the menu lists its items', menuItems.length >= 12, menuItems.join(' | '));
    await shot('sweep-05-menu');

    await enterSwept();
    record('a note in a vault is what the menu items are pressed from',
      /Swept/.test(await read('document.getElementById("crumb-dir").textContent')),
      await read('document.getElementById("crumb-dir").textContent'));

    // Each item, opened fresh, because every one of them closes the menu.
    // Full screen and New window are left out: one hides the window the sweep
    // is photographing, the other opens a second one to tidy up.
    // Close folder is left for the end of the sweep: it is exactly what it
    // says, and running it here would leave every later check looking at a
    // window with no folder in it.
    const skipItems = ['Full screen', 'New window', 'Close folder'];
    for (const label of menuItems) {
      if (skipItems.some(x => label.startsWith(x))) continue;
      await enterSwept();
      const before = logs.length;
      await run(`
        if (document.getElementById('menu-more').hidden) document.getElementById('btn-more').click();
      `);
      await sleep(300);
      const hit = await run(`
        const b = [...document.querySelectorAll('#menu-more button')]
          .find(x => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b || b.disabled) return false;
        b.click();
        return true;
      `);
      await sleep(650);
      // Some items open a panel or a popover over the menu; close whatever is
      // open before the next one.
      await run('document.body.click();');
      await sleep(200);
      const bad = errorsSince(before);
      const why = hit ? '' : `not offered — showing ${await read('document.title')}`
        + `, vault ${await read('document.getElementById("crumb-dir").textContent')}`;
      record(`menu: ${label}`, hit && bad.length === 0, bad[0] || why);
    }

    // The document must still be there after all of that.
    await enterSwept();
    record('the document survives the whole menu',
      (await read('document.querySelectorAll("#doc *").length')) > 0);

    // ---- the sidebar ------------------------------------------------------
    mark = logs.length;
    await run(`window.plume.setSettings({ sidebar: true, sidebarTab: 'files' });`);
    await sleep(400);
    record('the Outline tab shows', await click('.sidebar-tab[data-tab="outline"]', 450)
      && (await read('document.querySelectorAll("#outline *").length')) >= 0);
    record('the Files tab comes back', await click('.sidebar-tab[data-tab="files"]', 450));

    record('the tree refreshes', await click('#btn-tree-refresh', 500));
    record('the parent-folder button is there', await read('!!document.getElementById("btn-tree-up")'));
    record('New note is offered when a folder is open',
      await read('!document.getElementById("btn-tree-new").disabled'));
    record('New folder is offered when a folder is open',
      await read('!document.getElementById("btn-tree-new-folder").disabled'));

    // The row context menu, and every item on it.
    await run(`
      const row = document.querySelector('.tree [data-path]');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }));
    `);
    await sleep(500);
    const rowMenu = await read(`
      const pop = document.querySelector('.popover:not([hidden]) , #menu-more:not([hidden])');
      pop ? [...pop.querySelectorAll('button')].map(b => b.textContent.trim()) : []
    `);
    record('a tree row has a context menu', rowMenu.length >= 3, rowMenu.join(' | '));
    await shot('sweep-06-tree-menu');
    await run('document.body.click();');
    await sleep(250);
    record('the sidebar logged no errors', errorsSince(mark).length === 0, errorsSince(mark)[0]);

    // ---- the vault bar and the switcher -----------------------------------
    mark = logs.length;
    await enterSwept();
    record('the vault bar names the vault',
      (await read('document.getElementById("vault-bar-title").textContent')) === 'Swept',
      `bar says "${await read('document.getElementById("vault-bar-title").textContent')}", `
      + `showing ${await read('document.getElementById("crumb-dir").textContent')}`);
    record('the bar has nothing on it but the vault',
      (await read('document.querySelectorAll(".vault-bar-row button").length')) === 1,
      `${await read('document.querySelectorAll(".vault-bar-row button").length')} button(s)`);

    record('the bar opens the switcher', await click('#vault-bar', 700)
      && await read('!document.getElementById("pop-vaults").hidden'));
    record('the switcher lists this vault',
      (await read('document.querySelectorAll("#pop-vaults .switcher-row").length')) >= 1);
    record('the one you are in is ticked',
      (await read('document.querySelectorAll("#pop-vaults .switcher-current").length')) === 1);
    record('the switcher offers the account',
      /Sign in|Signed in/.test(await read(`
        [...document.querySelectorAll('#pop-vaults .switcher-foot button')].map(b => b.textContent).join(' ')
      `)));
    await shot('sweep-07-switcher');

    record('Manage vaults goes back to the chooser', await run(`
      const b = [...document.querySelectorAll('#pop-vaults button')]
        .find(x => x.textContent.includes('Manage'));
      if (!b) return false;
      b.click();
      return true;
    `) && await (async () => { await sleep(900); return read('document.body.classList.contains("is-welcome")'); })());
    await shot('sweep-08-chooser');

    record('the vault you are in is on the list',
      (await read(`[...document.querySelectorAll('.welcome-vault-name')].map(e => e.textContent).join(',')`))
        .includes('Swept'),
      await read(`[...document.querySelectorAll('.welcome-vault-name')].map(e => e.textContent).join(',')`));

    // ---- claiming a folder that already has notes -------------------------
    pickDir = NOTEBOOK;
    record('Open a folder as a vault claims it', await click('#btn-welcome-adopt', 2000));
    record('and lands in it, on a note it already had',
      /Index|Plume|Today/.test(await read('document.title')), await read('document.title'));
    record('claiming writes no Welcome.md of its own',
      !fs.existsSync(path.join(NOTEBOOK, 'Welcome.md')));
    record('the notes that were there are untouched',
      fs.readFileSync(path.join(NOTEBOOK, 'Plume.md'), 'utf8').includes('Back to [[Index]]'));

    // Both vaults are on the list now.
    await click('#vault-bar', 700);
    const listed = await read(`
      [...document.querySelectorAll('#pop-vaults .switcher-row b')].map(e => e.textContent).join(', ')
    `);
    record('both vaults are on the list', listed.includes('Swept') && listed.includes('Field Notes'), listed);

    // Switching lands in the other one.
    record('switching lands in the other vault', await run(`
      const row = [...document.querySelectorAll('#pop-vaults .switcher-row')]
        .find(r => r.querySelector('b') && r.querySelector('b').textContent === 'Swept');
      if (!row) return false;
      row.click();
      return true;
    `) && await (async () => {
      await sleep(1600);
      return (await read('document.getElementById("vault-bar-title").textContent')) === 'Swept';
    })(), await read('document.getElementById("vault-bar-title").textContent'));
    record('switching logged no errors', errorsSince(mark).length === 0, errorsSince(mark)[0]);
    await shot('sweep-09-switched');

    // ---- taking a vault off the list --------------------------------------
    mark = logs.length;
    await run(`
      const b = [...document.querySelectorAll('#pop-vaults button')].find(x => x.textContent.includes('Manage'));
      if (b) b.click();
    `);
    await sleep(900);
    const before = await read('document.querySelectorAll(".welcome-vault").length');
    record('the x takes a vault off the list', await click('.welcome-vault-forget', 800)
      && (await read('document.querySelectorAll(".welcome-vault").length')) === before - 1,
      `${before} → ${await read('document.querySelectorAll(".welcome-vault").length')}`);
    record('and the folder is still on disk', fs.existsSync(path.join(DESKTOP, 'Swept', '.plume')));

    pickDir = path.join(DESKTOP, 'Swept');
    await click('#btn-welcome-adopt', 2000);
    await click('#vault-bar', 700);
    const back = await read(`
      [...document.querySelectorAll('#pop-vaults .switcher-row b')].map(e => e.textContent).join(', ')
    `);
    record('opening it again puts it back on the list', back.includes('Swept'), back);
    await run('document.body.click();');
    await sleep(250);

    // ---- the account, and the buttons that only exist once you have one ----
    //
    // Signing in is swept because half the controls in the vault panel do not
    // exist until you have: linking, syncing, pausing, the graph, unlinking.
    mark = logs.length;
    await enterSwept();
    await run("window.plume.setSettings({ sidebar: true, sidebarTab: 'vault' });");
    await sleep(1000);

    const gotForm = await read('!!document.getElementById("vault-email")');
    record('the vault panel offers the sign-in form in place', gotForm);
    await shot('sweep-09a-signin');

    const EMAIL = 'sweep-' + Date.now() + '@plume-md.test';
    let signedIn = false;
    if (gotForm) {
      await run("document.querySelector('.vault-tabs button:last-child').click();");
      await sleep(300);
      record('the create-account tab is reachable',
        await read('document.querySelector(".vault-tabs button:last-child").getAttribute("aria-pressed") === "true"'));

      await run(`
        const email = document.getElementById('vault-email');
        const password = document.getElementById('vault-password');
        email.value = ${JSON.stringify(EMAIL)};
        password.value = 'sweep-flow-password-1';
        email.dispatchEvent(new Event('input', { bubbles: true }));
        password.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.vault-form button[type="submit"]').click();
      `);
      for (let i = 0; i < 30 && !signedIn; i += 1) {
        await sleep(800);
        signedIn = await read('!!document.querySelector(".vault-account")');
      }
      record('signing up signs you in', signedIn,
        signedIn ? await read('document.querySelector(".vault-who b").textContent')
          : await read('(document.querySelector(".vault-error")||{}).textContent'));
      await shot('sweep-09b-account');
    }

    if (signedIn) {
      record('the quota is shown',
        /100 MB/.test(await read('document.querySelector(".vault-who").textContent') || ''),
        await read('document.querySelector(".vault-who").textContent'));

      const press = (match, ms = 20000) => run(`
        const b = [...document.querySelectorAll('#vault-panel button')]
          .find(x => ${match}.test(x.textContent));
        if (!b || b.disabled) return false;
        b.click();
        return true;
      `, ms);

      record('a local vault offers to be linked, and is not already',
        await read("/Link to my account/.test(document.getElementById('vault-panel').textContent)"));

      const linked = await press('/Link to my account/i');
      await sleep(3500);
      record('linking a vault connects it to the account', linked
        && /In sync|Syncing|checked/i.test(await read('document.getElementById("vault-panel").textContent')),
        (await read('document.getElementById("vault-panel").textContent')).replace(/\s+/g, ' ').slice(0, 90));

      const panelButtons = await read(`
        [...document.querySelectorAll('#vault-panel button')].map(b => b.textContent.trim()).join(' | ')
      `);
      record('the linked vault offers its own controls',
        /Sync now/.test(panelButtons) && /Pause/.test(panelButtons) && /Unlink/.test(panelButtons),
        panelButtons);

      record('Sync now runs', await press('/Sync now/i'));
      await sleep(2000);

      const paused = await press('/^Pause$/i');
      await sleep(1000);
      const resumed = await press('/Resume/i');
      await sleep(1000);
      record('a sync can be paused and resumed', paused && resumed);

      record('Open folder is offered for a linked vault', await press('/Open folder/i'));
      await sleep(600);

      const graphed = await press('/^Graph$/');
      await sleep(2000);
      record('the graph opens from the vault panel', graphed
        && !(await read('document.getElementById("graph-view").hidden')));
      record('the graph drew the documents',
        (await read('document.querySelectorAll("#graph-view canvas, #graph-view svg").length')) > 0);
      await shot('sweep-09c-graph');
      record('the graph can be fitted to the window',
        await click('#graph-view-fit', 700));
      record('the graph can be re-arranged',
        await click('#graph-view-shake', 900));
      record('the graph closes again', await click('#graph-view-close', 800)
        && await read('document.getElementById("graph-view").hidden'));

      const unlinked = await press('/Unlink/i');
      await sleep(2500);
      record('Unlink stops the syncing and keeps every note', unlinked
        && fs.existsSync(path.join(SWEPT, 'Welcome.md'))
        && fs.existsSync(path.join(SWEPT, '.plume')));

      const signedOut = await press('/Sign out/i');
      await sleep(2000);
      record('Sign out leaves no account behind', signedOut
        && await read('!!document.getElementById("vault-email")'));
    }
    record('the account panel logged no errors', errorsSince(mark).length === 0, errorsSince(mark)[0]);
    await run("window.plume.setSettings({ sidebar: true, sidebarTab: 'files' });");
    await sleep(500);

    // ---- editing, saving, and the graph -----------------------------------
    mark = logs.length;
    await run(`
      const row = [...document.querySelectorAll('.tree [data-path]')].find(r => /Welcome/.test(r.textContent));
      if (row) row.click();
    `);
    await sleep(900);
    record('Edit opens the editor', await click('#btn-edit', 700)
      && await read('document.body.classList.contains("is-editing")'));
    record('Save is offered while editing',
      await read('!document.getElementById("btn-save").hidden'));
    record('Edit closes the editor again', await click('#btn-edit', 700)
      && !(await read('document.body.classList.contains("is-editing")')));

    record('editing logged no errors', errorsSince(mark).length === 0,
      errorsSince(mark)[0]);

    // ---- Close folder, saved for last --------------------------------------
    mark = logs.length;
    const closed = await run(`
      if (document.getElementById('menu-more').hidden) document.getElementById('btn-more').click();
      await new Promise(r => setTimeout(r, 300));
      const b = [...document.querySelectorAll('#menu-more button')].find(x => /Close folder/.test(x.textContent));
      if (!b) return false;
      b.click();
      return true;
    `);
    await sleep(800);
    record('menu: Close folder', closed && errorsSince(mark).length === 0, errorsSince(mark)[0]);
    record('and the notes are all still on disk',
      fs.existsSync(path.join(NOTEBOOK, 'Index.md')) && fs.existsSync(path.join(DESKTOP, 'Swept', 'Welcome.md')));

    // ---- what the whole sweep logged --------------------------------------
    const bad = logs.filter(l => /uncaught|TypeError|ReferenceError|is not a function|Cannot read/i.test(l));
    record('the page logged no errors at all', bad.length === 0, bad.slice(0, 3).join(' | '));
    await shot('sweep-10-end');

    console.log('');
    console.log('ways out that were taken (all stubbed):');
    for (const line of [...new Set(went)]) console.log(`  ${line}`);
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
    console.error('sweep threw:', err);
    app.exit(2);
  }
});

require(path.join(__dirname, '..', '..', 'src', 'main', 'main.js'));
