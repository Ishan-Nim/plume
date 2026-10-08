'use strict';

// Plume — main process.
// One window per document. A second launch (double-clicking another .md in
// Explorer) is routed to this process through the single-instance lock, so
// files open instantly in a new window instead of booting a fresh app.

const {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, clipboard, screen, session,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { spawn, execFile } = require('node:child_process');
const settings = require('./settings');
const files = require('./files');
const vault = require('./vault');
const sync = require('./sync');
const updater = require('./updater');

const APP_ID = 'app.plume.viewer';
const PROG_ID = 'Plume.Markdown';
const ROOT = path.join(__dirname, '..', '..');
const RENDERER_DIR = path.join(ROOT, 'out', 'renderer');
const RENDERER_HTML = path.join(RENDERER_DIR, 'index.html');
const NOTICES = app.isPackaged ? path.join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt')
  : path.join(RENDERER_DIR, 'THIRD_PARTY_NOTICES.txt');
const ICON = path.join(ROOT, 'resources', 'icon.png');
const TITLEBAR_HEIGHT = 40;
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const FILE_MANAGER = isWin ? 'File Explorer' : isMac ? 'Finder' : 'the file manager';
const OPEN_DIALOG = {
  title: 'Open Markdown file',
  properties: ['openFile', 'multiSelections'],
  filters: [
    { name: 'Markdown', extensions: [...files.MD_EXTS, ...files.MD_LIKE_EXTS].map(e => e.slice(1)) },
    { name: 'Text', extensions: ['txt', 'text', 'log'] },
    { name: 'All files', extensions: ['*'] },
  ],
};

// Explorer starts Plume in the folder of the file that was double-clicked,
// and Windows looks in the current folder before PATH for a bare program
// name. Start system tools by full path, and switch that lookup off for
// anything else this process spawns.
const SYSTEM32 = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
if (isWin) process.env.NoDefaultCurrentDirectoryInExePath = '1';

// The packaged app's fuses already refuse --inspect and NODE_OPTIONS. These
// Chromium switches would give the same control over the app (a debugging
// port) or make Plume start any program as a helper process.
const UNSAFE_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'gpu-launcher', 'renderer-cmd-prefix',
  'utility-cmd-prefix', 'zygote-cmd-prefix', 'browser-subprocess-path'];
if (app.isPackaged && UNSAFE_SWITCHES.some(s => app.commandLine.hasSwitch(s))) {
  app.exit(1);
}

// Must match --chrome / --text-2 / --bg in styles.css.
const THEME = {
  light: { chrome: '#f6f6f8', symbol: '#55555f', bg: '#ffffff' },
  dark: { chrome: '#18181b', symbol: '#a4a4ae', bg: '#1e1e22' },
};

/** @type {Map<number, {win: BrowserWindow, filePath: string|null, initialPath: string|null, ready: boolean, crashes: number[], watcher: fs.FSWatcher|null, timer: any, dirTimer: any, poll: any, folderPoll: any, checkFolder: Function|null, stamp: string}>} */
const windows = new Map();
const pendingOpen = [];

if (isWin) app.setAppUserModelId(APP_ID);

// ---------------------------------------------------------------------------
// Single instance

const gotLock = app.requestSingleInstanceLock({ argv: process.argv, cwd: process.cwd() });
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory, extra) => {
    const args = (extra && Array.isArray(extra.argv)) ? extra.argv : argv;
    const cwd = (extra && typeof extra.cwd === 'string') ? extra.cwd : workingDirectory;
    const paths = pathsFromArgv(args, cwd);
    if (paths.length) paths.forEach(openPath);
    else focusOrCreate();
  });

  // macOS delivers files this way; harmless elsewhere.
  app.on('open-file', (event, p) => {
    event.preventDefault();
    if (app.isReady()) openPath(p);
    else pendingOpen.push(p);
  });

  app.whenReady().then(onReady);
  // macOS apps keep running with no windows open (see 'activate' in onReady).
  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
  app.on('before-quit', () => settings.flush());
}

function pathsFromArgv(argv, cwd) {
  const out = [];
  // Packaged: Plume.exe <file>. Development: electron.exe <app entry> <file>.
  for (const arg of (argv || []).slice(app.isPackaged ? 1 : 2)) {
    if (typeof arg !== 'string' || !arg || arg.startsWith('-')) continue;
    let p = arg;
    if (/^file:\/\//i.test(p)) {
      try { p = fileURLToPath(p); } catch { continue; }
    }
    p = path.resolve(cwd || process.cwd(), p);
    try {
      if (fs.statSync(p).isFile()) out.push(p);
    } catch { /* not a file */ }
  }
  return out;
}

function onReady() {
  settings.load();
  nativeTheme.themeSource = settings.get().theme;
  Menu.setApplicationMenu(isMac ? macMenu() : null);
  hardenSession();

  nativeTheme.on('updated', () => {
    for (const ctx of windows.values()) applyChrome(ctx.win);
  });

  const paths = [...pathsFromArgv(process.argv, process.cwd()), ...pendingOpen];
  if (paths.length) paths.forEach(openPath);
  else createWindow(null);

  // The folder picks up where it left off, including anything changed while
  // Plume was closed.
  setTimeout(() => sync.start(), 1500);

  // A quiet look for a newer release, well after the window is usable.
  setTimeout(async () => {
    if (!settings.get().autoUpdate) return;
    const update = await updater.check();
    if (!update) return;
    if (update.version === settings.get().skippedVersion) return;
    for (const win of liveWindows()) win.webContents.send('update:available', update);
  }, 8000);

  // Clicking the Dock icon with no windows open.
  app.on('activate', () => {
    if (!liveWindows().length) createWindow(null);
  });
}

// macOS needs an application menu for Quit, Hide and the clipboard shortcuts,
// and a File menu that still works once every window is closed (the app keeps
// running). Elsewhere the window has no menu bar at all.
function macMenu() {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow(null) },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => openFromMenu() },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    { role: 'windowMenu' },
  ]);
}

// File › Open: in the focused window, as Cmd+O works elsewhere; with no
// window open, ask here and give each file a window.
async function openFromMenu() {
  const win = BrowserWindow.getFocusedWindow();
  const ctx = win && windows.get(win.webContents.id);
  if (ctx && ctx.ready) {
    win.webContents.send('command', 'open');
    return;
  }
  const { canceled, filePaths } = await dialog.showOpenDialog(OPEN_DIALOG);
  if (!canceled) filePaths.forEach(openPath);
}

function hardenSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', event => event.preventDefault());
  // A session has a single onBeforeRequest listener, so every file:// rule
  // lives in allowFileRequest.
  ses.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, callback) => {
    callback({ cancel: !allowFileRequest(details) });
  });
}

// The renderer runs from file://, where CSP 'self' matches every local file
// and every \\server share. So scripts may only come from the app's own
// renderer folder, and other loads (images, media, fonts…) must not reach
// another computer: Windows would sign in to it with the user's credentials.
// A document opened from a share may still load files from that same server.
function allowFileRequest({ url, resourceType, webContentsId }) {
  let p;
  try {
    p = fileURLToPath(url);
  } catch {
    return false;
  }
  if (resourceType === 'script') return files.isWithin(RENDERER_DIR, p);
  if (files.isWithin(ROOT, p)) return true;
  const ctx = windows.get(webContentsId);
  return !files.isForeignUnc(p, ctx && ctx.filePath);
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The renderer is a single page; any navigation away from it is unwanted.
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
});

// ---------------------------------------------------------------------------
// Windows

function isDark() {
  return nativeTheme.shouldUseDarkColors;
}

function palette() {
  return isDark() ? THEME.dark : THEME.light;
}

function applyChrome(win) {
  if (!win || win.isDestroyed()) return;
  const p = palette();
  win.setBackgroundColor(p.bg);
  if (!isMac) {
    try {
      win.setTitleBarOverlay({ color: p.chrome, symbolColor: p.symbol, height: TITLEBAR_HEIGHT });
    } catch { /* overlay not available */ }
  }
}

function liveWindows() {
  return [...windows.values()].map(c => c.win).filter(w => !w.isDestroyed());
}

function visibleOnSomeDisplay(b) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 &&
    b.y < a.y + a.height - 40 && b.y >= a.y - 10);
}

function initialBounds() {
  const ref = BrowserWindow.getFocusedWindow() || liveWindows().pop();
  if (ref) {
    const b = ref.getNormalBounds();
    const next = { x: b.x + 28, y: b.y + 28, width: b.width, height: b.height };
    const area = screen.getDisplayMatching(b).workArea;
    if (next.x + next.width > area.x + area.width || next.y + next.height > area.y + area.height) {
      next.x = area.x + 40;
      next.y = area.y + 40;
    }
    return next;
  }
  const saved = settings.get().bounds;
  if (saved && visibleOnSomeDisplay(saved)) return saved;
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1120, area.width - 80);
  const height = Math.min(840, area.height - 60);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

function createWindow(initialPath) {
  const p = palette();
  const firstWindow = windows.size === 0;
  const win = new BrowserWindow({
    ...initialBounds(),
    minWidth: 440,
    minHeight: 320,
    show: false,
    title: 'Plume',
    icon: ICON,
    backgroundColor: p.bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: isMac ? undefined
      : { color: p.chrome, symbolColor: p.symbol, height: TITLEBAR_HEIGHT },
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      backgroundThrottling: true,
    },
  });

  const ctx = {
    win, filePath: null, initialPath: initialPath || null, ready: false, crashes: [],
    watcher: null, timer: null, dirTimer: null, poll: null, folderPoll: null, checkFolder: null, stamp: '',
  };
  const id = win.webContents.id;
  windows.set(id, ctx);

  win.once('ready-to-show', () => {
    if (firstWindow && settings.get().maximized) win.maximize();
    win.show();
  });
  win.on('close', () => {
    settings.update({ bounds: win.getNormalBounds(), maximized: win.isMaximized() });
  });
  win.on('closed', () => {
    stopWatching(ctx);
    windows.delete(id);
  });
  win.on('focus', () => {
    if (ctx.checkFolder) ctx.checkFolder();
  });
  win.webContents.on('context-menu', (_e, params) => showContextMenu(win, params));
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) recoverFromCrash(ctx);
  });

  win.loadFile(RENDERER_HTML);
  return win;
}

// Reloading restores the open document (app:init hands it back). A document
// that crashes the renderer again within 30 s is dropped rather than
// reloaded in a loop, and a window that keeps crashing is left alone.
function recoverFromCrash(ctx) {
  const now = Date.now();
  ctx.crashes = ctx.crashes.filter(t => now - t < 30_000).concat(now);
  if (ctx.crashes.length > 3) return;
  const culprit = ctx.crashes.length > 1 ? ctx.filePath : null;
  if (culprit) {
    stopWatching(ctx);
    ctx.filePath = null;
    ctx.initialPath = null;
  }
  ctx.ready = false;
  ctx.win.reload();
  if (culprit) {
    dialog.showMessageBox(ctx.win, {
      type: 'error',
      buttons: ['OK'],
      title: 'Plume',
      message: `“${path.basename(culprit)}” keeps crashing the viewer, so Plume closed it.`,
      noLink: true,
    }).catch(() => {});
  }
}

function focusWindow(win) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function focusOrCreate() {
  const win = liveWindows()[0];
  if (win) focusWindow(win);
  else createWindow(null);
}

// Open a file: focus it if already open, reuse an empty window, or make a new one.
function openPath(p) {
  if (!app.isReady()) {
    pendingOpen.push(p);
    return;
  }
  for (const ctx of windows.values()) {
    if (ctx.win.isDestroyed()) continue;
    const shown = ctx.filePath || ctx.initialPath;
    if (shown && files.samePath(shown, p)) {
      focusWindow(ctx.win);
      return;
    }
  }
  for (const ctx of windows.values()) {
    if (ctx.win.isDestroyed() || ctx.filePath || ctx.initialPath || !ctx.ready) continue;
    ctx.initialPath = p;
    ctx.win.webContents.send('open-path', p);
    focusWindow(ctx.win);
    return;
  }
  createWindow(p);
}

function showContextMenu(win, params) {
  const items = [];
  const hasSelection = params.selectionText && params.selectionText.trim();
  if (params.isEditable) {
    items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
  } else {
    if (hasSelection) items.push({ role: 'copy' });
    const link = params.linkURL;
    if (link && !/#$/.test(link) && /^(https?|mailto|file):/i.test(link)) {
      items.push({
        label: 'Copy link address',
        click: () => {
          let text = link;
          if (/^file:/i.test(link)) {
            try { text = fileURLToPath(link.replace(/#.*$/, '')); } catch { /* keep URL */ }
          }
          clipboard.writeText(text);
        },
      });
    }
    if (params.mediaType === 'image') {
      items.push({ label: 'Copy image', click: () => win.webContents.copyImageAt(params.x, params.y) });
    }
    if (items.length) items.push({ type: 'separator' });
    items.push(
      { label: 'Back', accelerator: 'Alt+Left', click: () => win.webContents.send('command', 'back') },
      { label: 'Forward', accelerator: 'Alt+Right', click: () => win.webContents.send('command', 'forward') },
      { type: 'separator' },
      { role: 'selectAll' },
    );
  }
  Menu.buildFromTemplate(items).popup({ window: win });
}

// ---------------------------------------------------------------------------
// Live reload: watch the document's folder (robust against editors that save
// by writing a temp file and renaming it over the original).

function stopWatching(ctx) {
  clearTimeout(ctx.timer);
  clearTimeout(ctx.dirTimer);
  clearInterval(ctx.poll);
  clearInterval(ctx.folderPoll);
  ctx.timer = ctx.dirTimer = ctx.poll = ctx.folderPoll = ctx.checkFolder = null;
  if (ctx.watcher) {
    try { ctx.watcher.close(); } catch { /* ignore */ }
  }
  ctx.watcher = null;
}

function startWatching(ctx, filePath, stamp) {
  stopWatching(ctx);
  ctx.stamp = stamp;
  const dir = path.dirname(filePath);
  const base = path.basename(filePath).toLowerCase();
  try {
    const watcher = fs.watch(dir, { persistent: false }, (_type, name) => {
      // When the folder itself is deleted, Windows reports the folder's own
      // path in a tight loop, and the open watch keeps the folder from being
      // created again until it is closed.
      if (!name || path.isAbsolute(name) || name === path.basename(dir)) {
        if (!fs.existsSync(dir)) {
          folderGone(ctx, filePath);
          return;
        }
      }
      if (!ctx.dirTimer) {
        ctx.dirTimer = setTimeout(() => {
          ctx.dirTimer = null;
          if (!ctx.win.isDestroyed()) ctx.win.webContents.send('dir:changed', dir);
        }, 250);
      }
      if (name && name.toLowerCase() !== base) return;
      clearTimeout(ctx.timer);
      ctx.timer = setTimeout(() => refresh(ctx, filePath), 140);
    });
    ctx.watcher = watcher;
    watcher.on('error', () => folderGone(ctx, filePath));
    watchFolderPlace(ctx, watcher, filePath);
  } catch {
    ctx.watcher = null;
  }
}

// Moving the folder away (Explorer's Delete moves it to the Recycle Bin)
// fires no watch event, and the watch follows the folder to its new place.
// So check now and then, and whenever the window is focused, that the same
// folder is still where the document was.
function watchFolderPlace(ctx, watcher, filePath) {
  const dir = path.dirname(filePath);
  let ino = null;
  ctx.checkFolder = () => fs.stat(dir, (err, st) => {
    if (ctx.watcher !== watcher) return;
    if (err ? err.code === 'ENOENT' || err.code === 'ENOTDIR' : !st.isDirectory()) {
      folderGone(ctx, filePath);
    } else if (st && st.ino) {
      if (ino === null) {
        ino = st.ino;
      } else if (st.ino !== ino) {
        // A new folder of the same name: watch that one instead.
        startWatching(ctx, filePath, ctx.stamp);
        refresh(ctx, filePath);
      }
    }
  });
  ctx.checkFolder();
  ctx.folderPoll = setInterval(ctx.checkFolder, 3000);
}

// The document's folder vanished or can no longer be watched: report the
// document as missing, then check now and then, without holding the folder
// open, and resume live reload once the file is back.
function folderGone(ctx, filePath) {
  stopWatching(ctx);
  refresh(ctx, filePath);
  ctx.poll = setInterval(() => {
    if (ctx.win.isDestroyed()) {
      stopWatching(ctx);
      return;
    }
    if (!fs.existsSync(filePath)) return;
    startWatching(ctx, filePath, ctx.stamp);
    refresh(ctx, filePath);
  }, 2000);
}

async function refresh(ctx, filePath) {
  if (ctx.win.isDestroyed() || !ctx.filePath || !files.samePath(ctx.filePath, filePath)) return;
  try {
    const doc = await files.readDocument(filePath);
    const stamp = `${doc.mtimeMs}:${doc.size}`;
    if (stamp === ctx.stamp) return;
    ctx.stamp = stamp;
    if (!ctx.win.isDestroyed()) ctx.win.webContents.send('doc:changed', { path: doc.path, content: doc.content });
  } catch (err) {
    if (err && err.code === 'ENOENT' && !ctx.win.isDestroyed()) {
      ctx.stamp = '';
      ctx.win.webContents.send('doc:missing', { path: filePath });
    }
  }
}

// ---------------------------------------------------------------------------
// IPC

function ctxFor(event) {
  return windows.get(event.sender.id) || null;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const ctx = ctxFor(event);
    if (!ctx) throw new Error('Unknown window');
    return fn(ctx, ...args);
  });
}

/**
 * A path the renderer chose. Reaching a \server path makes Windows sign in to
 * it with the user's credentials, so one is only ever followed when it stays
 * on this machine. Attaching the check to the argument type means a new
 * handler cannot forget it.
 */
function localPath(ctx, p, max = 4096) {
  const abs = path.resolve(str(p, max));
  if (files.isForeignUnc(abs, ctx ? ctx.filePath : null)) {
    throw new Error('That path is on another computer.');
  }
  return abs;
}

function str(v, max = 32768) {
  if (typeof v !== 'string' || !v || v.length > max) throw new Error('Invalid argument');
  return v;
}

function dirUrl(dir) {
  const href = pathToFileURL(dir).href;
  return href.endsWith('/') ? href : `${href}/`;
}

function friendlyError(err) {
  if (!err) return 'Unknown error';
  switch (err.code) {
    case 'ENOENT': return 'The file no longer exists.';
    case 'EACCES':
    case 'EPERM': return 'Permission denied.';
    case 'EBUSY': return 'The file is open in another app. Close it and try again.';
    case 'EISDIR':
    case 'ENOTFILE': return 'That is a folder, not a file.';
    case 'ETOOBIG': return err.message;
    default: return err.message || String(err);
  }
}

function broadcastSettings() {
  const view = settings.publicView();
  for (const win of liveWindows()) win.webContents.send('settings:changed', view);
}

handle('app:init', ctx => {
  ctx.ready = true;
  return {
    // After a renderer crash the reloaded page asks again and gets back the
    // document it was showing.
    initialPath: ctx.initialPath || ctx.filePath,
    settings: settings.publicView(),
    version: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
  };
});

handle('doc:load', async (ctx, p) => {
  const requested = localPath(ctx, p);
  try {
    const doc = await files.readDocument(requested);
    ctx.filePath = doc.path;
    ctx.initialPath = null;
    startWatching(ctx, doc.path, `${doc.mtimeMs}:${doc.size}`);
    settings.addRecent(doc.path);
    if (isWin || isMac) app.addRecentDocument(doc.path);
    const dir = path.dirname(doc.path);
    const vaultRoot = await files.findVaultRoot(dir);
    broadcastSettings();
    return {
      path: doc.path,
      name: path.basename(doc.path),
      dir,
      dirUrl: dirUrl(dir),
      content: doc.content,
      vaultRoot,
      vaultName: vaultRoot ? path.basename(vaultRoot) : null,
      sep: path.sep,
    };
  } catch (err) {
    if (ctx.initialPath && files.samePath(ctx.initialPath, requested)) ctx.initialPath = null;
    if (err && err.code === 'ENOENT') {
      settings.removeRecent(requested);
      broadcastSettings();
    }
    return { error: friendlyError(err), path: requested };
  }
});

// Read another note for ![[transclusion]]. Markdown files only.
/**
 * Writes the open document back to disk.
 *
 * The path is never taken from the renderer: it is whatever this window
 * already has open, so a document can only ever overwrite itself. The write is
 * atomic, and the watcher's stamp is updated afterwards so Plume does not
 * treat its own save as somebody else changing the file and reload over the
 * editor.
 */
handle('doc:save', async (ctx, requested, content) => {
  if (!ctx.filePath) throw new Error('No document is open.');
  if (typeof content !== 'string') throw new Error('Invalid content');
  if (content.length > 20 * 1024 * 1024) throw new Error('That document is too large to save.');

  const target = localPath(ctx, requested);

  // The editor says which document it is editing, and this window says which
  // one it is showing. If they disagree the reader navigated away mid-edit,
  // and this text belongs to a document that is no longer open — writing it
  // here would replace an unrelated file with content meant for another.
  if (!files.samePath(target, ctx.filePath)) {
    return { error: 'That document is no longer open in this window.' };
  }
  if (!files.isSavable(target)) {
    return { error: 'Plume saves Markdown and text documents.' };
  }
  const tmp = `${target}.${process.pid}.plume-tmp`;

  try {
    await fs.promises.writeFile(tmp, content, 'utf8');
    await fs.promises.rename(tmp, target);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    return { error: friendlyError(err) };
  }

  try {
    const stat = await fs.promises.stat(target);
    ctx.stamp = `${stat.mtimeMs}:${stat.size}`;
    return { path: target, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (err) {
    return { path: target };
  }
});

handle('doc:read', async (ctx, p) => {
  const abs = path.resolve(str(p));
  if (!files.isMarkdown(abs)) return { error: 'Not a Markdown file' };
  if (files.isForeignUnc(abs, ctx.filePath)) return { error: 'The note is on another computer' };
  try {
    const doc = await files.readDocument(abs);
    return { path: doc.path, content: doc.content, dirUrl: dirUrl(path.dirname(doc.path)) };
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

// Classify a link the user clicked. The renderer passes the absolute URL the
// browser resolved against the document's folder.
handle('link:resolve', async (ctx, href) => {
  let url;
  try {
    url = new URL(str(href));
  } catch {
    return { kind: 'invalid' };
  }
  if (url.protocol !== 'file:') return { kind: 'external' };
  let hash = '';
  try { hash = decodeURIComponent(url.hash.replace(/^#/, '')); } catch { hash = url.hash.slice(1); }
  url.hash = '';
  url.search = '';
  let p;
  try {
    p = fileURLToPath(url);
  } catch {
    return { kind: 'invalid' };
  }
  // Even a stat of \\server\… signs in to that server.
  if (files.isForeignUnc(p, ctx.filePath)) return { kind: 'blocked', path: p };
  const tryStat = async q => {
    try { return await fs.promises.stat(q); } catch { return null; }
  };
  let st = await tryStat(p);
  if (!st && !path.extname(p)) {
    const withExt = `${p}.md`;
    st = await tryStat(withExt);
    if (st) p = withExt;
  }
  if (!st) return { kind: 'missing', path: p };
  if (st.isDirectory()) return { kind: 'dir', path: p };
  if (files.isMarkdown(p)) return { kind: 'md', path: p, hash };
  return { kind: 'file', path: p };
});

function refuseLink(ctx, detail) {
  return dialog.showMessageBox(ctx.win, {
    type: 'warning',
    buttons: ['OK'],
    title: 'Plume',
    message: 'Plume will not open this link.',
    detail,
    noLink: true,
  });
}

// Non-Markdown local file linked from a document: ask before handing it to the OS.
handle('link:openFile', async (ctx, p) => {
  const abs = path.resolve(str(p));
  const name = path.basename(abs);
  const remote = `“${abs}” is on another computer. Windows would sign in to it with your account.`;
  if (files.isForeignUnc(abs, ctx.filePath)) {
    await refuseLink(ctx, remote);
    return true;
  }
  if (files.isAmbiguousWindowsName(abs)) {
    await refuseLink(ctx, `“${name}” is not a plain file name (it uses a stream suffix or trailing dot), a trick used to disguise programs.`);
    return true;
  }
  // Judge what the link really leads to: a symlink called "guide.pdf" or
  // "docs" can point at a program or an app bundle. (The JS realpath keeps a
  // mapped drive letter rather than turning it into \\server.)
  let real;
  let isDirectory;
  try {
    real = fs.realpathSync(abs);
    isDirectory = fs.statSync(real).isDirectory();
  } catch {
    return false;
  }
  if (files.isForeignUnc(real, ctx.filePath)) {
    await refuseLink(ctx, remote);
    return true;
  }
  if (isDirectory && files.isPlainFolder(real)) {
    await shell.openPath(real);
    return true;
  }
  if (isDirectory || !files.isOpenableFromLink(abs) || !files.isOpenableFromLink(real)) {
    const { response } = await dialog.showMessageBox(ctx.win, {
      type: 'warning',
      buttons: ['Show in folder', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Plume',
      message: `Plume does not open “${name}” from a link.`,
      detail: 'Only documents, images, media and plain folders open directly; programs, apps, scripts and other ' +
        `files are never launched from a document. You can reveal it in ${FILE_MANAGER} instead.`,
      noLink: true,
    });
    if (response === 0) shell.showItemInFolder(abs);
    return true;
  }
  const { response } = await dialog.showMessageBox(ctx.win, {
    type: 'question',
    buttons: ['Open', 'Show in folder', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Plume',
    message: `Open “${name}”?`,
    detail: 'It will open in its default app.',
    noLink: true,
  });
  if (response === 0) await shell.openPath(real);
  else if (response === 1) shell.showItemInFolder(abs);
  return true;
});

handle('link:external', async (_ctx, href) => {
  const url = str(href);
  if (!/^(https?:\/\/|mailto:)/i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});

handle('wiki:resolve', async (ctx, fromFile, targets) => {
  const from = path.resolve(str(fromFile));
  if (!Array.isArray(targets)) throw new Error('Invalid argument');
  const out = {};
  // `fromFile` can come from markup in the document, so it gets the same
  // network-path check as links.
  if (files.isForeignUnc(from, ctx.filePath)) return out;
  for (const t of targets.slice(0, 2000)) {
    if (typeof t !== 'string' || t.length > 1024) continue;
    try {
      const hit = await files.resolveWiki(from, t);
      out[t] = hit && !files.isForeignUnc(hit.path, ctx.filePath)
        ? { ...hit, url: pathToFileURL(hit.path).href } : null;
    } catch {
      out[t] = null;
    }
  }
  return out;
});

handle('dir:list', async (ctx, dir) => {
  localPath(ctx, dir);
  try {
    return await files.listDir(str(dir));
  } catch (err) {
    return { error: friendlyError(err), dir };
  }
});

handle('settings:set', (_ctx, patch) => {
  const applied = settings.update(patch, { fromRenderer: true });
  if ('theme' in applied) nativeTheme.themeSource = applied.theme;
  broadcastSettings();
  return settings.publicView();
});

handle('recent:remove', (_ctx, p) => {
  settings.removeRecent(str(p));
  broadcastSettings();
  return settings.publicView();
});

// Returns the file to show in this window. Any others the user picked open in
// windows of their own here, whatever their type: the user chose them. This
// window is marked as taken first, so openPath does not hand one of them to it.
handle('app:openDialog', async ctx => {
  const { canceled, filePaths } = await dialog.showOpenDialog(ctx.win, OPEN_DIALOG);
  if (canceled || !filePaths.length) return [];
  if (!ctx.filePath) ctx.initialPath = filePaths[0];
  filePaths.slice(1, 20).forEach(openPath);
  return filePaths.slice(0, 1);
});

// Extra windows for dropped files and Ctrl+clicked links: documents only, so
// a dropped image or PDF never opens a window of binary noise (doc:load also
// refuses binary content behind a text-like name).
handle('app:openPaths', (_ctx, paths) => {
  if (!Array.isArray(paths)) return false;
  paths.filter(p => typeof p === 'string' && p && files.isViewable(p))
    .slice(0, 20).forEach(p => openPath(path.resolve(p)));
  return true;
});

handle('app:newWindow', () => {
  createWindow(null);
  return true;
});

handle('app:about', async ctx => {
  const hasNotices = fs.existsSync(NOTICES);
  const { response } = await dialog.showMessageBox(ctx.win, {
    type: 'none',
    icon: ICON,
    title: 'About Plume',
    message: 'Plume',
    detail: `Version ${app.getVersion()}\nA feather-light Markdown viewer.\n\n` +
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    buttons: hasNotices ? ['OK', 'Third-party notices'] : ['OK'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response === 1) await shell.openPath(NOTICES);
  return true;
});

handle('app:defaultStatus', async () => {
  if (!isWin || !app.isPackaged) return { supported: false };
  const progId = await currentMdProgId();
  return { supported: true, isDefault: isPlumeProgId(progId), progId };
});

handle('app:openDefaultApps', async () => {
  if (!isWin) return false;
  // A per-machine install registers under HKLM, a per-user one under HKCU;
  // Settings needs to be told which registration to open.
  const perMachine = /\\Program Files( \(x86\))?\\/i.test(process.execPath);
  await shell.openExternal(`ms-settings:defaultapps?${perMachine ? 'registeredAppMachine' : 'registeredAppUser'}=Plume`);
  return true;
});

handle('win:close', ctx => {
  ctx.win.close();
  return true;
});

handle('win:fullscreen', ctx => {
  ctx.win.setFullScreen(!ctx.win.isFullScreen());
  return ctx.win.isFullScreen();
});

handle('win:devtools', ctx => {
  ctx.win.webContents.toggleDevTools();
  return true;
});

handle('clipboard:write', (_ctx, text) => {
  if (typeof text !== 'string') return false;
  clipboard.writeText(text);
  return true;
});

handle('shell:showInFolder', (_ctx, p) => {
  shell.showItemInFolder(path.resolve(str(p)));
  return true;
});

handle('shell:openInEditor', async (_ctx, p) => {
  const abs = path.resolve(str(p));
  const editor = findEditor();
  if (editor) {
    launchDetached(editor.cmd, [...editor.args, abs]);
    return editor.name;
  }
  // No known editor: show the folder. Handing the .md itself to xdg-open
  // could route it straight back to Plume.
  await shell.openPath(path.dirname(abs));
  return 'your file manager';
});

handle('shell:openWith', (_ctx, p) => {
  const abs = path.resolve(str(p));
  if (!isWin) return false;
  // OpenAs_RunDLL takes the raw remainder of the command line as the path.
  launchDetached(path.join(SYSTEM32, 'rundll32.exe'), [`shell32.dll,OpenAs_RunDLL ${abs}`],
    { windowsVerbatimArguments: true });
  return true;
});

handle('shell:openInObsidian', async (_ctx, p) => {
  const abs = path.resolve(str(p));
  if (!(await files.findVaultRoot(path.dirname(abs)))) return false;
  await shell.openExternal(`obsidian://open?path=${encodeURIComponent(abs)}`);
  return true;
});

// Paper is white in every theme, but Chromium paints the page margins with
// the window's background colour, which follows the dark theme.
async function onPaper(ctx, print) {
  ctx.win.setBackgroundColor('#ffffff');
  try {
    return await print();
  } finally {
    applyChrome(ctx.win);
  }
}

handle('doc:print', ctx => onPaper(ctx, () => new Promise(resolve => {
  ctx.win.webContents.print({ printBackground: true }, ok => resolve(ok));
})));

handle('doc:exportPdf', async ctx => {
  const base = ctx.filePath ? path.basename(ctx.filePath).replace(/\.[^.]+$/, '') : 'document';
  const defaultDir = ctx.filePath ? path.dirname(ctx.filePath) : app.getPath('documents');
  const { canceled, filePath } = await dialog.showSaveDialog(ctx.win, {
    title: 'Export as PDF',
    defaultPath: path.join(defaultDir, `${base}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  try {
    const data = await onPaper(ctx, () => ctx.win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
      generateDocumentOutline: true,
    }));
    await fs.promises.writeFile(filePath, data);
    return filePath;
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

// ---------------------------------------------------------------------------
// Plume Vault
//
// The renderer never sees the account token: it asks for an action here and
// gets back a plain result. Errors are passed on as messages the user can act
// on rather than as stack traces.

function vaultResult(fn) {
  return async (...args) => {
    try {
      return { ok: true, ...(await fn(...args)) };
    } catch (err) {
      return {
        ok: false,
        error: err && err.message ? err.message : 'The vault is not available.',
        status: err && err.status,
        conflict: err && err.conflict,
        usage: err && err.usage,
      };
    }
  };
}

function broadcastVault() {
  const state = vault.publicState();
  for (const win of liveWindows()) win.webContents.send('vault:changed', state);
  // Signing in or out starts or stops the folder sync.
  sync.refresh();
}

sync.onChange(state => {
  for (const win of liveWindows()) win.webContents.send('sync:changed', state);
});

handle('sync:state', () => sync.publicState());

// ---------------------------------------------------------------------------
// Updates. Nothing is downloaded or installed without being asked for.

handle('update:state', () => updater.state());

handle('update:check', vaultResult(async (_ctx, force) => {
  const update = await updater.check({ force: Boolean(force) });
  return { update, state: updater.state() };
}));

handle('update:download', vaultResult(async ctx => {
  const result = await updater.download(progress => {
    if (!ctx.win.isDestroyed()) ctx.win.webContents.send('update:progress', progress);
  });
  for (const win of liveWindows()) win.webContents.send('update:ready', updater.state());
  return result;
}));

handle('update:install', vaultResult(async () => {
  await updater.install();
  return { installing: true };
}));

handle('update:page', vaultResult(async () => {
  await updater.openReleasePage();
  return { opened: true };
}));

handle('update:skip', vaultResult(async (_ctx, version) => {
  settings.update({ skippedVersion: typeof version === 'string' ? version : null });
  broadcastSettings();
  return { skipped: version };
}));

handle('sync:choose', vaultResult(async ctx => {
  const { canceled, filePaths } = await dialog.showOpenDialog(ctx.win, {
    title: 'Choose the folder to keep in your vault',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Sync this folder',
  });
  if (canceled || !filePaths.length) return { canceled: true };

  const folder = filePaths[0];
  const look = await sync.preview(folder);
  settings.update({ vaultFolder: folder, syncPaused: false });
  broadcastSettings();
  sync.refresh();
  return { folder, preview: look, state: sync.publicState() };
}));

handle('sync:forget', vaultResult(async () => {
  settings.update({ vaultFolder: null, syncPaused: false });
  broadcastSettings();
  sync.stop();
  // Nothing is deleted anywhere: the folder stays on disk and the documents
  // already in the vault stay in the vault.
  return { state: sync.publicState() };
}));

handle('sync:pause', vaultResult(async (_ctx, paused) => {
  settings.update({ syncPaused: Boolean(paused) });
  broadcastSettings();
  sync.refresh();
  return { state: sync.publicState() };
}));

handle('sync:now', vaultResult(async () => {
  await sync.syncNow();
  return { state: sync.publicState() };
}));

handle('sync:reveal', vaultResult(async () => {
  const folder = settings.get().vaultFolder;
  if (!folder) throw new Error('No folder is being synced yet.');
  shell.openPath(folder);
  return { folder };
}));

handle('vault:state', (ctx, rootDir) => ({
  ...vault.publicState(),
  link: vault.linkFor(ctx.filePath),
  syncable: vault.isSyncable(ctx.filePath),
  // Named relative to the folder on screen, so a notebook keeps its shape in
  // the vault instead of collapsing into one flat list.
  suggested: ctx.filePath
    ? vault.suggestVaultPath(ctx.filePath, typeof rootDir === 'string' ? rootDir : null)
    : null,
}));

handle('vault:suggest', vaultResult(async (_ctx, paths, rootDir) => {
  const list = Array.isArray(paths) ? paths.slice(0, 2000) : [];
  const root = typeof rootDir === 'string' ? rootDir : null;
  const items = list
    .filter(p => typeof p === 'string' && vault.isSyncable(p))
    .map(p => ({ localPath: path.resolve(p), vaultPath: vault.suggestVaultPath(path.resolve(p), root) }));
  return { items, skipped: list.length - items.length };
}));

handle('vault:collectFolder', vaultResult(async (ctx, dir, rootDir) => {
  const target = localPath(ctx, dir);
  // Only somewhere the user actually chose: the folder they sync, or the one
  // the open document lives in. Otherwise this walks the whole disk and
  // doubles as a list of every document on the machine.
  const allowed = settings.get().vaultFolder || (ctx.filePath && path.dirname(ctx.filePath));
  if (!allowed || !files.isWithin(allowed, target)) {
    throw new Error('That folder is not one Plume is syncing.');
  }
  const root = typeof rootDir === 'string' ? path.resolve(rootDir) : path.dirname(target);
  const items = await vault.collectFolder(target, root);
  return { items };
}));

handle('vault:pushMany', vaultResult(async (ctx, items, options) => {
  const clean = (Array.isArray(items) ? items : [])
    .filter(i => i && typeof i.localPath === 'string' && typeof i.vaultPath === 'string')
    .slice(0, 2000)
    // cleanVaultPath throws on anything that could step outside the account's
    // own namespace, so a name typed into the panel cannot reach another vault.
    .map(i => ({ localPath: localPath(ctx, i.localPath), vaultPath: vault.cleanVaultPath(i.vaultPath) }));

  if (!clean.length) throw new Error('Nothing to sync.');

  const result = await vault.pushMany(clean, {
    force: Boolean(options && options.force),
    onProgress: progress => {
      if (!ctx.win.isDestroyed()) ctx.win.webContents.send('vault:progress', progress);
    },
  });
  broadcastVault();
  return result;
}));

// Creating an account is two calls: one asks for a code by email, the other
// spends it. Only the second one signs anybody in.
handle('vault:signUpStart', vaultResult(async (_ctx, email, password) => (
  vault.signUpStart(str(email, 320), str(password, 400))
)));

handle('vault:signUpVerify', vaultResult(async (_ctx, email, code) => {
  const state = await vault.signUpVerify(str(email, 320), str(code, 32));
  broadcastVault();
  return { state };
}));

handle('vault:forgot', vaultResult(async (_ctx, email) => vault.forgot(str(email, 320))));

handle('vault:resetWithCode', vaultResult(async (_ctx, email, code, password) => {
  const { state, note } = await vault.resetWithCode(str(email, 320), str(code, 32), str(password, 400));
  broadcastVault();
  return { state, note };
}));

handle('vault:signIn', vaultResult(async (_ctx, email, password) => {
  const state = await vault.signIn(str(email, 320), str(password, 400));
  broadcastVault();
  return { state };
}));

handle('vault:signOut', vaultResult(async () => {
  const state = vault.signOut();
  broadcastVault();
  return { state };
}));

handle('vault:list', vaultResult(async () => vault.list()));

handle('vault:graph', vaultResult(async () => vault.graph()));

handle('vault:push', vaultResult(async (ctx, vaultPath, options) => {
  if (!ctx.filePath) throw new Error('Open a document first.');
  const result = await vault.push(ctx.filePath, vaultPath ? str(vaultPath, 400) : null, {
    force: Boolean(options && options.force),
  });
  broadcastVault();
  return result;
}));

handle('vault:pull', vaultResult(async (ctx, vaultPath) => {
  const name = str(vaultPath, 400);
  const defaultDir = ctx.filePath ? path.dirname(ctx.filePath) : app.getPath('documents');
  const { canceled, filePath } = await dialog.showSaveDialog(ctx.win, {
    title: 'Save from Plume Vault',
    defaultPath: path.join(defaultDir, path.basename(name)),
  });
  if (canceled || !filePath) return { canceled: true };
  const result = await vault.pull(name, filePath);
  openPath(result.localPath);
  return result;
}));

handle('vault:keepBoth', vaultResult(async (ctx, vaultPath) => {
  if (!ctx.filePath) throw new Error('Open a document first.');
  const copy = await vault.saveConflictCopy(ctx.filePath, str(vaultPath, 400));
  return { copy };
}));

handle('vault:remove', vaultResult(async (_ctx, vaultPath) => {
  const result = await vault.remove(str(vaultPath, 400));
  broadcastVault();
  return result;
}));

handle('vault:unlink', vaultResult(async ctx => {
  if (!ctx.filePath) throw new Error('Open a document first.');
  return vault.unlink(ctx.filePath);
}));

// ---------------------------------------------------------------------------
// Helpers

const LINUX_EDITORS = [['code', 'VS Code'], ['codium', 'VSCodium'], ['gnome-text-editor', 'Text Editor'],
  ['gedit', 'gedit'], ['kate', 'Kate'], ['mousepad', 'Mousepad']];

// The editor Ctrl+E opens a document in, as { cmd, args, name }, or null.
function findEditor() {
  if (isWin) {
    const local = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const exe = [
      path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(programFiles, 'Microsoft VS Code', 'Code.exe'),
      path.join(local, 'Programs', 'cursor', 'Cursor.exe'),
    ].find(c => path.isAbsolute(c) && fs.existsSync(c));
    return exe ? { cmd: exe, args: [], name: path.basename(exe, '.exe') }
      : { cmd: path.join(SYSTEM32, 'notepad.exe'), args: [], name: 'Notepad' };
  }
  if (isMac) {
    const dirs = ['/Applications', path.join(app.getPath('home'), 'Applications')];
    const bundle = ['Visual Studio Code.app', 'Cursor.app']
      .flatMap(name => dirs.map(dir => path.join(dir, name)))
      .find(p => fs.existsSync(p));
    return bundle ? { cmd: '/usr/bin/open', args: ['-a', bundle], name: path.basename(bundle, '.app') }
      : { cmd: '/usr/bin/open', args: ['-t'], name: 'your text editor' };
  }
  for (const [bin, name] of LINUX_EDITORS) {
    const cmd = findOnPath(bin);
    if (cmd) return { cmd, args: [], name };
  }
  return null;
}

// Absolute PATH entries only: a relative one would search the current
// folder, which is wherever the document lives.
function findOnPath(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return null;
}

function launchDetached(cmd, args, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS' || key === 'NoDefaultCurrentDirectoryInExePath') {
      delete env[key];
    }
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env, ...extra });
    child.on('error', () => {});
    child.unref();
  } catch { /* ignore */ }
}

function regQuery(key, value) {
  return new Promise(resolve => {
    const args = value ? ['query', key, '/v', value] : ['query', key, '/ve'];
    execFile(path.join(SYSTEM32, 'reg.exe'), args, { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /REG_SZ\s+(.+?)\s*$/m.exec(stdout || '');
      // An unset default prints a localised "(value not set)".
      resolve(m && !m[1].startsWith('(') ? m[1].trim() : null);
    });
  });
}

async function currentMdProgId() {
  const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md';
  // Windows 11 keeps the user's choice in UserChoiceLatest\ProgId, older
  // builds in UserChoice; the Classes default applies only without either.
  return (await regQuery(`${base}\\UserChoiceLatest\\ProgId`, 'ProgId')) ||
    (await regQuery(`${base}\\UserChoice`, 'ProgId')) ||
    (await regQuery('HKCU\\Software\\Classes\\.md', null)) ||
    (await regQuery('HKCR\\.md', null));
}

function isPlumeProgId(progId) {
  if (!progId) return false;
  return progId === PROG_ID || /^Applications\\Plume\.exe$/i.test(progId);
}
