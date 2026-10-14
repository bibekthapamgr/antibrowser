/**
 * R1 product model (ADR-0020): the organization presented as a Workspace/Team, folders, per-workspace feature
 * settings, onboarding state, capability negotiation and the device migration record. Browser-safe: no Node imports.
 *
 * Nothing here replaces an earlier contract. org_id remains the tenant boundary; "workspace" is a label.
 */
import Type, { type Static, type TSchema } from 'typebox';
import { ID_PATTERN } from './ids.ts';
import { ROLES, type Role } from './resources.ts';

const Id = (prefix: Parameters<typeof ID_PATTERN>[0]) => Type.String({ pattern: ID_PATTERN(prefix) });
const Timestamp = Type.String({ format: 'date-time', description: 'UTC, RFC 3339' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const Version = Type.Integer({ minimum: 1 });
const Name = Type.String({ minLength: 1, maxLength: 120 });
const Colour = Type.String({ pattern: '^#[0-9a-f]{6}$' });

// ---------------------------------------------------------------- role presets
/**
 * The three presets the customer UI shows (R1 step 2). They map onto existing roles and never broaden them:
 * Owner = owner, Admin = admin, Member = operator with explicit grants. viewer and billing stay available as
 * "advanced" presets for existing members; nothing is promoted or renamed in the database.
 */
export const ROLE_PRESETS = {
  owner: { role: 'owner', label: 'Owner', advanced: false },
  admin: { role: 'admin', label: 'Admin', advanced: false },
  member: { role: 'operator', label: 'Member', advanced: false },
  viewer: { role: 'viewer', label: 'Viewer (advanced)', advanced: true },
  billing: { role: 'billing', label: 'Billing only (advanced)', advanced: true },
} as const satisfies Record<string, { role: Role; label: string; advanced: boolean }>;
export type RolePreset = keyof typeof ROLE_PRESETS;
export function presetOfRole(role: Role): RolePreset {
  const found = (Object.keys(ROLE_PRESETS) as RolePreset[]).find((k) => ROLE_PRESETS[k].role === role);
  return found ?? 'viewer';
}

// ---------------------------------------------------------------- folders
export const Folder = Type.Object(
  {
    id: Id('fld'),
    org_id: Id('org'),
    name: Name,
    colour: Nullable(Colour),
    position: Type.Integer({ minimum: 0, maximum: 9999 }),
    archived_at: Nullable(Timestamp),
    /** Profiles in this folder that the caller can see. */
    profile_count: Type.Integer({ minimum: 0 }),
    version: Version,
    created_at: Timestamp,
    updated_at: Timestamp,
  },
  { additionalProperties: false },
);
export type Folder = Static<typeof Folder>;
export const FolderCreate = Type.Object(
  {
    name: Name,
    colour: Type.Optional(Nullable(Colour)),
    position: Type.Optional(Type.Integer({ minimum: 0, maximum: 9999 })),
  },
  { additionalProperties: false },
);
export const FolderUpdate = Type.Object(
  {
    expected_version: Type.Optional(Version),
    name: Type.Optional(Name),
    colour: Type.Optional(Nullable(Colour)),
    position: Type.Optional(Type.Integer({ minimum: 0, maximum: 9999 })),
    archived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);
/** Puts a profile in a folder (or in none). Moving between folders changes nobody's access (ADR-0020). */
export const ProfileFolderSet = Type.Object(
  { folder_id: Nullable(Id('fld')) },
  { additionalProperties: false },
);
export const ProfileFolder = Type.Object(
  { profile_id: Id('prf'), folder_id: Nullable(Id('fld')) },
  { additionalProperties: false },
);

// ---------------------------------------------------------------- feature settings
/**
 * Known per-workspace settings with their defaults. Unknown keys are refused; a value must match its schema.
 *   ui.unified_profiles  the R3 single Profiles view (on since R3, ADR-0022; off is the rollback switch of R1/R3)
 *   modules.agency       client dashboards, tasks and bookmarks (hidden by default for new workspaces; on where
 *                        data exists, see ADR-0020)
 *   modules.automation   developer tools (API tokens, jobs, webhooks) shown in the UI
 */
export const FEATURE_SETTINGS = {
  'ui.unified_profiles': { schema: Type.Boolean(), default: true },
  'modules.agency': { schema: Type.Boolean(), default: false },
  'modules.automation': { schema: Type.Boolean(), default: false },
} as const;
export type FeatureKey = keyof typeof FEATURE_SETTINGS;
export const FEATURE_KEYS = Object.keys(FEATURE_SETTINGS) as FeatureKey[];
const FeatureValue = Type.Boolean();
export const FeatureSettings = Type.Object(
  {
    settings: Type.Array(
      Type.Object(
        {
          key: Type.Enum(FEATURE_KEYS as readonly FeatureKey[] as [FeatureKey, ...FeatureKey[]]),
          value: FeatureValue,
          /** Whether the workspace set it (false: the default applies). */
          set: Type.Boolean(),
          version: Nullable(Version),
          updated_at: Nullable(Timestamp),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type FeatureSettings = Static<typeof FeatureSettings>;
export const FeatureSettingsUpdate = Type.Object(
  {
    settings: Type.Array(
      Type.Object(
        {
          key: Type.Enum(FEATURE_KEYS as readonly FeatureKey[] as [FeatureKey, ...FeatureKey[]]),
          value: FeatureValue,
          expected_version: Type.Optional(Nullable(Version)),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 16 },
    ),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------- onboarding
/** R2 adds `choose`: several owned workspaces, the person picks the default once. */
export const ONBOARDING_STATES = ['new', 'invited', 'ready', 'choose'] as const;
export const OnboardingState = Type.Object(
  {
    state: Type.Enum(ONBOARDING_STATES),
    /** The workspace the app opens first. */
    default_org_id: Nullable(Id('org')),
    /** True when the row exists (R2 writes it); false when it was derived from memberships. */
    recorded: Type.Boolean(),
    completed_at: Nullable(Timestamp),
  },
  { additionalProperties: false },
);
export type OnboardingState = Static<typeof OnboardingState>;

// ---------------------------------------------------------------- capability negotiation
/**
 * What this server offers, so a desktop shows only what the server can do, and what the server requires of the
 * desktop. Features here are server abilities, not per-workspace settings.
 */
export const SERVER_FEATURES = [
  'folders',
  'feature_settings',
  'onboarding_state',
  'profile_identity_map',
  'migration_runs',
] as const;
export const Capabilities = Type.Object(
  {
    api: Type.Literal('v1'),
    server_version: Type.String(),
    features: Type.Array(Type.Enum(SERVER_FEATURES)),
    /** Desktops below this must update (also enforced with 426 CLIENT_UPDATE_REQUIRED). */
    minimum_desktop_version: Nullable(Type.String()),
    /** The newest desktop version the server knows about (what updates offer), when configured. */
    latest_desktop_version: Nullable(Type.String()),
  },
  { additionalProperties: false },
);
export type Capabilities = Static<typeof Capabilities>;

// ---------------------------------------------------------------- migration runs
export const MIGRATION_STATES = ['planned', 'running', 'completed', 'failed', 'rolled_back'] as const;
export type MigrationState = (typeof MIGRATION_STATES)[number];
const Digest = Type.String({ pattern: '^[0-9a-f]{64}$' });
/** Counts only: never profile names, cookies or secrets. */
const Counts = Type.Record(Type.String({ pattern: '^[a-z_]{1,40}$' }), Type.Integer({ minimum: 0 }), {
  maxProperties: 32,
  additionalProperties: false,
});
export const MigrationRun = Type.Object(
  {
    id: Id('mgr'),
    org_id: Id('org'),
    device_id: Id('dev'),
    owner_id: Id('usr'),
    manifest_digest: Digest,
    state: Type.Enum(MIGRATION_STATES),
    checkpoint: Type.Record(Type.String(), Type.Unknown()),
    counts: Counts,
    error_code: Nullable(Type.String({ pattern: '^[A-Z0-9_]{1,64}$' })),
    version: Version,
    created_at: Timestamp,
    updated_at: Timestamp,
  },
  { additionalProperties: false },
);
export type MigrationRun = Static<typeof MigrationRun>;
/** Creates the run for (device, manifest) or returns the existing one; later calls update state and checkpoint. */
export const MigrationRunUpsert = Type.Object(
  {
    device_id: Id('dev'),
    manifest_digest: Digest,
    state: Type.Enum(MIGRATION_STATES),
    checkpoint: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    counts: Type.Optional(Counts),
    error_code: Type.Optional(Nullable(Type.String({ pattern: '^[A-Z0-9_]{1,64}$' }))),
  },
  { additionalProperties: false },
);
export type MigrationRunUpsert = Static<typeof MigrationRunUpsert>;

/** The roles presets refer to, re-exported for the UI's convenience. */
export const PRESET_ROLES = ROLES;
