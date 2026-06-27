'use strict';

const esbuild = require('esbuild');
const fs      = require('fs');
const path    = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC  = path.join(ROOT, 'src');
const OUT  = path.join(ROOT, 'bundled');

// Clean
if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'renderer'), { recursive: true });

const external = [
  'electron', 'chokidar', 'electron-log',
  'electron-store', 'electron-updater', 'node-fetch', 'fsevents'
];

// 1. Main process
console.log('Bundling main process...');
esbuild.buildSync({
  entryPoints: [path.join(SRC, 'main.js')],
  bundle:   true,
  platform: 'node',
  target:   'node18',
  external,
  outfile:  path.join(OUT, 'main.js'),
  format:   'cjs',
  define:   { 'process.env.NODE_ENV': '"production"' }
});
console.log('  OK: bundled/main.js');

// 2. Preload
console.log('Bundling preload...');
esbuild.buildSync({
  entryPoints: [path.join(SRC, 'preload.js')],
  bundle:   true,
  platform: 'node',
  target:   'node18',
  external: ['electron'],
  outfile:  path.join(OUT, 'preload.js'),
  format:   'cjs'
});
console.log('  OK: bundled/preload.js');

// 3. Renderer — copy index.html as-is (JS is already inline)
console.log('Copying renderer...');
fs.copyFileSync(
  path.join(SRC, 'renderer', 'index.html'),
  path.join(OUT, 'renderer', 'index.html')
);
console.log('  OK: bundled/renderer/index.html');

console.log('\nBundle complete.');
