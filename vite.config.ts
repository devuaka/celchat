import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const HUB = process.env.HUB_DEV_URL || 'http://localhost:8781';

/** Production builds get a strict CSP meta tag (the hub also sends it as a header). */
const csp = (): Plugin => ({
  name: 'celchat-csp',
  apply: 'build',
  transformIndexHtml(html) {
    const policy = [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "media-src 'self' blob: data:",
      "font-src 'self' blob: data:",
      'connect-src *',
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ');
    return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
  },
});

export default defineConfig({
  // relative paths: the same build runs at /, at /celchat/ on GitHub Pages and inside the desktop app
  base: process.env.VITE_BASE || './',
  root: fileURLToPath(new URL('./client', import.meta.url)),
  publicDir: fileURLToPath(new URL('./client/public', import.meta.url)),
  plugins: [react(), csp()],
  resolve: { alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) } },
  server: {
    port: 8780,
    strictPort: true,
    host: true,
    proxy: {
      '/ws': { target: HUB.replace(/^http/, 'ws'), ws: true },
      '/api': { target: HUB, changeOrigin: false },
    },
  },
  preview: { port: 8782, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
