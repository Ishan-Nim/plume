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
  createNote: (dir, name) => invoke('note:create', dir, name),
  createFolder: (dir, name) => invoke('note:create', dir, name, 'folder'),
  renameNote: (p, name, root) => invoke('note:rename', p, name, root),
  moveNote: (p, dir, root) => invoke('note:move', p, dir, root),
  trashNote: p => invoke('note:trash', p),

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

  // There is deliberately no way from here to send a local path up. Uploading
  // is something a linked vault does to its own contents, decided in the main
  // process from the vault's manifest — so the guarantee that a loose file
  // never reaches the cloud is not a rule the renderer is trusted to keep.
  vault: {
    signUp: (email, password) => invoke('vault:signUp', email, password),
    signIn: (email, password) => invoke('vault:signIn', email, password),
    signOut: () => invoke('vault:signOut'),
    list: () => invoke('vault:list'),
    graph: () => invoke('vault:graph'),
    pull: vaultPath => invoke('vault:pull', vaultPath),
    remove: vaultPath => invoke('vault:remove', vaultPath),
  },

  // Vaults: the folders Plume has been asked to treat as vaults, and their
  // relationship to the account. Nothing here happens on its own.
  vaults: {
    state: () => invoke('vaults:state'),
    create: options => invoke('vaults:create', options),
    location: options => invoke('vaults:location', options),
    rename: (root, name) => invoke('vaults:rename', root, name),
    open: root => invoke('vaults:open', root),
    forget: root => invoke('vaults:forget', root),
    link: root => invoke('vaults:link', root),
    unlink: root => invoke('vaults:unlink', root),
    remotes: () => invoke('vaults:remotes'),
    clone: remoteName => invoke('vaults:clone', remoteName),
    deleteRemote: remoteName => invoke('vaults:deleteRemote', remoteName),
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
    pause: (root, paused) => invoke('sync:pause', root, paused),
    now: root => invoke('sync:now', root),
    reveal: root => invoke('sync:reveal', root),
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
  onVaultsChanged: subscribe('vaults:changed'),
  onVaultProgress: subscribe('vault:progress'),
  onSyncChanged: subscribe('sync:changed'),
  onGitChanged: subscribe('git:changed'),
  onUpdateAvailable: subscribe('update:available'),
  onUpdateProgress: subscribe('update:progress'),
  onUpdateReady: subscribe('update:ready'),
});
