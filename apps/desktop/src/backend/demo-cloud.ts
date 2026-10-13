/**
 * In-memory stand-in for the organization server and the sign-in flow (UI development and UI tests only). It follows
 * the API contract of services/api closely enough for the screens: roles and grants from the shared permission
 * matrix, non-disclosing 404s, versions, invitations bound to an e-mail address, recent sign-in for ownership
 * transfer, and offline answers from a cache marked stale.
 *
 * Modes (`?demo=`): `signedin` (start signed in), `unverified` (e-mail not verified), `cloudoffline` (the server is
 * unreachable after the first answers), `member` (the demo user is an operator of the demo organization).
 */
import {
  type ASSIGNABLE_ROLES,
  type Permission,
  ROLE_PERMISSIONS,
  ROLE_SCOPE,
  type Role,
} from '@pb/contracts/resources';
import type { AccountRepository, AccountView, CloudRequest, CloudResponse, OrgImportView } from './types.ts';

const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const rid = (prefix: string) =>
  `${prefix}_${Array.from({ length: 26 }, () => CROCK[Math.floor(Math.random() * 32)]).join('')}`;
const token = () =>
  Array.from(
    { length: 43 },
    () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[Math.floor(Math.random() * 64)],
  ).join('');
const now = () => new Date().toISOString();
const DAY = 86_400_000;

interface OrgRec {
  id: string;
  name: string;
  version: number;
  created_at: string;
  members: Map<string, { role: Role; version: number; created_at: string }>;
  clients: {
    id: string;
    name: string;
    colour: string | null;
    archived_at: string | null;
    version: number;
    created_at: string;
    updated_at: string;
  }[];
  profiles: {
    id: string;
    name: string;
    client_id: string | null;
    notes: string;
    version: number;
    created_at: string;
    updated_at: string;
    deleted: boolean;
  }[];
  invitations: {
    id: string;
    email: string;
    role: (typeof ASSIGNABLE_ROLES)[number];
    token: string;
    created_at: string;
    expires_at: string;
    accepted_at: string | null;
    revoked: boolean;
  }[];
  grants: {
    id: string;
    user_id: string;
    client_id: string | null;
    profile_id: string | null;
    created_at: string;
  }[];
  audit: {
    id: string;
    actor_user_id: string | null;
    actor_device_id: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    outcome: 'success' | 'denied' | 'failed';
    request_id: string;
    details: Record<string, unknown>;
    created_at: string;
  }[];
}

interface LocalProfile {
  id: string;
  name: string;
  client_id: string | null;
  client_name: string | null;
  notes: string;
}

export function demoCloud(opts: {
  mode: string;
  emit: (e: {
    status: 'signed_in' | 'signed_out' | 'expired' | 'failed';
    reauth?: boolean;
    message?: string;
  }) => void;
  localProfiles: (workspaceId: string) => LocalProfile[];
}): AccountRepository {
  const me = {
    id: rid('usr'),
    display_name: 'Demo Person',
    email: 'demo.person@example.test',
    email_verified: !opts.mode.includes('unverified'),
  };
  const people = new Map<string, { id: string; display_name: string; email: string }>([[me.id, me]]);
  const sam = { id: rid('usr'), display_name: 'Sam Operator', email: 'sam@example.test' };
  const vic = { id: rid('usr'), display_name: 'Vic Viewer', email: 'vic@example.test' };
  people.set(sam.id, sam);
  people.set(vic.id, vic);
  const deviceId = rid('dev');
  const devices = [
    {
      id: deviceId,
      name: 'Project Browser on this computer',
      platform: 'linux-x64',
      created_at: now(),
      last_seen_at: now(),
      revoked_at: null as string | null,
    },
    {
      id: rid('dev'),
      name: 'Project Browser on Windows',
      platform: 'windows-x64',
      created_at: new Date(Date.now() - 9 * DAY).toISOString(),
      last_seen_at: new Date(Date.now() - 2 * DAY).toISOString(),
      revoked_at: null as string | null,
    },
  ];
  const orgs = new Map<string, OrgRec>();
  const cache = new Map<string, { body: unknown; at: string }>();
  const links: { local_profile_id: string; org_id: string; org_profile_id: string; linked_at: string }[] = [];
  let server: string | null =
    opts.mode.includes('signedin') || opts.mode.includes('member') ? 'https://browser.example.test' : null;
  let status: AccountView['status'] = server ? 'signed_in' : 'signed_out';
  let signingIn = false;
  let recentAuthUntil = 0;
  let requests = 0;

  // A demo organization with clients, profiles and two more members.
  const seedOrg = (myRole: Role) => {
    const t = now();
    const org: OrgRec = {
      id: rid('org'),
      name: 'Demo Agency',
      version: 1,
      created_at: t,
      members: new Map([
        [me.id, { role: myRole, version: 1, created_at: t }],
        [sam.id, { role: myRole === 'operator' ? 'owner' : 'operator', version: 1, created_at: t }],
        [vic.id, { role: 'viewer', version: 1, created_at: t }],
      ]),
      clients: [],
      profiles: [],
      invitations: [],
      grants: [],
      audit: [],
    };
    for (const name of ['Client North', 'Client South']) {
      org.clients.push({
        id: rid('cli'),
        name,
        colour: null,
        archived_at: null,
        version: 1,
        created_at: t,
        updated_at: t,
      });
    }
    const [north, south] = org.clients;
    for (const [name, client] of [
      ['North shop admin', north],
      ['North ads', north],
      ['South support desk', south],
    ] as const) {
      org.profiles.push({
        id: rid('prf'),
        name,
        client_id: client?.id ?? null,
        notes: '',
        version: 1,
        created_at: t,
        updated_at: t,
        deleted: false,
      });
    }
    const grantTo = myRole === 'operator' ? me.id : sam.id;
    org.grants.push({
      id: rid('grt'),
      user_id: grantTo,
      client_id: north?.id ?? null,
      profile_id: null,
      created_at: t,
    });
    orgs.set(org.id, org);
  };
  if (opts.mode.includes('member')) seedOrg('operator');
  else if (status === 'signed_in') seedOrg('owner');

  const err = (s: number, code: string, message: string, details: Record<string, unknown> = {}) => ({
    status: s,
    body: { code, message, request_id: rid('req'), retryable: false, safe_details: details },
  });
  const notFound = (what: string) => err(404, 'NOT_FOUND', `${what} not found`);
  const audit = (
    org: OrgRec,
    action: string,
    target: string | null,
    outcome: 'success' | 'denied' = 'success',
  ) =>
    org.audit.unshift({
      id: rid('aud'),
      actor_user_id: me.id,
      actor_device_id: deviceId,
      action,
      target_type: null,
      target_id: target,
      outcome,
      request_id: rid('req'),
      details: {},
      created_at: now(),
    });
  const role = (org: OrgRec) => org.members.get(me.id)?.role ?? null;
  const allows = (r: Role, p: Permission) => ROLE_PERMISSIONS[r].includes(p);
  const visibleProfile = (org: OrgRec, p: OrgRec['profiles'][number]) => {
    const r = role(org);
    if (!r || p.deleted) return false;
    if (ROLE_SCOPE[r] === 'organization') return true;
    if (ROLE_SCOPE[r] === 'none') return false;
    return org.grants.some(
      (g) => g.user_id === me.id && (g.profile_id === p.id || (g.client_id && g.client_id === p.client_id)),
    );
  };
  const visibleClient = (org: OrgRec, c: OrgRec['clients'][number]) => {
    const r = role(org);
    if (!r) return false;
    if (ROLE_SCOPE[r] === 'organization') return true;
    if (ROLE_SCOPE[r] === 'none') return false;
    return org.grants.some(
      (g) =>
        g.user_id === me.id &&
        (g.client_id === c.id || org.profiles.some((p) => p.id === g.profile_id && p.client_id === c.id)),
    );
  };
  const page = <T>(items: T[]) => ({ status: 200, body: { items: items.slice(0, 100), next_cursor: null } });
  const memberRow = (org: OrgRec, userId: string) => {
    const m = org.members.get(userId);
    const p = people.get(userId);
    return m && p
      ? {
          user_id: userId,
          display_name: p.display_name,
          email: p.email,
          role: m.role,
          version: m.version,
          created_at: m.created_at,
        }
      : null;
  };
  const invitationRow = (i: OrgRec['invitations'][number]) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    status: i.revoked
      ? 'revoked'
      : i.accepted_at
        ? 'accepted'
        : Date.parse(i.expires_at) <= Date.now()
          ? 'expired'
          : 'open',
    created_at: i.created_at,
    expires_at: i.expires_at,
    accepted_at: i.accepted_at,
  });

  /** The API itself. Returns `{status, body}`; paths are already allow-listed by the caller. */
  const route = (req: CloudRequest): { status: number; body: unknown } => {
    const q = new Map(req.query ?? []);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const version = req.ifMatch
      ? Number(req.ifMatch.replaceAll('"', ''))
      : ((body.expected_version as number | undefined) ?? undefined);
    const parts = req.path.split('/').slice(2); // after /v1
    const [a, b, c, d, e] = parts;
    if (a === 'me' && !b)
      return {
        status: 200,
        body: {
          user_id: me.id,
          display_name: me.display_name,
          email: me.email,
          email_verified: me.email_verified,
          memberships: [],
        },
      };
    if (a === 'me' && b === 'workspaces') {
      return {
        status: 200,
        body: {
          items: [...orgs.values()]
            .filter((o) => role(o))
            .map((o) => ({
              kind: 'organization',
              org_id: o.id,
              name: o.name,
              role: role(o),
              profiles: o.profiles.filter((p) => visibleProfile(o, p)).length,
            })),
        },
      };
    }
    if (a === 'devices' && !b)
      return { status: 200, body: { items: devices.map((d) => ({ ...d, current: d.id === deviceId })) } };
    if (a === 'devices' && c === 'revoke') {
      const dev = devices.find((x) => x.id === b);
      if (!dev) return notFound('Device');
      dev.revoked_at ??= now();
      if (dev.id === deviceId) {
        status = 'signed_out';
        setTimeout(() => opts.emit({ status: 'expired' }), 0);
      }
      return { status: 200, body: { ...dev, current: dev.id === deviceId } };
    }
    if (a === 'organizations') {
      if (!me.email_verified)
        return err(403, 'EMAIL_NOT_VERIFIED', 'Verify your e-mail address with your sign-in provider first');
      const t = now();
      const org: OrgRec = {
        id: rid('org'),
        name: String(body.name ?? '').trim(),
        version: 1,
        created_at: t,
        members: new Map([[me.id, { role: 'owner', version: 1, created_at: t }]]),
        clients: [],
        profiles: [],
        invitations: [],
        grants: [],
        audit: [],
      };
      orgs.set(org.id, org);
      audit(org, 'organization.created', org.id);
      return { status: 201, body: { id: org.id, name: org.name, role: 'owner', version: 1, created_at: t } };
    }
    if (a === 'invitations' && b) {
      const found = [...orgs.values()]
        .flatMap((o) => o.invitations.map((i) => ({ o, i })))
        .find(({ i }) => i.token === b);
      if (!found) return notFound('Invitation');
      const row = invitationRow(found.i);
      if (!c) {
        return {
          status: 200,
          body: {
            org_name: found.o.name,
            role: found.i.role,
            expires_at: found.i.expires_at,
            status: row.status,
            for_this_account: me.email_verified && me.email === found.i.email,
          },
        };
      }
      if (row.status === 'expired' || row.status === 'revoked')
        return err(410, 'INVITATION_EXPIRED', 'This invitation has expired; ask for a new one');
      if (row.status === 'accepted') return err(410, 'INVITATION_USED', 'This invitation was already used');
      if (!me.email_verified)
        return err(403, 'EMAIL_NOT_VERIFIED', 'Verify your e-mail address with your sign-in provider first');
      if (me.email !== found.i.email)
        return err(
          403,
          'INVITATION_WRONG_ACCOUNT',
          'This invitation is for a different e-mail address; sign in with the invited account',
        );
      if (found.o.members.has(me.id))
        return err(409, 'ALREADY_MEMBER', 'You are already a member of this organization');
      found.i.accepted_at = now();
      found.o.members.set(me.id, { role: found.i.role, version: 1, created_at: now() });
      audit(found.o, 'invitation.accepted', found.i.id);
      return { status: 200, body: { org_id: found.o.id, role: found.i.role } };
    }
    if (a !== 'orgs' || !b) return notFound('Route');
    const org = orgs.get(b);
    const r = org ? role(org) : null;
    if (!org || !r) return notFound('Organization');
    const need = (p: Permission) =>
      allows(r, p) ? null : err(403, 'FORBIDDEN', 'Your role does not allow this action', { permission: p });
    const t = now();

    if (!c) {
      if (req.method === 'GET')
        return {
          status: 200,
          body: { id: org.id, name: org.name, role: r, version: org.version, created_at: org.created_at },
        };
      const denied = need('org.update');
      if (denied) return denied;
      if (version !== org.version)
        return err(409, 'VERSION_CONFLICT', 'This was changed by someone else; reload and retry', {
          current_version: org.version,
        });
      org.name = String(body.name).trim();
      org.version++;
      audit(org, 'organization.renamed', org.id);
      return {
        status: 200,
        body: { id: org.id, name: org.name, role: r, version: org.version, created_at: org.created_at },
      };
    }
    if (c === 'members') {
      if (!d) return need('members.read') ?? page([...org.members.keys()].map((u) => memberRow(org, u)));
      const target = org.members.get(d);
      const leaving = d === me.id && req.method === 'DELETE';
      if (!leaving) {
        const denied = need('members.manage');
        if (denied) return denied;
      }
      if (!target) return notFound('Member');
      if (target.role === 'owner' && r !== 'owner' && !leaving)
        return err(403, 'FORBIDDEN', 'Only an owner can change an owner’s role');
      const owners = [...org.members.values()].filter((m) => m.role === 'owner').length;
      if (req.method === 'DELETE') {
        if (target.role === 'owner' && owners === 1)
          return err(
            409,
            'LAST_OWNER',
            'An organization must keep at least one owner; transfer ownership first',
          );
        org.members.delete(d);
        org.grants = org.grants.filter((g) => g.user_id !== d);
        audit(org, leaving ? 'membership.left' : 'membership.removed', d);
        return { status: 204, body: null };
      }
      if (version !== target.version)
        return err(409, 'VERSION_CONFLICT', 'This was changed by someone else; reload and retry', {
          current_version: target.version,
        });
      if (target.role === 'owner' && owners === 1)
        return err(
          409,
          'LAST_OWNER',
          'An organization must keep at least one owner; transfer ownership first',
        );
      target.role = body.role as Role;
      target.version++;
      audit(org, 'membership.role_changed', d);
      return { status: 200, body: memberRow(org, d) };
    }
    if (c === 'ownership-transfer') {
      const denied = need('org.transfer_ownership');
      if (denied) return denied;
      if (Date.now() > recentAuthUntil)
        return err(401, 'REAUTHENTICATION_REQUIRED', 'Sign in again to confirm this action', {
          max_age_seconds: 600,
        });
      const target = org.members.get(String(body.user_id));
      if (!target) return notFound('Member');
      target.role = 'owner';
      target.version++;
      const mine = org.members.get(me.id);
      if (mine) {
        mine.role = 'admin';
        mine.version++;
      }
      audit(org, 'organization.ownership_transferred', String(body.user_id));
      return { status: 200, body: memberRow(org, String(body.user_id)) };
    }
    if (c === 'invitations') {
      const denied = need('members.manage');
      if (denied) return denied;
      if (req.method === 'GET') return page(org.invitations.map(invitationRow));
      if (d && e === 'revoke') {
        const inv = org.invitations.find((i) => i.id === d);
        if (!inv) return notFound('Invitation');
        if (!inv.accepted_at) inv.revoked = true;
        audit(org, 'invitation.revoked', d);
        return { status: 200, body: invitationRow(inv) };
      }
      const email = String(body.email).trim().toLowerCase();
      if ([...org.members.keys()].some((u) => people.get(u)?.email === email))
        return err(409, 'ALREADY_MEMBER', 'This person is already a member');
      for (const old of org.invitations) if (old.email === email && !old.accepted_at) old.revoked = true;
      const inv = {
        id: rid('inv'),
        email,
        role: body.role as (typeof ASSIGNABLE_ROLES)[number],
        token: token(),
        created_at: t,
        expires_at: new Date(Date.now() + Number(body.expires_in_days ?? 7) * DAY).toISOString(),
        accepted_at: null,
        revoked: false,
      };
      org.invitations.unshift(inv);
      audit(org, 'invitation.created', inv.id);
      return { status: 201, body: { invitation: invitationRow(inv), token: inv.token } };
    }
    if (c === 'clients') {
      if (!d) {
        if (req.method === 'GET')
          return need('clients.read') ?? page(org.clients.filter((x) => visibleClient(org, x)));
        const denied = need('clients.manage');
        if (denied) return denied;
        const name = String(body.name).trim();
        if (org.clients.some((x) => x.name.toLowerCase() === name.toLowerCase()))
          return err(409, 'ALREADY_EXISTS', 'A client with this name already exists');
        const cl = {
          id: rid('cli'),
          name,
          colour: null,
          archived_at: null,
          version: 1,
          created_at: t,
          updated_at: t,
        };
        org.clients.push(cl);
        audit(org, 'client.created', cl.id);
        return { status: 201, body: { ...cl, org_id: org.id } };
      }
      const cl = org.clients.find((x) => x.id === d && visibleClient(org, x));
      if (!cl) return notFound('Client');
      if (req.method === 'GET') return { status: 200, body: { ...cl, org_id: org.id } };
      const denied = need('clients.manage');
      if (denied) return denied;
      if (version !== cl.version)
        return err(409, 'VERSION_CONFLICT', 'This was changed by someone else; reload and retry', {
          current_version: cl.version,
        });
      if (typeof body.name === 'string') cl.name = body.name.trim();
      if (typeof body.archived === 'boolean') cl.archived_at = body.archived ? (cl.archived_at ?? t) : null;
      cl.version++;
      cl.updated_at = t;
      audit(org, 'client.updated', cl.id);
      return { status: 200, body: { ...cl, org_id: org.id } };
    }
    if (c === 'grants') {
      const denied = need('grants.manage');
      if (denied) return denied;
      if (req.method === 'GET')
        return page(org.grants.filter((g) => !q.get('user_id') || g.user_id === q.get('user_id')));
      if (req.method === 'DELETE') {
        const before = org.grants.length;
        org.grants = org.grants.filter((g) => g.id !== d);
        if (org.grants.length === before) return notFound('Grant');
        audit(org, 'grant.removed', d ?? null);
        return { status: 204, body: null };
      }
      const g = {
        id: rid('grt'),
        user_id: String(body.user_id),
        client_id: (body.client_id as string) ?? null,
        profile_id: (body.profile_id as string) ?? null,
        created_at: t,
      };
      if (!org.members.has(g.user_id)) return notFound('Member');
      if (
        org.grants.some(
          (x) => x.user_id === g.user_id && x.client_id === g.client_id && x.profile_id === g.profile_id,
        )
      )
        return err(409, 'ALREADY_EXISTS', 'This member already has this grant');
      org.grants.push(g);
      audit(org, 'grant.created', g.id);
      return { status: 201, body: g };
    }
    if (c === 'profiles') {
      const view = (p: OrgRec['profiles'][number]) => ({
        id: p.id,
        org_id: org.id,
        name: p.name,
        client_id: p.client_id,
        notes: p.notes,
        version: p.version,
        created_at: p.created_at,
        updated_at: p.updated_at,
      });
      if (!d) {
        if (req.method === 'GET') {
          const denied = need('profile.read');
          if (denied) return denied;
          const text = (q.get('q') ?? '').toLowerCase();
          return page(
            org.profiles
              .filter(
                (p) =>
                  visibleProfile(org, p) &&
                  (!text || p.name.toLowerCase().includes(text)) &&
                  (!q.get('client_id') || p.client_id === q.get('client_id')),
              )
              .map(view),
          );
        }
        const denied = need('profile.create');
        if (denied) return denied;
        const p = {
          id: rid('prf'),
          name: String(body.name).trim(),
          client_id: (body.client_id as string | null) ?? null,
          notes: String(body.notes ?? ''),
          version: 1,
          created_at: t,
          updated_at: t,
          deleted: false,
        };
        org.profiles.push(p);
        audit(org, 'profile.created', p.id);
        return { status: 201, body: view(p) };
      }
      const p = org.profiles.find((x) => x.id === d && visibleProfile(org, x));
      if (!p) return notFound('Profile');
      if (req.method === 'GET') return need('profile.read') ?? { status: 200, body: view(p) };
      const denied = need(req.method === 'DELETE' ? 'profile.delete' : 'profile.update');
      if (denied) return denied;
      if (version !== p.version)
        return err(409, 'VERSION_CONFLICT', 'This was changed by someone else; reload and retry', {
          current_version: p.version,
        });
      if (req.method === 'DELETE') {
        p.deleted = true;
        audit(org, 'profile.deleted', p.id);
        return { status: 204, body: null };
      }
      if (typeof body.name === 'string') p.name = body.name.trim();
      if ('client_id' in body) p.client_id = (body.client_id as string | null) ?? null;
      if (typeof body.notes === 'string') p.notes = body.notes;
      p.version++;
      p.updated_at = t;
      audit(org, 'profile.updated', p.id);
      return { status: 200, body: view(p) };
    }
    if (c === 'audit-events') return need('audit.read') ?? page(org.audit);
    return notFound('Route');
  };

  const view = (): AccountView => ({
    server_url: server,
    status,
    signing_in: signingIn,
    user: status === 'signed_out' ? null : me,
    device_id: status === 'signed_out' ? null : deviceId,
    session_saved: true,
  });

  return {
    async get() {
      return view();
    },
    async setServer(url) {
      if (url !== null && !/^https:\/\/[^\s/?#]+[^\s?#]*$/i.test(url.trim()))
        throw {
          code: 'CLOUD_BAD_SERVER',
          message:
            'Enter the server address starting with https:// (http is accepted only for this computer).',
        };
      const next = url ? url.trim().replace(/\/+$/, '') : null;
      if (next !== server) {
        status = 'signed_out';
        cache.clear();
      }
      server = next;
      return view();
    },
    async signIn(reauth) {
      if (!server)
        throw {
          code: 'CLOUD_NOT_CONFIGURED',
          message: "Add your organization server's address in Account first.",
        };
      signingIn = true;
      // The browser round trip: sign-in completes a moment later and arrives as an event.
      setTimeout(() => {
        signingIn = false;
        const first = status !== 'signed_in';
        status = 'signed_in';
        if (reauth) recentAuthUntil = Date.now() + 600_000;
        if (first && orgs.size === 0 && !opts.mode.includes('fresh')) seedOrg('owner');
        opts.emit({ status: 'signed_in', reauth: !!reauth });
      }, 150);
    },
    async cancelSignIn() {
      signingIn = false;
      return view();
    },
    async signOut() {
      status = 'signed_out';
      cache.clear();
      opts.emit({ status: 'signed_out' });
      return view();
    },
    async request(req): Promise<CloudResponse> {
      if (!server)
        throw {
          code: 'CLOUD_NOT_CONFIGURED',
          message: "Add your organization server's address in Account first.",
        };
      if (status !== 'signed_in')
        throw { code: 'CLOUD_SIGNED_OUT', message: 'Sign in to use organizations.' };
      const key = `${req.path}?${JSON.stringify(req.query ?? [])}`;
      requests++;
      if (opts.mode.includes('cloudoffline') && requests > 6) {
        const hit = req.method === 'GET' ? cache.get(key) : undefined;
        if (hit) return { status: 200, body: structuredClone(hit.body), stale: true, fetched_at: hit.at };
        throw {
          code: 'CLOUD_OFFLINE',
          message: 'The organization server cannot be reached. Check your connection and try again.',
        };
      }
      await new Promise((r) => setTimeout(r, 20));
      const res = route(req);
      if (req.method === 'GET' && res.status === 200 && !req.path.startsWith('/v1/invitations/')) {
        cache.set(key, { body: structuredClone(res.body), at: now() });
      }
      return { status: res.status, body: structuredClone(res.body), stale: false, fetched_at: null };
    },
    async orgImport(workspaceId, orgId, dryRun, mapping): Promise<OrgImportView> {
      const org = orgs.get(orgId);
      if (!org || !role(org))
        return {
          status: 404,
          body: { code: 'NOT_FOUND', message: 'Organization not found' },
          clients: [],
          profiles: 0,
          linked: 0,
        };
      const local = opts.localProfiles(workspaceId);
      if (local.length === 0)
        throw { code: 'ORG_IMPORT_EMPTY', message: 'This workspace has no active profiles to copy.' };
      const clientRefs = new Map<string, string>();
      for (const p of local) if (p.client_id && p.client_name) clientRefs.set(p.client_id, p.client_name);
      const clients = [...clientRefs].map(([ref, name]) => ({ ref, name }));
      const planned = clients.map((c) => {
        const mapped = mapping?.[c.ref];
        const existing = org.clients.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
        return {
          ref: c.ref,
          client_id: mapped ?? existing?.id ?? null,
          outcome: mapped ? 'mapped' : existing ? 'existing' : 'create',
        };
      });
      let linked = 0;
      const profiles = local.map((p) => ({
        local_id: p.id,
        profile_id: null as string | null,
        outcome: 'create',
      }));
      if (!dryRun) {
        const t = now();
        for (const c of planned) {
          if (c.client_id) continue;
          const created = {
            id: rid('cli'),
            name: clientRefs.get(c.ref) ?? 'Client',
            colour: null,
            archived_at: null,
            version: 1,
            created_at: t,
            updated_at: t,
          };
          org.clients.push(created);
          c.client_id = created.id;
        }
        const target = new Map(planned.map((c) => [c.ref, c.client_id]));
        for (const [i, p] of local.entries()) {
          const rec = {
            id: rid('prf'),
            name: p.name,
            client_id: p.client_id ? (target.get(p.client_id) ?? null) : null,
            notes: p.notes,
            version: 1,
            created_at: t,
            updated_at: t,
            deleted: false,
          };
          org.profiles.push(rec);
          const row = profiles[i];
          if (row) row.profile_id = rec.id;
          links.push({ local_profile_id: p.id, org_id: orgId, org_profile_id: rec.id, linked_at: t });
          linked++;
        }
        audit(org, 'workspace.imported', org.id);
      }
      return {
        status: dryRun ? 200 : 201,
        body: { dry_run: dryRun, clients: planned, profiles },
        clients,
        profiles: local.length,
        linked,
      };
    },
    async links(orgId) {
      return links.filter((l) => !orgId || l.org_id === orgId);
    },
  };
}
