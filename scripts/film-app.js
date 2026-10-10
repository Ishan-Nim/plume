'use strict';

// Films a short tour of the real app for the website hero.
//
//   npx electron scripts/film-app.js
//   (then) ffmpeg, which this prints the command for, or run with PLUME_ENCODE=1
//
// Frames come from the same capturePage() the screenshots use, so what is in
// the video is the actual app rendering an actual notebook — not a mockup.
// Nothing here touches a vault: the tour is reading, the outline, the palettes
// and the editor, all local.

const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.PLUME_FILM || path.join(ROOT, 'site', 'assets', 'shots');
const FPS = Number(process.env.PLUME_FPS || 15);

const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-film-'));
fs.mkdirSync(OUT, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-film-data-'));
app.setPath('userData', tmp);

// Even dimensions, because H.264 wants them.
const [w, h] = (process.env.PLUME_SIZE || '1280x832').split('x').map(Number);

// A copy, so filming never writes to the repository.
// Named, not a temporary directory: the folder's name is on screen in the
// sidebar's header, the breadcrumb and the vault bar for the whole film.
const notebook = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plume-demo-')), 'Notebook');
fs.cpSync(path.join(ROOT, 'docs', 'film-notebook'), notebook, { recursive: true });

// The graph is only worth filming with something to draw. Five notes make a
// star; a few dozen that link to each other as well as to the hub make the mesh
// a real vault has. These are generated rather than committed because nobody
// needs to read them — they exist to be edges.
const TOPICS = [
  'reading-view', 'wiki-links', 'callouts', 'front-matter', 'syntax-highlighting',
  'katex-math', 'mermaid-diagrams', 'task-lists', 'footnotes', 'definition-lists',
  'outline-panel', 'find-in-page', 'live-reload', 'the-editor', 'printing',
  'pdf-export', 'palettes', 'dark-mode', 'reading-width', 'serif-and-sans',
  'the-vault', 'folder-sync', 'api-tokens', 'mcp-server', 'the-graph',
  'backlinks', 'tags', 'search', 'updates', 'keyboard',
];
const title = (slug) => slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
TOPICS.forEach((slug, i) => {
  // Two siblings each, picked at a stride, so the web is woven rather than
  // chained — a chain draws as a ring, which is not what a vault looks like.
  const a = TOPICS[(i + 7) % TOPICS.length];
  const b = TOPICS[(i + 13) % TOPICS.length];
  fs.writeFileSync(path.join(notebook, `${title(slug)}.md`), [
    '---', 'tags: [reference]', '---', '',
    `# ${title(slug)}`, '',
    `Part of [[A tour of Plume]].`, '',
    `See also [[${title(a)}]] and [[${title(b)}]].`, '',
  ].join('\n'));
});
// The hub links out to all of them, which is what makes it the centre.
const hub = path.join(notebook, 'A tour of Plume.md');
fs.appendFileSync(hub, `\n\n## Reference\n\n${TOPICS.map((s) => `- [[${title(s)}]]`).join('\n')}\n`);

fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: 'light',
  palette: 'plume',
  bounds: { x: 40, y: 40, width: w, height: h },
  sidebar: true,
  sidebarWidth: 262,
  autoUpdate: false,
  // Set here so the tour never has to open a native folder dialog, which is
  // the one thing in this app a script cannot drive.
  vaultFolder: notebook,
}));

process.argv.push(hub);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Show without stealing focus or flashing on the desktop.
BrowserWindow.prototype.show = function show() {
  this.setOpacity(0);
  this.setSkipTaskbar(true);
  this.showInactive();
};
BrowserWindow.prototype.maximize = function maximize() {};

let n = 0;
let filming = false;

/**
 * Grabs frames on a fixed interval for as long as the tour runs. JPEG rather
 * than PNG: a PNG of this window takes longer than the frame interval, and a
 * recorder that cannot keep up produces a video that stutters where the app
 * does not.
 */
async function record(win) {
  const every = 1000 / FPS;
  while (filming) {
    const started = Date.now();
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(frames, `f${String(++n).padStart(5, '0')}.jpg`), img.toJPEG(92));
    } catch (err) { /* a frame lost to a resize is not worth stopping for */ }
    const spent = Date.now() - started;
    if (spent < every) await sleep(every - spent);
  }
}

async function main(win) {
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

  // Eased scrolling, in the page, so the motion is the browser's rather than a
  // series of jumps a frame apart.
  const glide = (to, ms) => run(`
    const el = document.getElementById('viewer') || document.scrollingElement;
    const from = el.scrollTop;
    const dist = (${to}) - from;
    const start = performance.now();
    await new Promise((done) => {
      function step(now) {
        const t = Math.min(1, (now - start) / ${ms});
        // easeInOutCubic: starts and stops gently, like a hand on a wheel.
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        el.scrollTop = from + dist * e;
        if (t < 1) requestAnimationFrame(step); else done();
      }
      requestAnimationFrame(step);
    });
  `);

  await until('document.body.dataset.ready === "1"');
  await sleep(1500);

  filming = true;
  let recorder = record(win);

  // ---- 1. the document, as you meet it ----
  //
  // Short: a long still opening is exactly what makes a film look like a
  // screenshot to somebody who glances at it.
  await sleep(600);

  // ---- 2. read down the page ----
  const far = await read("(document.getElementById('viewer')||document.scrollingElement).scrollHeight");
  await glide(Math.round(far * 0.28), 2600);
  await sleep(900);
  await glide(Math.round(far * 0.55), 2600);
  await sleep(1000);

  // ---- 3. the outline ----
  await run(`document.querySelector('.sidebar-tab[data-tab="outline"]').click();`);
  await sleep(1700);
  await run(`document.querySelector('.sidebar-tab[data-tab="files"]').click();`);
  await sleep(700);

  await glide(0, 1800);
  await sleep(600);

  // ---- 4. the palettes, one after another ----
  await run(`document.getElementById('btn-reading').click();`);
  await sleep(1100);
  for (const palette of ['greenwood', 'commit', 'lapis', 'starless']) {
    await run(`document.querySelector('[data-set="palette:${palette}"]').click();`);
    // Starless is the one that wants the dark side to make its point.
    if (palette === 'lapis') {
      await run(`document.querySelector('[data-set="theme:dark"]').click();`);
    }
    await sleep(1250);
  }
  await sleep(500);
  await run(`document.querySelector('[data-set="palette:plume"]').click();`);
  await sleep(900);
  await run(`document.querySelector('[data-set="theme:light"]').click();`);
  await sleep(700);
  await run(`document.getElementById('btn-reading').click();`);
  await sleep(900);

  // ---- 5. it edits, when you ask it to ----
  await run(`document.getElementById('btn-edit').click();`);
  await sleep(2200);
  await run(`document.getElementById('btn-edit').click();`);
  await sleep(1600);

  // ---- 6. the vault, and the graph of what is in it ----
  //
  // Only when there is somewhere to sign up to. Without PLUME_VAULT_API the
  // tour simply ends after the editor, which is still a tour.
  if (process.env.PLUME_VAULT_API) {
    // The camera stops for the setup. Signing up and uploading thirty
    // documents is a minute of a progress line moving, which is not a tour —
    // and leaving it in is what made the first cut fifty-six seconds long.
    filming = false;
    await recorder;

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
    if (!(await until('!!document.querySelector(".vault-account")', 30000))) {
      throw new Error('could not sign up to the vault');
    }
    await sleep(900);

    // One at a time, through the tree, so the renderer's own state follows
    // along — calling the IPC directly moves the document without telling it,
    // and every sync would then send the same file.
    const notes = fs.readdirSync(notebook).filter((f) => f.endsWith('.md'));
    process.stdout.write(`  syncing ${notes.length} notes `);
    for (const note of notes) {
      const name = path.basename(note, '.md');
      await run(`
        document.querySelector('.sidebar-tab[data-tab="files"]').click();
        await new Promise(r => setTimeout(r, 180));
        const row = [...document.querySelectorAll('.tree-row')].find(r => r.textContent.trim() === ${JSON.stringify(name)});
        if (row) row.click();
      `);
      await sleep(550);
      await run(`window.plume.setSettings({ sidebar: true, sidebarTab: 'vault' });`);
      await sleep(320);
      await run(`
        const send = [...document.querySelectorAll('.vault-btn')].find(b => b.textContent.trim() === 'Sync to vault');
        if (send) send.click();
      `);
      await sleep(900);
      process.stdout.write('.');
    }
    console.log(' done');

    // Back to the hub, and roll again for the graph itself.
    await run(`
      document.querySelector('.sidebar-tab[data-tab="files"]').click();
      await new Promise(r => setTimeout(r, 250));
      const row = [...document.querySelectorAll('.tree-row')].find(r => r.textContent.trim() === 'A tour of Plume');
      if (row) row.click();
    `);
    await sleep(1200);
    await run(`window.plume.setSettings({ sidebar: true, sidebarTab: 'vault' });`);
    await sleep(800);

    filming = true;
    recorder = record(win);
    await sleep(900);

    await run(`
      const graph = [...document.querySelectorAll('.vault-btn')].find(b => b.textContent.trim() === 'Graph');
      if (graph) graph.click();
    `);
    if (await until('!document.getElementById("graph-view").hidden', 30000)) {
      // Let the force layout settle, fit it, then let it breathe.
      await sleep(4500);
      await run(`document.getElementById('graph-view-fit').click();`);
      await sleep(3000);
      await run(`document.getElementById('graph-view-shake').click();`);
      await sleep(3800);
      await run(`document.getElementById('graph-view-fit').click();`);
      await sleep(2400);
    }
  }

  filming = false;
  await recorder;
  console.log(`\n${n} frames at ${FPS}fps — ${(n / FPS).toFixed(1)}s`);
  return frames;
}

function encode() {
  const mp4 = path.join(OUT, 'tour.mp4');
  const webm = path.join(OUT, 'tour.webm');
  const poster = path.join(OUT, 'tour-poster.jpg');
  const input = path.join(frames, 'f%05d.jpg');
  const ff = (args) => execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

  // yuv420p and even dimensions, or Safari and most Android players show black.
  ff(['-y', '-framerate', String(FPS), '-i', input,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '27',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', mp4]);

  ff(['-y', '-framerate', String(FPS), '-i', input,
    '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-row-mt', '1',
    '-pix_fmt', 'yuv420p', webm]);

  // The first frame, for the poster: what somebody sees before it plays, and
  // what they keep seeing if they have asked for less motion.
  ff(['-y', '-i', path.join(frames, 'f00001.jpg'), '-q:v', '4', poster]);

  for (const f of [mp4, webm, poster]) {
    console.log(`  ${path.basename(f)}  ${(fs.statSync(f).size / 1048576).toFixed(2)} MB`);
  }
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', () => {});
});

app.whenReady().then(async () => {
  await sleep(1800);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error('film-app: no window');
    app.exit(2);
    return;
  }
  try {
    await main(win);
    console.log('\nencoding…');
    encode();
    console.log('\ndone');
    app.exit(0);
  } catch (err) {
    filming = false;
    console.error('film-app failed:', err && err.message);
    app.exit(1);
  }
});

require('../src/main/main.js');
