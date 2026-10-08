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

// The bug this guards against: the update bar grew a second click handler for
// "Install and restart" without removing the first, so one click both started
// the install and started a fresh download. The download's discard() deleted
// the installer Windows was about to run, the install failed silently, and the
// app reopened on the old version and offered the same update again.
test('a second download cannot start while one is running', {
  skip: process.platform === 'win32' ? false : 'an install is only offered on Windows',
}, async () => {
  const realFetch = globalThis.fetch;
  const base = 'https://github.com/Ishan-Nim/plume/releases/download/v9.9.9';
  const release = {
    tag_name: 'v9.9.9',
    body: '',
    html_url: 'https://github.com/Ishan-Nim/plume/releases/tag/v9.9.9',
    assets: [
      { name: 'Plume-Setup-9.9.9.exe', size: 10, browser_download_url: `${base}/Plume-Setup-9.9.9.exe` },
      { name: 'SHA256SUMS.txt', browser_download_url: `${base}/SHA256SUMS.txt` },
    ],
  };

  // The checksum fetch never answers, so the first download is still in flight
  // when the second one is attempted.
  let abandon;
  const stalled = new Promise((resolve, reject) => { abandon = reject; });

  globalThis.fetch = async (url) => {
    if (String(url).includes('api.github.com')) return { ok: true, json: async () => release };
    return stalled;
  };

  try {
    const update = await updater.check({ force: true });
    assert.ok(update && update.installable, 'the stubbed release should be installable');

    const first = updater.download().then(() => 'finished', () => 'stopped');

    // Raced against a timer rather than simply awaited: without the guard the
    // second download does not reject at all, it goes and fetches, and the
    // test would hang instead of failing.
    const second = updater.download().then(() => 'a second download started', err => err.message);
    const outcome = await Promise.race([
      second,
      new Promise(resolve => setTimeout(() => resolve('a second download started'), 2000).unref()),
    ]);
    assert.match(outcome, /already downloading/i);

    abandon(new Error('the test is over'));
    assert.strictEqual(await first, 'stopped');

    // And once nothing is in flight, the guard is out of the way again.
    await assert.rejects(updater.download(), /the test is over/);
  } finally {
    globalThis.fetch = realFetch;
    await updater.discard();
  }
});
