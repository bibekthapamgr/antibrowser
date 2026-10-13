/**
 * In-memory stand-in for the organization server and the sign-in flow (UI development and UI tests only). It follows
 * the API contract of services/api closely enough for the screens: roles and grants from the shared permission
 * matrix, non-disclosing 404s, versions, invitations bound to an e-mail address, recent sign-in for ownership
 * transfer, and offline answers from a cache marked stale.
 *
 * Modes (`?demo=`): `signedin` (start signed in), `unverified` (e-mail not verified), `cloudoffline` (the server is
 * unreachable after the first answers), `member` (the demo user is an operator of the demo organization).
 * Milestone 08 (with `linked`): `inuse` (Sam has the first organization profile open on another computer).
 */
import {
  type ASSIGNABLE_ROLES,
  defaultCapabilities,
  GRANT_CAPABILITIES,
  type GrantCapability,
  type Permission,
  ROLE_PERMISSIONS,
  ROLE_SCOPE,
  type Role,
} from '@pb/contracts/resources';
import { secretHint } from '../notes.ts';
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
    deleted_at?: string;
  }[];
  /** Committed encrypted snapshots (milestone 07): metadata only, as the API returns it. */
  snapshots: DemoSnapshot[];
  policy: { retention_days: number; trash_days: number };
  keys: {
    id: string;
    version: number;
    status: 'active' | 'retired' | 'destroyed';
    created_at: string;
    retired_at: string | null;
    destroy_after: string | null;
    destroyed_at: string | null;
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
    capabilities: GrantCapability[];
    created_at: string;
  }[];
  /** Milestone 08: each profile's current lease, access requests and recovery copies. */
  leases: Map<string, DemoLease>;
  requests: DemoRequest[];
  recovery: DemoRecovery[];
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

interface DemoLease {
  id: string;
  holder: string;
  holder_name: string;
  device_id: string;
  device_name: string;
  state: 'active' | 'released' | 'taken_over' | 'revoked';
  /** The holder stopped answering (its lease ran out): nobody else may open it until an admin takes it over. */
  uncertain: boolean;
  fencing: number;
  since: string;
  heartbeat_at: string | null;
  run_state: string | null;
  note: { text: string; by_user_id: string; by_name: string; at: string } | null;
}

interface DemoRequest {
  id: string;
  profile_id: string;
  requested_by: string;
  holder_user_id: string | null;
  note: string;
  status: 'open' | 'declined' | 'canceled' | 'fulfilled' | 'expired';
  created_at: string;
  responded_at: string | null;
  expires_at: string;
}

interface DemoRecovery {
  id: string;
  profile_id: string;
  lease_id: string | null;
  created_by: string;
  device_id: string | null;
  kept_at: string;
}

export interface DemoSnapshot {
  id: string;
  profile_id: string;
  status: 'committed';
  version: number;
  parent_version: number;
  digest: string;
  ciphertext_size: number;
  plaintext_size: number;
  platform: string;
  browser_version: string;
  schema_version: number;
  encryption_scheme: string;
  key_version: string;
  created_by: string;
  device_id: string | null;
  created_at: string;
  committed_at: string;
}

/** What the demo sync engine (demo.ts) needs from the demo server. */
export interface DemoCloudSync {
  deviceId: string;
  /** The first organization profile (for the `linked` demo mode). */
  firstProfile(): { orgId: string; profileId: string } | null;
  link(localId: string, orgId: string, orgProfileId: string): void;
  unlink(localId: string): void;
  /** The local profile's link (synchronous, for list views). */
  linkOf(localId: string): { org_id: string; org_profile_id: string } | null;
  profileName(orgId: string, orgProfileId: string): string | null;
  /** Newest committed version (0: none) and its snapshot. */
  head(orgId: string, orgProfileId: string): { version: number; snapshot: DemoSnapshot | null };
  snapshot(orgId: string, snapshotId: string): DemoSnapshot | null;
  /** Compare-and-swap commit; a newer head is a conflict, never an overwrite. */
  commit(
    orgId: string,
    orgProfileId: string,
    base: number,
    device: string,
  ): { version: number; snapshot: DemoSnapshot } | { conflict: number };
}

/** What the demo shared sessions (demo-team.ts) need from the demo server (milestone 08). */
export interface DemoCloudTeam {
  open(
    orgId: string,
    orgProfileId: string,
  ):
    | { note: { text: string; by_user_id: string; by_name: string; at: string } | null }
    | {
        refused: 'PROFILE_IN_USE_ELSEWHERE' | 'PROFILE_SESSION_UNCERTAIN' | 'NO_ACCESS';
        holder_name: string;
        device_name: string;
        since: string | null;
      };
  /** A heartbeat: the lease's state and open requests addressed to this person. */
  beat(
    orgId: string,
    orgProfileId: string,
    runState: string,
  ): { state: 'active' | 'released' | 'taken_over' | 'revoked' | 'none'; requests: DemoTeamRequest[] };
  release(orgId: string, orgProfileId: string, note: string | null): void;
  capabilities(orgId: string, orgProfileId: string): GrantCapability[];
  /** Demo stand-ins for teammates: Sam asks for the profile, or an admin takes it over. */
  teammateAsks(orgId: string, orgProfileId: string, note: string): void;
  adminTakesOver(orgId: string, orgProfileId: string): void;
  keepRecovery(orgId: string, orgProfileId: string): void;
}

export interface DemoTeamRequest {
  id: string;
  profile_id: string;
  requested_by: string;
  requested_by_name: string;
  holder_user_id: string | null;
  note: string;
  status: 'open' | 'declined' | 'canceled' | 'fulfilled' | 'expired';
  created_at: string;
  responded_at: string | null;
  expires_at: string;
  mine: boolean;
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
}): AccountRepository & { sync: DemoCloudSync; team: DemoCloudTeam } {
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
  let fencing = 100;

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
      snapshots: [],
      policy: { retention_days: 7, trash_days: 30 },
      keys: [
        {
          id: rid('okv'),
          version: 1,
          status: 'active',
          created_at: t,
          retired_at: null,
          destroy_after: null,
          destroyed_at: null,
        },
      ],
      invitations: [],
      grants: [],
      audit: [],
      leases: new Map(),
      requests: [],
      recovery: [],
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
    // One profile already has an encrypted backup made on Sam's computer (milestone 07).
    const backedUp = org.profiles[0];
    if (backedUp) {
      org.snapshots.push({
        id: rid('snp'),
        profile_id: backedUp.id,
        status: 'committed',
        version: 1,
        parent_version: 0,
        digest: 'a'.repeat(64),
        ciphertext_size: 41_000_000,
        plaintext_size: 96_000_000,
        platform: 'windows-x64',
        browser_version: '155.0.8059.39',
        schema_version: 1,
        encryption_scheme: 'aes-256-gcm-chunked-v1',
        key_version: org.keys[0]?.id ?? '',
        created_by: sam.id,
        device_id: rid('dev'),
        created_at: new Date(Date.now() - DAY).toISOString(),
        committed_at: new Date(Date.now() - DAY).toISOString(),
      });
    }
    const grantTo = myRole === 'operator' ? me.id : sam.id;
    org.grants.push({
      id: rid('grt'),
      user_id: grantTo,
      client_id: north?.id ?? null,
      profile_id: null,
      capabilities: ['launch', 'backup_download'],
      created_at: t,
    });
    // Milestone 08: Sam has the first profile open on his Windows laptop.
    if (opts.mode.includes('inuse') && backedUp) {
      org.leases.set(backedUp.id, {
        id: rid('lse'),
        holder: sam.id,
        holder_name: sam.display_name,
        device_id: rid('dev'),
        device_name: 'Sam’s Windows laptop',
        state: 'active',
        uncertain: false,
        fencing: ++fencing,
        since: new Date(Date.now() - 40 * 60_000).toISOString(),
        heartbeat_at: now(),
        run_state: 'running',
        note: null,
      });
    }
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

  // ------------------------------------------------------------------ milestone 08: sessions and access
  const ALL_CAPS: GrantCapability[] = [...GRANT_CAPABILITIES];
  /** What this person may do with a profile: everything for owners and admins, their grants' capabilities else. */
  const capsOf = (org: OrgRec, p: OrgRec['profiles'][number], userId = me.id): GrantCapability[] => {
    const r = org.members.get(userId)?.role;
    if (!r) return [];
    if (ROLE_SCOPE[r] === 'organization') return ALL_CAPS;
    if (r !== 'operator') return [];
    const caps = new Set<GrantCapability>();
    for (const g of org.grants)
      if (g.user_id === userId && (g.profile_id === p.id || (g.client_id && g.client_id === p.client_id)))
        for (const c of g.capabilities) caps.add(c);
    return ALL_CAPS.filter((c) => caps.has(c));
  };
  const openLease = (org: OrgRec, profileId: string) => {
    const l = org.leases.get(profileId);
    return l && l.state === 'active' ? l : null;
  };
  const leaseView = (profileId: string, l: DemoLease) => ({
    id: l.id,
    profile_id: profileId,
    purpose: 'session',
    state: l.state === 'active' && l.uncertain ? 'uncertain' : l.state,
    holder_user_id: l.holder,
    holder_name: l.holder_name,
    device_id: l.device_id,
    device_name: l.device_name,
    fencing_token: String(l.fencing),
    run_state: l.run_state,
    acquired_at: l.since,
    expires_at: new Date(Date.parse(l.heartbeat_at ?? l.since) + 60_000).toISOString(),
    heartbeat_at: l.heartbeat_at,
    ttl_seconds: 60,
    heartbeat_seconds: 15,
  });
  const inUse = (org: OrgRec, profileId: string) => {
    const l = openLease(org, profileId);
    return l
      ? {
          lease_id: l.id,
          purpose: 'session',
          state: l.uncertain ? 'uncertain' : 'active',
          holder_user_id: l.holder,
          holder_name: l.holder_name,
          device_id: l.device_id,
          device_name: l.device_name,
          run_state: l.run_state,
          since: l.since,
          heartbeat_at: l.heartbeat_at,
          expires_at: new Date(Date.parse(l.heartbeat_at ?? l.since) + 60_000).toISOString(),
          mine: l.holder === me.id,
        }
      : null;
  };
  const requestRow = (r: DemoRequest): DemoTeamRequest => ({
    ...r,
    requested_by_name: people.get(r.requested_by)?.display_name ?? '',
    mine: r.requested_by === me.id,
  });
  const fulfil = (org: OrgRec, profileId: string) => {
    for (const r of org.requests)
      if (r.profile_id === profileId && r.status === 'open') {
        r.status = 'fulfilled';
        r.responded_at = now();
      }
  };

  /** Grants or roles changed: leases their holders may no longer hold end as revoked. */
  const endOutOfReach = (org: OrgRec) => {
    for (const [profileId, l] of org.leases) {
      const p = org.profiles.find((x) => x.id === profileId);
      if (l.state === 'active' && p && !capsOf(org, p, l.holder).includes('launch')) {
        l.state = 'revoked';
        l.fencing = ++fencing;
        fulfil(org, profileId);
      }
    }
  };

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
        snapshots: [],
        policy: { retention_days: 7, trash_days: 30 },
        keys: [
          {
            id: rid('okv'),
            version: 1,
            status: 'active',
            created_at: t,
            retired_at: null,
            destroy_after: null,
            destroyed_at: null,
          },
        ],
        invitations: [],
        grants: [],
        audit: [],
        leases: new Map(),
        requests: [],
        recovery: [],
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
        endOutOfReach(org);
        return { status: 204, body: null };
      }
      const asked = Array.isArray(body.capabilities)
        ? ALL_CAPS.filter((c) => (body.capabilities as string[]).includes(c))
        : null;
      if (req.method === 'PATCH') {
        const g = org.grants.find((x) => x.id === d);
        if (!g) return notFound('Grant');
        const memberRole = org.members.get(g.user_id)?.role;
        if (memberRole === 'viewer' && asked?.length)
          return err(
            400,
            'VALIDATION_FAILED',
            'Viewers’ access cannot include opening, editing or downloads',
          );
        g.capabilities = asked ?? [];
        audit(org, 'grant.updated', g.id);
        endOutOfReach(org);
        return { status: 200, body: g };
      }
      const memberRole = org.members.get(String(body.user_id))?.role;
      const g = {
        id: rid('grt'),
        user_id: String(body.user_id),
        client_id: (body.client_id as string) ?? null,
        profile_id: (body.profile_id as string) ?? null,
        capabilities: memberRole === 'viewer' ? [] : (asked ?? defaultCapabilities(memberRole ?? 'viewer')),
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
        snapshot_version: sync.head(org.id, p.id).version,
        last_snapshot_at: sync.head(org.id, p.id).snapshot?.committed_at ?? null,
        in_use: inUse(org, p.id),
        capabilities: capsOf(org, p),
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
      if (e === 'undelete') {
        const denied = need('backups.manage');
        if (denied) return denied;
        const gone = org.profiles.find((x) => x.id === d && x.deleted);
        if (!gone) return notFound('Profile in the trash');
        gone.deleted = false;
        delete gone.deleted_at;
        gone.version++;
        gone.updated_at = t;
        audit(org, 'profile.undeleted', gone.id);
        return { status: 200, body: view(gone) };
      }
      const p = org.profiles.find((x) => x.id === d && visibleProfile(org, x));
      if (!p) return notFound('Profile');
      // Milestone 08: who has it open, access requests and forced takeover.
      const [, , , , , f, g] = parts;
      if (e === 'leases' && f === 'current') {
        const denied = need('profile.read');
        if (denied) return denied;
        const l = openLease(org, p.id);
        return { status: 200, body: { lease: l ? leaseView(p.id, l) : null } };
      }
      if (e === 'handoff-requests') {
        if (!f) {
          if (req.method === 'GET')
            return (
              need('profile.read') ?? page(org.requests.filter((x) => x.profile_id === p.id).map(requestRow))
            );
          const denied = need('profile.launch');
          if (denied) return denied;
          const note = String(body.note ?? '').trim();
          if (secretHint(note))
            return err(400, 'NOTE_LOOKS_SECRET', 'Notes must not contain passwords or keys');
          const l = openLease(org, p.id);
          if (!l || l.holder === me.id)
            return err(409, 'PROFILE_NOT_IN_USE', 'Nobody else has this profile open');
          const open = org.requests.find(
            (x) => x.profile_id === p.id && x.requested_by === me.id && x.status === 'open',
          );
          if (open) return { status: 200, body: requestRow(open) };
          const r: DemoRequest = {
            id: rid('hrq'),
            profile_id: p.id,
            requested_by: me.id,
            holder_user_id: l.holder,
            note,
            status: 'open',
            created_at: t,
            responded_at: null,
            expires_at: new Date(Date.now() + 4 * 3_600_000).toISOString(),
          };
          org.requests.unshift(r);
          audit(org, 'handoff.requested', p.id);
          return { status: 201, body: requestRow(r) };
        }
        const r = org.requests.find((x) => x.id === f && x.profile_id === p.id);
        if (!r) return notFound('Request');
        const answerer = g === 'decline' ? r.holder_user_id : r.requested_by;
        if (answerer !== me.id) return notFound('Request');
        if (r.status === 'open') {
          r.status = g === 'decline' ? 'declined' : 'canceled';
          r.responded_at = t;
          audit(org, 'handoff.answered', p.id);
        }
        return { status: 200, body: requestRow(r) };
      }
      if (e === 'force-takeover') {
        const denied = need('lease.force_release');
        if (denied) return denied;
        const reason = String(body.reason ?? '').trim();
        if (reason.length < 3 || body.confirm !== true)
          return err(400, 'VALIDATION_FAILED', 'A reason is required');
        const l = openLease(org, p.id);
        if (!l) return err(409, 'PROFILE_NOT_IN_USE', 'Nobody has this profile open');
        const previous = leaseView(p.id, l);
        l.state = 'taken_over';
        l.fencing = ++fencing;
        fulfil(org, p.id);
        audit(org, 'lease.taken_over', p.id);
        return { status: 200, body: { previous, fencing_token: String(l.fencing) } };
      }
      if (e === 'snapshots') {
        return (
          need('snapshot.read') ??
          page(
            org.snapshots
              .filter((x) => x.profile_id === p.id)
              .sort((x, y) => y.version - x.version)
              .map((x) => ({ ...x })),
          )
        );
      }
      if (req.method === 'GET') return need('profile.read') ?? { status: 200, body: view(p) };
      const denied = need(req.method === 'DELETE' ? 'profile.delete' : 'profile.update');
      if (denied) return denied;
      if (version !== p.version)
        return err(409, 'VERSION_CONFLICT', 'This was changed by someone else; reload and retry', {
          current_version: p.version,
        });
      if (req.method === 'DELETE') {
        p.deleted = true;
        p.deleted_at = t;
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
    if (c === 'handoff-requests') {
      const mine = q.get('mine') === 'true';
      return page(
        org.requests
          .filter(
            (x) => x.status === 'open' && (mine ? x.requested_by === me.id : x.holder_user_id === me.id),
          )
          .map(requestRow),
      );
    }
    if (c === 'recovery-copies') {
      const denied = need('backups.manage');
      if (denied) return denied;
      return page(
        org.recovery.map((x) => ({
          id: x.id,
          profile_id: x.profile_id,
          profile_name: org.profiles.find((p) => p.id === x.profile_id)?.name ?? '',
          lease_id: x.lease_id,
          created_by: x.created_by,
          created_by_name: people.get(x.created_by)?.display_name ?? '',
          device_id: x.device_id,
          ciphertext_size: 38_000_000,
          plaintext_size: 91_000_000,
          platform: 'linux-x64',
          browser_version: '155.0.8059.39',
          kept_at: x.kept_at,
          erase_after: new Date(Date.parse(x.kept_at) + org.policy.trash_days * DAY).toISOString(),
        })),
      );
    }
    // Milestone 07: backup policy, trash and key versions.
    const usedBytes = () => org.snapshots.reduce((n, x) => n + x.ciphertext_size, 0);
    const policyView = () => ({
      ...org.policy,
      quota_bytes: 20 * 1024 ** 3,
      max_snapshot_bytes: 4 * 1024 ** 3,
      used_bytes: usedBytes(),
    });
    if (c === 'backup-policy') {
      if (req.method === 'GET') return { status: 200, body: policyView() };
      const denied = need('backups.manage');
      if (denied) return denied;
      for (const k of ['retention_days', 'trash_days'] as const) {
        const v = body[k];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 90)
          return err(400, 'VALIDATION_FAILED', `${k} must be 1-90 days`);
        org.policy[k] = v;
      }
      audit(org, 'backup_policy.updated', org.id);
      return { status: 200, body: policyView() };
    }
    if (c === 'trash') {
      const denied = need('backups.manage');
      if (denied) return denied;
      return page(
        org.profiles
          .filter((x) => x.deleted && x.deleted_at)
          .map((x) => ({
            profile: {
              id: x.id,
              org_id: org.id,
              name: x.name,
              client_id: x.client_id,
              notes: x.notes,
              version: x.version,
              created_at: x.created_at,
              updated_at: x.updated_at,
            },
            deleted_at: x.deleted_at,
            purge_after: new Date(Date.parse(x.deleted_at ?? t) + org.policy.trash_days * DAY).toISOString(),
          })),
      );
    }
    if (c === 'keys') {
      const keysView = () => ({
        kms_provider: 'local',
        keys: [...org.keys]
          .sort((x, y) => y.version - x.version)
          .map((k) => ({
            ...k,
            snapshots: org.snapshots.filter((x) => x.key_version === k.id).length,
          })),
      });
      if (!d) return need('backups.manage') ?? { status: 200, body: keysView() };
      const denied = need('keys.manage');
      if (denied) return denied;
      if (Date.now() > recentAuthUntil)
        return err(401, 'REAUTHENTICATION_REQUIRED', 'Sign in again to confirm this action', {
          max_age_seconds: 600,
        });
      const active = org.keys.find((k) => k.status === 'active');
      if (active) {
        active.status = 'retired';
        active.retired_at = t;
        active.destroy_after = new Date(Date.now() + 30 * DAY).toISOString();
      }
      const next = {
        id: rid('okv'),
        version: (active?.version ?? 0) + 1,
        status: 'active' as const,
        created_at: t,
        retired_at: null,
        destroy_after: null,
        destroyed_at: null,
      };
      org.keys.push(next);
      // Existing snapshots are re-wrapped under the new version (demo: instantly).
      for (const x of org.snapshots) x.key_version = next.id;
      audit(org, 'org_key.rotated', next.id);
      return { status: 200, body: keysView() };
    }
    return notFound('Route');
  };

  const sync: DemoCloudSync = {
    deviceId,
    firstProfile() {
      const org = [...orgs.values()][0];
      const p = org?.profiles[0];
      return org && p ? { orgId: org.id, profileId: p.id } : null;
    },
    link(localId, orgId, orgProfileId) {
      const i = links.findIndex((l) => l.local_profile_id === localId);
      if (i >= 0) links.splice(i, 1);
      links.push({
        local_profile_id: localId,
        org_id: orgId,
        org_profile_id: orgProfileId,
        linked_at: now(),
      });
    },
    unlink(localId) {
      const i = links.findIndex((l) => l.local_profile_id === localId);
      if (i >= 0) links.splice(i, 1);
    },
    linkOf(localId) {
      return links.find((l) => l.local_profile_id === localId) ?? null;
    },
    profileName(orgId, orgProfileId) {
      return orgs.get(orgId)?.profiles.find((p) => p.id === orgProfileId)?.name ?? null;
    },
    head(orgId, orgProfileId) {
      const list = (orgs.get(orgId)?.snapshots ?? []).filter((x) => x.profile_id === orgProfileId);
      const top = list.reduce<DemoSnapshot | null>((m, x) => (!m || x.version > m.version ? x : m), null);
      return { version: top?.version ?? 0, snapshot: top };
    },
    snapshot(orgId, snapshotId) {
      return orgs.get(orgId)?.snapshots.find((x) => x.id === snapshotId) ?? null;
    },
    commit(orgId, orgProfileId, base, device) {
      const org = orgs.get(orgId);
      const head = sync.head(orgId, orgProfileId).version;
      if (!org || head !== base) return { conflict: head };
      const t = now();
      const snap: DemoSnapshot = {
        id: rid('snp'),
        profile_id: orgProfileId,
        status: 'committed',
        version: head + 1,
        parent_version: base,
        digest: Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''),
        ciphertext_size: 30_000_000 + Math.floor(Math.random() * 20_000_000),
        plaintext_size: 70_000_000 + Math.floor(Math.random() * 20_000_000),
        platform: 'linux-x64',
        browser_version: '155.0.8059.39',
        schema_version: 1,
        encryption_scheme: 'aes-256-gcm-chunked-v1',
        key_version: org.keys.find((k) => k.status === 'active')?.id ?? '',
        created_by: me.id,
        device_id: device,
        created_at: t,
        committed_at: t,
      };
      org.snapshots.push(snap);
      audit(org, 'snapshot.committed', snap.id);
      return { version: snap.version, snapshot: snap };
    },
  };

  const team: DemoCloudTeam = {
    open(orgId, orgProfileId) {
      const org = orgs.get(orgId);
      const p = org?.profiles.find((x) => x.id === orgProfileId && !x.deleted);
      if (!org || !p || !capsOf(org, p).includes('launch'))
        return { refused: 'NO_ACCESS', holder_name: '', device_name: '', since: null };
      const cur = org.leases.get(p.id);
      if (cur && cur.state === 'active' && cur.device_id !== deviceId)
        return {
          refused: cur.uncertain ? 'PROFILE_SESSION_UNCERTAIN' : 'PROFILE_IN_USE_ELSEWHERE',
          holder_name: cur.holder_name,
          device_name: cur.device_name,
          since: cur.since,
        };
      const note = cur?.state === 'released' ? cur.note : null;
      org.leases.set(p.id, {
        id: rid('lse'),
        holder: me.id,
        holder_name: me.display_name,
        device_id: deviceId,
        device_name: devices[0]?.name ?? 'This computer',
        state: 'active',
        uncertain: false,
        fencing: ++fencing,
        since: now(),
        heartbeat_at: now(),
        run_state: 'starting',
        note: null,
      });
      audit(org, 'lease.acquired', p.id);
      return { note };
    },
    beat(orgId, orgProfileId, runState) {
      const org = orgs.get(orgId);
      const l = org?.leases.get(orgProfileId);
      if (!org || !l || l.device_id !== deviceId) return { state: 'none', requests: [] };
      if (l.state === 'active') {
        l.heartbeat_at = now();
        l.run_state = runState;
      }
      return {
        state: l.state,
        requests: org.requests
          .filter((r) => r.profile_id === orgProfileId && r.status === 'open')
          .map(requestRow),
      };
    },
    release(orgId, orgProfileId, note) {
      const org = orgs.get(orgId);
      const l = org?.leases.get(orgProfileId);
      if (!org || !l || l.device_id !== deviceId || l.state !== 'active') return;
      l.state = 'released';
      l.run_state = 'closed';
      l.note = note ? { text: note, by_user_id: me.id, by_name: me.display_name, at: now() } : null;
      fulfil(org, orgProfileId);
      audit(org, 'lease.released', orgProfileId);
    },
    capabilities(orgId, orgProfileId) {
      const org = orgs.get(orgId);
      const p = org?.profiles.find((x) => x.id === orgProfileId);
      return org && p ? capsOf(org, p) : [];
    },
    teammateAsks(orgId, orgProfileId, note) {
      const org = orgs.get(orgId);
      if (!org) return;
      org.requests.unshift({
        id: rid('hrq'),
        profile_id: orgProfileId,
        requested_by: sam.id,
        holder_user_id: me.id,
        note,
        status: 'open',
        created_at: now(),
        responded_at: null,
        expires_at: new Date(Date.now() + 4 * 3_600_000).toISOString(),
      });
    },
    adminTakesOver(orgId, orgProfileId) {
      const org = orgs.get(orgId);
      const l = org?.leases.get(orgProfileId);
      if (!org || !l || l.state !== 'active') return;
      l.state = 'taken_over';
      l.fencing = ++fencing;
      fulfil(org, orgProfileId);
      audit(org, 'lease.taken_over', orgProfileId);
    },
    keepRecovery(orgId, orgProfileId) {
      const org = orgs.get(orgId);
      if (!org) return;
      org.recovery.unshift({
        id: rid('snp'),
        profile_id: orgProfileId,
        lease_id: org.leases.get(orgProfileId)?.id ?? null,
        created_by: me.id,
        device_id: deviceId,
        kept_at: now(),
      });
    },
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
    sync,
    team,
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
