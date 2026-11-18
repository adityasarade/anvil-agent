// Bundles the extension host code (Node, CJS) and the agent-panel webview (browser, IIFE).
import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extension = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
};

async function copyAssets() {
  await mkdir('dist', { recursive: true });
  await copyFile('src/webview/panel.css', 'dist/webview.css').catch(() => {});
}

if (watch) {
  const a = await esbuild.context(extension);
  const b = await esbuild.context(webview);
  await copyAssets();
  await Promise.all([a.watch(), b.watch()]);
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
  await copyAssets();
}
