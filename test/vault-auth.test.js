'use strict';

// Signing up and resetting a password both go through a 6-digit code sent by
// email. What the desktop app sends for each step, what it keeps, and what it
// passes back to the panel are tested here against a small stand-in vault on
// 127.0.0.1 — never the real one.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-vault-auth-'));

const electronStub = {
  app: { getVersion: () => '1.0.1', getPath: () => userData, isPackaged: false },
  // No encryption means no session is written to disk, which keeps this test
  // from leaving anything behind.
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
};
const realResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: electronStub };

/** The renderer is an ES module for the browser; bundle it so Node can load it. */
function loadRenderer(entry) {
  const res = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'renderer', entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  });
  const m = new Module(entry);
  m.paths = module.paths;
  m._compile(res.outputFiles[0].text, entry);
  return m.exports;
}

let bundled = null;
const panel = () => bundled || (bundled = loadRenderer('vault.js'));

// ---------- a stand-in vault ----------

const GOOD_SIGNUP_CODE = '123456';
const GOOD_RESET_CODE = '654321';
const WRONG = 'That code is not right, or it has expired. Ask for a new one.';
const START_NOTE = 'We sent a 6-digit code to that address. Enter it to finish creating your vault.';
const FORGOT_NOTE = 'If there is an account for that address, a 6-digit code and a link are on their way.';
const RESET_NOTE = 'Your password is set. Every other device, and every personal access token, has been signed out.';

const seen = [];
let server;
let vault;

function answer(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

const account = (email) => ({ email, plan: 'free', usedBytes: 0, quotaBytes: 100 * 1024 * 1024, files: 0 });

function fakeVault(req, res) {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });

    if (body.email === 'busy@plume-md.test') {
      return answer(res, 429, { ok: false, error: 'Too many attempts for that address. Try again later.' }, { 'retry-after': '30' });
    }

    switch (`${req.method} ${req.url}`) {
      case 'POST /api/auth/signup/start':
        return answer(res, 200, { ok: true, verify: true, minutes: 10, note: START_NOTE });
      case 'POST /api/auth/signup/verify':
        if (body.email === 'taken@plume-md.test') {
          return answer(res, 409, { ok: false, error: 'There is already an account with that email. Try signing in.' });
        }
        if (body.code !== GOOD_SIGNUP_CODE) return answer(res, 400, { ok: false, error: WRONG });
        return answer(res, 201, { ok: true, token: 'token-signup', account: account(body.email) });
      case 'POST /api/auth/forgot':
        if (body.email === 'off@plume-md.test') {
          return answer(res, 501, { ok: false, error: 'Password reset is not switched on yet.' });
        }
        return answer(res, 200, { ok: true, note: FORGOT_NOTE });
      case 'POST /api/auth/reset/code':
        if (body.code !== GOOD_RESET_CODE) return answer(res, 400, { ok: false, error: WRONG });
        return answer(res, 200, { ok: true, token: 'token-reset', account: account(body.email), note: RESET_NOTE });
      default:
        return answer(res, 404, { ok: false, error: 'Not found.' });
    }
  });
}

before(async () => {
  server = http.createServer(fakeVault);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Read once, when vault.js loads — so it is set before the require.
  process.env.PLUME_VAULT_API = `http://127.0.0.1:${server.address().port}/api`;
  vault = require(path.join(ROOT, 'src', 'main', 'vault.js'));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(userData, { recursive: true, force: true });
});

const last = () => seen[seen.length - 1];

// ---------- codes ----------

test('a code is six plain digits, however it was typed or pasted', () => {
  assert.strictEqual(vault.cleanCode('123456'), '123456');
  assert.strictEqual(vault.cleanCode(' 123 456 '), '123456');
  assert.strictEqual(vault.cleanCode('123-456'), '123456');
  assert.strictEqual(vault.cleanCode('012345'), '012345', 'a leading zero is part of the code');
  // A Japanese input method types full-width digits.
  assert.strictEqual(vault.cleanCode('１２３４５６'), '123456');

  for (const bad of ['', '12345', '1234567', 'abcdef', '12345a', '١٢٣٤٥٦', null, undefined, 123456.5]) {
    assert.throws(() => vault.cleanCode(bad), /6-digit code/, `${JSON.stringify(bad)} must be refused`);
  }
});

test('the panel pulls the code out of whatever lands in the box', () => {
  const { codeDigits } = panel();
  assert.strictEqual(codeDigits('123456'), '123456');
  assert.strictEqual(codeDigits('123 456'), '123456');
  assert.strictEqual(codeDigits('１２３ ４５６'), '123456');
  assert.strictEqual(codeDigits('Your Plume code is 123456'), '123456');
  assert.strictEqual(codeDigits('Your Plume code is 987654. It works for 10 minutes.'), '987654');
  // Half-typed is left alone, and letters never get in.
  assert.strictEqual(codeDigits('12'), '12');
  assert.strictEqual(codeDigits('1a2b3'), '123');
  assert.strictEqual(codeDigits(''), '');
  assert.strictEqual(codeDigits('12345678'), '123456');
});

test('"Resend code" waits out the minute the vault would ignore it in', () => {
  const { resendWait } = panel();
  const sent = 1_000_000;
  assert.strictEqual(resendWait(sent, sent), 60);
  assert.strictEqual(resendWait(sent, sent + 59_001), 1);
  assert.strictEqual(resendWait(sent, sent + 60_000), 0);
  assert.strictEqual(resendWait(sent, sent + 3_600_000), 0);
  assert.strictEqual(resendWait(undefined, sent), 0);
});

// ---------- creating an account ----------

test('asking for a sign-up code sends the address and password, and signs nobody in', async () => {
  const result = await vault.signUpStart('  new@plume-md.test ', 'qa-flow-password-1');
  const req = last();
  assert.strictEqual(req.method, 'POST');
  assert.strictEqual(req.url, '/api/auth/signup/start');
  assert.deepStrictEqual(req.body, { email: 'new@plume-md.test', password: 'qa-flow-password-1' });
  assert.strictEqual(req.headers.authorization, undefined);

  assert.deepStrictEqual(result, { verify: true, minutes: 10, note: START_NOTE });
  assert.strictEqual(vault.publicState().signedIn, false);
});

test('a wrong sign-up code passes the vault\'s sentence on and signs nobody in', async () => {
  await assert.rejects(vault.signUpVerify('new@plume-md.test', '000000'), (err) => {
    assert.strictEqual(err.message, WRONG);
    assert.strictEqual(err.status, 400);
    return true;
  });
  assert.strictEqual(vault.publicState().signedIn, false);
});

test('a code that cannot be right is refused before it costs an attempt', async () => {
  const count = seen.length;
  await assert.rejects(vault.signUpVerify('new@plume-md.test', '12345'), /6-digit code/);
  await assert.rejects(vault.resetWithCode('new@plume-md.test', 'abc', 'another-password-2'), /6-digit code/);
  assert.strictEqual(seen.length, count, 'nothing reached the vault');
});

test('an account made elsewhere in the meantime comes back as a 409', async () => {
  await assert.rejects(vault.signUpVerify('taken@plume-md.test', GOOD_SIGNUP_CODE), (err) => {
    assert.strictEqual(err.status, 409);
    assert.match(err.message, /already an account/);
    return true;
  });
  assert.strictEqual(vault.publicState().signedIn, false);
});

test('the right sign-up code creates the account and signs in', async () => {
  const state = await vault.signUpVerify('new@plume-md.test', '123 456');
  assert.deepStrictEqual(last().body, { email: 'new@plume-md.test', code: '123456' });
  assert.strictEqual(last().url, '/api/auth/signup/verify');
  assert.strictEqual(state.signedIn, true);
  assert.strictEqual(state.email, 'new@plume-md.test');
  // The token stays in the main process.
  assert.ok(!JSON.stringify(state).includes('token-signup'));
  vault.signOut();
});

// ---------- a forgotten password ----------

test('asking for a reset code passes the vault\'s note on', async () => {
  const result = await vault.forgot('someone@plume-md.test');
  assert.strictEqual(last().url, '/api/auth/forgot');
  assert.deepStrictEqual(last().body, { email: 'someone@plume-md.test' });
  assert.deepStrictEqual(result, { note: FORGOT_NOTE });
});

test('a vault without mail says so in its own words', async () => {
  await assert.rejects(vault.forgot('off@plume-md.test'), (err) => {
    assert.strictEqual(err.status, 501);
    assert.match(err.message, /not switched on/);
    return true;
  });
});

test('the reset code sets the new password and signs in, without sending an old session', async () => {
  // Signed in as somebody else first: the reset must not carry that token.
  await vault.signUpVerify('other@plume-md.test', GOOD_SIGNUP_CODE);
  assert.strictEqual(vault.publicState().signedIn, true);

  const { state, note } = await vault.resetWithCode('someone@plume-md.test', '６５４３２１', 'another-password-2');
  const req = last();
  assert.strictEqual(req.url, '/api/auth/reset/code');
  assert.deepStrictEqual(req.body, { email: 'someone@plume-md.test', code: GOOD_RESET_CODE, password: 'another-password-2' });
  assert.strictEqual(req.headers.authorization, undefined);

  assert.strictEqual(state.signedIn, true);
  assert.strictEqual(state.email, 'someone@plume-md.test');
  assert.strictEqual(note, RESET_NOTE);
  vault.signOut();
});

test('a wrong reset code changes nothing', async () => {
  await assert.rejects(vault.resetWithCode('someone@plume-md.test', '111111', 'another-password-2'), (err) => {
    assert.strictEqual(err.message, WRONG);
    return true;
  });
  assert.strictEqual(vault.publicState().signedIn, false);
});

// ---------- slowing down ----------

test('being told to slow down keeps the vault\'s reason and how long to wait', async () => {
  await assert.rejects(vault.signUpStart('busy@plume-md.test', 'qa-flow-password-1'), (err) => {
    assert.strictEqual(err.status, 429);
    assert.strictEqual(err.message, 'Too many attempts for that address. Try again later.');
    assert.strictEqual(err.retryAfterMs, 30_000);
    return true;
  });
});

// ---------- the bridge ----------

test('every vault call the renderer can make has a handler, and the retired one is gone', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const invoked = new Set([...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]));
  const handled = new Set([...main.matchAll(/handle\('([^']+)'/g)].map((m) => m[1]));

  for (const channel of ['vault:signUpStart', 'vault:signUpVerify', 'vault:forgot', 'vault:resetWithCode']) {
    assert.ok(invoked.has(channel), `preload does not expose ${channel}`);
  }
  for (const channel of invoked) assert.ok(handled.has(channel), `nothing handles ${channel}`);

  // The one-step sign-up is refused by the vault now; nothing should still call it.
  assert.ok(!invoked.has('vault:signUp') && !handled.has('vault:signUp'));
  assert.strictEqual(vault.signUp, undefined);
});
