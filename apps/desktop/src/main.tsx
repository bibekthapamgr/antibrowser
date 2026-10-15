import '@pb/ui/tokens.css';
import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { tauriBackend } from './backend/tauri.ts';
import type { Backend } from './backend/types.ts';

// Inside the desktop shell the UI talks to Rust over IPC. The in-memory demo backend (development server and UI tests)
// exists only in demo builds (`vite --mode demo` / `build:demo` → dist-demo): R7 retirement gate, the production
// bundle carries no demo data or demo code (scripts/ci/check-production-bundles.mjs proves it on every build).
const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const DEMO_BUILD = import.meta.env.MODE === 'demo' || import.meta.env.DEV;

async function pickBackend(): Promise<Backend | null> {
  if (inTauri) return tauriBackend();
  if (DEMO_BUILD) {
    const { demoBackend } = await import('./backend/demo.ts');
    const backend = demoBackend(new URLSearchParams(window.location.search).get('demo') ?? '');
    // Exposed for UI tests only in demo builds.
    (window as unknown as { __pbDemo: unknown }).__pbDemo = backend;
    return backend;
  }
  return null;
}

const root = document.getElementById('root');
if (root) {
  void pickBackend().then((backend) => {
    if (!backend) {
      root.textContent = 'This page is part of the Project Browser desktop app and only works inside it.';
      return;
    }
    createRoot(root).render(
      <StrictMode>
        <App backend={backend} />
      </StrictMode>,
    );
  });
}
