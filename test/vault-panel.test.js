'use strict';

// The vault panel shows a folder by its name. Getting that wrong is not
// cosmetic: the name is what the reader checks before pressing a button that
// sends a folder to the cloud, and the whole path on a button is both
// unreadable and wider than the sidebar.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

function load(entry) {
  const res = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'renderer', entry)],
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

const { folderName } = load('vault.js');

test('a Windows path shows as its folder, not the whole path', () => {
  // This is the one that was wrong: splitting on "/" alone leaves every
  // backslash path untouched, so the panel showed C:\Users\…\Notes where the
  // word "Notes" belonged — on the synced folder, and on the button that
  // offers to sync one.
  assert.equal(folderName('C:\\Users\\me\\AppData\\Local\\Temp\\plume-demo'), 'plume-demo');
  assert.equal(folderName('E:\\MD APP\\docs\\announcements'), 'announcements');
  assert.equal(folderName('C:\\Work\\'), 'Work');
});

test('a POSIX path shows as its folder too', () => {
  assert.equal(folderName('/home/me/Notes'), 'Notes');
  assert.equal(folderName('/home/me/Notes/'), 'Notes');
});

test('a name that is already a name is left alone', () => {
  assert.equal(folderName('Notes'), 'Notes');
});

test('nothing in, nothing out — and never a crash', () => {
  // The panel asks for this before it knows whether a folder is open.
  assert.equal(folderName(''), '');
  assert.equal(folderName(null), '');
  assert.equal(folderName(undefined), '');
});

test('a root is not mistaken for an empty name', () => {
  // Trimming the trailing separator off "C:\" leaves "C:", which is still
  // what the reader would call it; it must not come back empty.
  assert.equal(folderName('C:\\'), 'C:');
  assert.equal(folderName('/'), '/');
});
