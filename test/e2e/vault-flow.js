'use strict';

// End-to-end check of the whole vault flow in the real app: sign up with the
// code from the email (after a wrong one, and after "Resend code"), sync the
// open document, read the file list, draw the graph, sign out, then forget the
// password and set a new one with a code, check the old password is refused,
// and that five wrong codes kill a code. Along the way: a long address does not
// push the panel sideways, a mistyped address is caught before anything is
// sent, and the cursor lands somewhere useful after every step. It drives the
// actual UI rather than the IPC layer, so a button that stops being wired up
// fails this test. It takes a little over a minute, because "Resend code"
// waits out its minute.
//
// The vault to run it against is plume-vault's scripts/dev-server-memory.js,
// with its output going to the file PLUME_MAIL_LOG names:
//
//   node scripts/dev-server-memory.js > vault-stdout.log   (in plume-vault)
//   set PLUME_VAULT_API=http://127.0.0.1:8098/api
//   set PLUME_MAIL_LOG=path\to\vault-stdout.log
//   set PLUME_SHOTS=path\to\shots
//   npx electron test/e2e/vault-flow.js
//
// Env: PLUME_VAULT_API (required — never point this at production),
//      PLUME_MAIL_LOG (required — the file a local vault running with
//        MAIL_TRANSPORT=log writes its output to; the codes are read from it),
//      PLUME_SHOTS (directory for screenshots), PLUME_SIZE, PLUME_THEME,
//      PLUME_SIDEBAR (sidebar width in pixels).

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API = process.env.PLUME_VAULT_API;
if (!API) {
  console.error('vault-flow: PLUME_VAULT_API is required');
  process.exit(2);
}
if (/plume-md\.com/i.test(API)) {
  console.error('vault-flow: refusing to run against production');
  process.exit(2);
}
const MAIL_LOG = process.env.PLUME_MAIL_LOG;
if (!MAIL_LOG) {
  console.error('vault-flow: PLUME_MAIL_LOG is required — the codes come from the local vault\'s mail log');
  process.exit(2);
}

const SHOTS = process.env.PLUME_SHOTS || path.join(os.tmpdir(), 'plume-vault-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-vault-'));
app.setPath('userData', tmp);

// As in capture.js: shown without focus and fully transparent, so the window
// paints (hidden windows produce no fresh frames) without covering the desktop
// or appearing in the taskbar.
BrowserWindow.prototype.show = function show() {
  this.setOpacity(0);
  this.setSkipTaskbar(true);
  this.showInactive();
};
BrowserWindow.prototype.maximize = function maximize() {};

const [w, h] = (process.env.PLUME_SIZE || '1340x880').split('x').map(Number);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  theme: process.env.PLUME_THEME || 'light',
  bounds: { x: 40, y: 40, width: w, height: h },
  sidebar: true,
  // PLUME_SIDEBAR=180 runs the whole flow in the narrowest sidebar there is.
  ...(process.env.PLUME_SIDEBAR ? { sidebarWidth: Number(process.env.PLUME_SIDEBAR) } : {}),
}));

// A small linked notebook to sync, so the graph has something to draw.
const notebook = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-e2e-notes-'));
const NOTES = {
  'Index.md': '# Index\n\nStart with [[Plume]] and [[Reading]].\n',
  'Plume.md': '# Plume\n\nBack to [[Index]]. See also [[Reading]].\n',
  'Reading.md': '# Reading\n\nFrom [[Index]]. Nothing links to [[Someday]] yet.\n',
};
for (const [name, body] of Object.entries(NOTES)) {
  fs.writeFileSync(path.join(notebook, name), body);
}
fs.mkdirSync(path.join(notebook, 'Projects'), { recursive: true });
fs.writeFileSync(
  path.join(notebook, 'Projects', 'Index.md'),
  ['# Project index', '', 'A second Index, under a folder.', ''].join('\n'),
);

const firstNote = path.join(notebook, 'Index.md');
process.argv.push(firstNote);

const EMAIL = `qa-${Date.now()}@plume-md.test`;
// One unbroken word, wider than the sidebar.
const LONG_EMAIL = `alexandra.konstantinopoulou.marketing.${Date.now()}@internationalholdings.example`;
const PASSWORD = 'qa-flow-password-1';
const NEW_PASSWORD = 'qa-flow-password-2';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- reading codes out of the local vault's mail ----

/** How much the mail log holds now, so only what is written after counts. */
function mailMark() {
  try {
    return fs.statSync(MAIL_LOG).size;
  } catch {
    return 0;
  }
}

/**
 * The newest 6-digit code in a stretch of mail. "Your Plume code is 123456"
 * first; failing that, six digits standing on their own, which a message id
 * or a date never are.
 */
function findCode(text) {
  const said = [...text.matchAll(/\bcode\b[^0-9\n]{0,24}(\d{6})(?!\d)/gi)];
  if (said.length) return said[said.length - 1][1];
  const bare = [...text.matchAll(/(?:^|[\s>:])(\d{6})(?=[\s.,<]|$)/gm)];
  return bare.length ? bare[bare.length - 1][1] : null;
}

/** Waits for a code to be mailed after `mark`. */
async function codeSince(mark, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let text = '';
    try {
      text = fs.readFileSync(MAIL_LOG).subarray(mark).toString('utf8');
    } catch {
      // Not written yet.
    }
    const code = findCode(text);
    if (code) return code;
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}

// Fills the code box the way people do: pasted, with a space in the middle.
const PASTE_CODE = code => `
  const box = document.getElementById('vault-code');
  const data = new DataTransfer();
  data.setData('text/plain', ${JSON.stringify(`${code.slice(0, 3)} ${code.slice(3)}`)});
  box.focus();
  box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
`;
const TYPE_CODE = code => `
  const box = document.getElementById('vault-code');
  box.value = ${JSON.stringify(code)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
`;
const SUBMIT = 'document.querySelector(\'.vault-form button[type="submit"]\').click();';
const ERROR_TEXT = '(document.querySelector(".vault-error") || {}).textContent || ""';
const FOCUSED = '(document.activeElement && document.activeElement.id) || (document.activeElement || {}).tagName';
// Nothing in the panel is wider than the panel.
const NO_SIDEWAYS = '(() => { const p = document.querySelector("[data-panel=vault]"); return !!p && p.scrollWidth <= p.clientWidth + 1; })()';
const PANEL_WIDTH = '(() => { const p = document.querySelector("[data-panel=vault]"); return p ? `${p.scrollWidth} in ${p.clientWidth}` : "no panel"; })()';
const fill = (id, value) => `
  (() => {
    const box = document.getElementById(${JSON.stringify(id)});
    box.value = ${JSON.stringify(value)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
  })();
`;
const button = label => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;

// The vault sits in a bar at the foot of the sidebar, and that bar toggles —
// so clicking it blindly a second time would close what we just opened.
const OPEN_VAULT = 'var p = document.querySelector("[data-panel=vault]");'
  + ' if (p && p.hidden) document.getElementById("vault-bar").click();';

const logs = [];
const results = [];
let failures = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main(win) {
  const wc = win.webContents;
  const run = js => wc.executeJavaScript(`(async () => { ${js} })()`);
  const read = expr => wc.executeJavaScript(`(async () => (${expr}))()`);
  const shot = async name => {
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), img.toPNG());
  };

  /** Waits for an expression to become truthy. */
  async function until(expr, { timeout = 15000, every = 150 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await read(expr)) return true;
      if (Date.now() > deadline) return false;
      await sleep(every);
    }
  }

  // ---- the document itself ----
  await until('document.body.dataset.ready === "1"');
  await sleep(600);
  record('a document opens', await read('!!document.querySelector("#doc h1")'),
    await read('document.querySelector("#doc h1") && document.querySelector("#doc h1").textContent'));
  await shot('01-document');

  // ---- the vault tab exists and is not a dialog ----
  record('the sidebar has a vault bar at the foot', await read('!!document.getElementById("vault-bar")'));
  record('no modal overlay is used', await read('!document.querySelector(".vault-overlay")'));

  await run(OPEN_VAULT);
  const gotForm = await until('!!document.getElementById("vault-email")');
  record('the sign-in form appears in place', gotForm);
  await shot('02-signin');

  if (!gotForm) return;

  // ---- create an account ----
  await run(`
    document.querySelector('.vault-tabs button:last-child').click();
  `);
  await sleep(250);
  record('the create-account mode is reachable',
    await read('document.querySelector(".vault-tabs button:last-child").getAttribute("aria-pressed") === "true"'));
  record('choosing a tab puts the cursor in its form, not on the page', await read(`${FOCUSED} === 'vault-email'`), await read(FOCUSED));

  // ---- a long address on the code step stays inside the sidebar ----
  let mark = mailMark();
  await run(`${fill('vault-email', LONG_EMAIL)} ${fill('vault-password', PASSWORD)} ${SUBMIT}`);
  const longStep = await until('!!document.getElementById("vault-code")', { timeout: 25000 });
  record('a long address reaches the code step', longStep, longStep ? '' : await read(ERROR_TEXT));
  await sleep(200);
  record('a long address wraps instead of pushing the panel sideways', await read(NO_SIDEWAYS), await read(PANEL_WIDTH));
  record('the sign-up code step says a taken address gets a sign-in email instead',
    /already has a vault, the email says how to sign in instead/.test(await read('document.getElementById("vault-code-hint").textContent')),
    await read('document.getElementById("vault-code-hint").textContent'));
  await shot('02b-long-address');
  // Its mail is out of the way before the real sign-up's is looked for.
  await codeSince(mark);
  await run(`${button('Use a different email')}.click();`);
  await until('!!document.getElementById("vault-email")');
  record('"Use a different email" goes back with the cursor in the address', await read(`${FOCUSED} === 'vault-email'`), await read(FOCUSED));

  mark = mailMark();
  await run(`
    const email = document.getElementById('vault-email');
    const password = document.getElementById('vault-password');
    email.value = ${JSON.stringify(EMAIL)};
    password.value = ${JSON.stringify(PASSWORD)};
    email.dispatchEvent(new Event('input', { bubbles: true }));
    password.dispatchEvent(new Event('input', { bubbles: true }));
    ${SUBMIT}
  `);

  // ---- the account only exists once the emailed code is in ----
  const askedForCode = await until('!!document.getElementById("vault-code")', { timeout: 25000 });
  record('creating an account asks for the code from the email', askedForCode, askedForCode ? '' : await read(ERROR_TEXT));
  await shot('03-signup-code');
  if (!askedForCode) return;

  record('nobody is signed in before the code is entered', await read('!document.querySelector(".vault-account")'));
  record('the code box is made for a one-time code', await read(`(() => {
    const c = document.getElementById('vault-code');
    return c.getAttribute('inputmode') === 'numeric' && c.getAttribute('autocomplete') === 'one-time-code'
      && c.maxLength === 6 && !!document.querySelector('label[for="vault-code"]');
  })()`));
  const resendLabel = await read(`(() => {
    const b = [...document.querySelectorAll('.vault-btn')].find(x => /^Resend code/.test(x.textContent.trim()));
    return b ? (b.disabled ? 'disabled: ' : 'enabled: ') + b.textContent.trim() : null;
  })()`);
  record('"Resend code" waits out its minute, counting down', /^disabled: Resend code \(\d+\)$/.test(resendLabel || ''), resendLabel);
  record('there is a way back to change the address', await read(`!!${button('Use a different email')}`));

  const firstCode = await codeSince(mark);
  record('the sign-up code arrives by email', Boolean(firstCode));
  if (!firstCode) return;

  // A wrong code first: it is refused in words, and nothing is created.
  const wrong = String((Number(firstCode) + 1) % 1000000).padStart(6, '0');
  await run(`${TYPE_CODE(wrong)} ${SUBMIT}`);
  const refused = await until(`${ERROR_TEXT}.length > 0`, { timeout: 15000 });
  record('a wrong code is refused, in words, and says to check it', refused && /Check it and try again/.test(await read(ERROR_TEXT)), await read(ERROR_TEXT));
  record('a wrong code creates nothing', await read('!document.querySelector(".vault-account") && !!document.getElementById("vault-code")'));
  record('a wrong code stays in the box, selected, to be corrected', await read(`(() => {
    const c = document.getElementById('vault-code');
    return document.activeElement === c && c.value === ${JSON.stringify(wrong)} && c.selectionStart === 0 && c.selectionEnd === 6;
  })()`), await read('document.getElementById("vault-code").value'));
  await shot('03b-wrong-code');

  // "Resend code" once its minute is up: a new code, and the cursor back in
  // the box it goes in rather than on a button that has just been disabled.
  const resendReady = await until(`!!${button('Resend code')} && !${button('Resend code')}.disabled`, { timeout: 75000, every: 500 });
  record('"Resend code" comes back after its minute', resendReady);
  // The vault's own minute started a moment after the panel's.
  await sleep(1500);
  mark = mailMark();
  await run(`${button('Resend code')}.click();`);
  const resent = await until('/Sent again/.test((document.querySelector(".vault-status") || {}).textContent || "")', { timeout: 15000 });
  record('"Resend code" says a new code is on its way', resent, await read(ERROR_TEXT));
  record('after "Resend code" the cursor is in the code box', await read(`${FOCUSED} === 'vault-code'`), await read(FOCUSED));
  const signupCode = await codeSince(mark);
  record('the resent code arrives by email', Boolean(signupCode) && signupCode !== firstCode, signupCode);
  if (!signupCode) return;

  await run(PASTE_CODE(signupCode));
  const pasted = await read('document.getElementById("vault-code").value');
  record('a pasted "123 456" becomes the six digits', pasted === signupCode, pasted);
  await run(SUBMIT);

  const signedIn = await until('!!document.querySelector(".vault-account")', { timeout: 25000 });
  record('the right code creates the vault and signs you in', signedIn,
    signedIn ? await read('document.querySelector(".vault-who b").textContent') : await read(ERROR_TEXT));
  await shot('03c-signed-in');

  if (!signedIn) return;

  record('the quota is shown', /100 MB/.test(await read('document.querySelector(".vault-who span").textContent') || ''),
    await read('document.querySelector(".vault-who span").textContent'));

  // ---- sync the open document ----
  const hasSync = await until('!!document.querySelector(".vault-name")');
  record('the open document can be named and synced', hasSync);

  await run(`
    const buttons = [...document.querySelectorAll('.vault-btn')];
    const sync = buttons.find(b => b.textContent.trim() === 'Sync to vault');
    sync.click();
  `);

  const synced = await until('document.querySelectorAll(".vault-files li").length > 0', { timeout: 25000 });
  record('the document reaches the vault', synced,
    synced ? await read('document.querySelector(".vault-files li b").textContent') : await read('(document.querySelector(".vault-error")||{}).textContent'));
  await shot('04-synced');

  // ---- sync the rest, so the graph has links ----
  for (const name of ['Plume.md', 'Reading.md']) {
    await run(`window.plume.openPaths([${JSON.stringify(path.join(notebook, name))}]);`);
    await sleep(1200);
  }
  // Those open in their own windows; sync them through the API the panel uses.
  for (const name of ['Plume.md', 'Reading.md']) {
    const full = path.join(notebook, name);
    const other = BrowserWindow.getAllWindows().find(x => x.id !== win.id);
    if (!other) continue;
    await other.webContents.executeJavaScript(`(async () => {
      var p = document.querySelector("[data-panel=vault]"); if (p && p.hidden) document.getElementById("vault-bar").click();
      await new Promise(r => setTimeout(r, 1200));
      const buttons = [...document.querySelectorAll('.vault-btn')];
      const sync = buttons.find(b => b.textContent.trim() === 'Sync to vault');
      if (sync) sync.click();
      return ${JSON.stringify(full)};
    })()`).catch(() => {});
    await sleep(2500);
    if (other && !other.isDestroyed()) other.close();
    await sleep(400);
  }

  await run(OPEN_VAULT);
  await sleep(300);
  await run(`
    const buttons = [...document.querySelectorAll('.vault-btn')];
    const refresh = buttons.find(b => b.textContent.trim() === 'Graph');
    if (refresh) refresh.click();
  `);

  // The panel must offer the name of the document that is open now. Offering
  // the one that was open when it first drew made syncing a second document
  // overwrite the first one's copy in the vault.
  await run(`
    document.getElementById('graph-view-close').click();
    document.querySelector('.sidebar-tab[data-tab="files"]').click();
    await new Promise(r => setTimeout(r, 500));
    const rows = [...document.querySelectorAll('.tree-row')];
    const row = rows.find(r => r.textContent.trim() === 'Reading');
    if (row) row.click();
  `);
  await sleep(1600);
  await run(OPEN_VAULT);
  await sleep(800);
  const offered = await read('(document.querySelector(".vault-name") || {}).value');
  record('the name offered is the open document, not a stale one', offered === 'Reading.md', offered);

  // A note inside a folder must keep that folder in its vault name. Offering
  // the bare file name made two documents called Index.md collide, and syncing
  // the second one replaced the first.
  await run(`
    document.querySelector('.sidebar-tab[data-tab="files"]').click();
    await new Promise(r => setTimeout(r, 400));
    const folder = [...document.querySelectorAll('.tree-row')].find(r => r.textContent.trim() === 'Projects');
    if (folder) folder.click();
    await new Promise(r => setTimeout(r, 900));
    const rows = [...document.querySelectorAll('.tree-row.is-file')];
    const deep = rows.find(r => r.textContent.trim() === 'Index');
    if (deep) deep.click();
  `);
  await sleep(1600);
  await run(OPEN_VAULT);
  await sleep(800);
  const nested = await read('(document.querySelector(".vault-name") || {}).value');
  record('a note in a folder keeps its folder in the vault name',
    nested === 'Projects/Index.md', nested);

  await run(`
    const again = [...document.querySelectorAll('.vault-btn')].find(b => b.textContent.trim() === 'Graph');
    if (again) again.click();
  `);

  const graphShown = await until('!document.getElementById("graph-view").hidden', { timeout: 20000 });
  record('the graph view opens', graphShown);

  const drew = await until('!document.getElementById("graph-view-empty").hidden === false', { timeout: 20000 })
    || await until('document.getElementById("graph-view-empty").hidden === true', { timeout: 20000 });
  const meta = await read('document.getElementById("graph-view-meta").textContent');
  record('the graph has documents and links', /document/.test(meta || ''), meta);
  await sleep(1500);
  await shot('05-graph');

  record('the graph canvas painted', await read(`(() => {
    const c = document.getElementById('graph-view-canvas');
    return !!c && c.width > 0 && c.height > 0;
  })()`));

  await run('document.getElementById("graph-view-close").click();');
  await sleep(300);
  record('the graph closes again', await read('document.getElementById("graph-view").hidden'));

  // ---- signing out clears what was on screen ----
  record('sign out is a labelled button, not a bare icon',
    await read('!!document.querySelector(".vault-account .vault-btn") && document.querySelector(".vault-account .vault-btn").textContent.trim() === "Sign out"'));

  await run(`
    document.querySelector('.vault-account .vault-btn').click();
  `);
  const signedOut = await until('!!document.getElementById("vault-email")', { timeout: 15000 });
  record('signing out returns to the form', signedOut);
  record('no account details are left behind',
    await read('!document.querySelector(".vault-who")'));
  await shot('06-signed-out');
  if (!signedOut) return;

  // ---- a forgotten password, reset with a code ----
  record('sign-in offers "Forgot password?"', await read(`!!${button('Forgot password?')}`));
  await run(`${button('Forgot password?')}.click();`);
  const askedForAddress = await until(`!!document.getElementById("vault-email") && !!${button('Email me a code')}`);
  record('"Forgot password?" asks for the address', askedForAddress);
  if (!askedForAddress) return;

  // The vault answers a mistyped address like any other, so the panel has to
  // catch it, before anybody waits for an email that is never coming.
  await run(`${fill('vault-email', 'someone@typo')} ${SUBMIT}`);
  await until(`${ERROR_TEXT}.length > 0`);
  record('a mistyped address is caught before anything is sent',
    (await read(ERROR_TEXT)) === 'That email address does not look right.'
      && await read(`!!${button('Email me a code')} && !document.getElementById("vault-code")`)
      && await read(`${FOCUSED} === 'vault-email'`),
    await read(ERROR_TEXT));

  await run(`${button('Back to sign in')}.click();`);
  await until('!!document.getElementById("vault-password")');
  record('"Back to sign in" puts the cursor in the form, not on the page',
    await read(`['vault-email', 'vault-password'].includes(${FOCUSED})`), await read(FOCUSED));
  await run(`${button('Forgot password?')}.click();`);
  await until(`!!${button('Email me a code')}`);

  mark = mailMark();
  await run(`
    const email = document.getElementById('vault-email');
    email.value = ${JSON.stringify(EMAIL)};
    email.dispatchEvent(new Event('input', { bubbles: true }));
    ${SUBMIT}
  `);
  const resetStep = await until('!!document.getElementById("vault-code") && !!document.getElementById("vault-password")', { timeout: 25000 });
  record('the reset asks for the code and a new password', resetStep, resetStep ? await read('document.querySelector(".vault-note").textContent') : await read(ERROR_TEXT));
  record('the reset code step stays inside the sidebar', await read(NO_SIDEWAYS), await read(PANEL_WIDTH));
  await shot('07-reset-code');
  if (!resetStep) return;

  const resetCode = await codeSince(mark);
  record('the reset code arrives by email', Boolean(resetCode));
  if (!resetCode) return;

  // The vault checks the password before it spends the code, so a password it
  // will not take leaves the code in the box, still good.
  await run(`
    ${TYPE_CODE(resetCode)}
    const pw = document.getElementById('vault-password');
    pw.value = 'short';
    pw.dispatchEvent(new Event('input', { bubbles: true }));
    ${SUBMIT}
  `);
  const tooShort = await until(`${ERROR_TEXT}.length > 0`, { timeout: 15000 });
  record('a password the vault refuses is explained, and the code stays',
    tooShort && await read(`document.getElementById('vault-code').value === ${JSON.stringify(resetCode)}`),
    await read(ERROR_TEXT));

  await run(`
    const pw = document.getElementById('vault-password');
    pw.value = ${JSON.stringify(NEW_PASSWORD)};
    pw.dispatchEvent(new Event('input', { bubbles: true }));
    ${SUBMIT}
  `);
  const resetIn = await until('!!document.querySelector(".vault-account")', { timeout: 25000 });
  record('the reset code sets the password and signs you in', resetIn, resetIn ? '' : await read(ERROR_TEXT));
  record('the vault\'s note about other devices is shown',
    await read('/signed out/i.test((document.querySelector(".vault-status") || {}).textContent || "")'),
    await read('(document.querySelector(".vault-status") || {}).textContent'));
  await shot('08-reset-signed-in');
  if (!resetIn) return;

  // ---- the old password stops working, and the new one is the one that works ----
  await run('document.querySelector(\'.vault-account .vault-btn\').click();');
  await until('!!document.getElementById("vault-email")', { timeout: 15000 });

  const signInWith = secret => run(`
    const error = document.querySelector('.vault-error');
    if (error) error.textContent = '';
    const email = document.getElementById('vault-email');
    const password = document.getElementById('vault-password');
    email.value = ${JSON.stringify(EMAIL)};
    password.value = ${JSON.stringify(secret)};
    email.dispatchEvent(new Event('input', { bubbles: true }));
    password.dispatchEvent(new Event('input', { bubbles: true }));
    ${SUBMIT}
  `);

  await signInWith(PASSWORD);
  const oldRefused = await until(`${ERROR_TEXT}.length > 0`, { timeout: 15000 });
  record('the old password no longer signs in',
    oldRefused && await read('!document.querySelector(".vault-account")'), await read(ERROR_TEXT));
  await shot('09-old-password-refused');

  await signInWith(NEW_PASSWORD);
  const newWorks = await until('!!document.querySelector(".vault-account")', { timeout: 25000 });
  record('the new password signs in', newWorks, newWorks ? '' : await read(ERROR_TEXT));

  await run('document.querySelector(\'.vault-account .vault-btn\').click();');
  await until('!!document.getElementById("vault-email")', { timeout: 15000 });
  if (!newWorks) return;

  // ---- five wrong codes and the code is dead, even the right one ----
  await run(`${button('Forgot password?')}.click();`);
  await until(`!!${button('Email me a code')}`);
  mark = mailMark();
  await run(`
    const email = document.getElementById('vault-email');
    email.value = ${JSON.stringify(EMAIL)};
    email.dispatchEvent(new Event('input', { bubbles: true }));
    ${SUBMIT}
  `);
  const again = await until('!!document.getElementById("vault-code") && !!document.getElementById("vault-password")', { timeout: 25000 });
  const deadCode = again ? await codeSince(mark) : null;
  record('a second reset code arrives', Boolean(deadCode));
  if (!deadCode) return;

  const tryReset = code => run(`
    document.querySelector('.vault-error').textContent = '';
    ${TYPE_CODE(code)}
    const pw = document.getElementById('vault-password');
    pw.value = 'qa-flow-password-3';
    pw.dispatchEvent(new Event('input', { bubbles: true }));
    ${SUBMIT}
  `);
  const answers = [];
  for (let i = 1; i <= 5; i += 1) {
    await tryReset(String((Number(deadCode) + i) % 1000000).padStart(6, '0'));
    await until(`${ERROR_TEXT}.length > 0`, { timeout: 15000 });
    answers.push(await read(ERROR_TEXT));
  }
  record('five wrong codes are each refused', answers.length === 5 && answers.every(a => /code is not right/.test(a)), answers[4]);
  record('a wrong reset code stays in the box, selected', await read(`(() => {
    const c = document.getElementById('vault-code');
    return document.activeElement === c && c.value.length === 6 && c.selectionStart === 0 && c.selectionEnd === 6;
  })()`), await read(FOCUSED));

  await tryReset(deadCode);
  await until(`${ERROR_TEXT}.length > 0`, { timeout: 15000 });
  const afterFive = await read(ERROR_TEXT);
  record('after five wrong tries the right code is dead too',
    /code is not right/.test(afterFive) && await read('!document.querySelector(".vault-account")'), afterFive);
  await shot('10-code-dead');

  // Nothing changed: the password set before is still the password.
  await run(`${button('Use a different email')}.click();`);
  await run(`${button('Back to sign in')}.click();`);
  await until('!!document.getElementById("vault-password")', { timeout: 15000 });
  await signInWith(NEW_PASSWORD);
  const stillWorks = await until('!!document.querySelector(".vault-account")', { timeout: 25000 });
  record('a dead code changed nothing: the password still works', stillWorks, stillWorks ? '' : await read(ERROR_TEXT));

  await run('document.querySelector(\'.vault-account .vault-btn\').click();');
  await until('!!document.getElementById("vault-email")', { timeout: 15000 });
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (event, level, message) => {
    const msg = typeof event === 'object' && event.message ? event.message : message;
    logs.push(String(msg));
  });
});

app.whenReady().then(async () => {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error('vault-flow: no window opened');
    app.exit(2);
    return;
  }
  try {
    await main(win);
  } catch (err) {
    record('the run finished without throwing', false, err && err.message);
  }

  const errors = logs.filter(l => /error|uncaught|refused|violat/i.test(l));
  record('the page logged no errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  fs.writeFileSync(path.join(SHOTS, 'report.json'), JSON.stringify({ results, logs }, null, 2));
  console.log(`\n${results.length - failures}/${results.length} checks passed — shots in ${SHOTS}`);
  app.exit(failures ? 1 : 0);
});

require('../../src/main/main.js');
