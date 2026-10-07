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
const NM = path.join(ROOT, 'node_modules');
const release = process.argv.includes('--release');

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
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
