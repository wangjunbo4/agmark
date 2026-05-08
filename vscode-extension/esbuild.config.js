const esbuild = require('esbuild');
const path = require('path');

const isWatch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  platform: 'node',
  target: 'node10',
  format: 'cjs',
  sourcemap: true,
  minify: false,
};

const webviewConfig = {
  entryPoints: ['src/webview/App.ts'],
  bundle: true,
  outfile: 'dist/webview.js',
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  sourcemap: true,
  minify: false,
  external: [],
};

async function build() {
  try {
    const ctxs = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
    ]);

    if (isWatch) {
      await Promise.all(ctxs.map((ctx) => ctx.watch()));
      console.log('[AgentMark] Watching for changes...');
    } else {
      await Promise.all(ctxs.map((ctx) => ctx.rebuild()));
      console.log('[AgentMark] Build complete');
      await Promise.all(ctxs.map((ctx) => ctx.dispose()));
    }
  } catch (e) {
    console.error('[AgentMark] Build failed:', e);
    process.exit(1);
  }
}

build();
