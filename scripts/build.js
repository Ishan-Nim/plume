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

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(SRC, 'app.js')],
    outfile: path.join(OUT, 'renderer.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome130',
    minify: release,
    sourcemap: release ? false : 'linked',
    legalComments: release ? 'none' : 'inline',
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

  const size = fs.statSync(path.join(OUT, 'renderer.js')).size;
  console.log(`renderer built (${release ? 'release' : 'dev'}) — renderer.js ${(size / 1024).toFixed(0)} KB`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
