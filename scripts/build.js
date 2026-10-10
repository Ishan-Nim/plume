'use strict';

// Bundle the renderer with esbuild and copy static assets into out/renderer.
//   node scripts/build.js            development build (sourcemaps)
//   node scripts/build.js --release  minified production build

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');
const OUT = path.join(ROOT, 'out', 'renderer');
// The web view is the same Markdown pipeline in a browser tab, so it is built
// from the same sources into the site's assets rather than kept as a copy.
const WEB_SRC = path.join(ROOT, 'src', 'web');
const WEB_OUT = path.join(ROOT, 'site', 'assets');
const NM = path.join(ROOT, 'node_modules');
const release = process.argv.includes('--release');

// The slice of the renderer's stylesheet the web view shares. See the markers
// in src/renderer/styles.css.
const SHARED_START = '/* ============================================================ document */';
const SHARED_END = '/* <<< end of what the web view shares */';

// Packages copied into out/renderer as prebuilt files rather than bundled.
// Mermaid's dist file inlines its own dependencies, so their licenses count too.
const COPIED_PACKAGES = [['mermaid', { withDependencies: true }], ['katex', { withDependencies: false }]];

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// node_modules/<name>/… or node_modules/@scope/<name>/… → the package folder.
function packageDirOf(input) {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replace(/\\/g, '/'));
  const dir = m && path.join(ROOT, m[1]);
  return dir && fs.existsSync(path.join(dir, 'package.json')) ? dir : null;
}

// Resolve a dependency the way Node does: nearest node_modules upwards.
function findPackage(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === ROOT || path.dirname(dir) === dir) return null;
  }
}

function addWithDependencies(dirs, dir) {
  if (!dir || dirs.has(dir)) return;
  dirs.add(dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies || {})) addWithDependencies(dirs, findPackage(dep, dir));
}

// MIT, BSD and Apache licenses all require their notices to travel with the
// binaries, so collect the license files of everything that ends up in the app.
function writeNotices(metafile) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const dir = packageDirOf(input);
    if (dir) dirs.add(dir);
  }
  for (const [name, { withDependencies }] of COPIED_PACKAGES) {
    if (withDependencies) addWithDependencies(dirs, path.join(NM, name));
    else dirs.add(path.join(NM, name));
  }

  const entries = new Map();
  for (const dir of dirs) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const key = `${pkg.name} ${pkg.version}`;
    if (entries.has(key) || pkg.name.startsWith('@types/')) continue;
    const texts = fs.readdirSync(dir)
      .filter(f => /^(licen[cs]e|copying|notice)\b/i.test(f) && fs.statSync(path.join(dir, f)).isFile())
      .map(f => fs.readFileSync(path.join(dir, f), 'utf8').trim());
    const license = typeof pkg.license === 'string' ? pkg.license : 'see below';
    const body = texts.length ? texts.join('\n\n') : `Licensed under ${license}; the package ships no license file.`;
    entries.set(key, `${'-'.repeat(72)}\n${key} (${license})\n${'-'.repeat(72)}\n\n${body}\n`);
  }

  const header = 'Plume includes the third-party software listed below. Each component is\n' +
    'provided under its own license, reproduced here in full.\n\n';
  const sorted = [...entries.keys()].sort((a, b) => a.localeCompare(b)).map(k => entries.get(k));
  fs.writeFileSync(path.join(OUT, 'THIRD_PARTY_NOTICES.txt'), header + sorted.join('\n'));
  return sorted.length;
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [path.join(SRC, 'app.js')],
    outfile: path.join(OUT, 'renderer.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome130',
    minify: release,
    sourcemap: release ? false : 'linked',
    // Release builds move license comments to renderer.js.LEGAL.txt.
    legalComments: release ? 'external' : 'inline',
    metafile: true,
    logLevel: 'warning',
  });

  copy(path.join(SRC, 'index.html'), path.join(OUT, 'index.html'));
  copy(path.join(SRC, 'styles.css'), path.join(OUT, 'styles.css'));

  // Mermaid is large, so it is loaded on demand from its own file.
  copy(path.join(NM, 'mermaid', 'dist', 'mermaid.min.js'), path.join(OUT, 'vendor', 'mermaid.min.js'));

  // KaTeX stylesheet + woff2 fonts (every supported Chromium uses woff2).
  const katexDist = path.join(NM, 'katex', 'dist');
  copy(path.join(katexDist, 'katex.min.css'), path.join(OUT, 'vendor', 'katex', 'katex.min.css'));
  for (const f of fs.readdirSync(path.join(katexDist, 'fonts'))) {
    if (f.endsWith('.woff2')) copy(path.join(katexDist, 'fonts', f), path.join(OUT, 'vendor', 'katex', 'fonts', f));
  }

  const notices = writeNotices(result.metafile);

  const size = fs.statSync(path.join(OUT, 'renderer.js')).size;
  console.log(`renderer built (${release ? 'release' : 'dev'}) — renderer.js ${(size / 1024).toFixed(0)} KB, ` +
    `${notices} third-party notices`);

  // ---- the web view ----
  //
  // Always minified: this one is served over the network to somebody waiting
  // for it, which the desktop bundle never is.
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [path.join(WEB_SRC, 'app.js')],
    outfile: path.join(WEB_OUT, 'web.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    minify: true,
    sourcemap: false,
    legalComments: 'external',
    logLevel: 'warning',
  });

  // KaTeX renders maths to HTML that needs its stylesheet and fonts.
  copy(path.join(katexDist, 'katex.min.css'), path.join(WEB_OUT, 'vendor', 'katex', 'katex.min.css'));
  for (const f of fs.readdirSync(path.join(katexDist, 'fonts'))) {
    if (f.endsWith('.woff2')) copy(path.join(katexDist, 'fonts', f), path.join(WEB_OUT, 'vendor', 'katex', 'fonts', f));
  }

  // The rules for the document itself are shared rather than written twice, so
  // a note reads the same in a browser tab as it does in the app. The markers
  // are in src/renderer/styles.css; everything between them comes across.
  const rendererCss = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
  const from = rendererCss.indexOf(SHARED_START);
  const to = rendererCss.indexOf(SHARED_END);
  if (from < 0 || to < 0 || to < from) {
    throw new Error('the shared document markers are missing from src/renderer/styles.css');
  }
  // The colours the document rules refer to live in the app's theme blocks:
  // `:root` for what never changes, `:root, [data-theme="light"]` for the
  // light palette, and `[data-theme="dark"]` for the dark one. They come
  // across scoped to .markdown-body, so the document is coloured exactly like
  // the app's while the site keeps its own palette for everything around it.
  const varsOf = (selector) => {
    const at = rendererCss.indexOf(selector);
    if (at < 0) throw new Error(`${selector} is missing from src/renderer/styles.css`);
    const open = rendererCss.indexOf('{', at);
    const close = rendererCss.indexOf(`\n}`, open);
    if (open < 0 || close < 0) throw new Error(`${selector} is not a block`);
    return rendererCss.slice(open + 1, close)
      .split('\n')
      .filter((line) => /^\s*--/.test(line))
      .join('\n');
  };

  const header = [
    '/* Generated by scripts/build.js from src/renderer/styles.css. Do not edit:',
    '   change the document rules there and both the app and the web view follow. */',
    '',
  ].join('\n');
  // Dark arrives two ways and they are not the same selector: chosen, which
  // puts data-theme="dark" on the root, and inherited from the system, which
  // puts nothing there at all. A rule written for only one of them leaves the
  // document light while the page around it is dark — which is what happened.
  //
  // So every palette, and the base theme, is written three times in this
  // order: light, chosen dark, then system dark inside a media query. Light
  // goes first so the two darks override it, and the system-dark rule carries
  // :not([data-theme="light"]) so that choosing light on a dark system wins.
  const themeRules = (name, light, dark) => {
    const on = name ? `[data-palette="${name}"]` : '';
    const out = [];
    if (light.trim()) out.push(`:root${on} .markdown-body {\n${light}\n}`);
    if (dark.trim()) {
      out.push(`:root[data-theme="dark"]${on} .markdown-body {\n${dark}\n}`);
      out.push(`@media (prefers-color-scheme: dark) {\n`
        + `:root:not([data-theme="light"])${on} .markdown-body {\n${dark}\n}\n}`);
    }
    return out.join('\n');
  };

  const palettes = [];
  const byPalette = new Map();
  for (const m of rendererCss.matchAll(/^\[data-theme="(light|dark)"\]\[data-palette="([a-z]+)"\] \{/gm)) {
    const [, mode, name] = m;
    const row = byPalette.get(name) || { light: '', dark: '' };
    row[mode] = varsOf(m[0]);
    byPalette.set(name, row);
  }
  for (const [name, row] of byPalette) palettes.push(themeRules(name, row.light, row.dark));

  const theme = [
    // The measurements and fonts do not change with the theme.
    `.markdown-body {\n${varsOf(':root {')}\n}`,
    '',
    themeRules(null, varsOf(':root,'), varsOf('[data-theme="dark"] {')),
    '',
    palettes.join('\n'),
  ].join('\n');

  fs.writeFileSync(path.join(WEB_OUT, 'web-doc.css'),
    `${header}\n${theme}\n\n${rendererCss.slice(from, to).trimEnd()}\n`);

  const webSize = fs.statSync(path.join(WEB_OUT, 'web.js')).size;
  const cssSize = fs.statSync(path.join(WEB_OUT, 'web-doc.css')).size;
  console.log(`web view built — site/assets/web.js ${(webSize / 1024).toFixed(0)} KB, `
    + `web-doc.css ${(cssSize / 1024).toFixed(0)} KB`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
