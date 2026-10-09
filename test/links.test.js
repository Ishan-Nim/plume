'use strict';

// Renaming a note rewrites the links that point at it, across the whole vault.
// That is an edit to somebody's writing made without them watching, so every
// shape a link comes in is pinned here.

const test = require('node:test');
const assert = require('node:assert/strict');
const links = require('../src/main/links.js');

const rw = (text, from, to, docRel = null) => links.rewriteLinks(text, from, to, docRel);

test('a bare wiki link follows the note', () => {
  const out = rw('See [[Old note]] for the rest.', 'Old note.md', 'New note.md');
  assert.equal(out.text, 'See [[New note]] for the rest.');
  assert.equal(out.count, 1);
});

test('headings, aliases and embeds are kept exactly as written', () => {
  const cases = [
    ['[[Old note#Summary]]', '[[New note#Summary]]'],
    ['[[Old note|what I called it]]', '[[New note|what I called it]]'],
    ['[[Old note#Summary|both]]', '[[New note#Summary|both]]'],
    ['![[Old note]]', '![[New note]]'],
    ['![[Old note#Summary]]', '![[New note#Summary]]'],
    ['[[Old note.md]]', '[[New note.md]]'],
  ];
  for (const [before, after] of cases) {
    assert.equal(rw(before, 'Old note.md', 'New note.md').text, after, before);
  }
});

test('a link that names folders keeps as many as it had', () => {
  assert.equal(rw('[[work/Plan]]', 'work/Plan.md', 'work/Roadmap.md').text, '[[work/Roadmap]]');
  assert.equal(rw('[[Plan]]', 'work/Plan.md', 'archive/work/Plan.md').text, '[[Plan]]');
  // Moved to another folder: a one-folder link follows it to the new one.
  assert.equal(rw('[[work/Plan]]', 'work/Plan.md', 'done/Plan.md').text, '[[done/Plan]]');
});

test('a link to a different note of the same name is left alone', () => {
  // archive/Plan.md is not the note being renamed.
  assert.equal(rw('[[archive/Plan]]', 'work/Plan.md', 'work/Roadmap.md').text, '[[archive/Plan]]');
  assert.equal(rw('[[Planning]]', 'Plan.md', 'Roadmap.md').text, '[[Planning]]');
  assert.equal(rw('[[Plan 2]]', 'Plan.md', 'Roadmap.md').text, '[[Plan 2]]');
});

test('a pipe escaped for a table is still an alias, and stays escaped', () => {
  // Inside a Markdown table the pipe has to be escaped or the row ends there.
  const out = rw('| [[Old note\\|what I call it]] | yes |', 'Old note.md', 'New note.md');
  assert.equal(out.text, '| [[New note\\|what I call it]] | yes |');
});

test('Markdown links and images follow too, encoding and all', () => {
  assert.equal(rw('[the plan](Old%20note.md)', 'Old note.md', 'New note.md').text,
    '[the plan](New%20note.md)');
  assert.equal(rw('[the plan](notes/Old%20note.md#top)', 'Old note.md', 'New note.md').text,
    '[the plan](notes/New%20note.md#top)');
  assert.equal(rw('[the plan](<Old note.md>)', 'Old note.md', 'New note.md').text,
    '[the plan](<New note.md>)');
  assert.equal(rw('[p](Old.md "Titled")', 'Old.md', 'New.md').text, '[p](New.md "Titled")');
});

test('a Markdown link is read from where the document itself lives', () => {
  // work/Journal.md links to work/Plan.md; archive/Journal.md links to its own
  // archive/Plan.md. Renaming work/Plan.md must move exactly one of them.
  const text = '[the plan](Plan.md)';
  assert.equal(rw(text, 'work/Plan.md', 'work/Roadmap.md', 'work/Journal.md').text, '[the plan](Roadmap.md)');
  assert.equal(rw(text, 'work/Plan.md', 'work/Roadmap.md', 'archive/Journal.md').text, text);
  // From a folder above, the route to it is rewritten too.
  assert.equal(rw('[p](work/Plan.md)', 'work/Plan.md', 'done/Plan.md', 'Index.md').text, '[p](done/Plan.md)');
  assert.equal(rw('[p](../work/Plan.md)', 'work/Plan.md', 'work/Roadmap.md', 'archive/Old.md').text,
    '[p](../work/Roadmap.md)');
});

test('links that are not to this file are never touched', () => {
  const left = [
    '[docs](https://example.com/Old%20note.md)',
    '[anchor](#Old-note)',
    '[mail](mailto:someone@example.com)',
    '[other](Older.md)',
    'plain text about an Old note',
    '[[  ]]',
  ];
  for (const text of left) {
    assert.equal(rw(text, 'Old note.md', 'New note.md').text, text, text);
  }
});

test('the name is matched the way Obsidian matches it — without case', () => {
  assert.equal(rw('[[old NOTE]]', 'Old note.md', 'New note.md').text, '[[New note]]');
});

test('nothing to do is nothing changed', () => {
  const text = 'See [[Old note]].';
  assert.equal(rw(text, 'Old note.md', 'Old note.md').count, 0);
  assert.equal(rw(text, '', 'x.md').count, 0);
  assert.equal(rw(null, 'a.md', 'b.md').count, 0);
});

test('a document with many links reports how many it changed', () => {
  const text = '[[Old]] and [[Old|again]] and ![[Old]] and [a](Old.md) and [[Other]]';
  const out = rw(text, 'Old.md', 'New.md');
  assert.equal(out.count, 4);
  assert.ok(!out.text.includes('[[Old'), out.text);
  assert.ok(out.text.includes('[[Other]]'));
});
