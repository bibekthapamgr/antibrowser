import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri expects a fixed dev port and a relative, self-contained production bundle (no CDN assets: the CSP
// in src-tauri/tauri.conf.json only allows 'self').
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
