'use strict';

// Persistent user settings, stored as JSON in the userData folder.
// Every key is validated on load and on update so a hand-edited or
// corrupted file can never put the app into a broken state.

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const MAX_RECENT = 12;

// A palette recolours whichever of light or dark is in force; it does not
// replace that choice. 'plume' is Plume's own, and the rest are derived from
// the MIT-licensed Obsidian themes credited in README.md.
const PALETTES = ['plume', 'starless', 'greenwood', 'commit', 'lapis'];

const DEFAULTS = Object.freeze({
  theme: 'system',        // 'system' | 'light' | 'dark'
  palette: 'plume',       // recolouring applied on top of light/dark
  fontSize: 16,           // content font size in px
  width: 'normal',        // 'narrow' | 'normal' | 'wide' | 'full'
  font: 'sans',           // 'sans' | 'serif'
  lineBreaks: true,       // Obsidian-style: a single newline is a line break
  sidebar: true,
  sidebarTab: 'files',    // 'files' | 'outline' | 'vault'
  sidebarWidth: 260,
  recent: [],
  autoUpdate: true,       // check GitHub for a newer release on launch
  skippedVersion: null,   // a version the user chose not to be told about again
  vaultFolder: null,      // the folder kept in step with the vault, if any
  syncPaused: false,
  bounds: null,           // { x, y, width, height } of the last closed window
  maximized: false,
});

const VALIDATORS = {
  theme: v => ['system', 'light', 'dark'].includes(v),
  palette: v => PALETTES.includes(v),
  fontSize: v => Number.isInteger(v) && v >= 12 && v <= 28,
  width: v => ['narrow', 'normal', 'wide', 'full'].includes(v),
  font: v => ['sans', 'serif'].includes(v),
  lineBreaks: v => typeof v === 'boolean',
  sidebar: v => typeof v === 'boolean',
  sidebarTab: v => ['files', 'outline', 'vault'].includes(v),
  sidebarWidth: v => Number.isInteger(v) && v >= 180 && v <= 520,
  recent: v => Array.isArray(v) && v.every(p => typeof p === 'string' && p.length < 4096),
  autoUpdate: v => typeof v === 'boolean',
  skippedVersion: v => v === null || (typeof v === 'string' && v.length < 40),
  vaultFolder: v => v === null || (typeof v === 'string' && v.length > 0 && v.length < 4096),
  syncPaused: v => typeof v === 'boolean',
  bounds: v => v === null || (typeof v === 'object' &&
    ['x', 'y', 'width', 'height'].every(k => Number.isFinite(v[k]))),
  maximized: v => typeof v === 'boolean',
};

// Keys the renderer may change. Window geometry and the recent list are
// managed by the main process only.
const RENDERER_KEYS = new Set(['theme', 'palette', 'fontSize', 'width', 'font', 'lineBreaks',
  'sidebar', 'sidebarTab', 'sidebarWidth', 'autoUpdate', 'skippedVersion']);

let state = { ...DEFAULTS, recent: [] };
let file = null;
let saveTimer = null;

function settingsFile() {
  if (!file) file = path.join(app.getPath('userData'), 'settings.json');
  return file;
}

function sanitize(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of Object.keys(VALIDATORS)) {
    if (key in input && VALIDATORS[key](input[key])) out[key] = input[key];
  }
  if (out.recent) out.recent = out.recent.slice(0, MAX_RECENT);
  return out;
}

function load() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    state = { ...DEFAULTS, recent: [], ...sanitize(JSON.parse(raw)) };
  } catch {
    state = { ...DEFAULTS, recent: [] };
  }
  return state;
}

function get() {
  return state;
}

// Public view sent to renderers.
function publicView() {
  const { bounds, maximized, ...rest } = state;
  return { ...rest, recent: [...state.recent] };
}

function update(patch, { fromRenderer = false } = {}) {
  const clean = sanitize(patch);
  if (fromRenderer) {
    for (const key of Object.keys(clean)) if (!RENDERER_KEYS.has(key)) delete clean[key];
  }
  state = { ...state, ...clean };
  scheduleSave();
  return clean;
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function addRecent(p) {
  const recent = state.recent.filter(r => !samePath(r, p));
  recent.unshift(p);
  state = { ...state, recent: recent.slice(0, MAX_RECENT) };
  scheduleSave();
}

function removeRecent(p) {
  state = { ...state, recent: state.recent.filter(r => !samePath(r, p)) };
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 300);
}

// Atomic write: write a temp file then rename over the real one, so a crash
// mid-write never leaves a truncated settings.json behind.
function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const target = settingsFile();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, target);
  } catch {
    // Settings are a convenience; failing to save must never crash the app.
  }
}

module.exports = { DEFAULTS, load, get, publicView, update, addRecent, removeRecent, flush, samePath };
