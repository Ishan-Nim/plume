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

const APP_ID = 'app.plume.viewer';
const PROG_ID = 'Plume.Markdown';
const ROOT = path.join(__dirname, '..', '..');
const RENDERER_HTML = path.join(ROOT, 'out', 'renderer', 'index.html');
const ICON = path.join(ROOT, 'resources', 'icon.png');
const TITLEBAR_HEIGHT = 40;

// Must match --chrome / --text-2 / --bg in styles.css.
const THEME = {
  light: { chrome: '#f6f6f8', symbol: '#55555f', bg: '#ffffff' },
  dark: { chrome: '#18181b', symbol: '#a4a4ae', bg: '#1e1e22' },
};

// Extensions we never hand to the OS from a link inside a document.
const DANGEROUS_EXTS = new Set(['.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.scr', '.pif', '.lnk', '.hta', '.cpl', '.jar',
  '.reg', '.inf', '.application', '.appref-ms', '.url', '.dll', '.sys', '.gadget', '.msc', '.scf',
  '.settingcontent-ms', '.library-ms', '.appx', '.msix', '.appinstaller', '.sh', '.py', '.pyw']);

/** @type {Map<number, {win: BrowserWindow, filePath: string|null, initialPath: string|null, watcher: fs.FSWatcher|null, timer: any, stamp: string}>} */
const windows = new Map();
const pendingOpen = [];

app.setAppUserModelId(APP_ID);

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
  app.on('window-all-closed', () => app.quit());
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
  Menu.setApplicationMenu(null);
  hardenSession();

  nativeTheme.on('updated', () => {
    for (const ctx of windows.values()) applyChrome(ctx.win);
  });

  const paths = [...pathsFromArgv(process.argv, process.cwd()), ...pendingOpen];
  if (paths.length) paths.forEach(openPath);
  else createWindow(null);
}

function hardenSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', event => event.preventDefault());
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
  if (process.platform !== 'darwin') {
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
    titleBarOverlay: process.platform === 'darwin' ? undefined
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

  const ctx = { win, filePath: null, initialPath: initialPath || null, watcher: null, timer: null, stamp: '' };
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
  win.webContents.on('context-menu', (_e, params) => showContextMenu(win, params));
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) win.reload();
  });

  win.loadFile(RENDERER_HTML);
  return win;
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
    ctx.watcher = fs.watch(dir, { persistent: false }, (_type, name) => {
      if (!ctx.win.isDestroyed()) ctx.win.webContents.send('dir:changed', dir);
      if (name && name.toLowerCase() !== base) return;
      clearTimeout(ctx.timer);
      ctx.timer = setTimeout(() => refresh(ctx, filePath), 140);
    });
    ctx.watcher.on('error', () => stopWatching(ctx));
  } catch {
    ctx.watcher = null;
  }
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
  const initialPath = ctx.initialPath;
  return {
    initialPath,
    settings: settings.publicView(),
    version: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
  };
});

handle('doc:load', async (ctx, p) => {
  const requested = path.resolve(str(p));
  try {
    const doc = await files.readDocument(requested);
    ctx.filePath = doc.path;
    ctx.initialPath = null;
    startWatching(ctx, doc.path, `${doc.mtimeMs}:${doc.size}`);
    settings.addRecent(doc.path);
    app.addRecentDocument(doc.path);
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
handle('doc:read', async (_ctx, p) => {
  const abs = path.resolve(str(p));
  if (!files.isMarkdown(abs)) return { error: 'Not a Markdown file' };
  try {
    const doc = await files.readDocument(abs);
    return { path: doc.path, content: doc.content, dirUrl: dirUrl(path.dirname(doc.path)) };
  } catch (err) {
    return { error: friendlyError(err) };
  }
});

// Classify a link the user clicked. The renderer passes the absolute URL the
// browser resolved against the document's folder.
handle('link:resolve', async (_ctx, href) => {
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

// Non-Markdown local file linked from a document: ask before handing it to the OS.
handle('link:openFile', async (ctx, p) => {
  const abs = path.resolve(str(p));
  const ext = path.extname(abs).toLowerCase();
  const name = path.basename(abs);
  let isDirectory = false;
  try { isDirectory = fs.statSync(abs).isDirectory(); } catch { return false; }
  if (isDirectory) {
    await shell.openPath(abs);
    return true;
  }
  if (DANGEROUS_EXTS.has(ext)) {
    const { response } = await dialog.showMessageBox(ctx.win, {
      type: 'warning',
      buttons: ['Show in folder', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Plume',
      message: `“${name}” is a program or script.`,
      detail: 'Plume will not run it from a link. You can reveal it in File Explorer instead.',
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
  if (response === 0) await shell.openPath(abs);
  else if (response === 1) shell.showItemInFolder(abs);
  return true;
});

handle('link:external', async (_ctx, href) => {
  const url = str(href);
  if (!/^(https?:\/\/|mailto:)/i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});

handle('wiki:resolve', async (_ctx, fromFile, targets) => {
  const from = path.resolve(str(fromFile));
  if (!Array.isArray(targets)) throw new Error('Invalid argument');
  const out = {};
  for (const t of targets.slice(0, 2000)) {
    if (typeof t !== 'string' || t.length > 1024) continue;
    try {
      const hit = await files.resolveWiki(from, t);
      out[t] = hit ? { ...hit, url: pathToFileURL(hit.path).href } : null;
    } catch {
      out[t] = null;
    }
  }
  return out;
});

handle('dir:list', async (_ctx, dir) => {
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

handle('app:openDialog', async ctx => {
  const { canceled, filePaths } = await dialog.showOpenDialog(ctx.win, {
    title: 'Open Markdown file',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown', extensions: [...files.MD_EXTS].map(e => e.slice(1)) },
      { name: 'Text', extensions: ['txt', 'text', 'log'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return canceled ? [] : filePaths;
});

handle('app:openPaths', (_ctx, paths) => {
  if (!Array.isArray(paths)) return false;
  paths.filter(p => typeof p === 'string' && p).slice(0, 20).forEach(p => openPath(path.resolve(p)));
  return true;
});

handle('app:newWindow', () => {
  createWindow(null);
  return true;
});

handle('app:about', async ctx => {
  await dialog.showMessageBox(ctx.win, {
    type: 'none',
    icon: ICON,
    title: 'About Plume',
    message: 'Plume',
    detail: `Version ${app.getVersion()}\nA feather-light Markdown viewer.\n\n` +
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    buttons: ['OK'],
    noLink: true,
  });
  return true;
});

handle('app:defaultStatus', async () => {
  if (process.platform !== 'win32' || !app.isPackaged) return { supported: false };
  const progId = await currentMdProgId();
  return { supported: true, isDefault: isPlumeProgId(progId), progId };
});

handle('app:openDefaultApps', async () => {
  if (process.platform !== 'win32') return false;
  await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Plume');
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

handle('shell:openInEditor', (_ctx, p) => {
  const abs = path.resolve(str(p));
  const editor = findEditor();
  launchDetached(editor || 'notepad.exe', [abs]);
  return editor ? path.basename(editor, '.exe') : 'Notepad';
});

handle('shell:openWith', (_ctx, p) => {
  const abs = path.resolve(str(p));
  if (process.platform !== 'win32') return false;
  // OpenAs_RunDLL takes the raw remainder of the command line as the path.
  launchDetached('rundll32.exe', [`shell32.dll,OpenAs_RunDLL ${abs}`], { windowsVerbatimArguments: true });
  return true;
});

handle('shell:openInObsidian', async (_ctx, p) => {
  const abs = path.resolve(str(p));
  if (!(await files.findVaultRoot(path.dirname(abs)))) return false;
  await shell.openExternal(`obsidian://open?path=${encodeURIComponent(abs)}`);
  return true;
});

handle('doc:print', ctx => new Promise(resolve => {
  ctx.win.webContents.print({ printBackground: true }, ok => resolve(ok));
}));

handle('doc:exportPdf', async ctx => {
  const base = ctx.filePath ? path.basename(ctx.filePath).replace(/\.[^.]+$/, '') : 'document';
  const defaultDir = ctx.filePath ? path.dirname(ctx.filePath) : app.getPath('documents');
  const { canceled, filePath } = await dialog.showSaveDialog(ctx.win, {
    title: 'Export as PDF',
    defaultPath: path.join(defaultDir, `${base}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  const data = await ctx.win.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    generateDocumentOutline: true,
  });
  await fs.promises.writeFile(filePath, data);
  return filePath;
});

// ---------------------------------------------------------------------------
// Helpers

function findEditor() {
  if (process.platform !== 'win32') return null;
  const local = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const candidates = [
    path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(programFiles, 'Microsoft VS Code', 'Code.exe'),
    path.join(local, 'Programs', 'cursor', 'Cursor.exe'),
  ];
  return candidates.find(c => c && fs.existsSync(c)) || null;
}

function launchDetached(cmd, args, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') delete env[key];
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
    execFile('reg.exe', args, { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /REG_SZ\s+(.+?)\s*$/m.exec(stdout || '');
      resolve(m ? m[1].trim() : null);
    });
  });
}

async function currentMdProgId() {
  const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md';
  return (await regQuery(`${base}\\UserChoiceLatest`, 'ProgId')) ||
    (await regQuery(`${base}\\UserChoice`, 'ProgId')) ||
    (await regQuery('HKCU\\Software\\Classes\\.md', null)) ||
    (await regQuery('HKCR\\.md', null));
}

function isPlumeProgId(progId) {
  if (!progId) return false;
  return progId === PROG_ID || /^Applications\\Plume\.exe$/i.test(progId);
}
