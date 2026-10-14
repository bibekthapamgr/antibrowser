import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `vite build` makes the customer portal the API serves at /app/ (WEB_DIR). `--mode demo` makes a build with an
// in-memory stand-in for the API, for UI tests and screenshots only (dist-demo/, never deployed).
export default defineConfig(({ mode }) => ({
  base: '/app/',
  plugins: [react()],
  server: { port: 5175, strictPort: true, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    outDir: mode === 'demo' ? 'dist-demo' : 'dist',
    emptyOutDir: true,
    // No inline scripts or styles: the portal's CSP allows only its own files.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
}));
