/**
 * What the support console needs from the server, and the real implementation over /v1/support (same origin). The
 * staff token lives in this closure only — not in storage — so a reload or a closed tab ends the session; the
 * server ends it after 30 minutes anyway.
 */

import type {
  AdminCatalog,
  AdminCustomerDetail,
  AdminCustomers,
  AdminCustomersQuery,
  AdminMe,
  AdminMetrics,
  AdminOperations,
  AdminStaff,
  CatalogPublication,
  PlanDraft,
  PlanDraftCreate,
  PlanDraftUpdate,
  Restriction,
  RestrictionCreate,
  SupportNote,
} from '@pb/contracts/admin';
import type {
  AccessRequest,
  AccessRequestCreate,
  AuditExport,
  BillingAlert,
  ConsoleConfig,
  Override,
  OverrideCreate,
  PlatformAuditEntry,
  StaffRole,
  StaffSession,
  SupportActivityEntry,
  SupportMember,
  SupportOrgOverview,
  SupportSearchResult,
} from '@pb/contracts/billing';
import { CONSOLE_PATH } from '@pb/contracts/billing';
import { beginSignIn, completeSignIn, isCallback, SignInError } from './oidc.ts';

export interface Staff {
  user_id: string;
  display_name: string;
  roles: StaffRole[];
}

export interface Session {
  staff: Staff;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

export class ConsoleError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;
  constructor(
    code: string,
    message: string,
    status = 0,
    details: Record<string, unknown> = {},
    requestId: string | null = null,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }
}

export interface ConsoleApi {
  /** Demo builds only: shown on the sign-in screen. */
  readonly demo: boolean;
  /** Starts sign-in (the real console leaves the page for the identity provider). */
  signIn(): Promise<Session | null>;
  /** On the provider's redirect back: finishes sign-in. Otherwise null. */
  resume(): Promise<Session | null>;
  signOut(): Promise<void>;
  search(q: string): Promise<SupportSearchResult>;
  org(orgId: string): Promise<SupportOrgOverview>;
  overrides(orgId: string): Promise<Override[]>;
  addOverride(orgId: string, body: OverrideCreate): Promise<Override>;
  revokeOverride(id: string): Promise<Override>;
  resync(orgId: string): Promise<boolean>;
  requestAccess(orgId: string, body: AccessRequestCreate): Promise<AccessRequest>;
  accessRequests(pendingOnly: boolean): Promise<AccessRequest[]>;
  decide(id: string, decision: 'approve' | 'deny'): Promise<AccessRequest>;
  revokeAccess(id: string): Promise<AccessRequest>;
  members(orgId: string): Promise<SupportMember[]>;
  activity(orgId: string): Promise<SupportActivityEntry[]>;
  alerts(openOnly: boolean): Promise<BillingAlert[]>;
  resolveAlert(id: string): Promise<BillingAlert>;
  audit(orgId?: string): Promise<PlatformAuditEntry[]>;
  /** Milestone 12: the hash-chained audit in chain order (support leads). */
  auditExport(afterSeq?: string): Promise<AuditExport>;
  /** Milestone 12: break-glass only. */
  revokeApiTokens(orgId: string, reason: string): Promise<number>;
  // R5: business administration (/v1/admin). Every call names a staff permission on the server and needs MFA.
  adminMe(): Promise<AdminMe>;
  metrics(): Promise<AdminMetrics>;
  customers(q: AdminCustomersQuery): Promise<AdminCustomers>;
  customer(orgId: string): Promise<AdminCustomerDetail>;
  addNote(orgId: string, body: string): Promise<SupportNote>;
  restrict(body: RestrictionCreate): Promise<Restriction>;
  liftRestriction(id: string, reason: string): Promise<Restriction>;
  adminResync(orgId: string): Promise<boolean>;
  catalog(): Promise<AdminCatalog>;
  createDraft(body: PlanDraftCreate): Promise<PlanDraft>;
  updateDraft(id: string, body: PlanDraftUpdate): Promise<PlanDraft>;
  discardDraft(id: string, revision: number): Promise<PlanDraft>;
  publishDraft(id: string, revision: number): Promise<CatalogPublication>;
  operations(): Promise<AdminOperations>;
  retryEmail(id: string): Promise<boolean>;
  requestRelease(body: { action: string; version?: string; reason: string }): Promise<{ id: string }>;
  staffList(): Promise<AdminStaff>;
}

const enc = encodeURIComponent;

export function httpApi(): ConsoleApi {
  let token: string | null = null;
  const redirectUri = `${window.location.origin}${CONSOLE_PATH}`;

  async function call<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    auth = true,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      if (!token) throw new ConsoleError('UNAUTHENTICATED', 'Sign in again', 401);
      headers.authorization = `Bearer ${token}`;
    }
    let res: Response;
    try {
      res = await fetch(`/v1${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch {
      throw new ConsoleError('OFFLINE', 'The server could not be reached');
    }
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      if (res.status === 401) token = null;
      throw new ConsoleError(
        typeof json?.code === 'string' ? json.code : 'HTTP_ERROR',
        typeof json?.message === 'string' ? json.message : `The server answered ${res.status}`,
        res.status,
        (json?.safe_details as Record<string, unknown>) ?? {},
        typeof json?.request_id === 'string' ? json.request_id : null,
      );
    }
    return json as T;
  }

  const config = () => call<ConsoleConfig>('GET', '/support/auth/config', undefined, false);

  return {
    demo: false,
    async signIn() {
      const target = await beginSignIn(await config(), window.sessionStorage, redirectUri);
      window.location.assign(target);
      return null;
    },
    async resume() {
      const search = window.location.search;
      if (!isCallback(search)) return null;
      // The code and state leave the address bar (and history) before anything else happens.
      window.history.replaceState(null, '', CONSOLE_PATH);
      try {
        const { idToken, nonce } = await completeSignIn(await config(), window.sessionStorage, search);
        const s = await call<StaffSession>('POST', '/support/sessions', { id_token: idToken, nonce }, false);
        token = s.access_token;
        return { staff: s.staff, expiresAt: Date.now() + s.expires_in * 1000 };
      } catch (e) {
        if (e instanceof SignInError) throw new ConsoleError('SIGN_IN_FAILED', e.message);
        throw e;
      }
    },
    async signOut() {
      if (token) await call('POST', '/support/sign-out').catch(() => undefined);
      token = null;
    },
    search: (q) => call('GET', `/support/orgs?q=${enc(q)}`),
    org: (orgId) => call('GET', `/support/orgs/${enc(orgId)}`),
    overrides: async (orgId) =>
      (await call<{ items: Override[] }>('GET', `/support/orgs/${enc(orgId)}/overrides`)).items,
    addOverride: (orgId, body) => call('POST', `/support/orgs/${enc(orgId)}/overrides`, body),
    revokeOverride: (id) => call('POST', `/support/overrides/${enc(id)}/revoke`),
    resync: async (orgId) =>
      (await call<{ queued: boolean }>('POST', `/support/orgs/${enc(orgId)}/billing/resync`)).queued,
    requestAccess: (orgId, body) => call('POST', `/support/orgs/${enc(orgId)}/access-requests`, body),
    accessRequests: async (pendingOnly) =>
      (
        await call<{ items: AccessRequest[] }>(
          'GET',
          `/support/access-requests${pendingOnly ? '?state=pending' : ''}`,
        )
      ).items,
    decide: (id, decision) => call('POST', `/support/access-requests/${enc(id)}/decision`, { decision }),
    revokeAccess: (id) => call('POST', `/support/access-requests/${enc(id)}/revoke`),
    members: async (orgId) =>
      (await call<{ items: SupportMember[] }>('GET', `/support/orgs/${enc(orgId)}/members`)).items,
    activity: async (orgId) =>
      (await call<{ items: SupportActivityEntry[] }>('GET', `/support/orgs/${enc(orgId)}/activity`)).items,
    alerts: async (openOnly) =>
      (await call<{ items: BillingAlert[] }>('GET', `/support/alerts${openOnly ? '?open=true' : ''}`)).items,
    resolveAlert: (id) => call('POST', `/support/alerts/${enc(id)}/resolve`),
    audit: async (orgId) =>
      (
        await call<{ items: PlatformAuditEntry[] }>(
          'GET',
          `/support/audit${orgId ? `?org_id=${enc(orgId)}` : ''}`,
        )
      ).items,
    auditExport: (afterSeq) =>
      call('GET', `/support/audit/export?limit=5000${afterSeq ? `&after_seq=${enc(afterSeq)}` : ''}`),
    adminMe: () => call('GET', '/admin/me'),
    metrics: () => call('GET', '/admin/metrics'),
    customers: (q) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') qs.set(k, String(v));
      return call('GET', `/admin/customers${qs.size ? `?${qs}` : ''}`);
    },
    customer: (orgId) => call('GET', `/admin/customers/${enc(orgId)}`),
    addNote: (orgId, body) => call('POST', `/admin/customers/${enc(orgId)}/notes`, { body }),
    restrict: (body) => call('POST', '/admin/restrictions', body),
    liftRestriction: (id, reason) => call('POST', `/admin/restrictions/${enc(id)}/lift`, { reason }),
    adminResync: async (orgId) =>
      (await call<{ queued: boolean }>('POST', `/admin/customers/${enc(orgId)}/resync`)).queued,
    catalog: () => call('GET', '/admin/catalog'),
    createDraft: (body) => call('POST', '/admin/plan-drafts', body),
    updateDraft: (id, body) => call('PUT', `/admin/plan-drafts/${enc(id)}`, body),
    discardDraft: (id, revision) => call('POST', `/admin/plan-drafts/${enc(id)}/discard`, { revision }),
    publishDraft: (id, revision) => call('POST', `/admin/plan-drafts/${enc(id)}/publish`, { revision }),
    operations: () => call('GET', '/admin/operations'),
    retryEmail: async (id) =>
      (await call<{ queued: boolean }>('POST', `/admin/email/${enc(id)}/retry`)).queued,
    requestRelease: (body) => call('POST', '/admin/release-requests', body),
    staffList: () => call('GET', '/admin/staff'),
    revokeApiTokens: async (orgId, reason) =>
      (
        await call<{ revoked_api_tokens: number }>(
          'POST',
          `/support/orgs/${enc(orgId)}/emergency/revoke-api-tokens`,
          { reason },
        )
      ).revoked_api_tokens,
  };
}
