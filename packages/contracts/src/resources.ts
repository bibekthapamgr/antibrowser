import Type, { type Static } from 'typebox';
import { BillingSummary } from './billing.ts';
import { ID_PATTERN } from './ids.ts';

const Id = (prefix: Parameters<typeof ID_PATTERN>[0]) => Type.String({ pattern: ID_PATTERN(prefix) });
const FencingTokenString = () => Type.String({ pattern: '^[1-9][0-9]{0,18}$' });
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
  'snapshot.restore',
  'backups.manage',
  'keys.manage',
  'lease.force_release',
  'grants.manage',
  'audit.read',
  // Milestone 09: client tasks (create and edit what one can see) and the browser extension policy.
  'tasks.write',
  'extensions.manage',
  // Milestone 10: developer API and authorized automation (ADR-0017).
  /** See automation jobs on profiles one can see. */
  'automation.read',
  /** Ask for jobs on profiles one may open (the grant's `launch` capability), cancel one's own jobs. */
  'automation.run',
  /** Approved sites, job limits, every job and every computer that runs jobs. */
  'automation.manage',
  /** Jobs that hand a browser session to a local Playwright script (full control of that session). */
  'automation.debug',
  /** Let one's own computer run jobs (as oneself: only profiles one may open). */
  'automation.agent',
  /** Create API tokens for oneself, never beyond one's own access. */
  'tokens.create',
  /** See and revoke everyone's API tokens. */
  'tokens.manage',
  /** Webhook endpoints, their secrets and deliveries. */
  'webhooks.manage',
  // R1 (ADR-0020): folders organize a workspace's profiles; owners and admins manage them. Reading them needs only
  // profile.read. Folders are not a grant scope.
  'folders.manage',
  /** Per-workspace feature settings (the new UI, optional modules). */
  'features.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Single source of truth for the permission matrix (docs/permission-matrix.md is generated from it). */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter(
    (p) =>
      p !== 'org.transfer_ownership' && p !== 'billing.read' && p !== 'billing.manage' && p !== 'keys.manage',
  ),
  // Operators act only on granted profiles, and only with the capability the grant carries (GRANT_CAPABILITIES).
  operator: [
    'org.read',
    'clients.read',
    'profile.read',
    'profile.update',
    'profile.launch',
    'snapshot.read',
    'snapshot.commit',
    'snapshot.restore',
    'tasks.write',
    'automation.read',
    'automation.run',
    'automation.agent',
    'tokens.create',
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

/**
 * Milestone 08: what a grant lets a member do with the profiles it covers. Members with a `granted` scope need the
 * capability in a grant covering the profile, on top of their role's permission. Launch, configuration edit and backup
 * download are separate; permanent deletion, export and sharing are never grantable (owners and admins only).
 */
export const GRANT_CAPABILITIES = ['launch', 'edit', 'backup_download'] as const;
export type GrantCapability = (typeof GRANT_CAPABILITIES)[number];
/** The capability a permission needs on a granted profile (permissions not listed need none beyond the grant). */
export const PERMISSION_CAPABILITY: Partial<Record<Permission, GrantCapability>> = {
  'profile.launch': 'launch',
  'snapshot.commit': 'launch',
  'profile.update': 'edit',
  'snapshot.restore': 'backup_download',
};
/** Capabilities of a new grant when none are given: operators open and restore, viewers nothing. */
export function defaultCapabilities(role: Role): GrantCapability[] {
  return role === 'operator' ? ['launch', 'backup_download'] : [];
}
/** R3: what the Member preset gets when access is chosen in one step: open and use, nothing else. */
export const MEMBER_DEFAULT_CAPABILITIES: GrantCapability[] = ['launch'];

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
    /** Milestone 11: plan and subscription state (no amounts or provider references); GET of one organization. */
    billing: Type.Optional(BillingSummary),
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
/**
 * R3 (ADR-0022): which profiles a member reaches, chosen in one step. `all` and `folder` follow future profiles only
 * when `include_future` is true (the rule is shown in the preview); otherwise the profiles there now are granted one
 * by one. `profiles` names them; `client` keeps the agency module's whole-client grant.
 */
export const AccessScope = Type.Union([
  Type.Object({ kind: Type.Literal('all'), include_future: Type.Boolean() }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('folder'), folder_id: Id('fld'), include_future: Type.Boolean() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('profiles'),
      profile_ids: Type.Array(Id('prf'), { minItems: 1, maxItems: 500, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('client'), client_id: Id('cli') }, { additionalProperties: false }),
]);
export type AccessScope = Static<typeof AccessScope>;
const AccessCapabilities = Type.Array(Type.Enum(GRANT_CAPABILITIES), { uniqueItems: true, maxItems: 3 });
export const AccessSpec = Type.Object(
  {
    scope: AccessScope,
    /** Default for members (operators): open and use only — no restore/export of backups, no editing. */
    capabilities: Type.Optional(AccessCapabilities),
  },
  { additionalProperties: false },
);
export type AccessSpec = Static<typeof AccessSpec>;
/** What a scope reaches now, shown before anything is granted. */
export const AccessPreview = Type.Object(
  {
    profile_count: Type.Integer({ minimum: 0 }),
    /** Up to 50, by name. */
    profiles: Type.Array(
      Type.Object({ id: Id('prf'), name: Type.String() }, { additionalProperties: false }),
    ),
    /** Profiles added later are included too (a folder or whole-workspace rule). */
    includes_future: Type.Boolean(),
    capabilities: AccessCapabilities,
  },
  { additionalProperties: false },
);
export type AccessPreview = Static<typeof AccessPreview>;

export const InvitationCreate = Type.Object(
  {
    email: Email,
    role: Type.Enum(ASSIGNABLE_ROLES),
    expires_in_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, default: 7 })),
    /** R3: the access the member gets on acceptance (members and viewers; admins reach everything). */
    access: Type.Optional(AccessSpec),
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
  {
    invitation: Invitation,
    token: Type.String(),
    /** R2: whether the link was also queued as an e-mail to the invited address (`not_configured`: share it). */
    email_delivery: Type.Optional(Type.Enum(['queued', 'not_configured'])),
  },
  { additionalProperties: false },
);
export const InvitationPreview = Type.Object(
  {
    org_id: Id('org'),
    org_name: Type.String(),
    role: Type.Enum(ASSIGNABLE_ROLES),
    expires_at: Timestamp,
    status: Type.Enum(['open', 'accepted', 'expired', 'revoked']),
    for_this_account: Type.Boolean({
      description: "Whether the caller's verified e-mail matches the invitation.",
    }),
    already_member: Type.Boolean({
      description:
        'Whether the signed-in account is already a member of this workspace (the invitation has nothing left ' +
        'to do; the portal shows a friendly confirmation rather than an error).',
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

const Capabilities = Type.Array(Type.Enum(GRANT_CAPABILITIES), { uniqueItems: true, maxItems: 3 });
export const Grant = Type.Object(
  {
    id: Id('grt'),
    user_id: Id('usr'),
    client_id: Type.Union([Id('cli'), Type.Null()]),
    profile_id: Type.Union([Id('prf'), Type.Null()]),
    /** R3: every profile in this folder, now and later (an explicit rule). */
    folder_id: Type.Optional(Type.Union([Id('fld'), Type.Null()])),
    /** R3: every profile of the workspace, now and later. */
    all_profiles: Type.Optional(Type.Boolean()),
    /** Milestone 08: launch, edit (configuration) and backup_download (restore). Viewers' grants carry none. */
    capabilities: Capabilities,
    created_at: Timestamp,
  },
  { additionalProperties: false },
);
export type Grant = Static<typeof Grant>;
export const GrantCreate = Type.Union([
  Type.Object(
    { user_id: Id('usr'), client_id: Id('cli'), capabilities: Type.Optional(Capabilities) },
    { additionalProperties: false },
  ),
  Type.Object(
    { user_id: Id('usr'), profile_id: Id('prf'), capabilities: Type.Optional(Capabilities) },
    { additionalProperties: false },
  ),
  Type.Object(
    { user_id: Id('usr'), folder_id: Id('fld'), capabilities: Type.Optional(Capabilities) },
    { additionalProperties: false },
  ),
  Type.Object(
    { user_id: Id('usr'), all_profiles: Type.Literal(true), capabilities: Type.Optional(Capabilities) },
    { additionalProperties: false },
  ),
]);
/** R3: one member's access set in one step (grants are created as the scope says; see AccessScope). */
export const MemberAccessSet = AccessSpec;
/** R3: who gains or loses access when a profile moves to another folder (folder grants follow the folder). */
export const FolderMoveImpact = Type.Object(
  {
    gains: Type.Array(
      Type.Object({ user_id: Id('usr'), display_name: Type.String() }, { additionalProperties: false }),
    ),
    losses: Type.Array(
      Type.Object({ user_id: Id('usr'), display_name: Type.String() }, { additionalProperties: false }),
    ),
    /** Whether the caller may make this move (an access change needs grants.manage). */
    allowed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type FolderMoveImpact = Static<typeof FolderMoveImpact>;
export const GrantUpdate = Type.Object({ capabilities: Capabilities }, { additionalProperties: false });

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

export const LEASE_PURPOSES = ['session', 'upload'] as const;
/** What a holder reports about the browser run on its device (milestone 08; audited on change). */
export const RUN_STATES = ['starting', 'restoring', 'running', 'stopping', 'uploading', 'closed'] as const;

/**
 * Milestone 08: the profile is open (or being backed up) on a device. `uncertain`: a session whose lease expired
 * without a release; its browser may still be open, so nobody else can open the profile until that device confirms it
 * closed or an admin forces a takeover.
 */
export const ProfileInUse = Type.Object(
  {
    lease_id: Id('lse'),
    purpose: Type.Enum(LEASE_PURPOSES),
    state: Type.Enum(['active', 'uncertain'] as const),
    holder_user_id: Id('usr'),
    holder_name: Type.String(),
    device_id: Id('dev'),
    device_name: Type.String(),
    run_state: Type.Union([Type.Enum(RUN_STATES), Type.Null()]),
    since: Timestamp,
    heartbeat_at: Type.Union([Timestamp, Type.Null()]),
    expires_at: Timestamp,
    /** The caller holds it (this person, any of their devices). */
    mine: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ProfileInUse = Static<typeof ProfileInUse>;

/** Every profile has exactly one owner organization; moving between organizations is an export/import. */
export const Profile = Type.Object(
  {
    id: Id('prf'),
    org_id: Id('org'),
    name: Label,
    client_id: Type.Union([Id('cli'), Type.Null()]),
    notes: Type.String({ maxLength: 2000 }),
    version: Version,
    /** Version of the newest committed snapshot (0: never backed up). Milestone 07. */
    snapshot_version: Type.Integer({ minimum: 0 }),
    last_snapshot_at: Type.Union([Timestamp, Type.Null()]),
    /** Milestone 08: who has it open right now (null: nobody). Lists and single reads only. */
    in_use: Type.Optional(Type.Union([ProfileInUse, Type.Null()])),
    /** Milestone 08: what the caller may do with this profile (from role and grants). Lists and single reads only. */
    capabilities: Type.Optional(Capabilities),
    /** R3: the folder it is in (null: none). Lists, single reads, create and update answers. */
    folder_id: Type.Optional(Type.Union([Id('fld'), Type.Null()])),
    created_at: Timestamp,
    updated_at: Timestamp,
  },
  { additionalProperties: false },
);
export type Profile = Static<typeof Profile>;

/** A deleted profile in the organization's trash (restorable until `purge_after`). */
export const TrashedProfile = Type.Object(
  {
    profile: Profile,
    deleted_at: Timestamp,
    purge_after: Timestamp,
  },
  { additionalProperties: false },
);
export type TrashedProfile = Static<typeof TrashedProfile>;

export const ProfileCreate = Type.Object(
  {
    name: Label,
    client_id: Type.Optional(Type.Union([Id('cli'), Type.Null()])),
    notes: Type.Optional(Type.String({ maxLength: 2000 })),
    /** R3: created straight into this folder (optional). */
    folder_id: Type.Optional(Type.Union([Id('fld'), Type.Null()])),
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
    /**
     * R1: the importing device. With it, each local profile maps to at most one workspace profile (the server's
     * profile identity map): importing the same local profile again returns the existing mapping instead of a copy.
     */
    device_id: Type.Optional(Id('dev')),
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
          outcome: Type.Enum(['create', 'existing'], {
            description:
              'create: a new organization profile (always a new server id; the device keeps its local record). ' +
              'existing (R1, with device_id): this local profile was already adopted by this device; its mapping.',
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

// ---------------------------------------------------------------- Session leases and handoff (milestone 08)
/**
 * Session leases: one writer per shared profile. The holder heartbeats every `heartbeat_seconds`; the lease lasts
 * `ttl_seconds` past the last heartbeat (database clock). Tunable starting values (handoff file: 15 s / 60 s).
 */
export const SESSION_LEASE = { ttlSeconds: 60, heartbeatSeconds: 15, uploadTtlSeconds: 600 } as const;
/** How long an access request waits for an answer before it expires. */
export const HANDOFF_REQUEST_HOURS = 4;
const Note = Type.String({ maxLength: 500 });

export const LEASE_STATES = [
  'active',
  'uncertain',
  'released',
  'taken_over',
  'revoked',
  'superseded',
] as const;
export const SessionLease = Type.Object(
  {
    id: Id('lse'),
    profile_id: Id('prf'),
    purpose: Type.Enum(LEASE_PURPOSES),
    state: Type.Enum(LEASE_STATES),
    holder_user_id: Id('usr'),
    holder_name: Type.String(),
    device_id: Id('dev'),
    device_name: Type.String(),
    /** Decimal string (64-bit). Every fenced write must present it. */
    fencing_token: FencingTokenString(),
    run_state: Type.Union([Type.Enum(RUN_STATES), Type.Null()]),
    acquired_at: Timestamp,
    expires_at: Timestamp,
    heartbeat_at: Type.Union([Timestamp, Type.Null()]),
    ttl_seconds: Type.Integer({ minimum: 30, maximum: 600 }),
    heartbeat_seconds: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type SessionLease = Static<typeof SessionLease>;

/** POST /orgs/{org}/profiles/{prf}/leases (Idempotency-Key required). */
export const LeaseOpen = Type.Object(
  {
    device_id: Id('dev'),
    /** `session` (default): the browser will run on this device. `upload`: a backup of the closed profile. */
    purpose: Type.Optional(Type.Enum(LEASE_PURPOSES)),
    platform: Type.Enum(PLATFORMS),
    /** The browser this device will open the profile with (checked against the newest backup). */
    browser_version: Type.String({ minLength: 1, maxLength: 64, pattern: '^[0-9A-Za-z._+-]+$' }),
  },
  { additionalProperties: false },
);
export type LeaseOpen = Static<typeof LeaseOpen>;

export const HandoffNote = Type.Object(
  { text: Type.String(), by_user_id: Id('usr'), by_name: Type.String(), at: Timestamp },
  { additionalProperties: false },
);
export const LeaseOpened = Type.Object(
  {
    lease: SessionLease,
    /** Left by the previous holder when they released the profile. */
    handoff_note: Type.Union([HandoffNote, Type.Null()]),
    /** The newest committed backup (0: none): restore it first when this device's copy is older. */
    head_version: Type.Integer({ minimum: 0 }),
    server_time: Timestamp,
  },
  { additionalProperties: false },
);
export type LeaseOpened = Static<typeof LeaseOpened>;

export const LeaseHeartbeat = Type.Object(
  { fencing_token: FencingTokenString(), run_state: Type.Optional(Type.Enum(RUN_STATES)) },
  { additionalProperties: false },
);

export const HANDOFF_STATUSES = ['open', 'declined', 'canceled', 'fulfilled', 'expired'] as const;
export const HandoffRequest = Type.Object(
  {
    id: Id('hrq'),
    profile_id: Id('prf'),
    requested_by: Id('usr'),
    requested_by_name: Type.String(),
    holder_user_id: Type.Union([Id('usr'), Type.Null()]),
    note: Type.String(),
    status: Type.Enum(HANDOFF_STATUSES),
    created_at: Timestamp,
    responded_at: Type.Union([Timestamp, Type.Null()]),
    expires_at: Timestamp,
    /** The caller asked. */
    mine: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type HandoffRequest = Static<typeof HandoffRequest>;
export const HandoffRequestCreate = Type.Object(
  { note: Type.Optional(Note), device_id: Type.Optional(Id('dev')) },
  { additionalProperties: false },
);

export const LeaseBeat = Type.Object(
  {
    lease: SessionLease,
    /** Lease had expired (uncertain) and this heartbeat confirmed the holder is still here. */
    revived: Type.Boolean(),
    /** Open requests from teammates who want this profile. */
    handoff_requests: Type.Array(HandoffRequest),
    server_time: Timestamp,
  },
  { additionalProperties: false },
);
export type LeaseBeat = Static<typeof LeaseBeat>;

export const LEASE_OUTCOMES = ['committed', 'closed', 'aborted', 'failed'] as const;
/** Release with the current fencing token; allowed after expiry (the holder confirms its browser closed). */
export const LeaseEnd = Type.Object(
  {
    fencing_token: FencingTokenString(),
    /** committed: closed and backed up ("handoff ready"); closed: closed without a new backup; aborted: handoff
     *  given up, the newest backup stays as it was; failed: the launch failed. */
    outcome: Type.Enum(LEASE_OUTCOMES),
    handoff_note: Type.Optional(Note),
  },
  { additionalProperties: false },
);

export const ForceTakeover = Type.Object(
  {
    reason: Type.String({ minLength: 3, maxLength: 500 }),
    /** The caller saw the warning: the other device may still be open and its unsynced changes are not merged. */
    confirm: Type.Literal(true),
  },
  { additionalProperties: false },
);
export const TakeoverResult = Type.Object(
  { previous: SessionLease, fencing_token: FencingTokenString() },
  { additionalProperties: false },
);

/** An upload kept from a device that lost its session lease: never the head, restorable as a copy by admins. */
export const RecoveryCopy = Type.Object(
  {
    id: Id('snp'),
    profile_id: Id('prf'),
    profile_name: Type.String(),
    lease_id: Type.Union([Id('lse'), Type.Null()]),
    created_by: Id('usr'),
    created_by_name: Type.String(),
    device_id: Type.Union([Id('dev'), Type.Null()]),
    ciphertext_size: Type.Integer({ minimum: 1 }),
    plaintext_size: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    platform: Type.String(),
    browser_version: Type.String(),
    kept_at: Timestamp,
    erase_after: Timestamp,
  },
  { additionalProperties: false },
);
export type RecoveryCopy = Static<typeof RecoveryCopy>;

// ---------------------------------------------------------------- Snapshots and synchronization (milestone 07)
/** Snapshot container scheme (pb-seal): tar + zstd + chunked AES-256-GCM (STREAM). */
export const SNAPSHOT_SCHEME = 'aes-256-gcm-chunked-v1' as const;
/** Archive layout version inside the container. */
export const SNAPSHOT_SCHEMA_VERSION = 1;
const Digest = Type.String({ pattern: '^[0-9a-f]{64}$' });
const FencingToken = Type.String({ pattern: '^[1-9][0-9]{0,18}$' });
const PartNumber = Type.Integer({ minimum: 1, maximum: 10000 });

/** `kept`: a recovery copy was verified and stored (it never becomes the head). Milestone 08. */
export const SYNC_STATES = [
  'uploading',
  'verifying',
  'committed',
  'kept',
  'failed',
  'canceled',
  'expired',
] as const;
export type SyncState = (typeof SYNC_STATES)[number];

export const SNAPSHOT_STATUSES = [
  'pending',
  'verifying',
  'committed',
  'failed',
  'canceled',
  'expired',
  'deleted',
  'recovery',
] as const;

/** A committed (or in-progress) snapshot manifest. Object locations and wrapped keys are never returned. */
export const Snapshot = Type.Object(
  {
    id: Id('snp'),
    profile_id: Id('prf'),
    status: Type.Enum(SNAPSHOT_STATUSES),
    version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    parent_version: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    digest: Type.Union([Digest, Type.Null()]),
    ciphertext_size: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    plaintext_size: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    platform: Type.String(),
    browser_version: Type.String(),
    schema_version: Type.Integer(),
    encryption_scheme: Type.String(),
    key_version: Type.String(),
    created_by: Id('usr'),
    device_id: Type.Union([Id('dev'), Type.Null()]),
    created_at: Timestamp,
    committed_at: Type.Union([Timestamp, Type.Null()]),
  },
  { additionalProperties: false },
);
export type Snapshot = Static<typeof Snapshot>;

export const SyncOperation = Type.Object(
  {
    id: Id('syn'),
    profile_id: Id('prf'),
    snapshot_id: Id('snp'),
    state: Type.Enum(SYNC_STATES),
    base_version: Type.Integer({ minimum: 0 }),
    /** The version this snapshot became (committed only). */
    version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    error_code: Type.Union([Type.String(), Type.Null()]),
    expires_at: Timestamp,
    created_at: Timestamp,
    updated_at: Timestamp,
  },
  { additionalProperties: false },
);
export type SyncOperation = Static<typeof SyncOperation>;

/** The data key and binding a device uses to seal (init) or open (restore plan) one snapshot. Never logged. */
export const SnapshotKey = Type.Object(
  {
    scheme: Type.Literal(SNAPSHOT_SCHEME),
    schema_version: Type.Integer(),
    key_version: Id('okv'),
    /** 32 bytes, base64. Shown only to the authorized device in this response. */
    data_key: Type.String({ pattern: '^[A-Za-z0-9+/]{43}=$' }),
    org_id: Id('org'),
    profile_id: Id('prf'),
    snapshot_id: Id('snp'),
  },
  { additionalProperties: false },
);
export type SnapshotKey = Static<typeof SnapshotKey>;

/** POST /orgs/{org}/profiles/{prf}/snapshots/init (Idempotency-Key required). */
export const SnapshotInit = Type.Object(
  {
    /** The snapshot version this device's copy is based on (0 for the first backup). */
    base_version: Type.Integer({ minimum: 0 }),
    fencing_token: FencingToken,
    platform: Type.Enum(PLATFORMS),
    browser_version: Type.String({ minLength: 1, maxLength: 64, pattern: '^[0-9A-Za-z._+-]+$' }),
    /** Optional estimate (bytes of profile data) for an early quota check. */
    estimated_size: Type.Optional(Type.Integer({ minimum: 0 })),
    /**
     * Milestone 08: keep this upload as a recovery copy. `fencing_token` is then the token of a session lease this
     * device held and lost (taken over or revoked); the upload never becomes the head.
     */
    recovery: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type SnapshotInit = Static<typeof SnapshotInit>;

export const SnapshotInitResult = Type.Object(
  {
    operation: SyncOperation,
    key: SnapshotKey,
    upload: Type.Object(
      {
        part_size: Type.Integer({ minimum: 1 }),
        max_parts: Type.Integer({ minimum: 1 }),
        max_bytes: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type SnapshotInitResult = Static<typeof SnapshotInitResult>;

export const PartUrlsRequest = Type.Object(
  { part_numbers: Type.Array(PartNumber, { minItems: 1, maxItems: 50, uniqueItems: true }) },
  { additionalProperties: false },
);
export const PartUrls = Type.Object(
  {
    parts: Type.Array(
      Type.Object(
        { part_number: PartNumber, url: Type.String(), expires_at: Timestamp },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const UploadedParts = Type.Object(
  {
    parts: Type.Array(
      Type.Object(
        { part_number: PartNumber, size: Type.Integer({ minimum: 0 }), etag: Type.String() },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** POST .../snapshots/{snp}/commit: the device declares what it uploaded; the server verifies before committing. */
export const SnapshotCommit = Type.Object(
  {
    fencing_token: FencingToken,
    digest: Digest,
    ciphertext_size: Type.Integer({ minimum: 1 }),
    plaintext_size: Type.Integer({ minimum: 0 }),
    parts: Type.Array(
      Type.Object(
        { part_number: PartNumber, etag: Type.String({ minLength: 1, maxLength: 200 }) },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 10000 },
    ),
  },
  { additionalProperties: false },
);
export type SnapshotCommit = Static<typeof SnapshotCommit>;

/** POST .../restore-plans: download link + data key for one committed snapshot (default: the newest). */
export const RestorePlanRequest = Type.Object(
  { snapshot_id: Type.Optional(Id('snp')) },
  { additionalProperties: false },
);
export const RestorePlan = Type.Object(
  {
    snapshot: Snapshot,
    /** The profile's newest committed version at planning time (a restored copy is based on it). */
    head_version: Type.Integer({ minimum: 0 }),
    download: Type.Object({ url: Type.String(), expires_at: Timestamp }, { additionalProperties: false }),
    key: SnapshotKey,
  },
  { additionalProperties: false },
);
export type RestorePlan = Static<typeof RestorePlan>;

// ---------------------------------------------------------------- Backup policy, trash and keys (milestone 07)
export const BackupPolicy = Type.Object(
  {
    /** Newest snapshot of each of this many days is kept (plus everything from the last 24 hours and the newest). */
    retention_days: Type.Integer({ minimum: 1, maximum: 90 }),
    /** Deleted profiles stay restorable this long, then their snapshots are erased. */
    trash_days: Type.Integer({ minimum: 1, maximum: 90 }),
    /**
     * The smaller of the service operator's cost limit and the plan's backup storage (milestone 11); not editable by
     * the organization.
     */
    quota_bytes: Type.Integer({ minimum: 1 }),
    max_snapshot_bytes: Type.Integer({ minimum: 1 }),
    used_bytes: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type BackupPolicy = Static<typeof BackupPolicy>;
export const BackupPolicyUpdate = Type.Object(
  {
    retention_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
    trash_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const ORG_KEY_STATUSES = ['active', 'retired', 'destroyed'] as const;
export const OrgKeyVersion = Type.Object(
  {
    id: Id('okv'),
    version: Type.Integer({ minimum: 1 }),
    status: Type.Enum(ORG_KEY_STATUSES),
    /** Snapshots whose data keys are still wrapped by this version. */
    snapshots: Type.Integer({ minimum: 0 }),
    created_at: Timestamp,
    retired_at: Type.Union([Timestamp, Type.Null()]),
    destroy_after: Type.Union([Timestamp, Type.Null()]),
    destroyed_at: Type.Union([Timestamp, Type.Null()]),
  },
  { additionalProperties: false },
);
export type OrgKeyVersion = Static<typeof OrgKeyVersion>;
export const OrgKeys = Type.Object(
  { keys: Type.Array(OrgKeyVersion), kms_provider: Type.String() },
  { additionalProperties: false },
);
export type OrgKeys = Static<typeof OrgKeys>;
