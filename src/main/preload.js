'use strict';

// The only bridge between the sandboxed renderer and the main process.
// Exposes a small, explicit API — no raw ipcRenderer, no Node.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel) {
  return callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('plume', {
  init: () => invoke('app:init'),

  loadDoc: p => invoke('doc:load', p),
  readNote: p => invoke('doc:read', p),
  saveDoc: (p, content) => invoke('doc:save', p, content),
  resolveLink: href => invoke('link:resolve', href),
  openFile: p => invoke('link:openFile', p),
  openExternal: url => invoke('link:external', url),
  resolveWiki: (fromFile, targets) => invoke('wiki:resolve', fromFile, targets),
  listDir: dir => invoke('dir:list', dir),

  setSettings: patch => invoke('settings:set', patch),
  removeRecent: p => invoke('recent:remove', p),

  openDialog: () => invoke('app:openDialog'),
  openFolder: () => invoke('app:openFolder'),
  forgetFolder: () => invoke('app:forgetFolder'),
  openPaths: paths => invoke('app:openPaths', paths),
  newWindow: () => invoke('app:newWindow'),
  about: () => invoke('app:about'),
  defaultStatus: () => invoke('app:defaultStatus'),
  openDefaultApps: () => invoke('app:openDefaultApps'),

  closeWindow: () => invoke('win:close'),
  toggleFullscreen: () => invoke('win:fullscreen'),
  toggleDevTools: () => invoke('win:devtools'),

  copyText: text => invoke('clipboard:write', text),
  showInFolder: p => invoke('shell:showInFolder', p),
  openInEditor: p => invoke('shell:openInEditor', p),
  openWith: p => invoke('shell:openWith', p),
  openInObsidian: p => invoke('shell:openInObsidian', p),
  print: () => invoke('doc:print'),
  exportPdf: () => invoke('doc:exportPdf'),

  // Git sync. Plume never handles a credential here: git does, with whatever
  // helper or key the machine already has.
  git: {
    state: () => invoke('git:state'),
    choose: () => invoke('git:choose'),
    connect: (remote, branch) => invoke('git:connect', remote, branch),
    sync: message => invoke('git:sync', message),
    auto: (on, every) => invoke('git:auto', on, every),
    forget: () => invoke('git:forget'),
  },

  vault: {
    state: rootDir => invoke('vault:state', rootDir),
    suggest: (paths, rootDir) => invoke('vault:suggest', paths, rootDir),
    collectFolder: (dir, rootDir) => invoke('vault:collectFolder', dir, rootDir),
    pushMany: (items, options) => invoke('vault:pushMany', items, options),
    signUp: (email, password) => invoke('vault:signUp', email, password),
    signIn: (email, password) => invoke('vault:signIn', email, password),
    signOut: () => invoke('vault:signOut'),
    list: () => invoke('vault:list'),
    graph: () => invoke('vault:graph'),
    push: (vaultPath, options) => invoke('vault:push', vaultPath, options),
    pull: vaultPath => invoke('vault:pull', vaultPath),
    keepBoth: vaultPath => invoke('vault:keepBoth', vaultPath),
    remove: vaultPath => invoke('vault:remove', vaultPath),
    unlink: () => invoke('vault:unlink'),
  },

  update: {
    state: () => invoke('update:state'),
    check: force => invoke('update:check', force),
    download: () => invoke('update:download'),
    install: () => invoke('update:install'),
    page: () => invoke('update:page'),
    skip: version => invoke('update:skip', version),
  },

  sync: {
    state: () => invoke('sync:state'),
    choose: () => invoke('sync:choose'),
    forget: () => invoke('sync:forget'),
    pause: paused => invoke('sync:pause', paused),
    now: () => invoke('sync:now'),
    reveal: () => invoke('sync:reveal'),
  },

  pathForFile: file => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },

  onSettings: subscribe('settings:changed'),
  onDocChanged: subscribe('doc:changed'),
  onDocMissing: subscribe('doc:missing'),
  onDirChanged: subscribe('dir:changed'),
  onOpenPath: subscribe('open-path'),
  onCommand: subscribe('command'),
  onVaultChanged: subscribe('vault:changed'),
  onVaultProgress: subscribe('vault:progress'),
  onSyncChanged: subscribe('sync:changed'),
  onGitChanged: subscribe('git:changed'),
  onUpdateAvailable: subscribe('update:available'),
  onUpdateProgress: subscribe('update:progress'),
  onUpdateReady: subscribe('update:ready'),
});
