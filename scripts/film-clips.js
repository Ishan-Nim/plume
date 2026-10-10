'use strict';

// Films one short clip per documentation section, from the real app.
//
//   node scripts/dev-server-memory.js        (in the plume-vault repository)
//   PLUME_VAULT_API=http://127.0.0.1:8098/api npx electron scripts/film-clips.js
//
// Each clip is recorded, encoded to mp4 and webm, and given a poster from its
// own first frame — the same treatment as the hero film in scripts/film-app.js.
// Setup that nobody needs to watch (signing up, uploading thirty documents)
// happens with the camera off.
//
// PLUME_CLIPS=git,graph films only those.

const { app, BrowserWindow } = require('electron');
const { execFileSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.PLUME_CLIPS_DIR || path.join(ROOT, 'site', 'assets', 'clips');
const FPS = Number(process.env.PLUME_FPS || 15);
const ONLY = (process.env.PLUME_CLIPS || '').split(',').map((s) => s.trim()).filter(Boolean);

fs.mkdirSync(OUT, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-clips-data-'));
app.setPath('userData', tmp);

const [w, h] = (process.env.PLUME_SIZE || '1180x760').split('x').map(Number);

// Notes to film against, plus a web of links so the graph has something to draw.
// The folder is called "Notes" rather than the temporary directory it sits in,
// because its name is on screen — in the sidebar's header and in the title bar.
const notebook = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plume-clipnotes-')), 'Notes');
fs.cpSync(path.join(ROOT, 'docs', 'film-notebook'), notebook, { recursive: true });
const TOPICS = ['reading-view', 'wiki-links', 'callouts', 'front-matter', 'katex-math',
  'mermaid-diagrams', 'task-lists', 'the-outline', 'live-reload', 'the-editor',
  'palettes', 'dark-mode', 'the-vault', 'folder-sync', 'the-graph', 'backlinks',
  'api-tokens', 'updates', 'keyboard', 'privacy'];
const title = (slug) => slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
TOPICS.forEach((slug, i) => {
  const a = TOPICS[(i + 5) % TOPICS.length];
  const b = TOPICS[(i + 11) % TOPICS.length];
  fs.writeFileSync(path.join(notebook, `${title(slug)}.md`), [
    '---', 'tags: [reference]', '---', '', `# ${title(slug)}`, '',
    'Part of [[A tour of Plume]].', '', `See also [[${title(a)}]] and [[${title(b)}]].`, '',
  ].join('\n'));
});
const hub = path.join(notebook, 'A tour of Plume.md');
fs.appendFileSync(hub, `\n\n## Reference\n\n${TOPICS.map((s) => `- [[${title(s)}]]`).join('\n')}\n`);

// A bare repository on disk stands in for a remote, so filming needs no network
// and no credentials.
const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-clip-remote-'));
const gitFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-clip-gitnotes-'));
try {
  execFileSync('git', ['init', '--bare', '--initial-branch=main'], { cwd: bare, stdio: 'ignore' });
  fs.cpSync(path.join(ROOT, 'docs', 'film-notebook'), gitFolder, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: gitFolder, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: gitFolder, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'you@example.com'], { cwd: gitFolder, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'You'], { cwd: gitFolder, stdio: 'ignore' });
} catch (err) {
  console.error('could not prepare the stand-in repository:', err.message);
}

fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'light', palette: 'plume', sidebar: true, sidebarWidth: 250,
  bounds: { x: 40, y: 40, width: w, height: h }, autoUpdate: false,
  gitFolder,
}));
process.argv.push(hub);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
BrowserWindow.prototype.show = function show() {
  this.setOpacity(0);
  this.setSkipTaskbar(true);
  this.showInactive();
};
BrowserWindow.prototype.maximize = function maximize() {};

// ---------------------------------------------------------------- recording

let frames = null;
let n = 0;
let filming = false;
let recorder = null;

async function pump(win) {
  const every = 1000 / FPS;
  while (filming) {
    const started = Date.now();
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(frames, `f${String(++n).padStart(5, '0')}.jpg`), img.toJPEG(92));
    } catch (err) { /* a dropped frame is not worth stopping for */ }
    const spent = Date.now() - started;
    if (spent < every) await sleep(every - spent);
  }
}

function start(win) {
  frames = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-clipframes-'));
  n = 0;
  filming = true;
  recorder = pump(win);
}

const ff = (args) => new Promise((resolve, reject) => {
  execFile('ffmpeg', args, { maxBuffer: 8 * 1024 * 1024 }, (err) => (err ? reject(err) : resolve()));
});

async function stop(name) {
  filming = false;
  await recorder;
  const input = path.join(frames, 'f%05d.jpg');
  const mp4 = path.join(OUT, `${name}.mp4`);
  const webm = path.join(OUT, `${name}.webm`);
  const poster = path.join(OUT, `${name}.jpg`);

  await ff(['-y', '-framerate', String(FPS), '-i', input, '-c:v', 'libx264', '-preset', 'slow',
    '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', mp4]);
  await ff(['-y', '-framerate', String(FPS), '-i', input, '-c:v', 'libvpx-vp9', '-crf', '38',
    '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p', webm]);
  await ff(['-y', '-i', path.join(frames, 'f00001.jpg'), '-q:v', '4', poster]);

  const mb = (f) => (fs.statSync(f).size / 1048576).toFixed(2);
  console.log(`  ${name.padEnd(10)} ${(n / FPS).toFixed(1)}s   mp4 ${mb(mp4)} MB   webm ${mb(webm)} MB`);
  fs.rmSync(frames, { recursive: true, force: true });
}

// ---------------------------------------------------------------- the clips

app.whenReady().then(async () => {
  await sleep(2500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.error('film-clips: no window'); app.exit(2); return; }
  const wc = win.webContents;
  const run = (js) => wc.executeJavaScript(`(async () => { ${js} })()`);
  const read = (expr) => wc.executeJavaScript(`(async () => (${expr}))()`);

  async function until(expr, timeout = 20000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await read(expr)) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  }

  const glide = (to, ms) => run(`
    const el = document.getElementById('viewer') || document.scrollingElement;
    const from = el.scrollTop;
    const dist = (${to}) - from;
    const start = performance.now();
    await new Promise((done) => {
      function step(now) {
        const t = Math.min(1, (now - start) / ${ms});
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        el.scrollTop = from + dist * e;
        if (t < 1) requestAnimationFrame(step); else done();
      }
      requestAnimationFrame(step);
    });
  `);

  // Types the way somebody types, a character at a time, so the film shows a
  // name being chosen rather than appearing.
  const typeInto = async (selector, text, every = 70) => {
    for (let i = 1; i <= text.length; i += 1) {
      await run(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.value = ${JSON.stringify(text)}.slice(0, ${i});
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      `);
      await sleep(every);
    }
  };

  const press = (selector, key) => run(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
  `);

  const reset = async () => {
    await run(`
      await window.plume.setSettings({ theme: 'light', palette: 'plume', sidebar: true, sidebarTab: 'files' });
      const pop = document.getElementById('pop-reading'); if (pop && !pop.hidden) document.getElementById('btn-reading').click();
      const git = document.getElementById('pop-git'); if (git && !git.hidden) git.hidden = true;
      const g = document.getElementById('graph-view'); if (g && !g.hidden) document.getElementById('graph-view-close').click();
      (document.getElementById('viewer') || document.scrollingElement).scrollTop = 0;
    `);
    await sleep(700);
  };

  await until('document.body.dataset.ready === "1"');
  await sleep(1800);

  const clips = {
    // ---- reading a document ----
    async reading() {
      await sleep(900);
      const far = await read("(document.getElementById('viewer')||document.scrollingElement).scrollHeight");
      await glide(Math.round(far * 0.22), 2400);
      await sleep(700);
      await glide(Math.round(far * 0.46), 2400);
      await sleep(700);
      await glide(Math.round(far * 0.70), 2400);
      await sleep(900);
    },

    // ---- the outline ----
    async outline() {
      await sleep(600);
      await run(`document.querySelector('.sidebar-tab[data-tab="outline"]').click();`);
      await sleep(1600);
      await run(`
        const links = [...document.querySelectorAll('#outline a, .outline a')];
        const target = links.find(a => /Diagrams|Mathematics/i.test(a.textContent)) || links[3];
        if (target) target.click();
      `);
      await sleep(2200);
      await run(`document.querySelector('.sidebar-tab[data-tab="files"]').click();`);
      await sleep(800);
    },

    // ---- palettes and themes ----
    async themes() {
      await run(`document.getElementById('btn-reading').click();`);
      await sleep(1100);
      for (const p of ['greenwood', 'commit', 'lapis', 'starless']) {
        await run(`document.querySelector('[data-set="palette:${p}"]').click();`);
        if (p === 'lapis') await run(`document.querySelector('[data-set="theme:dark"]').click();`);
        await sleep(1250);
      }
      await sleep(400);
      await run(`document.querySelector('[data-set="palette:plume"]').click();`);
      await sleep(700);
      await run(`document.querySelector('[data-set="theme:light"]').click();`);
      await sleep(600);
      await run(`document.getElementById('btn-reading').click();`);
      await sleep(700);
    },

    // ---- the editor ----
    async editing() {
      await sleep(700);
      await run(`document.getElementById('btn-edit').click();`);
      await sleep(2400);
      await run(`document.getElementById('btn-edit').click();`);
      await sleep(1600);
    },

    // ---- making a note from the sidebar ----
    async newnote() {
      await sleep(700);
      await run(`document.getElementById('btn-tree-new').click();`);
      await until('!!document.querySelector(".tree-draft-name")');
      await sleep(600);
      await typeInto('.tree-draft-name', 'Thursday meeting');
      await sleep(900);
      await press('.tree-draft-name', 'Enter');
      // The editor element does not exist until editing starts, so this asks
      // whether it is there and showing rather than reading through a null.
      await until('!!document.getElementById("editor") && !document.getElementById("editor").hidden', 8000);
      await sleep(1300);
      await typeInto('#editor', '# Thursday meeting\n\nWhat we decided:', 55);
      await sleep(1600);
    },

    // ---- renaming, and the links following ----
    async organise() {
      // A document open behind it, so the rename happens in a window somebody
      // is working in rather than against an empty page.
      await run(`
        const row = [...document.querySelectorAll('.tree-row')]
          .find(r => r.querySelector('.tree-name') && r.querySelector('.tree-name').textContent === 'A tour of Plume');
        if (row) row.click();
      `);
      await sleep(1400);
      // Right-click the row, where the row actually is.
      await run(`
        const row = [...document.querySelectorAll('.tree-row')]
          .find(r => r.querySelector('.tree-name') && r.querySelector('.tree-name').textContent === 'Wiki links');
        if (!row) throw new Error('no row to rename');
        row.scrollIntoView({ block: 'center' });
        await new Promise(r => setTimeout(r, 400));
        const box = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: Math.round(box.left + box.width * 0.6),
          clientY: Math.round(box.top + box.height / 2),
        }));
      `);
      await until('!document.getElementById("menu-tree").hidden');
      await sleep(1600);
      await run(`
        const item = [...document.querySelectorAll('#menu-tree .menu-item')].find(b => b.textContent.includes('Rename'));
        if (item) item.click();
      `);
      await until('!!document.querySelector(".tree-renaming .tree-draft-name")');
      await sleep(700);
      await run(`document.querySelector('.tree-draft-name').value = '';`);
      await typeInto('.tree-draft-name', 'Linking notes');
      await sleep(800);
      await press('.tree-draft-name', 'Enter');
      // The toast says how many links in how many notes followed it.
      await sleep(3200);
    },

    // ---- find in page ----
    async find() {
      await sleep(600);
      await run(`document.getElementById('btn-find').click();`);
      await sleep(700);
      const term = 'Markdown';
      for (let i = 1; i <= term.length; i += 1) {
        await run(`
          const input = document.getElementById('find-input');
          input.value = ${JSON.stringify(term)}.slice(0, ${i});
          input.dispatchEvent(new Event('input', { bubbles: true }));
        `);
        await sleep(110);
      }
      await sleep(1200);
      await run(`document.getElementById('find-next').click();`);
      await sleep(900);
      await run(`document.getElementById('find-next').click();`);
      await sleep(1100);
      await run(`document.getElementById('find-close').click();`);
      await sleep(600);
    },

    // ---- git sync ----
    async git() {
      await sleep(500);
      await run(`
        document.getElementById('btn-more').click();
        await new Promise(r => setTimeout(r, 300));
        const item = [...document.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Git sync'));
        if (item) item.click();
      `);
      await sleep(1800);
      await run(`
        const now = [...document.querySelectorAll('#pop-git .vault-btn')].find(b => /Sync now/.test(b.textContent));
        if (now) now.click();
      `);
      await sleep(3600);
      await run(`document.getElementById('pop-git').hidden = true;`);
      await sleep(500);
    },

    // ---- the vault ----
    async vault() {
      await sleep(600);
      await run(`await window.plume.setSettings({ sidebar: true, sidebarTab: 'vault' });`);
      await sleep(2600);
      await run(`await window.plume.setSettings({ sidebarTab: 'files' });`);
      await sleep(700);
    },

    // ---- the graph ----
    async graph() {
      await sleep(500);
      await run(`await window.plume.setSettings({ sidebar: true, sidebarTab: 'vault' });`);
      await sleep(1000);
      await run(`
        const g = [...document.querySelectorAll('.vault-btn')].find(b => b.textContent.trim() === 'Graph');
        if (g) g.click();
      `);
      if (await until('!document.getElementById("graph-view").hidden', 25000)) {
        await sleep(4000);
        await run(`document.getElementById('graph-view-fit').click();`);
        await sleep(2600);
        await run(`document.getElementById('graph-view-shake').click();`);
        await sleep(3400);
        await run(`document.getElementById('graph-view-fit').click();`);
        await sleep(2000);
        await run(`document.getElementById('graph-view-close').click();`);
      }
      await sleep(600);
    },
  };

  // The vault clips need an account and documents in it. Off camera.
  const NEEDS_VAULT = new Set(['vault', 'graph']);
  const wanted = Object.keys(clips).filter((k) => !ONLY.length || ONLY.includes(k));

  if (wanted.some((k) => NEEDS_VAULT.has(k)) && process.env.PLUME_VAULT_API) {
    console.log('preparing a vault (off camera)…');
    await run(`window.plume.setSettings({ sidebar: true, sidebarTab: 'vault' });`);
    await until('!!document.getElementById("vault-email")');
    await sleep(600);
    await run(`
      document.querySelector('.vault-tabs button:last-child').click();
      await new Promise(r => setTimeout(r, 250));
      document.getElementById('vault-email').value = ${JSON.stringify(`you-${Date.now()}@example.com`)};
      document.getElementById('vault-password').value = 'a-good-long-password-1';
      document.querySelector('.vault-form button[type="submit"]').click();
    `);
    if (await until('!!document.querySelector(".vault-account")', 30000)) {
      const notes = fs.readdirSync(notebook).filter((f) => f.endsWith('.md'));
      process.stdout.write(`  syncing ${notes.length} notes `);
      for (const note of notes) {
        const name = path.basename(note, '.md');
        await run(`
          document.querySelector('.sidebar-tab[data-tab="files"]').click();
          await new Promise(r => setTimeout(r, 170));
          const row = [...document.querySelectorAll('.tree-row')].find(r => r.textContent.trim() === ${JSON.stringify(name)});
          if (row) row.click();
        `);
        await sleep(520);
        await run(`window.plume.setSettings({ sidebar: true, sidebarTab: 'vault' });`);
        await sleep(300);
        await run(`
          const send = [...document.querySelectorAll('.vault-btn')].find(b => b.textContent.trim() === 'Sync to vault');
          if (send) send.click();
        `);
        await sleep(880);
        process.stdout.write('.');
      }
      console.log(' done');
      await run(`
        document.querySelector('.sidebar-tab[data-tab="files"]').click();
        await new Promise(r => setTimeout(r, 300));
        const row = [...document.querySelectorAll('.tree-row')].find(r => r.textContent.trim() === 'A tour of Plume');
        if (row) row.click();
      `);
      await sleep(1200);
    } else {
      console.log('  (could not sign up — the vault clips will show the signed-out panel)');
    }
  }

  console.log('\nfilming:');
  for (const name of wanted) {
    await reset();
    start(win);
    await sleep(350);
    try {
      await clips[name]();
    } catch (err) {
      console.error(`  ${name}: ${err.message}`);
    }
    await stop(name);
  }

  console.log('\ndone');
  app.exit(0);
});

require('../src/main/main.js');
