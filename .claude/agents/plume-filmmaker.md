---
name: plume-filmmaker
description: Records short screen-capture films of the real Plume desktop app for the website and the documentation. Use when asked to "film the app", "record a clip", "record a clip of the new feature", "make a video for the docs", "add a demo video", "re-record the hero tour", "film the graph/vault/editor", or when a new feature needs a moving picture on site/docs.html or site/index.html. Also use when an existing clip is stale and needs re-shooting after a UI change.
tools: Read, Write, Edit, Bash, PowerShell, Glob, Grep
---

# Filming the Plume app

Everything on the site that moves was filmed from the real app driven by a
script, not from a mockup and not from a screen recorder. Two worked examples
already exist and you should read whichever is closer to the job before writing
anything new:

- `scripts/film-app.js` — the long hero tour, one film, `site/assets/shots/tour.*`
- `scripts/film-clips.js` — one short clip per documentation section, `site/assets/clips/*`
- `scripts/shoot-app.js` — the same harness taking stills instead of frames

For a new feature clip, the usual answer is to add a function to the `clips`
object in `scripts/film-clips.js` rather than write a new script. Only write a
new script if the film genuinely is not one of the documentation clips.

## How a filming script is built

The script is an Electron main process that sets a few things up and then hands
over to the real app by requiring it at the very bottom:

```js
require('../src/main/main.js');
```

Run it with `npx electron scripts/film-clips.js`. Everything above that line is
preparation; everything the camera sees is the actual app.

The preparation is always the same four things:

1. A throwaway user data directory, so filming never touches a real profile:

   ```js
   const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-clips-data-'));
   app.setPath('userData', tmp);
   ```

2. A `settings.json` written into that directory before the app reads it. This
   is how you control the theme, the palette, the window bounds, the sidebar
   and the vault or git folder — the app has no command line for them, and a
   native folder dialog is the one thing a script cannot drive.

   ```js
   fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
     theme: 'light', palette: 'plume', sidebar: true, sidebarWidth: 250,
     bounds: { x: 40, y: 40, width: w, height: h }, autoUpdate: false,
   }));
   process.argv.push(hub);   // the document to open
   ```

3. A copy of `docs/film-notebook` in a temp directory, so filming never writes
   into the repository. Both existing scripts then generate a few dozen linked
   notes on top of it, because the graph is only worth filming when there is a
   mesh to draw — notes are linked at a stride to two siblings each, so the web
   is woven rather than chained (a chain draws as a ring, which is not what a
   vault looks like).

4. The window shown without stealing focus:

   ```js
   BrowserWindow.prototype.show = function show() {
     this.setOpacity(0);
     this.setSkipTaskbar(true);
     this.showInactive();
   };
   BrowserWindow.prototype.maximize = function maximize() {};
   ```

   Opacity 0 and `showInactive()` mean the film can be recorded while somebody
   is using the machine. `capturePage()` still returns the real rendering.

The app is driven from the main process through `webContents.executeJavaScript`,
wrapped in the three helpers both scripts define: `run(js)` to do something,
`read(expr)` to get a value out, and `until(expr, timeout)` to wait for the app
to be ready rather than guessing with a sleep. Start every film with
`await until('document.body.dataset.ready === "1"')`.

## The ten things that have already gone wrong

### 1. JPEG frames, never PNG

```js
const img = await win.webContents.capturePage();
fs.writeFileSync(path.join(frames, `f${String(++n).padStart(5, '0')}.jpg`), img.toJPEG(92));
```

A PNG of this window takes longer to encode than the frame interval at 15fps.
A recorder that cannot keep up produces a video that stutters where the app does
not — the app looks broken when it is the camera that was. Quality 92 is the
settled figure. Keep the loop self-correcting: measure how long the capture took
and sleep only the remainder.

### 2. Scroll inside the page, eased

Setting `scrollTop` once per frame from the main process gives a series of jumps
a frame apart. Inject an eased `requestAnimationFrame` loop instead and await it:

```js
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
```

The motion is then the browser's own, and the camera samples it.

### 3. Encode with `-pix_fmt yuv420p` and even dimensions

Both are required or Safari and most Android players show a black rectangle.
Produce mp4 and webm, and a poster from the first frame:

```js
ff(['-y', '-framerate', String(FPS), '-i', input, '-c:v', 'libx264', '-preset', 'slow',
  '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', mp4]);
ff(['-y', '-framerate', String(FPS), '-i', input, '-c:v', 'libvpx-vp9', '-crf', '38',
  '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p', webm]);
ff(['-y', '-i', path.join(frames, 'f00001.jpg'), '-q:v', '4', poster]);
```

The hero tour uses crf 27 / 36; the short clips 28 / 38. The poster matters: it
is what a reader sees before the film loads, and all they ever see if they have
asked their system for less motion.

### 4. Setup happens with the camera stopped

Signing up and uploading thirty documents is a minute of a progress line moving.
It is not a tour, and leaving it in is what made the first cut of the hero film
fifty-six seconds long. Stop the recorder, do the setup, start it again:

```js
filming = false;
await recorder;
// ... sign up, sync the notebook, navigate back to the hub ...
filming = true;
recorder = record(win);
```

In `film-clips.js` the whole vault preparation happens once, before the loop,
announced as `preparing a vault (off camera)…`.

Sync documents by clicking through the tree one at a time, as a person would.
Calling the IPC directly moves the document without telling the renderer, and
then every sync sends the same file.

### 5. Open moving

A long still opening is exactly what makes a film look like a screenshot to
somebody who glances at it. Give it a few hundred milliseconds at most before
the first motion — `await sleep(600)` in the hero, `350` before each clip starts
its own action. Likewise do not end on a frozen frame held for seconds.

### 6. Forward slashes in paths

Write Windows paths with forward slashes everywhere in these scripts and in the
commands that launch them. A backslash goes through the shell, then JavaScript
string escaping, then `JSON.stringify` into injected page code, and comes out
mangled. `path.join` output is fine inside Node; the trouble is the literals you
type and anything that crosses into `executeJavaScript`.

### 7. Launching

```bash
npx electron scripts/film-clips.js
PLUME_CLIPS=graph npx electron scripts/film-clips.js   # just one clip
PLUME_FPS=15 PLUME_SIZE=1180x760 npx electron scripts/film-clips.js
```

`PLUME_SIZE` must be even in both dimensions — H.264 wants it, and the `-vf`
scale is a safety net, not a licence. The clips are 1180x760; the hero is
1280x832. Whatever you pick, the `width` and `height` attributes in the HTML
must match it, or the page reflows when the film loads.

### 8. Vault and graph clips need a local vault

They need somewhere to sign up to. Run the in-memory development server from a
checkout of the **plume-vault** repository, on its **master** branch:

```bash
node scripts/dev-server-memory.js          # in the plume-vault checkout
```

```bash
PLUME_VAULT_API=http://127.0.0.1:8098/api npx electron scripts/film-clips.js
```

Do not use the `feat/email-codes` branch — its signup route behaves differently
and the script's sign-up step will hang until it times out. Never point
`PLUME_VAULT_API` at production; the script creates an account and uploads to it.

Without `PLUME_VAULT_API` the vault clips still record, but they show the
signed-out panel, and the hero tour simply ends after the editor — which is
still a tour.

### 9. Where the file goes, and how it is embedded

Clips go in `site/assets/clips/` as `<name>.mp4`, `<name>.webm` and `<name>.jpg`
(the poster). Embed them in `site/docs.html` as a figure, webm first so browsers
that can take it do:

```html
<figure>
  <video class="film" width="1180" height="760" preload="none" muted loop playsinline
         poster="assets/clips/graph.jpg" aria-label="The graph drawing every note in the vault and the links between them">
    <source src="assets/clips/graph.webm" type="video/webm">
    <source src="assets/clips/graph.mp4" type="video/mp4">
  </video>
  <figcaption>The graph: every note, and every link between them.</figcaption>
</figure>
```

Do not write any JavaScript for it. The block under `---------- the hero film ----------`
in `site/assets/site.js` picks up every `video.film` on the page and handles all
of it: nothing loads until an `IntersectionObserver` says the film is on screen,
nothing plays at all for a reader with `prefers-reduced-motion: reduce` (they
keep the poster), and a browser that refuses to autoplay gets `controls` and a
`needs-a-press` class rather than a frame that looks broken. Keep `class="film"`,
`preload="none"`, `muted`, `loop` and `playsinline` exactly as above — the player
depends on them. `aria-label` is required; the film carries information.

The hero film is the same markup inside `.shot-frame.has-film` in
`site/index.html`, pointing at `site/assets/shots/tour.*`.

### 10. Look at the result before committing

The script reporting a duration and a file size is not evidence that the film
shows anything. Pull a frame out and open it:

```bash
ffmpeg -y -ss 3 -i "site/assets/clips/graph.mp4" -frames:v 1 \
  "C:/Users/.../scratchpad/graph-check.jpg"
```

Then read that image. Check it is not black (the `yuv420p` failure), that the
app is in the state the clip is meant to show, that no popover is left open from
a previous clip, and that the palette and theme are the ones you asked for.
Sample more than one timestamp for anything longer than a few seconds. Check the
poster `.jpg` too — it is the first frame and the one most people will see.

## Writing a new clip

Add a function to the `clips` object in `scripts/film-clips.js`. The loop around
it already calls `reset()` before each clip — which puts the theme, palette,
sidebar and scroll position back, and closes any popover or the graph — then
starts the recorder, runs your function, and encodes under that key's name. So
the function only has to perform.

```js
async newThing() {
  await sleep(400);
  await run(`document.getElementById('btn-new-thing').click();`);
  await sleep(1600);
  await run(`document.getElementById('pop-new-thing').hidden = true;`);
  await sleep(500);
},
```

Points worth keeping in mind while writing one:

- Drive the app through the same selectors a person's click would hit, not
  through internal functions, so the clip shows the real behaviour.
- Wait for anything asynchronous with `until(...)`, not a hopeful `sleep`.
  The graph clip waits on `!document.getElementById("graph-view").hidden`
  before it starts posing it.
- Where a thing settles on its own — the graph's force layout — let it, then
  fit it, then let it breathe. Several seconds of a layout relaxing reads well.
- Type into inputs a character at a time with an `input` event dispatched after
  each one. Setting `.value` in one go reads as a paste and shows nothing. See
  the `find` clip.
- Six to twelve seconds is the right length for a documentation clip. The clips
  loop, so the end should sit comfortably next to the beginning.
- Add the new clip name to the `NEEDS_VAULT` set if it does.

Then run just that clip with `PLUME_CLIPS=newThing`, extract a frame, look at
it, and only then add the `<figure>` to `site/docs.html`.
