/** Shared pieces of the portal: loading with real states, messages for API errors, money and dates. */
import type { Permission, Role } from '@pb/contracts/resources';
import { ROLE_PERMISSIONS } from '@pb/contracts/resources';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api.ts';

export const can = (role: Role | null | undefined, p: Permission) =>
  !!role && ROLE_PERMISSIONS[role].includes(p);

export const ROLE_NAME: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  operator: 'Member',
  viewer: 'Viewer',
  billing: 'Billing manager',
};

const MESSAGES: Record<string, string> = {
  NETWORK: 'The server cannot be reached. Check your connection and try again.',
  EMAIL_NOT_VERIFIED: 'Verify your e-mail address first (the link is in your inbox), then sign in again.',
  ACCOUNT_SUSPENDED: 'A workspace cannot be created for this address. Contact support.',
  RATE_LIMITED: 'Too many attempts. Please wait a few minutes and try again.',
  INVITATION_WRONG_ACCOUNT:
    'This invitation was sent to a different e-mail address. Sign out and sign in with the invited address.',
  INVITATION_EXPIRED: 'This invitation has expired or was withdrawn. Ask for a new one.',
  INVITATION_USED: 'This invitation was already used.',
  WORKSPACE_SUSPENDED: 'This workspace is suspended. Nothing was deleted; contact support.',
  PLAN_LIMIT_REACHED: 'This workspace has reached its plan limit. An owner can change the plan in Billing.',
  TERMS_REQUIRED: 'The terms changed. Please review and accept them again.',
  ALREADY_SUBSCRIBED: 'This workspace already has a subscription. Change it with “Manage payment and plan”.',
  PLAN_NOT_AVAILABLE: 'This plan or billing period cannot be bought right now. Please try again later.',
  BILLING_UNAVAILABLE: 'Payments are not available right now. Nothing was charged; please try again later.',
  UNAUTHENTICATED: 'Your session ended. Sign in again.',
  FORBIDDEN: 'Your role in this workspace does not allow this.',
  VERSION_CONFLICT: 'Someone else changed this meanwhile. Reload and try again.',
  LAST_OWNER: 'A workspace must keep at least one owner.',
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return MESSAGES[err.code] ?? err.message;
  return 'Something went wrong. Please try again.';
}

/** Loads data with explicit loading / error / ready states; `reload` fetches again; stale answers are ignored. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: callers pass their own dependency list
  useEffect(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    load().then(
      (data) => mine === seq.current && setState({ data, error: null, loading: false }),
      (error) => mine === seq.current && setState((s) => ({ data: s.data, error, loading: false })),
    );
  }, [...deps, nonce]);
  return { ...state, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

export function Loading({ what = 'Loading…' }: { what?: string }) {
  return (
    <p role="status" className="muted">
      {what}
    </p>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div role="alert" className="notice notice--error">
      <p>{errorText(error)}</p>
      {retry && (
        <button type="button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Card({ children, title, id }: { children: ReactNode; title?: string; id?: string }) {
  return (
    <section className="card" aria-labelledby={title ? id : undefined}>
      {title && <h2 id={id}>{title}</h2>}
      {children}
    </section>
  );
}

export function money(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(
      amountMinor / 100,
    );
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export const TAX_TEXT: Record<string, string> = {
  inclusive: 'tax included',
  exclusive: 'plus applicable tax',
  automatic: 'tax calculated at checkout from your address',
  unspecified: 'plus any applicable tax',
};

export function day(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function bytes(n: number | null): string {
  if (n === null) return 'unlimited';
  const gib = n / 1024 ** 3;
  return gib >= 1 ? `${Math.round(gib)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

export const limitText = (n: number | null, unit: string) =>
  n === null ? `Unlimited ${unit}` : `${n} ${unit}`;

/** Focus the page heading after navigation, so screen readers announce the new page. */
export function usePageHeading(title: string) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} · Your account`;
    ref.current?.focus();
  }, [title]);
  return ref;
}
