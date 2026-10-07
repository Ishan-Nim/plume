'use strict';

// Visual smoke test: boots the real main process on a document, waits for the
// renderer to finish, optionally runs a script in the page, then saves a
// screenshot and any console errors.
//
//   set PLUME_OUT=shot.png & npx electron test/e2e/capture.js path\to\file.md
//
// Env: PLUME_OUT (png path, required), PLUME_THEME (light|dark), PLUME_SIZE (WxH),
//      PLUME_EVAL (JS to run before the capture), PLUME_SETTINGS (JSON merged into settings),
//      PLUME_WAIT (extra ms before capture), PLUME_REPORT (JS expression whose JSON result is saved).

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Never let a harness failure pop a modal error dialog on the desktop:
// print it and exit instead.
function fail(message, code = 2) {
  console.error(`capture: ${message}`);
  app.exit(code);
  process.exit(code);
}
process.on('uncaughtException', err => fail(err && err.stack ? err.stack : String(err), 1));
process.on('unhandledRejection', err => fail(err && err.stack ? err.stack : String(err), 1));

const out = process.env.PLUME_OUT;
if (!out) fail('PLUME_OUT is required');

let extraSettings = {};
if (process.env.PLUME_SETTINGS) {
  try {
    extraSettings = JSON.parse(process.env.PLUME_SETTINGS);
  } catch (err) {
    fail(`PLUME_SETTINGS is not valid JSON (${err.message}). Escape Windows backslashes as \\\\ or use forward slashes.`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-'));
app.setPath('userData', tmp);
const [w, h] = (process.env.PLUME_SIZE || '1280x860').split('x').map(Number);
const settings = {
  theme: process.env.PLUME_THEME || 'light',
  bounds: { x: 40, y: 40, width: w, height: h },
  ...extraSettings,
};
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify(settings));

// Show the window without focus and fully transparent, so it paints (hidden
// windows do not produce fresh frames) but does not disturb the desktop.
BrowserWindow.prototype.show = function show() {
  this.setOpacity(0);
  this.setSkipTaskbar(true);
  this.showInactive();
};
BrowserWindow.prototype.maximize = function maximize() {};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const logs = [];

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (event, level, message) => {
    const msg = typeof event === 'object' && event.message ? event.message : message;
    const lvl = typeof event === 'object' && event.level !== undefined ? event.level : level;
    logs.push(`[${lvl}] ${msg}`);
  });
  win.webContents.once('did-finish-load', async () => {
    try {
      for (let i = 0; i < 150; i++) {
        if (await win.webContents.executeJavaScript('document.body.dataset.ready === "1"')) break;
        await sleep(100);
      }
      await sleep(Number(process.env.PLUME_WAIT || 900));
      if (process.env.PLUME_EVAL) {
        await win.webContents.executeJavaScript(`(async () => { ${process.env.PLUME_EVAL} })()`);
        await sleep(700);
      }
      if (process.env.PLUME_REPORT) {
        const report = await win.webContents.executeJavaScript(`(async () => (${process.env.PLUME_REPORT}))()`);
        fs.writeFileSync(out.replace(/\.png$/i, '.json'), JSON.stringify(report, null, 2));
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(out, img.toPNG());
      fs.writeFileSync(out.replace(/\.png$/i, '.log'), logs.join('\n'));
      console.log(`captured ${out} (${img.getSize().width}x${img.getSize().height}), console lines: ${logs.length}`);
    } catch (err) {
      console.error('capture failed:', err);
      process.exitCode = 1;
    }
    app.exit(process.exitCode || 0);
  });
});

require('../../src/main/main.js');
