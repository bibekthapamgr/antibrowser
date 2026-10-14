/**
 * In-memory stand-in for the API the portal uses (demo builds only: UI tests and screenshots, never deployed). It
 * follows the server's rules closely enough for the screens: roles, one checkout per workspace, a payment that is
 * "pending verification" until the provider's confirmation arrives, invitations bound to an address.
 *
 * Modes (`?demo=`, space-separated): `signedin` (an owner on a trial), `member` (a Member of Demo Agency with 10
 * shared profiles), `new` (signed in, never onboarded: terms), `invite` (an invitation for this person waiting),
 * `delay` (the payment confirmation takes long), `available` (a stable desktop release exists), `noprices` (the
 * provider's prices cannot be verified).
 */
import { ApiError, type Method, type PortalApi } from './api.ts';

type Obj = Record<string, unknown>;
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const rid = (p: string) =>
  `${p}_${Array.from({ length: 26 }, () => CROCK[Math.floor(Math.random() * 32)]).join('')}`;
const now = () => new Date().toISOString();
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const TOKEN = 'DemoInvitationToken_abcdefghijklmnopqrstuvw';

interface Org {
  id: string;
  name: string;
  role: string;
  plan: { id: string; name: string };
  state: string;
  hasSub: boolean;
  profiles: { id: string; name: string }[];
  members: { user_id: string; display_name: string; email: string; role: string }[];
  invitations: { id: string; email: string; role: string; status: string; expires_at: string }[];
  checkout: { state: string; plan_id: string; interval: string; url: string } | null;
}

export function demoApi(mode: string) {
  const has = (m: string) => mode.split(/\s+/).includes(m);
  const me = {
    id: rid('usr'),
    display_name: 'Demo Person',
    email: 'demo.person@example.test',
    email_verified: true,
  };
  let signedIn = has('signedin') || has('member') || has('new') || has('invite');
  let onboarded = has('signedin') || has('member');
  const orgs: Org[] = [];
  const team = (name: string, role: string, n: number): Org => ({
    id: rid('org'),
    name,
    role,
    plan: { id: 'trial', name: 'Trial' },
    state: 'trial',
    hasSub: false,
    profiles: Array.from({ length: n }, (_, i) => ({
      id: rid('prf'),
      name: `Profile ${String(i + 1).padStart(2, '0')}`,
    })),
    members: [{ user_id: me.id, display_name: me.display_name, email: me.email, role }],
    invitations: [],
    checkout: null,
  });
  if (has('signedin')) {
    const o = team('Bibek Studio', 'owner', 3);
    o.members.push({
      user_id: rid('usr'),
      display_name: 'Sam Operator',
      email: 'sam@example.test',
      role: 'operator',
    });
    orgs.push(o);
  }
  if (has('member')) {
    const o = team('Demo Agency', 'operator', 10);
    o.members.unshift({
      user_id: rid('usr'),
      display_name: 'Ann Owner',
      email: 'ann@example.test',
      role: 'owner',
    });
    orgs.push(o);
  }
  const inviteOrg = team('Demo Agency', 'owner', 50);
  let defaultOrg: string | null = orgs[0]?.id ?? null;
  let terms = onboarded;
  const devices = [
    {
      id: rid('dev'),
      name: 'Office PC',
      platform: 'windows-x64',
      created_at: days(-20),
      last_seen_at: days(-1),
      revoked_at: null as string | null,
      current: false,
    },
    {
      id: rid('dev'),
      name: 'MacBook Air',
      platform: 'macos-arm64',
      created_at: days(-5),
      last_seen_at: now(),
      revoked_at: null as string | null,
      current: false,
    },
  ];
  const prefs = { marketing: false, billing_reminders: true };
  let deletion: { state: string; created_at: string; decided_at: string | null } | null = null;
  const navigated: string[] = [];
  let pendingPayment: Org | null = null;

  const fail = (status: number, code: string, message: string, details: Obj = {}): never => {
    throw new ApiError(status, code, message, details);
  };
  const orgOf = (id: string) =>
    orgs.find((o) => o.id === id) ?? fail(404, 'NOT_FOUND', 'Organization not found');
  const page = <T>(items: T[]) => ({ items, next_cursor: null });
  const status = () => ({
    state: onboarded ? 'ready' : has('invite') ? 'invited' : 'new',
    default_org_id: defaultOrg,
    bootstrap_org_id: null,
    workspaces: orgs.map((o) => ({ org_id: o.id, name: o.name, role: o.role, suspended: false })),
    email_verified: true,
    terms: { current_version: '2026-10-14', accepted_version: terms ? '2026-10-14' : null },
    marketing_consent: prefs.marketing,
    plan_intent: null,
    pending_invitations: [],
    trial_available: true,
    pending_tasks: [],
  });
  const PRICES: Record<string, { month: number; year?: number }> = {
    starter: { month: 1900 },
    team: { month: 4900, year: 49000 },
    agency: { month: 14900 },
  };
  const LIMITS: Record<string, { profiles: number; seats: number }> = {
    trial: { profiles: 100, seats: 5 },
    starter: { profiles: 100, seats: 1 },
    team: { profiles: 500, seats: 5 },
    agency: { profiles: 2000, seats: 20 },
  };
  const limits = (plan: string) => ({
    profiles: LIMITS[plan]?.profiles ?? 100,
    seats: LIMITS[plan]?.seats ?? 5,
    storage_bytes: 10 * 1024 ** 3,
    automation_concurrency: 1,
  });
  const subscriptionOf = (o: Org) => {
    const seats = o.members.length + o.invitations.filter((i) => i.status === 'open').length;
    const l = limits(o.plan.id);
    return {
      org_id: o.id,
      plan: { id: o.plan.id, version: 1, name: o.plan.name },
      state: o.state,
      reason: o.state === 'trial' ? 'trial' : 'paid',
      until: o.state === 'trial' ? days(12) : null,
      trial_ends_at: o.state === 'trial' ? days(12) : null,
      current_period_end: o.hasSub ? days(30) : null,
      cancel_at_period_end: false,
      grace_until: null,
      has_provider_subscription: o.hasSub,
      limits: l,
      features: { team_sessions: true, automation: true, api_tokens: true, webhooks: true },
      usage: { profiles: o.profiles.length, seats, storage_bytes: 120 * 1024 ** 2, automation_running: 0 },
      over_limits: [
        ...(o.profiles.length > l.profiles ? ['profiles'] : []),
        ...(seats > l.seats ? ['seats'] : []),
      ],
      overrides: [],
      retention_days: null,
      synced_at: now(),
      checkout: o.checkout ? { ...o.checkout, created_at: now(), expires_at: days(1) } : null,
    };
  };
  const billingOf = (o: Org) => ({
    plan_id: o.plan.id,
    plan_name: o.plan.name,
    state: o.state,
    reason: o.state === 'trial' ? 'trial' : 'paid',
    until: o.state === 'trial' ? days(12) : null,
  });
  const confirm = (o: Org) => {
    if (!o.checkout) return;
    const id = o.checkout.plan_id;
    o.plan = { id, name: id[0]?.toUpperCase() + id.slice(1) };
    o.state = 'active';
    o.hasSub = true;
    o.checkout.state = 'completed';
  };

  const route = (method: Method, path: string, body: Obj): unknown => {
    const [p = '', q = ''] = path.split('?');
    const query = new URLSearchParams(q);
    const parts = p.split('/').filter(Boolean);
    if (p === '/web/config')
      return {
        brand: 'Project Browser',
        terms_version: '2026-10-14',
        terms_url: null,
        download_url: null,
        sign_in: true,
        account_url: 'https://auth.example.test/realms/pb/account/',
        status_url: null,
      };
    if (p === '/public/downloads')
      return has('available')
        ? {
            channel: 'stable',
            status: 'available',
            version: '0.13.0',
            published_at: days(-2),
            notes_url: 'https://github.com/bibekthapamgr/antibrowser/releases/tag/desktop-v0.13.0',
            platforms: [
              {
                platform: 'windows-x64',
                label: 'Windows 10 or 11 (64-bit, x64)',
                kind: 'installer',
                url: 'https://github.com/bibekthapamgr/antibrowser/releases/download/desktop-v0.13.0/Project.Browser_0.13.0_x64-setup.exe',
                sha256: 'a'.repeat(64),
                size_bytes: 9_000_000,
              },
              {
                platform: 'macos-arm64',
                label: 'macOS 13 or later on Apple silicon (M1 or newer)',
                kind: 'disk-image',
                url: 'https://github.com/bibekthapamgr/antibrowser/releases/download/desktop-v0.13.0/Project.Browser_0.13.0_aarch64.dmg',
                sha256: 'b'.repeat(64),
                size_bytes: null,
              },
            ],
            checked_at: now(),
          }
        : {
            channel: 'stable',
            status: 'not_available',
            version: null,
            published_at: null,
            notes_url: null,
            platforms: [],
            checked_at: now(),
          };
    if (!signedIn) return fail(401, 'UNAUTHENTICATED', 'Sign in again');
    if (p === '/web/auth/session') return { user: me, csrf_token: 'x'.repeat(43), expires_at: days(1) };
    if (p === '/web/auth/logout' || p === '/web/auth/revoke-all') {
      signedIn = false;
      return null;
    }
    if (p === '/onboarding/status') return status();
    if (p === '/onboarding/complete') {
      if (body.invitation_token) {
        if (!orgs.includes(inviteOrg)) {
          inviteOrg.members = [
            { user_id: rid('usr'), display_name: 'Ann Owner', email: 'ann@example.test', role: 'owner' },
            { user_id: me.id, display_name: me.display_name, email: me.email, role: 'operator' },
          ];
          inviteOrg.role = 'operator';
          inviteOrg.profiles = inviteOrg.profiles.slice(10, 20);
          orgs.push(inviteOrg);
        }
        onboarded = true;
        defaultOrg = inviteOrg.id;
        return { outcome: 'joined', status: status() };
      }
      if (!terms && !body.accept_terms_version) return { outcome: 'terms_required', status: status() };
      if (!orgs.length) {
        terms = true;
        const o = team(String(body.workspace_name ?? "Demo Person's workspace"), 'owner', 0);
        orgs.push(o);
        defaultOrg = o.id;
        onboarded = true;
        return { outcome: 'created', status: status() };
      }
      onboarded = true;
      return { outcome: 'existing', status: status() };
    }
    if (parts[0] === 'invitations' && parts[1] === TOKEN)
      return {
        org_name: 'Demo Agency',
        role: 'operator',
        expires_at: days(7),
        status: orgs.includes(inviteOrg) ? 'accepted' : 'open',
        for_this_account: true,
      };
    if (p === '/me/workspaces')
      return page(
        orgs.map((o) => ({
          kind: 'organization',
          org_id: o.id,
          name: o.name,
          role: o.role,
          profiles: o.profiles.length,
        })),
      );
    if (p === '/devices') return page(devices);
    if (parts[0] === 'devices' && parts[2] === 'revoke') {
      const d = devices.find((x) => x.id === parts[1]) ?? fail(404, 'NOT_FOUND', 'Device not found');
      d.revoked_at = now();
      return d;
    }
    if (p === '/me/notifications') {
      if (method === 'PUT') Object.assign(prefs, body);
      return prefs;
    }
    if (p === '/me/deletion-request') {
      if (method === 'POST') {
        if (body.confirm !== true) fail(400, 'VALIDATION_FAILED', 'Request failed validation');
        if (deletion?.state !== 'pending')
          deletion = { state: 'pending', created_at: now(), decided_at: null };
      }
      if (method === 'DELETE' && deletion?.state === 'pending')
        deletion = { ...deletion, state: 'withdrawn', decided_at: now() };
      return {
        request: deletion,
        sole_owner_of: orgs.filter((o) => o.role === 'owner').map((o) => ({ org_id: o.id, name: o.name })),
      };
    }
    if (parts[0] !== 'orgs' || !parts[1]) return fail(404, 'NOT_FOUND', 'Route not found');
    const o = orgOf(parts[1]);
    const sub = parts.slice(2).join('/');
    const owner = o.role === 'owner';
    const admin = owner || o.role === 'admin';
    if (sub === '')
      return {
        id: o.id,
        name: o.name,
        role: o.role,
        version: 1,
        created_at: days(-3),
        billing: billingOf(o),
      };
    if (sub.startsWith('billing') && !owner && o.role !== 'billing')
      return fail(403, 'FORBIDDEN', 'Your role does not allow this action');
    if (sub === 'billing/subscription') return subscriptionOf(o);
    if (sub === 'billing/plans')
      return {
        items: ['starter', 'team', 'agency'].map((id) => {
          const pr = has('noprices') ? undefined : PRICES[id];
          const prices = pr
            ? [
                {
                  interval: 'month',
                  amount_minor: pr.month,
                  currency: 'usd',
                  tax: 'exclusive',
                  verified_at: now(),
                },
                ...(pr.year
                  ? [
                      {
                        interval: 'year',
                        amount_minor: pr.year,
                        currency: 'usd',
                        tax: 'exclusive',
                        verified_at: now(),
                      },
                    ]
                  : []),
              ]
            : [];
          return {
            id,
            version: 1,
            name: id[0]?.toUpperCase() + id.slice(1),
            description:
              id === 'starter'
                ? 'One person.'
                : id === 'team'
                  ? 'A small team sharing profiles.'
                  : 'Larger teams and many clients.',
            limits: limits(id),
            features: { team_sessions: id !== 'starter', automation: true, api_tokens: true, webhooks: true },
            available: prices.length > 0,
            price: prices[0]
              ? { amount_minor: prices[0].amount_minor, currency: 'usd', interval: 'month' }
              : null,
            prices,
          };
        }),
      };
    if (sub === 'billing/invoices')
      return page(
        o.hasSub
          ? [
              {
                id: 'in_demo1',
                number: 'PB-0001',
                status: 'paid',
                currency: 'usd',
                amount_due_minor: 4900,
                amount_paid_minor: 4900,
                created_at: now(),
                period_start: now(),
                period_end: days(30),
                has_hosted_page: true,
                has_pdf: true,
              },
            ]
          : [],
      );
    if (sub === 'billing/invoices/in_demo1/links')
      return {
        hosted_url: 'https://invoice.stripe.com/i/demo',
        pdf_url: 'https://pay.stripe.com/invoice/demo/pdf',
      };
    if (sub === 'billing/checkout-session') {
      if (!owner) return fail(403, 'FORBIDDEN', 'Your role does not allow this action');
      if (o.hasSub) return fail(409, 'ALREADY_SUBSCRIBED', 'A subscription is already live');
      const plan = String(body.plan_id);
      const interval = String(body.interval ?? 'month');
      if (has('noprices') || !PRICES[plan] || (interval === 'year' && !PRICES[plan]?.year))
        return fail(409, 'PLAN_NOT_AVAILABLE', 'This plan is not offered on this server');
      if (!(o.checkout?.state === 'open' && o.checkout.plan_id === plan && o.checkout.interval === interval))
        o.checkout = {
          state: 'open',
          plan_id: plan,
          interval,
          url: `https://checkout.stripe.com/c/pay/cs_test_${rid('x').slice(2)}`,
        };
      return { url: o.checkout.url, expires_at: days(1) };
    }
    if (sub.startsWith('billing/portal-session')) {
      if (!owner) return fail(403, 'FORBIDDEN', 'Your role does not allow this action');
      return { url: 'https://billing.stripe.com/p/session/demo', expires_at: null };
    }
    if (sub === 'members')
      return admin
        ? page(o.members.map((m) => ({ ...m, version: 1, created_at: days(-3) })))
        : fail(403, 'FORBIDDEN', 'Your role does not allow this action');
    if (parts[2] === 'members' && parts[3] && method === 'DELETE') {
      o.members = o.members.filter((m) => m.user_id !== parts[3]);
      return null;
    }
    if (parts[2] === 'members' && parts[4] === 'access') return { items: [] };
    if (sub === 'invitations') {
      if (method === 'GET') return page(o.invitations);
      const inv = {
        id: rid('inv'),
        email: String(body.email),
        role: String(body.role),
        status: 'open',
        expires_at: days(7),
      };
      o.invitations.unshift(inv);
      return {
        invitation: { ...inv, created_at: now(), accepted_at: null },
        token: TOKEN,
        email_delivery: 'queued',
      };
    }
    if (parts[2] === 'invitations' && parts[4] === 'revoke') {
      const inv = o.invitations.find((i) => i.id === parts[3]);
      if (inv) inv.status = 'revoked';
      return inv;
    }
    if (sub === 'access/preview') {
      const scope = body.scope as { kind: string; profile_ids?: string[]; include_future?: boolean };
      const reach =
        scope.kind === 'profiles' ? o.profiles.filter((x) => scope.profile_ids?.includes(x.id)) : o.profiles;
      return {
        profile_count: reach.length,
        profiles: reach.slice(0, 50),
        includes_future: scope.kind !== 'profiles' && !!scope.include_future,
        capabilities: [...((body.capabilities as string[]) ?? ['launch'])].sort(),
      };
    }
    if (sub === 'profiles')
      return page(
        o.profiles.map((x) => ({
          ...x,
          org_id: o.id,
          client_id: null,
          notes: '',
          version: 1,
          snapshot_version: 0,
          last_snapshot_at: null,
          created_at: now(),
          updated_at: now(),
        })),
      );
    if (sub === 'folders') return page([]);
    void query;
    return fail(404, 'NOT_FOUND', 'Route not found');
  };

  const api: PortalApi & { controls: Obj } = {
    async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
      await new Promise((r) => setTimeout(r, 30));
      return structuredClone(route(method, path, (body ?? {}) as Obj)) as T;
    },
    navigate(url: string) {
      navigated.push(url);
      if (url.startsWith('/v1/web/auth/login')) {
        const u = new URL(url, window.location.origin);
        signedIn = true;
        const back = u.searchParams.get('return_to') ?? '/app/#/welcome';
        window.location.hash = back.split('#')[1] ?? '/welcome';
        return;
      }
      if (url.startsWith('https://checkout.stripe.com/')) {
        // The customer pays on the provider's page and comes back; the confirmation follows (later with `delay`).
        const o = orgs.find((x) => x.checkout?.url === url) ?? null;
        pendingPayment = o;
        if (o && !has('delay')) setTimeout(() => confirm(o), 1500);
        window.location.hash = '#/billing/return?result=success';
        return;
      }
      if (url.startsWith('https://billing.stripe.com/')) {
        window.location.hash = '#/billing';
      }
    },
    controls: {
      navigated,
      /** The provider's confirmation arrives now (`delay` mode). */
      confirmPayment: () => pendingPayment && confirm(pendingPayment),
      signIn: () => {
        signedIn = true;
      },
    },
  };
  return api;
}
