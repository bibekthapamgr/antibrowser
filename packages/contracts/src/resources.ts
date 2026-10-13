import Type, { type Static } from 'typebox';
import { ID_PATTERN } from './ids.ts';

const Id = (prefix: Parameters<typeof ID_PATTERN>[0]) => Type.String({ pattern: ID_PATTERN(prefix) });
const Timestamp = Type.String({ format: 'date-time', description: 'UTC, RFC 3339' });

// ---------------------------------------------------------------- Roles & permissions
/**
 * Roles (milestone 06). owner: ownership and billing; admin: members and clients; operator: uses the profiles they
 * are granted; viewer: sees granted metadata only (cannot launch, read sessions or export); billing: subscription data
 * only.
 */
export const ROLES = ['owner', 'admin', 'operator', 'viewer', 'billing'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org.read',
  'org.update',
  'org.transfer_ownership',
  'members.read',
  'members.manage',
  'billing.read',
  'billing.manage',
  'clients.read',
  'clients.manage',
  'profile.read',
  'profile.create',
  'profile.update',
  'profile.delete',
  'profile.export',
  'profile.launch',
  'snapshot.read',
  'snapshot.commit',
  'lease.force_release',
  'grants.manage',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Single source of truth for the permission matrix (docs/permission-matrix.md is generated from it). */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter(
    (p) => p !== 'org.transfer_ownership' && p !== 'billing.read' && p !== 'billing.manage',
  ),
  operator: [
    'org.read',
    'clients.read',
    'profile.read',
    'profile.launch',
    'snapshot.read',
    'snapshot.commit',
  ],
  viewer: ['org.read', 'clients.read', 'profile.read'],
  billing: ['org.read', 'billing.read'],
};

/**
 * Which clients and profiles a role reaches. `organization`: all of them; `granted`: only clients and profiles named
 * in the member's permission grants (a client grant covers its profiles); `none`: no client or profile access.
 * Deny by default: a permission applies to a client or profile only inside this scope.
 */
export type ResourceScope = 'organization' | 'granted' | 'none';
export const ROLE_SCOPE: Record<Role, ResourceScope> = {
  owner: 'organization',
  admin: 'organization',
  operator: 'granted',
  viewer: 'granted',
  billing: 'none',
};

/** Roles an invitation or a role change may assign (ownership only moves through a transfer). */
export const ASSIGNABLE_ROLES = ['admin', 'operator', 'viewer', 'billing'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function roleAllows(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

// ---------------------------------------------------------------- Identity, sessions and devices
const Email = Type.String({ minLength: 3, maxLength: 254, format: 'email' });
const Name = Type.String({ minLength: 1, maxLength: 120 });
const Version = Type.Integer({ minimum: 1 });

/** Public sign-in configuration for the desktop (OIDC Authorization Code + PKCE in the system browser). */
export const AuthConfig = Type.Object(
  {
    issuer: Type.String(),
    client_id: Type.String(),
    redirect_uri: Type.String(),
    scopes: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type AuthConfig = Static<typeof AuthConfig>;

export const PLATFORMS = ['windows-x64', 'macos-arm64', 'macos-x64', 'linux-x64'] as const;
const IdToken = Type.String({
  minLength: 20,
  maxLength: 8192,
  pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$',
});
const Nonce = Type.String({ minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' });
const RefreshToken = Type.String({
  minLength: 40,
  maxLength: 128,
  pattern: '^ses_[0-9A-HJKMNP-TV-Z]{26}\\.[A-Za-z0-9_-]{43}$',
});

/** POST /v1/devices: sign in on a new device (the ID token proves who; the device is enrolled for that user). */
export const DeviceEnroll = Type.Object(
  {
    id_token: IdToken,
    nonce: Nonce,
    name: Type.String({ minLength: 1, maxLength: 80 }),
    platform: Type.Enum(PLATFORMS),
  },
  { additionalProperties: false },
);
export type DeviceEnroll = Static<typeof DeviceEnroll>;

/** POST /v1/auth/token: refresh (rotation) or a new sign-in on an already enrolled device (e.g. re-authentication). */
export const TokenRequest = Type.Union([
  Type.Object(
    { grant_type: Type.Literal('refresh_token'), refresh_token: RefreshToken },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      grant_type: Type.Literal('id_token'),
      id_token: IdToken,
      nonce: Nonce,
      device_id: Type.String({ pattern: ID_PATTERN('dev') }),
    },
    { additionalProperties: false },
  ),
]);
export type TokenRequest = Static<typeof TokenRequest>;

export const Device = Type.Object(
  {
    id: Id('dev'),
    name: Type.String(),
    platform: Type.Enum(PLATFORMS),
    created_at: Timestamp,
    last_seen_at: Type.Union([Timestamp, Type.Null()]),
    revoked_at: Type.Union([Timestamp, Type.Null()]),
    current: Type.Boolean({ description: 'The device making this request.' }),
  },
  { additionalProperties: false },
);
export type Device = Static<typeof Device>;

export const UserSummary = Type.Object(
  {
    id: Id('usr'),
    display_name: Type.String(),
    email: Type.Union([Type.String(), Type.Null()]),
    email_verified: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Session tokens issued by the API. The refresh token is shown once and must be kept in the OS keychain. */
export const Session = Type.Object(
  {
    access_token: Type.String(),
    token_type: Type.Literal('Bearer'),
    expires_in: Type.Integer({ minimum: 1 }),
    refresh_token: Type.String(),
    refresh_expires_at: Timestamp,
    auth_time: Timestamp,
    device: Device,
    user: UserSummary,
  },
  { additionalProperties: false },
);
export type Session = Static<typeof Session>;

export const Membership = Type.Object(
  { org_id: Id('org'), org_name: Type.String(), role: Type.Enum(ROLES) },
  { additionalProperties: false },
);
export const Me = Type.Object(
  {
    user_id: Id('usr'),
    display_name: Type.String(),
    email: Type.Union([Type.String(), Type.Null()]),
    email_verified: Type.Boolean(),
    memberships: Type.Array(Membership),
  },
  { additionalProperties: false },
);
export type Me = Static<typeof Me>;

// ---------------------------------------------------------------- Organizations and members
export const Organization = Type.Object(
  {
    id: Id('org'),
    name: Name,
    role: Type.Enum(ROLES, { description: "The caller's role." }),
    version: Version,
    created_at: Timestamp,
  },
  { additionalProperties: false },
);
export type Organization = Static<typeof Organization>;

export const OrganizationCreate = Type.Object({ name: Name }, { additionalProperties: false });
export const OrganizationUpdate = Type.Object(
  { name: Name, expected_version: Type.Optional(Version) },
  { additionalProperties: false },
);

/** GET /v1/me/workspaces: the organizations the caller belongs to (local workspaces live on the device only). */
export const Workspaces = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          kind: Type.Literal('organization'),
          org_id: Id('org'),
          name: Type.String(),
          role: Type.Enum(ROLES),
          profiles: Type.Integer({ minimum: 0, description: 'Profiles this member can see.' }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);
export type Workspaces = Static<typeof Workspaces>;

export const Member = Type.Object(
  {
    user_id: Id('usr'),
    display_name: Type.String(),
    email: Type.Union([Type.String(), Type.Null()]),
    role: Type.Enum(ROLES),
    version: Version,
    created_at: Timestamp,
  },
  { additionalProperties: false },
);
export type Member = Static<typeof Member>;

export const MemberUpdate = Type.Object(
  { role: Type.Enum(ASSIGNABLE_ROLES), expected_version: Type.Optional(Version) },
  { additionalProperties: false },
);
export const OwnershipTransfer = Type.Object(
  { user_id: Id('usr'), expected_version: Version },
  { additionalProperties: false },
);

// ---------------------------------------------------------------- Invitations
export const InvitationCreate = Type.Object(
  {
    email: Email,
    role: Type.Enum(ASSIGNABLE_ROLES),
    expires_in_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, default: 7 })),
  },
  { additionalProperties: false },
);
export const Invitation = Type.Object(
  {
    id: Id('inv'),
    email: Type.String(),
    role: Type.Enum(ASSIGNABLE_ROLES),
    status: Type.Enum(['open', 'accepted', 'expired', 'revoked']),
    created_at: Timestamp,
    expires_at: Timestamp,
    accepted_at: Type.Union([Timestamp, Type.Null()]),
  },
  { additionalProperties: false },
);
export type Invitation = Static<typeof Invitation>;
/** Returned once at creation: the token is never stored in clear and cannot be shown again. */
export const InvitationCreated = Type.Object(
  { invitation: Invitation, token: Type.String() },
  { additionalProperties: false },
);
export const InvitationPreview = Type.Object(
  {
    org_name: Type.String(),
    role: Type.Enum(ASSIGNABLE_ROLES),
    expires_at: Timestamp,
    status: Type.Enum(['open', 'accepted', 'expired', 'revoked']),
    for_this_account: Type.Boolean({
      description: "Whether the caller's verified e-mail matches the invitation.",
    }),
  },
  { additionalProperties: false },
);
export const InvitationAccepted = Type.Object(
  { org_id: Id('org'), role: Type.Enum(ROLES) },
  { additionalProperties: false },
);
/** Invitation tokens: 43 base64url characters (256 bits). */
export const INVITATION_TOKEN_PATTERN = '^[A-Za-z0-9_-]{43}$';

// ---------------------------------------------------------------- Clients and grants
const Colour = Type.String({ pattern: '^#[0-9a-f]{6}$' });
export const Client = Type.Object(
  {
    id: Id('cli'),
    org_id: Id('org'),
    name: Name,
    colour: Type.Union([Colour, Type.Null()]),
    archived_at: Type.Union([Timestamp, Type.Null()]),
    version: Version,
    created_at: Timestamp,
    updated_at: Timestamp,
  },
  { additionalProperties: false },
);
export type Client = Static<typeof Client>;
export const ClientCreate = Type.Object(
  { name: Name, colour: Type.Optional(Type.Union([Colour, Type.Null()])) },
  { additionalProperties: false },
);
export const ClientUpdate = Type.Object(
  {
    expected_version: Type.Optional(Version),
    name: Type.Optional(Name),
    colour: Type.Optional(Type.Union([Colour, Type.Null()])),
    archived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const Grant = Type.Object(
  {
    id: Id('grt'),
    user_id: Id('usr'),
    client_id: Type.Union([Id('cli'), Type.Null()]),
    profile_id: Type.Union([Id('prf'), Type.Null()]),
    created_at: Timestamp,
  },
  { additionalProperties: false },
);
export type Grant = Static<typeof Grant>;
export const GrantCreate = Type.Union([
  Type.Object({ user_id: Id('usr'), client_id: Id('cli') }, { additionalProperties: false }),
  Type.Object({ user_id: Id('usr'), profile_id: Id('prf') }, { additionalProperties: false }),
]);

// ---------------------------------------------------------------- Audit
export const AuditEvent = Type.Object(
  {
    id: Id('aud'),
    actor_user_id: Type.Union([Type.String(), Type.Null()]),
    actor_device_id: Type.Union([Type.String(), Type.Null()]),
    action: Type.String(),
    target_type: Type.Union([Type.String(), Type.Null()]),
    target_id: Type.Union([Type.String(), Type.Null()]),
    outcome: Type.Enum(['success', 'denied', 'failed']),
    request_id: Type.String(),
    details: Type.Record(Type.String(), Type.Unknown()),
    created_at: Timestamp,
  },
  { additionalProperties: false },
);
export type AuditEvent = Static<typeof AuditEvent>;

// ---------------------------------------------------------------- Profiles
/** Labels are display text only. They are never used to build disk paths (see ADR-0002 and crates/runtime). */
const Label = Type.String({ minLength: 1, maxLength: 120 });

/** Every profile has exactly one owner organization; moving between organizations is an export/import. */
export const Profile = Type.Object(
  {
    id: Id('prf'),
    org_id: Id('org'),
    name: Label,
    client_id: Type.Union([Id('cli'), Type.Null()]),
    notes: Type.String({ maxLength: 2000 }),
    version: Version,
    created_at: Timestamp,
    updated_at: Timestamp,
  },
  { additionalProperties: false },
);
export type Profile = Static<typeof Profile>;

export const ProfileCreate = Type.Object(
  {
    name: Label,
    client_id: Type.Optional(Type.Union([Id('cli'), Type.Null()])),
    notes: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);
export type ProfileCreate = Static<typeof ProfileCreate>;

export const ProfileUpdate = Type.Object(
  {
    expected_version: Type.Optional(Version),
    name: Type.Optional(Label),
    client_id: Type.Optional(Type.Union([Id('cli'), Type.Null()])),
    notes: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type ProfileUpdate = Static<typeof ProfileUpdate>;

/** Bulk changes: each id gets its own result; ids outside the caller's reach report `not_found`. */
export const ProfileBulk = Type.Union([
  Type.Object(
    {
      action: Type.Literal('set_client'),
      client_id: Type.Union([Id('cli'), Type.Null()]),
      profile_ids: Type.Array(Id('prf'), { minItems: 1, maxItems: 500, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal('delete'),
      profile_ids: Type.Array(Id('prf'), { minItems: 1, maxItems: 500, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
]);
export const BulkResult = Type.Object(
  {
    results: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          outcome: Type.Enum(['changed', 'unchanged', 'not_found', 'forbidden', 'in_use']),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** Configuration export (names, client, notes): no browser data, no session material. */
export const ProfileExport = Type.Object(
  {
    format: Type.Literal('pb-profiles-v1'),
    org_id: Id('org'),
    exported_at: Timestamp,
    profiles: Type.Array(
      Type.Object(
        {
          id: Id('prf'),
          name: Label,
          client: Type.Union([Type.String(), Type.Null()]),
          notes: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** Moving a local workspace into an organization (metadata only; browser data stays on the device until 07). */
export const LocalWorkspaceImport = Type.Object(
  {
    dry_run: Type.Boolean(),
    clients: Type.Array(
      Type.Object(
        {
          ref: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }),
          name: Name,
          colour: Type.Optional(Type.Union([Colour, Type.Null()])),
          map_to: Type.Optional(Id('cli')),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1000 },
    ),
    profiles: Type.Array(
      Type.Object(
        {
          local_id: Id('prf'),
          name: Label,
          client_ref: Type.Optional(
            Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }),
          ),
          notes: Type.Optional(Type.String({ maxLength: 2000 })),
        },
        { additionalProperties: false },
      ),
      { maxItems: 10000 },
    ),
  },
  { additionalProperties: false },
);
export type LocalWorkspaceImport = Static<typeof LocalWorkspaceImport>;
export const LocalWorkspaceImportResult = Type.Object(
  {
    dry_run: Type.Boolean(),
    clients: Type.Array(
      Type.Object(
        {
          ref: Type.String(),
          client_id: Type.Union([Id('cli'), Type.Null()]),
          outcome: Type.Enum(['create', 'existing', 'mapped']),
        },
        { additionalProperties: false },
      ),
    ),
    profiles: Type.Array(
      Type.Object(
        {
          local_id: Id('prf'),
          profile_id: Type.Union([Id('prf'), Type.Null()]),
          outcome: Type.Literal('create', {
            description:
              'Organization profiles always get a new server id; the device keeps its local record.',
          }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------- Leases
export const LEASE_TTL = { min: 30, max: 600, default: 120 } as const;

export const LeaseAcquire = Type.Object(
  {
    device_id: Id('dev'),
    ttl_seconds: Type.Optional(
      Type.Integer({ minimum: LEASE_TTL.min, maximum: LEASE_TTL.max, default: LEASE_TTL.default }),
    ),
  },
  { additionalProperties: false },
);
export const LeaseRenew = Type.Object(
  {
    fencing_token: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }),
    ttl_seconds: Type.Optional(
      Type.Integer({ minimum: LEASE_TTL.min, maximum: LEASE_TTL.max, default: LEASE_TTL.default }),
    ),
  },
  { additionalProperties: false },
);
export const LeaseRelease = Type.Object(
  { fencing_token: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }) },
  { additionalProperties: false },
);
export const Lease = Type.Object(
  {
    profile_id: Id('prf'),
    holder_device_id: Id('dev'),
    holder_user_id: Id('usr'),
    /** Monotonically increasing; decimal string because it is a 64-bit integer. */
    fencing_token: Type.String(),
    acquired_at: Timestamp,
    expires_at: Timestamp,
  },
  { additionalProperties: false },
);
export type Lease = Static<typeof Lease>;

// ---------------------------------------------------------------- Snapshots
export const SnapshotCommit = Type.Object(
  {
    fencing_token: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }),
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    size_bytes: Type.Integer({ minimum: 1 }),
    platform: Type.Enum(PLATFORMS),
    browser_revision: Type.String({ minLength: 1, maxLength: 64 }),
    encryption: Type.Object(
      {
        scheme: Type.Literal('aes-256-gcm-chunked-v1'),
        key_id: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type SnapshotCommit = Static<typeof SnapshotCommit>;

export const Snapshot = Type.Object(
  {
    id: Id('snp'),
    profile_id: Id('prf'),
    object_key: Type.String(),
    sha256: Type.String(),
    size_bytes: Type.Integer(),
    platform: Type.String(),
    browser_revision: Type.String(),
    fencing_token: Type.String(),
    created_at: Timestamp,
  },
  { additionalProperties: false },
);
export type Snapshot = Static<typeof Snapshot>;

/** A time-limited permission to download one snapshot (the signed storage URL itself arrives with 07). */
export const SnapshotDownload = Type.Object(
  {
    snapshot: Snapshot,
    object_key: Type.String(),
    expires_at: Timestamp,
  },
  { additionalProperties: false },
);
