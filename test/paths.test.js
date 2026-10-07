'use strict';

// What Plume will write to disk, and what it will call a document in the
// vault. Both are decided in one place each, so both are tested in one place.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const electronStub = {
  app: { getVersion: () => '1.3.1', getPath: () => require('node:os').tmpdir(), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
};
const realResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: electronStub };

const files = require(path.join(__dirname, '..', 'src', 'main', 'files.js'));
const vault = require(path.join(__dirname, '..', 'src', 'main', 'vault.js'));

test('only documents are ever written back to disk', () => {
  for (const good of ['notes.md', 'a.markdown', 'b.txt', 'c.text', 'd.log', 'e.qmd', 'f.rmd']) {
    assert.ok(files.isSavable(good), `${good} should be savable`);
  }
  // Viewing a file must not be enough to make it writable. Every one of these
  // is plain text that runs as the user, or configures something that does.
  for (const bad of [
    'profile.ps1', 'setup.bat', 'run.cmd', 'script.sh', 'a.py', 'x.exe', 'y.dll',
    '.bashrc', '.gitconfig', '.zshrc', 'Makefile', 'settings.json', 'config.yaml',
    'autostart.desktop', 'x.reg', 'noextension',
  ]) {
    assert.ok(!files.isSavable(bad), `${bad} must never be savable`);
  }
});

// Backslashes are built rather than written, so no escape sequence can be
// misread by whatever edits this file next.
const BS = String.fromCharCode(92);
const WIN_ABS = 'C:' + BS + 'windows' + BS + 'x.md';
const WIN_UP = '..' + BS + '..' + BS + 'escape.md';
const WIN_SEP = 'a' + BS + 'b.md';

test('a vault name cannot step outside the vault', () => {
  assert.strictEqual(vault.cleanVaultPath('notes/today.md'), 'notes/today.md');
  assert.strictEqual(vault.cleanVaultPath('a' + String.fromCharCode(92) + 'b.md'), 'a/b.md');
  assert.strictEqual(vault.cleanVaultPath('  spaced.md  '), 'spaced.md');
  assert.strictEqual(vault.cleanVaultPath('日本語.md'), '日本語.md');

  const refused = [
    '../escape.md',
    'a/../../escape.md',
    WIN_UP,
    '/absolute.md',
    WIN_ABS,
    './../x.md',
    'a/./../../b.md',
    '',
    '   ',
    null,
    undefined,
    'x'.repeat(401),
    'a/'.repeat(13) + 'deep.md',
  ];
  for (const bad of refused) {
    assert.throws(() => vault.cleanVaultPath(bad), `${JSON.stringify(bad)} must be refused`);
  }
  assert.throws(() => vault.cleanVaultPath('a\u0000b.md'), /control characters/);
});

test('a path relative to the folder keeps its folders', () => {
  const root = path.join('C:', 'notes');
  assert.strictEqual(vault.suggestVaultPath(path.join(root, 'Projects', 'Plume.md'), root), 'Projects/Plume.md');
  assert.strictEqual(vault.suggestVaultPath(path.join(root, 'top.md'), root), 'top.md');
  // Outside the folder it falls back to the bare name rather than escaping.
  assert.strictEqual(vault.suggestVaultPath(path.join('C:', 'elsewhere', 'x.md'), root), 'x.md');
});
