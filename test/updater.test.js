'use strict';

// The updater decides, from a URL, whether to download something and run it.
// That decision is the whole security boundary, so it is tested directly.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

// updater.js asks Electron only for the app version and the shell; outside
// Electron there is no such module, so a stand-in is installed before it loads.
const electronStub = {
  app: {
    getVersion: () => '1.2.0',
    getPath: () => require('node:os').tmpdir(),
    quit: () => {},
    isPackaged: false,
    // The updater registers a will-quit handler to clean up its download.
    on: () => {},
  },
  shell: { openPath: async () => '', openExternal: async () => true },
};

const realResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: electronStub };

const updater = require(path.join(__dirname, '..', 'src', 'main', 'updater.js'));

test('an update is only offered for a genuinely newer version', () => {
  assert.strictEqual(updater.compare('1.3.0', '1.2.0'), 1);
  assert.strictEqual(updater.compare('1.2.1', '1.2.0'), 1);
  assert.strictEqual(updater.compare('1.2.0', '1.2.0'), 0);
  assert.strictEqual(updater.compare('1.2.0', '1.3.0'), -1);
  // The one everybody gets wrong.
  assert.strictEqual(updater.compare('1.10.0', '1.9.0'), 1);
  assert.strictEqual(updater.compare('2.0.0', '1.99.99'), 1);
  assert.strictEqual(updater.compare('v1.3.0', '1.2.0'), 1);
});

test('only a release asset of this repository, over HTTPS, is ever downloaded', () => {
  const allowed = [
    'https://github.com/Ishan-Nim/plume/releases/download/v1.3.0/Plume-Setup-1.3.0.exe',
    'https://github.com/Ishan-Nim/plume/releases/download/v1.3.0/SHA256SUMS.txt',
    'https://objects.github.com/Ishan-Nim/plume/releases/download/v1.3.0/Plume-Setup-1.3.0.exe',
  ];
  for (const url of allowed) {
    assert.ok(updater.trusted(url), `should allow ${url}`);
  }

  const refused = [
    // Not HTTPS.
    'http://github.com/Ishan-Nim/plume/releases/download/v1.3.0/Plume-Setup-1.3.0.exe',
    // Another host entirely.
    'https://evil.example/Ishan-Nim/plume/releases/download/v1.3.0/Plume-Setup-1.3.0.exe',
    // A host that merely ends in the right name.
    'https://github.com.evil.example/Ishan-Nim/plume/releases/download/v1.3.0/x.exe',
    'https://notgithub.com/Ishan-Nim/plume/releases/download/v1.3.0/x.exe',
    // The right host, the wrong repository.
    'https://github.com/someone-else/plume/releases/download/v1.3.0/x.exe',
    'https://github.com/Ishan-Nim/other/releases/download/v1.3.0/x.exe',
    // The right host and repository, but not a release asset.
    'https://github.com/Ishan-Nim/plume/raw/master/x.exe',
    'https://github.com/Ishan-Nim/plume/archive/master.zip',
    // Credentials or a port used to disguise the host.
    'https://github.com@evil.example/Ishan-Nim/plume/releases/download/v1/x.exe',
    // Nonsense.
    'javascript:alert(1)',
    'file:///C:/Windows/System32/cmd.exe',
    '',
    null,
    undefined,
  ];
  for (const url of refused) {
    assert.ok(!updater.trusted(url), `should refuse ${url}`);
  }
});

test('nothing is reported as ready before anything has been downloaded', () => {
  const state = updater.state();
  assert.strictEqual(state.current, '1.2.0');
  assert.strictEqual(state.ready, false);
  assert.strictEqual(state.update, null);
});

test('install refuses when there is no verified download', async () => {
  await assert.rejects(updater.install(), /Download the update first/);
});

test('download refuses when no update has been found', async () => {
  await assert.rejects(updater.download(), /no update to install/i);
});

test('a redirect is only followed to a GitHub asset host', () => {
  const allowed = [
    'https://github.com/Ishan-Nim/plume/releases/download/v1.3.1/x.exe',
    'https://objects.githubusercontent.com/anything/at/all',
    'https://release-assets.githubusercontent.com/whatever',
  ];
  for (const url of allowed) assert.ok(updater.trustedHop(url), `should follow ${url}`);

  const refused = [
    'http://objects.githubusercontent.com/x',          // downgraded
    'https://evil.example/x',
    'https://objects.githubusercontent.com.evil.example/x',
    'https://github.com@evil.example/x',
    'file:///C:/Windows/System32/cmd.exe',
    '',
    null,
  ];
  for (const url of refused) assert.ok(!updater.trustedHop(url), `should refuse ${url}`);
});
