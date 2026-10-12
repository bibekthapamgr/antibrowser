import Type, { type Static } from 'typebox';
import { ID_PATTERN } from './ids.ts';

const Id = (prefix: Parameters<typeof ID_PATTERN>[0]) => Type.String({ pattern: ID_PATTERN(prefix) });
const Timestamp = Type.String({ format: 'date-time', description: 'UTC, RFC 3339' });

// ---------------------------------------------------------------- Roles & permissions
export const ROLES = ['owner', 'admin', 'manager', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org.read',
  'org.manage_members',
  'org.manage_billing',
  'profile.read',
  'profile.create',
  'profile.update',
  'profile.delete',
  'profile.launch',
  'lease.force_release',
  'snapshot.commit',
  'snapshot.restore',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Draft permission matrix (docs/permission-matrix.md is generated from this). Server-enforced only. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter((p) => p !== 'org.manage_billing'),
  manager: [
    'org.read',
    'profile.read',
    'profile.create',
    'profile.update',
    'profile.delete',
    'profile.launch',
    'lease.force_release',
    'snapshot.commit',
    'snapshot.restore',
    'audit.read',
  ],
  operator: ['org.read', 'profile.read', 'profile.launch', 'snapshot.commit', 'snapshot.restore'],
  viewer: ['org.read', 'profile.read'],
};

export function roleAllows(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

// ---------------------------------------------------------------- Me / devices
export const Membership = Type.Object(
  { org_id: Id('org'), org_name: Type.String(), role: Type.Enum(ROLES) },
  { additionalProperties: false },
);
export const Me = Type.Object(
  {
    user_id: Id('usr'),
    display_name: Type.String(),
    memberships: Type.Array(Membership),
  },
  { additionalProperties: false },
);
export type Me = Static<typeof Me>;

export const PLATFORMS = ['windows-x64', 'macos-arm64', 'macos-x64', 'linux-x64'] as const;
export const DeviceRegistration = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    platform: Type.Enum(PLATFORMS),
  },
  { additionalProperties: false },
);
export const Device = Type.Object(
  {
    id: Id('dev'),
    name: Type.String(),
    platform: Type.Enum(PLATFORMS),
    created_at: Timestamp,
  },
  { additionalProperties: false },
);
export type Device = Static<typeof Device>;

// ---------------------------------------------------------------- Profiles
/** Labels are display text only. They are never used to build disk paths (see ADR-0002 and crates/runtime). */
const Label = Type.String({ minLength: 1, maxLength: 120 });

export const Profile = Type.Object(
  {
    id: Id('prf'),
    org_id: Id('org'),
    name: Label,
    client_label: Type.Union([Label, Type.Null()]),
    folder_label: Type.Union([Label, Type.Null()]),
    notes: Type.String({ maxLength: 2000 }),
    version: Type.Integer({ minimum: 1 }),
    created_at: Timestamp,
    updated_at: Timestamp,
  },
  { additionalProperties: false },
);
export type Profile = Static<typeof Profile>;

export const ProfileCreate = Type.Object(
  {
    name: Label,
    client_label: Type.Optional(Type.Union([Label, Type.Null()])),
    folder_label: Type.Optional(Type.Union([Label, Type.Null()])),
    notes: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);
export type ProfileCreate = Static<typeof ProfileCreate>;

export const ProfileUpdate = Type.Object(
  {
    expected_version: Type.Optional(Type.Integer({ minimum: 1 })),
    name: Type.Optional(Label),
    client_label: Type.Optional(Type.Union([Label, Type.Null()])),
    folder_label: Type.Optional(Type.Union([Label, Type.Null()])),
    notes: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type ProfileUpdate = Static<typeof ProfileUpdate>;

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
