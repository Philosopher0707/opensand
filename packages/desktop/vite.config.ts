import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import path from 'node:path';

// Preact renderer. Output lands in dist/renderer-next, which DesktopServer
// serves by default; OPENSAND_RENDERER=legacy keeps renderer/app.js reachable.
export default defineConfig({
  root: path.resolve(import.meta.dirname, 'renderer-next'),
  base: './',
  plugins: [preact()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/renderer-next'),
    emptyOutDir: true,
    // The CSP is script-src 'self'; keep the preload polyfill out of inline code.
    modulePreload: { polyfill: false },
  },
});
