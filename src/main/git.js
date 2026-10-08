'use strict';

// Git sync.
//
// Keeps a folder of notes in step with a Git remote: fetch, rebase what is
// yours on top of what arrived, commit what changed, push. The same folder the
// vault syncs, if you use both — they do not know about each other, and do not
// need to.
//
// It drives the `git` already on the machine rather than reimplementing any of
// it. That is the whole design:
//
//   · no new dependency, and no second implementation of merge to get wrong
//   · your credentials stay where you already put them — the system credential
//     helper, an SSH agent, a deploy key. Plume never sees a token, never
//     stores one, and never asks for one
//   · conflicts, submodules, LFS, hooks and signing all behave as they do in
//     your terminal, because it is the same git
//
// The cost is that git must be installed, which is said plainly when it is not.
//
// Nothing here ever runs through a shell: every argument is passed as an
// argument, and a remote whose name begins with "-" is refused outright,
// because git would read it as an option.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const TIMEOUT_MS = Number(process.env.PLUME_GIT_TIMEOUT_MS || 120_000);
const MAX_OUTPUT = 1024 * 1024;

// https and ssh, and nothing else. file:// and ext:: reach the local machine;
// a URL starting with "-" is an argument, not an address.
const REMOTE_RE = /^(?:https:\/\/[^\s]+|git@[^\s:]+:[^\s]+|ssh:\/\/[^\s]+)$/;

/**
 * The environment every git call runs in.
 *
 * GIT_TERMINAL_PROMPT=0 and an askpass that answers nothing are what stop a
 * missing credential from hanging a window forever: git fails immediately and
 * says it could not authenticate, which is something a person can act on.
 */
function env() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    SSH_ASKPASS: 'echo',
    // Keep the author of an automatic commit honest if the user has set no
    // identity: git refuses to commit without one, and that error is clearer
    // than a silent default.
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
}

function run(dir, args, { timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: dir,
      env: env(),
      timeout,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? -1 : 0),
        killed: Boolean(err && err.killed),
        out: String(stdout || '').trim(),
        err: String(stderr || '').trim(),
      });
    });
  });
}

/** Is there a git to drive, and which one. */
async function available() {
  const res = await run(undefined, ['--version'], { timeout: 10_000 });
  if (!res.ok) return { ok: false, reason: 'Git is not installed, or not on the PATH.' };
  return { ok: true, version: res.out.replace(/^git version /, '') };
}

function validRemote(url) {
  const text = String(url == null ? '' : url).trim();
  if (!text || text.length > 2048) return null;
  if (text.startsWith('-')) return null;
  return REMOTE_RE.test(text) ? text : null;
}

async function isRepo(dir) {
  const res = await run(dir, ['rev-parse', '--git-dir'], { timeout: 15_000 });
  return res.ok;
}

/**
 * What state the folder is in, as far as anything here needs to know. Never
 * throws: a folder that is not a repository is an answer, not a failure.
 */
async function inspect(dir) {
  if (!dir) return { repo: false, reason: 'No folder is set.' };
  if (!fs.existsSync(dir)) return { repo: false, reason: 'That folder is not there any more.' };

  const git = await available();
  if (!git.ok) return { repo: false, git: false, reason: git.reason };
  if (!(await isRepo(dir))) return { repo: false, git: true, reason: 'That folder is not a Git repository.' };

  const [branch, remote, dirty, upstream, head] = await Promise.all([
    run(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    run(dir, ['remote', 'get-url', 'origin']),
    run(dir, ['status', '--porcelain']),
    run(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    run(dir, ['log', '-1', '--pretty=%h %s']),
  ]);

  const changed = dirty.ok
    ? dirty.out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean)
    : [];

  let ahead = 0;
  let behind = 0;
  if (upstream.ok) {
    const counts = await run(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
    if (counts.ok) {
      const [a, b] = counts.out.split(/\s+/).map((n) => parseInt(n, 10) || 0);
      ahead = a;
      behind = b;
    }
  }

  return {
    repo: true,
    git: true,
    branch: branch.ok ? branch.out : null,
    remote: remote.ok ? remote.out : null,
    upstream: upstream.ok ? upstream.out : null,
    changed,
    dirty: changed.length > 0,
    ahead,
    behind,
    lastCommit: head.ok ? head.out : null,
  };
}

/** A message that says what happened, rather than what git printed at us. */
function explain(res) {
  const text = `${res.err}\n${res.out}`.toLowerCase();
  if (res.killed) return 'Git took too long and was stopped. Check the network, or whether it is waiting for a password.';
  if (/could not read username|authentication failed|terminal prompts disabled|permission denied \(publickey\)/.test(text)) {
    return 'Git could not authenticate. Set up a credential helper or an SSH key for this remote, the way you would in a terminal.';
  }
  if (/could not resolve host|network is unreachable|failed to connect/.test(text)) {
    return 'That remote could not be reached. Check the network.';
  }
  if (/conflict/.test(text)) {
    return 'There is a conflict between your changes and the remote. Resolve it in the folder, then sync again.';
  }
  if (/non-fast-forward|rejected/.test(text)) {
    return 'The remote has moved on. Pull first, then sync again.';
  }
  if (/please tell me who you are|empty ident name/.test(text)) {
    return 'Git has no name or email set. Run git config --global user.name and user.email, then sync again.';
  }
  if (/divergent branches|need to specify how to reconcile/.test(text)) {
    return 'Git does not know how to reconcile this branch. Set pull.rebase for the repository, then sync again.';
  }
  return (res.err || res.out || 'Git failed.').split('\n')[0].slice(0, 300);
}

/**
 * One round: bring down what is there, put up what is here.
 *
 * Rebase rather than merge, so a folder of notes does not collect a merge
 * commit every few minutes. --autostash so uncommitted work is not in the way
 * of the fetch — it comes back afterwards either way.
 */
async function sync(dir, { message } = {}) {
  const state = await inspect(dir);
  if (!state.repo) return { ok: false, error: state.reason };
  if (!state.remote) return { ok: false, error: 'That repository has no "origin" remote.' };

  const steps = [];
  const note = (what, res) => {
    steps.push({ what, ok: res.ok });
    return res;
  };

  // A rebase or merge already half-done is not ours to finish.
  const midway = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']
    .some((f) => fs.existsSync(path.join(dir, '.git', f)));
  if (midway) {
    return { ok: false, error: 'This repository is in the middle of a merge or rebase. Finish it, then sync again.', steps };
  }

  // Commit first, so what is pushed is what was here when the user asked.
  if (state.dirty) {
    const add = note('stage', await run(dir, ['add', '--all']));
    if (!add.ok) return { ok: false, error: explain(add), steps };

    const text = String(message || `Plume sync — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`).slice(0, 500);
    const commit = note('commit', await run(dir, ['commit', '-m', text]));
    // "nothing to commit" is a success with nothing in it.
    if (!commit.ok && !/nothing to commit/i.test(`${commit.out}${commit.err}`)) {
      return { ok: false, error: explain(commit), steps };
    }
  }

  const fetch = note('fetch', await run(dir, ['fetch', 'origin']));
  if (!fetch.ok) return { ok: false, error: explain(fetch), steps };

  if (state.upstream) {
    const rebase = note('rebase', await run(dir, ['pull', '--rebase', '--autostash']));
    if (!rebase.ok) {
      // Leave the folder as git left it, but do not leave it mid-rebase on our
      // account: a half-finished rebase from an automatic sync is a trap.
      await run(dir, ['rebase', '--abort']);
      return { ok: false, error: explain(rebase), steps };
    }
  }

  const branch = state.branch && state.branch !== 'HEAD' ? state.branch : null;
  const pushArgs = state.upstream || !branch
    ? ['push']
    : ['push', '--set-upstream', 'origin', branch];
  const push = note('push', await run(dir, pushArgs));
  if (!push.ok) return { ok: false, error: explain(push), steps };

  const after = await inspect(dir);
  return {
    ok: true,
    steps,
    branch: after.branch,
    remote: after.remote,
    lastCommit: after.lastCommit,
    pushed: state.dirty || state.ahead > 0,
    pulled: state.behind > 0,
  };
}

/**
 * Attaches a folder to a remote: clones into it when it is empty, or adds the
 * remote to the repository already there. Never touches a folder that is a
 * different repository already.
 */
async function connect(dir, remoteUrl, { branch } = {}) {
  const url = validRemote(remoteUrl);
  if (!url) return { ok: false, error: 'That does not look like a Git remote. Use an https:// or SSH address.' };

  const git = await available();
  if (!git.ok) return { ok: false, error: git.reason };

  await fsp.mkdir(dir, { recursive: true });

  if (await isRepo(dir)) {
    const existing = await run(dir, ['remote', 'get-url', 'origin']);
    if (existing.ok && existing.out !== url) {
      return { ok: false, error: `That folder is already a repository pointing at ${existing.out}.` };
    }
    if (!existing.ok) {
      const add = await run(dir, ['remote', 'add', 'origin', '--', url]);
      if (!add.ok) return { ok: false, error: explain(add) };
    }
    return { ok: true, cloned: false, ...(await inspect(dir)) };
  }

  const entries = await fsp.readdir(dir);
  if (entries.length) {
    // Clone needs an empty directory; initialise in place instead so a folder
    // of notes that already exists is not an obstacle.
    const init = await run(dir, ['init']);
    if (!init.ok) return { ok: false, error: explain(init) };
    const add = await run(dir, ['remote', 'add', 'origin', '--', url]);
    if (!add.ok) return { ok: false, error: explain(add) };
    if (branch) await run(dir, ['checkout', '-B', branch]);
    return { ok: true, cloned: false, ...(await inspect(dir)) };
  }

  const args = ['clone'];
  if (branch) args.push('--branch', branch);
  args.push('--', url, '.');
  const clone = await run(dir, args, { timeout: 10 * 60 * 1000 });
  if (!clone.ok) return { ok: false, error: explain(clone) };
  return { ok: true, cloned: true, ...(await inspect(dir)) };
}

module.exports = { available, inspect, sync, connect, validRemote, explain };
