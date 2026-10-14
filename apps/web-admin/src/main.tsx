import '@pb/ui/tokens.css';
import './console.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { type ConsoleApi, httpApi } from './api.ts';

// Demo builds (`vite build --mode demo`, UI tests only) use an in-memory stand-in; the code is left out of the real
// build entirely, which talks to /v1/support on its own origin.
async function pickApi(): Promise<ConsoleApi> {
  if (import.meta.env.MODE === 'demo') {
    const { demoApi } = await import('./demo.ts');
    const api = demoApi(new URLSearchParams(window.location.search).get('as') ?? 'all');
    (window as unknown as { __pbConsoleDemo: unknown }).__pbConsoleDemo = api.controls;
    return api;
  }
  return httpApi();
}

const root = document.getElementById('root');
if (root) {
  void pickApi().then((api) =>
    createRoot(root).render(
      <StrictMode>
        <App api={api} />
      </StrictMode>,
    ),
  );
}
