#!/usr/bin/env node
'use strict';

/**
 * Gamescan bundler
 * ----------------
 * Uses esbuild to bundle all main-process JS into bundled/main.js
 * and copies + inlines the renderer into bundled/renderer/index.html
 *
 * Output:
 *   bundled/
 *     main.js          ← all of src/main.js + scanner/* + api.js merged
 *     preload.js       ← copied as-is (must stay separate for Electron security)
 *     renderer/
 *       index.html     ← index.html with app.js inlined (no external script tag)
 */

const esbuild = require('esbuild');
const fs      = require('fs');
const path    = require('path');

const ROOT    = path.resolve(__dirname, '..');
const SRC     = path.join(ROOT, 'src');
const OUT     = path.join(ROOT, 'bundled');

// ── Clean output dir ──────────────────────────────────────────────────────────
if (fs.existsSync(OUT)) rmDir(OUT);
fs.mkdirSync(path.join(OUT, 'renderer'), { recursive: true });

// ── 1. Bundle main process ────────────────────────────────────────────────────
console.log('⚡ Bundling main process…');
esbuild.buildSync({
  entryPoints: [path.join(SRC, 'main.js')],
  bundle:      true,
  platform:    'node',
  target:      'node18',
  external:    [
    'electron',
    // Native modules — must stay external
    'chokidar', 'electron-log', 'electron-store', 'electron-updater', 'node-fetch',
    'fsevents',
  ],
  outfile:     path.join(OUT, 'main.js'),
  sourcemap:   false,
  minify:      false,  // keep readable for debugging
  format:      'cjs',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});
console.log('  ✓ bundled/main.js');

// ── 2. Copy preload (must remain a separate file) ─────────────────────────────
console.log('⚡ Processing preload…');
esbuild.buildSync({
  entryPoints: [path.join(SRC, 'preload.js')],
  bundle:      true,
  platform:    'node',
  target:      'node18',
  external:    ['electron'],
  outfile:     path.join(OUT, 'preload.js'),
  sourcemap:   false,
  minify:      false,
  format:      'cjs',
});
console.log('  ✓ bundled/preload.js');

// ── 3. Inline renderer (app.js → inside index.html) ──────────────────────────
console.log('⚡ Inlining renderer…');

// Bundle app.js (browser target — no require(), pure ES)
const rendererResult = esbuild.buildSync({
  entryPoints: [path.join(SRC, 'renderer', 'app.js')],
  bundle:      false,   // app.js has no imports; just process it
  platform:    'browser',
  target:      'chrome114',
  write:       false,   // capture output in memory
  sourcemap:   false,
  minify:      false,
  format:      'iife',
});

const appJsContent = rendererResult.outputFiles[0].text;

// Read index.html and replace <script src="app.js"></script> with inlined script
let html = fs.readFileSync(path.join(SRC, 'renderer', 'index.html'), 'utf8');
html = html.replace(
  '<script src="app.js"></script>',
  `<script>\n${appJsContent}\n</script>`
);

fs.writeFileSync(path.join(OUT, 'renderer', 'index.html'), html, 'utf8');
console.log('  ✓ bundled/renderer/index.html  (app.js inlined)');

// ── Done ──────────────────────────────────────────────────────────────────────
console.log('\n✅ Bundle complete → bundled/\n');
printTree(OUT, '');

// ── Helpers ───────────────────────────────────────────────────────────────────
function rmDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.lstatSync(full).isDirectory()) rmDir(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(dir);
}

function printTree(dir, prefix) {
  const entries = fs.readdirSync(dir);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const full  = path.join(dir, entry);
    const isLast = i === entries.length - 1;
    const branch = isLast ? '└── ' : '├── ';
    const stat = fs.statSync(full);
    const size = stat.isFile() ? ` (${(stat.size / 1024).toFixed(1)} KB)` : '';
    console.log(`  ${prefix}${branch}${entry}${size}`);
    if (stat.isDirectory()) {
      printTree(full, prefix + (isLast ? '    ' : '│   '));
    }
  }
}
