// Drives the Git panel in the real app: sets the folder, connects it to a bare
// repository, syncs, and reports what the panel ends up saying.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-gitdrive-'));
app.setPath('userData', tmp);
const NOTES = 'C:\Users\BaBaY4ga\AppData\Local\Temp\gitdemo\notes';
const REMOTE = 'C:/Users/BaBaY4ga/AppData/Local/Temp/gitdemo/remote';
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'light', bounds: { x: 40, y: 40, width: 1200, height: 820 },
  gitFolder: NOTES,
}));
process.argv.push(path.join(NOTES, 'Note one.md'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
BrowserWindow.prototype.show = function () { this.setOpacity(0); this.setSkipTaskbar(true); this.showInactive(); };

app.whenReady().then(async () => {
  await sleep(2500);
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  const run = js => wc.executeJavaScript(`(async () => { ${js} })()`);

  // git.connect goes through the real IPC, same as the button.
  const connected = await run(`return await window.plume.git.connect(${JSON.stringify(REMOTE)});`);
  console.log('connect :', connected.ok ? `repo=${connected.repo} remote set` : 'FAILED ' + connected.error);

  const first = await run(`return await window.plume.git.sync('from the drive test');`);
  console.log('sync #1 :', first.ok ? `pushed=${first.pushed} ${first.lastCommit || ''}` : 'FAILED ' + first.error);

  const state = await run(`return await window.plume.git.state();`);
  console.log('state   :', `branch=${state.branch} dirty=${state.dirty} ahead=${state.ahead} behind=${state.behind}`);

  // The panel itself: open the menu item's popover and read what it says.
  await run(`document.getElementById('btn-more').click(); await new Promise(r=>setTimeout(r,200));
             [...document.querySelectorAll('.menu-item')].find(b=>b.textContent.includes('Git sync')).click();`);
  await sleep(900);
  const shown = await run(`return document.getElementById('pop-git').innerText.replace(/\n+/g,' | ');`);
  console.log('panel   :', shown);

  const img = await win.webContents.capturePage();
  fs.writeFileSync('C:/Users/BaBaY4ga/AppData/Local/Temp/claude/E--MD-APP/952b71e2-198a-49f0-a26e-9cb304795288/scratchpad/qa/git-panel.png', img.toPNG());
  app.exit(0);
});
require('./src/main/main.js');
