import '@pb/ui/tokens.css';
import { ClientBadge } from '@pb/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

function AdminShell() {
  return (
    <main style={{ maxWidth: 720, margin: '48px auto', padding: '0 16px' }}>
      <h1>Admin console</h1>
      <p style={{ color: 'var(--pb-text-muted)' }}>
        Placeholder shell. Organization, member and billing administration arrive in milestones 06 and 11 and
        use the same /v1 API and design tokens as the desktop manager.
      </p>
      <p>
        Client marker example: <ClientBadge label="Client North" />
      </p>
    </main>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AdminShell />
    </StrictMode>,
  );
}
