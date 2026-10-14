import '@pb/ui/tokens.css';
import './portal.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { httpApi, type PortalApi } from './api.ts';

// Demo builds (`vite build --mode demo`, UI tests and screenshots only) use an in-memory stand-in; the code is left
// out of the real build entirely, which talks to /v1 on its own origin with the session cookie.
async function pickApi(): Promise<PortalApi> {
  if (import.meta.env.MODE === 'demo') {
    const { demoApi } = await import('./demo.ts');
    const api = demoApi(new URLSearchParams(window.location.search).get('demo') ?? '');
    (window as unknown as { __pbPortalDemo: unknown }).__pbPortalDemo = api.controls;
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
