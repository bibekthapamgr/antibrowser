import '@pb/ui/tokens.css';
import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { demoBackend } from './backend/demo.ts';
import { tauriBackend } from './backend/tauri.ts';

// Inside the desktop shell the UI talks to Rust over IPC; in a plain browser (development, UI tests) it uses the
// in-memory demo backend. The installed app never loads remote content, so the demo path is never reachable there.
const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const demoMode = new URLSearchParams(window.location.search).get('demo') ?? '';
const backend = inTauri ? tauriBackend() : demoBackend(demoMode);
// Exposed for UI tests only in demo mode.
if (!inTauri) (window as unknown as { __pbDemo: unknown }).__pbDemo = backend;

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App backend={backend} />
    </StrictMode>,
  );
}
