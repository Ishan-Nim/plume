'use strict';

// Git sync drives the real git, so these do too: a repository and a bare
// "remote" in a temp folder, and the module pushed and pulled against them.
// What is pinned is the behaviour somebody would notice — that a sync carries
// work both ways, that a remote nobody should be able to name is refused, and
// that the awkward states say something a person can act on rather than
// whatever git printed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const git = require(path.join(__dirname, '..', 'src', 'main', 'git.js'));

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
})();
const needsGit = hasGit ? false : 'git is not installed here';

const made = [];
function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `plume-git-${prefix}-`));
  made.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function run(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A bare repository to push at, and a clone of it with an identity set. */
function pair() {
  const remote = temp('remote');
  run(remote, 'init', '--bare', '--initial-branch=main');

  const work = temp('work');
  run(work, 'clone', '--', remote, '.');
  run(work, 'config', 'user.email', 'tester@example.com');
  run(work, 'config', 'user.name', 'Tester');
  run(work, 'config', 'pull.rebase', 'true');
  run(work, 'checkout', '-B', 'main');
  fs.writeFileSync(path.join(work, 'first.md'), '# First\n');
  run(work, 'add', '-A');
  run(work, 'commit', '-m', 'first');
  run(work, 'push', '--set-upstream', 'origin', 'main');
  return { remote, work };
}

test('a remote has to look like one', () => {
  for (const good of [
    'https://github.com/someone/notes.git',
    'git@github.com:someone/notes.git',
    'ssh://git@example.com/notes.git',
  ]) assert.ok(git.validRemote(good), `should accept ${good}`);

  for (const bad of [
    '',
    'notes.git',
    'file:///etc',
    'ext::sh -c whoami',
    // Begins with a dash, so git would read it as an option, not an address.
    '--upload-pack=touch /tmp/pwned',
    'https://' + 'x'.repeat(4000),
    null,
    42,
  ]) assert.strictEqual(git.validRemote(bad), null, `should refuse ${JSON.stringify(bad)}`);
});

test('a folder that is not a repository says so, and does not throw', { skip: needsGit }, async () => {
  const dir = temp('plain');
  const state = await git.inspect(dir);
  assert.strictEqual(state.repo, false);
  assert.match(state.reason, /not a Git repository/i);

  const res = await git.sync(dir);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /not a Git repository/i);
});

test('a missing folder is an answer, not a crash', async () => {
  const state = await git.inspect(path.join(os.tmpdir(), 'plume-git-does-not-exist-9f3a'));
  assert.strictEqual(state.repo, false);
  assert.match(state.reason, /not there/i);
});

test('inspect reports the branch, the remote and what has changed', { skip: needsGit }, async () => {
  const { work } = pair();
  let state = await git.inspect(work);
  assert.strictEqual(state.repo, true);
  assert.strictEqual(state.branch, 'main');
  assert.strictEqual(state.dirty, false);
  assert.ok(state.remote);

  fs.writeFileSync(path.join(work, 'second.md'), '# Second\n');
  state = await git.inspect(work);
  assert.strictEqual(state.dirty, true);
  assert.deepStrictEqual(state.changed, ['second.md']);
});

test('a sync commits what is there and pushes it', { skip: needsGit }, async () => {
  const { remote, work } = pair();
  fs.writeFileSync(path.join(work, 'note.md'), '# A note\n');

  const res = await git.sync(work, { message: 'from the test' });
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.pushed, true);

  // The bare repository is the proof: the file is in its tree now.
  const listed = execFileSync('git', ['ls-tree', '-r', '--name-only', 'main'],
    { cwd: remote, encoding: 'utf8' });
  assert.match(listed, /note\.md/);
  assert.strictEqual((await git.inspect(work)).dirty, false);
});

test('a sync brings down what somebody else pushed', { skip: needsGit }, async () => {
  const { remote, work } = pair();

  // A second clone stands in for the other machine.
  const other = temp('other');
  run(other, 'clone', '--', remote, '.');
  run(other, 'config', 'user.email', 'other@example.com');
  run(other, 'config', 'user.name', 'Other');
  fs.writeFileSync(path.join(other, 'theirs.md'), '# Theirs\n');
  run(other, 'add', '-A');
  run(other, 'commit', '-m', 'theirs');
  run(other, 'push');

  const res = await git.sync(work);
  assert.strictEqual(res.ok, true, res.error);
  assert.ok(fs.existsSync(path.join(work, 'theirs.md')), 'their note should be here now');
});

test('both sides changing is rebased, not refused', { skip: needsGit }, async () => {
  const { remote, work } = pair();

  const other = temp('other2');
  run(other, 'clone', '--', remote, '.');
  run(other, 'config', 'user.email', 'other@example.com');
  run(other, 'config', 'user.name', 'Other');
  fs.writeFileSync(path.join(other, 'theirs.md'), '# Theirs\n');
  run(other, 'add', '-A');
  run(other, 'commit', '-m', 'theirs');
  run(other, 'push');

  // A different file here, so the two do not collide.
  fs.writeFileSync(path.join(work, 'mine.md'), '# Mine\n');

  const res = await git.sync(work);
  assert.strictEqual(res.ok, true, res.error);
  assert.ok(fs.existsSync(path.join(work, 'theirs.md')), 'theirs came down');

  const listed = execFileSync('git', ['ls-tree', '-r', '--name-only', 'main'],
    { cwd: remote, encoding: 'utf8' });
  assert.match(listed, /mine\.md/, 'mine went up');
});

test('a repository stopped mid-rebase is left alone', { skip: needsGit }, async () => {
  const { work } = pair();
  // The marker git itself leaves; sync must not try to finish somebody's merge.
  fs.mkdirSync(path.join(work, '.git', 'rebase-merge'), { recursive: true });

  const res = await git.sync(work);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /middle of a merge or rebase/i);
});

test('connect refuses a folder already pointed somewhere else', { skip: needsGit }, async () => {
  const { work } = pair();
  const res = await git.connect(work, 'https://github.com/someone/else.git');
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /already a repository pointing at/i);
});

test('connect puts a remote on a folder of notes that is not a repository yet', { skip: needsGit }, async () => {
  const dir = temp('adopt');
  fs.writeFileSync(path.join(dir, 'note.md'), '# Note\n');

  const res = await git.connect(dir, 'https://github.com/someone/notes.git');
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.cloned, false);
  assert.strictEqual(res.repo, true);
  assert.match(res.remote, /someone\/notes\.git$/);
  // The notes are still there: adopting a folder must never empty it.
  assert.ok(fs.existsSync(path.join(dir, 'note.md')));
});

test('what git says is turned into something a person can act on', () => {
  const cases = [
    ['fatal: Authentication failed for https://example.com', /credential helper or an SSH key/i],
    ['ssh: Could not resolve host: example.com', /could not be reached/i],
    ['CONFLICT (content): Merge conflict in note.md', /conflict/i],
    ['! [rejected] main -> main (non-fast-forward)', /remote has moved on/i],
    ['*** Please tell me who you are.', /no name or email set/i],
  ];
  for (const [stderr, expected] of cases) {
    assert.match(git.explain({ err: stderr, out: '', killed: false }), expected);
  }
  assert.match(git.explain({ err: '', out: '', killed: true }), /took too long/i);
});
