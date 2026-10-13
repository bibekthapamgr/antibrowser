/**
 * Desktop IPC contract (milestone 02 deliverable "IPC schemas"; milestone 03 adds the runtime lifecycle; milestone 04
 * adds profile/client management, bulk actions, the trash, templates, and configuration import/export; milestone 05
 * adds proxies, routing, connectivity checks and privacy/environment settings; milestone 06 adds the account, sign-in
 * and organization requests relayed by the shell; milestone 07 adds encrypted backups; milestone 08 adds shared
 * sessions: one writer per organization profile, handoff notes, requests, and what happens when access ends).
 *
 * The manager webview talks to the Rust shell only through these commands and events. Rust validates every input
 * again (apps/desktop/src-tauri); these schemas document the shapes and let the UI type-check its calls.
 * Generated JSON: docs/ipc-schema.json (`pnpm run docs:ipc`).
 *
 * This module must stay browser-safe: no Node imports.
 */
import Type, { type Static, type TSchema } from 'typebox';

const ProfileIdPattern = '^prf_[0-9A-HJKMNP-TV-Z]{26}$';
const WorkspaceIdPattern = '^wsp_[0-9A-HJKMNP-TV-Z]{26}$';
const ClientIdPattern = '^cli_[0-9A-HJKMNP-TV-Z]{26}$';
const TagIdPattern = '^tag_[0-9A-HJKMNP-TV-Z]{26}$';
const TemplateIdPattern = '^tpl_[0-9A-HJKMNP-TV-Z]{26}$';
const ImportJobIdPattern = '^imp_[0-9A-HJKMNP-TV-Z]{26}$';
const FilterIdPattern = '^flt_[0-9A-HJKMNP-TV-Z]{26}$';
const ProxyIdPattern = '^prx_[0-9A-HJKMNP-TV-Z]{26}$';
const NetworkCheckIdPattern = '^nck_[0-9A-HJKMNP-TV-Z]{26}$';

export const IpcError = Type.Object({
  code: Type.String(),
  message: Type.String(),
  current_version: Type.Optional(Type.Integer()),
});
export type IpcError = Static<typeof IpcError>;

export const Workspace = Type.Object({
  id: Type.String({ pattern: WorkspaceIdPattern }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  kind: Type.Literal('local'),
  created_at: Type.String(),
});
export type Workspace = Static<typeof Workspace>;

const Colour = Type.String({ pattern: '^#[0-9a-f]{6}$' });
const StartUrl = Type.String({ maxLength: 2048, pattern: '^https?://' });
export const PermissionDefault = Type.Enum(['ask', 'block', 'allow']);
export const RunState = Type.Enum(['stopped', 'starting', 'running', 'stopping', 'crashed', 'recovering']);
export type RunState = Static<typeof RunState>;
const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);

export const TagRef = Type.Object({
  id: Type.String({ pattern: TagIdPattern }),
  name: Type.String({ minLength: 1, maxLength: 40 }),
});
export type TagRef = Static<typeof TagRef>;

// ------------------------------------------------------------------------------------------------ milestone 05
export const WebRtcPolicy = Type.Enum(['default', 'public_interface_only', 'disable_non_proxied_udp']);
export const TextSize = Type.Enum(['default', 'large', 'larger']);
/**
 * Privacy and environment settings: configuration and QA controls the browser itself supports. They change what
 * the browser sends and shows; they do not make a profile look like a different device, and nothing is randomised.
 */
export const PrivacyConfig = Type.Object(
  {
    webrtc: Type.Optional(WebRtcPolicy),
    block_third_party_cookies: Type.Optional(Type.Boolean()),
    do_not_track: Type.Optional(Type.Boolean()),
    language: Type.Optional(Nullable(Type.String({ maxLength: 16 }))),
    timezone: Type.Optional(Nullable(Type.String({ maxLength: 40 }))),
    window: Type.Optional(
      Nullable(
        Type.Object(
          {
            width: Type.Integer({ minimum: 800, maximum: 3840 }),
            height: Type.Integer({ minimum: 600, maximum: 2160 }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    text_size: Type.Optional(TextSize),
    reduced_motion: Type.Optional(Type.Boolean()),
    preset: Type.Optional(Nullable(Type.String({ maxLength: 40 }))),
  },
  { additionalProperties: false },
);
export type PrivacyConfig = Static<typeof PrivacyConfig>;

export const NetworkView = Type.Object({
  status: Type.Enum(['off', 'ready', 'active', 'failing', 'bypassing', 'lost'], {
    description:
      'off: no proxy; ready: proxy assigned, profile closed; failing: traffic blocked; bypassing: fail-closed is off and traffic goes direct; lost: reopen the profile.',
  }),
  last_error: Nullable(Type.String({ maxLength: 64 })),
  direct_connections: Type.Integer({ minimum: 0 }),
  restart_required: Type.Boolean({ description: 'Settings changed while the profile was open.' }),
});
export type NetworkView = Static<typeof NetworkView>;

export const ProfileView = Type.Object({
  id: Type.String({ pattern: ProfileIdPattern }),
  workspace_id: Nullable(Type.String({ pattern: WorkspaceIdPattern })),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  client_id: Nullable(Type.String({ pattern: ClientIdPattern })),
  client_name: Nullable(Type.String({ maxLength: 120 })),
  client_colour: Nullable(Colour),
  tags: Type.Array(TagRef, { maxItems: 20 }),
  notes: Type.String({ maxLength: 2000 }),
  favourite: Type.Boolean(),
  archived_at: Nullable(Type.String()),
  trashed_at: Nullable(Type.String({ description: 'Set while the profile is in the trash.' })),
  purge_after: Nullable(Type.String({ description: 'When a trashed profile is deleted permanently.' })),
  template_id: Nullable(Type.String({ pattern: TemplateIdPattern })),
  proxy_id: Nullable(Type.String({ pattern: ProxyIdPattern })),
  proxy_label: Nullable(Type.String({ description: 'Name of the assigned proxy.' })),
  fail_closed: Type.Boolean({ description: 'With a proxy: block traffic that cannot go through it.' }),
  network: NetworkView,
  privacy: PrivacyConfig,
  sync_status: Type.Literal('local_only', {
    description: 'Organization backup state (milestone 07) is per profile: get_sync_status.',
  }),
  version: Type.Integer({ minimum: 1 }),
  created_at: Type.String(),
  updated_at: Type.String(),
  status: Type.Enum(['closed', 'starting', 'running', 'stopping', 'crashed', 'recovering']),
  state: RunState,
  pid: Nullable(Type.Integer()),
  adopted: Type.Boolean({ description: 'Running since before this manager instance started.' }),
  ready: Type.Boolean({ description: 'The browser has started its helper processes.' }),
  window_open: Type.Boolean({ description: 'At least one page (renderer) is open.' }),
  force_available: Type.Boolean({
    description: 'Graceful close timed out; an explicit force close is offered.',
  }),
  start_urls: Type.Array(StartUrl, { maxItems: 10 }),
  download_dir: Nullable(Type.String()),
  permissions: Type.Object({
    camera: PermissionDefault,
    microphone: PermissionDefault,
    location: PermissionDefault,
  }),
  runtime_version: Nullable(Type.String()),
  last_error: Nullable(Type.String({ maxLength: 64 })),
  crash_count: Type.Integer({ minimum: 0 }),
  last_started_at: Nullable(Type.String()),
  last_clean_shutdown_at: Nullable(Type.String()),
  last_backup_at: Nullable(Type.String()),
});
export type ProfileView = Static<typeof ProfileView>;

export const SettingValue = Type.Object({
  key: Type.Enum([
    'appearance.theme',
    'manager.close_behavior',
    'privacy.crash_reports',
    'downloads.directory',
    'workspace.active',
    'profiles.trash_retention_days',
    'proxies.allow_private_addresses',
  ]),
  value: Type.Unknown(),
  version: Type.Integer({ minimum: 0 }),
  ui_settable: Type.Boolean(),
});
export type SettingValue = Static<typeof SettingValue>;

export const KeychainStatus = Type.Object({
  available: Type.Boolean(),
  reason: Type.Union([Type.String(), Type.Null()]),
});

export const StoreFailure = Type.Object({
  code: Type.Enum(['MIGRATION_FAILED', 'DATABASE_TOO_NEW', 'DATABASE_UNREADABLE', 'REMOVED']),
  from_version: Type.Union([Type.Integer(), Type.Null()]),
  to_version: Type.Union([Type.Integer(), Type.Null()]),
  backup_available: Type.Boolean(),
});

export const AppView = Type.Object({
  app: Type.Object({ version: Type.String(), platform: Type.String(), arch: Type.String() }),
  store: Type.Object({ status: Type.Enum(['ready', 'failed']), failure: Type.Optional(StoreFailure) }),
  first_run: Type.Boolean(),
  workspaces: Type.Array(Workspace, { maxItems: 100 }),
  active_workspace_id: Type.Union([Type.String(), Type.Null()]),
  settings: Type.Array(SettingValue),
  recovery: Type.Object({
    previous_session_crashed: Type.Boolean(),
    crash_reports: Type.Integer(),
    adopted_profiles: Type.Integer(),
    cleared_stale_processes: Type.Integer(),
    interrupted_profiles: Type.Integer(),
    interrupted_installs: Type.Integer(),
  }),
  keychain: KeychainStatus,
  running_count: Type.Integer(),
});
export type AppView = Static<typeof AppView>;

export const Operation = Type.Object({
  operation_id: Type.String({ pattern: '^op_[0-9]+$' }),
  kind: Type.Enum([
    'launch_profile',
    'stop_profile',
    'close_all',
    'verify_runtime',
    'install_runtime',
    'recover_profile',
    'backup_profile',
    'import_profiles',
  ]),
  status: Type.Enum(['running', 'succeeded', 'failed']),
  progress: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  target: Type.Union([Type.String(), Type.Null()]),
  error_code: Type.Union([Type.String(), Type.Null()]),
  message: Type.Union([Type.String(), Type.Null()]),
});
export type Operation = Static<typeof Operation>;

export const Started = Type.Object({ operation_id: Type.String() });
export type Started = Static<typeof Started>;

export const ManifestStatus = Type.Union([
  Type.Object({ status: Type.Literal('verified'), version: Type.String() }),
  Type.Object({ status: Type.Literal('missing') }),
  Type.Object({ status: Type.Literal('invalid'), reason: Type.String() }),
]);

export const RunningProfile = Type.Object({
  profile_id: Type.String(),
  run_id: Nullable(Type.String()),
  pid: Nullable(Type.Integer()),
  state: RunState,
  adopted: Type.Boolean(),
  ready: Type.Boolean(),
  window_open: Type.Boolean(),
  helpers: Type.Integer(),
  force_available: Type.Boolean(),
});

export const RuntimeStatus = Type.Object({
  browser: Type.Object({
    configured: Type.Boolean(),
    source: Type.Enum(['manifest', 'development_override', 'none']),
    version: Nullable(Type.String()),
    error: Nullable(Type.String()),
    manifest_status: ManifestStatus,
    manifest: Nullable(
      Type.Object({
        version: Type.String(),
        channel: Type.String(),
        distribution: Type.String(),
        customer_distribution: Type.Boolean(),
        platform_supported: Type.Boolean(),
        size_bytes: Nullable(Type.Integer()),
      }),
    ),
    installing: Type.Boolean(),
  }),
  installations: Type.Array(
    Type.Object({
      version: Type.String(),
      platform: Type.String(),
      digest: Type.String(),
      verified_at: Nullable(Type.String()),
      path: Type.String(),
      status: Type.Enum(['staged', 'verified', 'quarantined', 'failed', 'removed', 'dev']),
      distribution: Nullable(Type.String()),
      executable: Nullable(Type.String()),
    }),
  ),
  interrupted: Type.Array(
    Type.Object({
      id: Type.String(),
      stage: Type.Enum(['copying', 'downloading', 'verifying', 'extracting', 'finalizing']),
    }),
  ),
  quarantined: Type.Integer(),
  running: Type.Array(RunningProfile),
  operations: Type.Array(Operation),
  manager_updates: Type.Object({ channel: Type.String(), automatic: Type.Boolean(), note: Type.String() }),
});
export type RuntimeStatus = Static<typeof RuntimeStatus>;

export const ChosenPath = Type.Object({ path: Type.Union([Type.String(), Type.Null()]) });

export const ProcessRun = Type.Object({
  run_id: Type.String({ pattern: '^run_[0-9a-f]{24}$' }),
  profile_id: Type.String({ pattern: ProfileIdPattern }),
  pid: Type.Integer(),
  identity: Type.Object({ start_time: Nullable(Type.Integer()), exe: Nullable(Type.String()) }),
  runtime_version: Nullable(Type.String()),
  exit_code: Nullable(Type.Integer()),
  outcome: Type.Enum(['running', 'clean', 'crashed', 'early_exit', 'forced', 'interrupted', 'lost']),
  started_at: Type.String(),
  ended_at: Nullable(Type.String()),
});

export const ProfileStatus = Type.Object({
  profile: ProfileView,
  runs: Type.Array(ProcessRun, { maxItems: 5 }),
  backup: Nullable(
    Type.Object({
      created_at_unix: Type.Integer(),
      runtime_version: Nullable(Type.String()),
      bytes: Type.Integer(),
      files: Type.Integer(),
    }),
  ),
  evidence_count: Type.Integer(),
  suggested_recovery: Nullable(Type.Enum(['reopen', 'restore_backup', 'start_fresh'])),
});
export type ProfileStatus = Static<typeof ProfileStatus>;

// ------------------------------------------------------------------------------------------------ milestone 04
export const ProfileFilter = Type.Object(
  {
    text: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
    view: Type.Optional(Type.Enum(['active', 'archived', 'trash'])),
    client: Type.Optional(
      Type.Union([
        Type.Object({ kind: Type.Literal('any') }),
        Type.Object({ kind: Type.Literal('none') }),
        Type.Object({
          kind: Type.Literal('ids'),
          ids: Type.Array(Type.String({ pattern: ClientIdPattern }), { minItems: 1, maxItems: 50 }),
        }),
      ]),
    ),
    tags: Type.Optional(
      Type.Array(Type.String({ pattern: TagIdPattern }), {
        maxItems: 20,
        description: 'The profile must carry every tag.',
      }),
    ),
    states: Type.Optional(Type.Array(RunState)),
    favourites_only: Type.Optional(Type.Boolean()),
    template: Type.Optional(Nullable(Type.String({ pattern: TemplateIdPattern }))),
    proxy: Type.Optional(Nullable(Type.String({ pattern: ProxyIdPattern }))),
  },
  { additionalProperties: false },
);
export type ProfileFilter = Static<typeof ProfileFilter>;

export const Sort = Type.Object({
  key: Type.Enum(['name', 'client', 'last_used', 'created', 'state']),
  descending: Type.Boolean(),
});
export type Sort = Static<typeof Sort>;

export const ProfilePage = Type.Object({
  rows: Type.Array(ProfileView, { maxItems: 500 }),
  total: Type.Integer({ minimum: 0 }),
  next_cursor: Nullable(Type.String({ maxLength: 64 })),
});
export type ProfilePage = Static<typeof ProfilePage>;

export const Client = Type.Object({
  id: Type.String({ pattern: ClientIdPattern }),
  workspace_id: Type.String({ pattern: WorkspaceIdPattern }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  colour: Nullable(Colour),
  archived_at: Nullable(Type.String()),
  version: Type.Integer({ minimum: 1 }),
  created_at: Type.String(),
});
export type Client = Static<typeof Client>;
export const ClientView = Type.Intersect([Client, Type.Object({ profiles: Type.Integer({ minimum: 0 }) })]);
export type ClientView = Static<typeof ClientView>;

export const Tag = Type.Object({
  id: Type.String({ pattern: TagIdPattern }),
  name: Type.String({ minLength: 1, maxLength: 40 }),
  profiles: Type.Integer({ minimum: 0 }),
});
export type Tag = Static<typeof Tag>;

export const TemplateConfig = Type.Object({
  start_urls: Type.Array(StartUrl, { maxItems: 10 }),
  camera: PermissionDefault,
  microphone: PermissionDefault,
  location: PermissionDefault,
  tags: Type.Array(Type.String({ maxLength: 40 }), { maxItems: 20 }),
  notes: Type.String({ maxLength: 2000 }),
});
export const Template = Type.Object({
  id: Type.String({ pattern: TemplateIdPattern }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  schema_version: Type.Integer({ minimum: 1 }),
  config: TemplateConfig,
  version: Type.Integer({ minimum: 1 }),
  updated_at: Type.String(),
});
export type Template = Static<typeof Template>;

export const SavedFilter = Type.Object({
  id: Type.String({ pattern: FilterIdPattern }),
  name: Type.String({ minLength: 1, maxLength: 60 }),
  filter: Type.Object({ filter: ProfileFilter, sort: Sort }),
  created_at: Type.String(),
});
export type SavedFilter = Static<typeof SavedFilter>;

export const Library = Type.Object({
  counts: Type.Object({
    active: Type.Integer(),
    favourites: Type.Integer(),
    running: Type.Integer(),
    archived: Type.Integer(),
    trash: Type.Integer(),
    without_client: Type.Integer(),
    per_client: Type.Array(Type.Tuple([Type.String({ pattern: ClientIdPattern }), Type.Integer()])),
  }),
  clients: Type.Array(ClientView, { maxItems: 5000 }),
  tags: Type.Array(Tag, { maxItems: 5000 }),
  templates: Type.Array(Template, { maxItems: 1000 }),
  saved_filters: Type.Array(SavedFilter, { maxItems: 200 }),
  trash_retention_days: Type.Integer({ minimum: 1 }),
});
export type Library = Static<typeof Library>;

const ProfileIds = Type.Array(Type.String({ pattern: ProfileIdPattern }), { maxItems: 10000 });
/** Explicit ids, or every profile matching a filter ("select all matching", checked against the count shown). */
export const Selection = Type.Union([
  Type.Object({ kind: Type.Literal('ids'), ids: ProfileIds }),
  Type.Object({
    kind: Type.Literal('filter'),
    filter: ProfileFilter,
    expected_total: Type.Integer({ minimum: 0 }),
  }),
]);
export type Selection = Static<typeof Selection>;

export const BulkAction = Type.Union([
  Type.Object({
    action: Type.Literal('add_tag'),
    tag_id: Type.Optional(Type.String({ pattern: TagIdPattern })),
    tag_name: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  }),
  Type.Object({ action: Type.Literal('remove_tag'), tag_id: Type.String({ pattern: TagIdPattern }) }),
  Type.Object({
    action: Type.Literal('move'),
    client_id: Nullable(Type.String({ pattern: ClientIdPattern })),
  }),
  Type.Object({ action: Type.Literal('archive') }),
  Type.Object({ action: Type.Literal('unarchive') }),
  Type.Object({ action: Type.Literal('favourite'), value: Type.Boolean() }),
  Type.Object({ action: Type.Literal('trash') }),
  Type.Object({ action: Type.Literal('restore') }),
  Type.Object({
    action: Type.Literal('set_proxy'),
    proxy_id: Nullable(Type.String({ pattern: ProxyIdPattern })),
    fail_closed: Type.Boolean(),
  }),
]);
export type BulkAction = Static<typeof BulkAction>;

export const BulkResult = Type.Object({
  action: Type.String(),
  requested: Type.Integer(),
  changed: Type.Integer(),
  unchanged: Type.Integer(),
  failed: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Nullable(Type.String()),
      code: Type.String(),
      message: Type.String(),
    }),
  ),
  undo_token: Nullable(Type.String({ pattern: '^[0-9a-f]{32}$' })),
});
export type BulkResult = Static<typeof BulkResult>;

export const FieldError = Type.Object({ field: Type.String(), code: Type.String(), message: Type.String() });
export const ImportPreview = Type.Object({
  preview_id: Nullable(Type.String({ pattern: ImportJobIdPattern })),
  file_name: Type.String(),
  format: Nullable(Type.Enum(['csv', 'json', 'bundle'])),
  schema_version: Nullable(Type.Integer()),
  file_error: Nullable(Type.Object({ code: Type.String(), message: Type.String() })),
  total: Type.Integer(),
  valid: Type.Integer(),
  invalid: Type.Integer(),
  will_create: Type.Integer(),
  will_update: Type.Integer(),
  will_skip: Type.Integer(),
  already_imported: Type.Integer(),
  with_warnings: Type.Integer(),
  new_clients: Type.Array(Type.String(), { maxItems: 50 }),
  new_tags: Type.Array(Type.String(), { maxItems: 50 }),
  rows: Type.Array(
    Type.Object({
      row: Type.Integer(),
      status: Type.Enum(['create', 'update', 'skip_duplicate', 'already_imported', 'error']),
      name: Type.String(),
      client: Nullable(Type.String()),
      tags: Type.Array(Type.String()),
      warnings: Type.Array(Type.String()),
      errors: Type.Array(FieldError),
    }),
    { maxItems: 500 },
  ),
  rows_truncated: Type.Boolean(),
  errors: Type.Array(Type.Intersect([Type.Object({ row: Type.Integer() }), FieldError]), { maxItems: 1000 }),
});
export type ImportPreview = Static<typeof ImportPreview>;

export const ImportJob = Type.Object({
  id: Type.String({ pattern: ImportJobIdPattern }),
  status: Type.Enum([
    'previewed',
    'running',
    'completed',
    'completed_with_errors',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  source_name: Type.String(),
  source_digest: Type.String(),
  format: Type.Enum(['csv', 'json', 'bundle']),
  settings: Type.Unknown(),
  total: Type.Integer(),
  succeeded: Type.Integer(),
  failed: Type.Integer(),
  skipped: Type.Integer(),
  errors: Type.Array(Type.Intersect([Type.Object({ row: Type.Integer() }), FieldError])),
  created_at: Type.String(),
  started_at: Nullable(Type.String()),
  finished_at: Nullable(Type.String()),
});
export type ImportJob = Static<typeof ImportJob>;

export const ImportSettings = Type.Object(
  {
    duplicates: Type.Optional(Type.Enum(['skip', 'create', 'update'])),
    default_client: Type.Optional(Nullable(Type.String({ maxLength: 120 }))),
  },
  { additionalProperties: false },
);
export type ImportSettings = Static<typeof ImportSettings>;

const Label = Type.String({ minLength: 1, maxLength: 120 });

export const ProxyType = Type.Enum(['http', 'https', 'socks5']);
/** A proxy login. It is sent to Rust once and stored only in the OS keychain; it is never returned. */
export const ProxyLogin = Type.Object(
  {
    username: Type.String({ minLength: 1, maxLength: 255 }),
    password: Type.String({ maxLength: 255 }),
  },
  { additionalProperties: false },
);
const ProxyDate = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' });
export const ProxyInput = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    type: ProxyType,
    host: Type.String({ minLength: 1, maxLength: 253 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    login: Type.Optional(ProxyLogin),
    expires_at: Type.Optional(ProxyDate),
    notes: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type ProxyInput = Static<typeof ProxyInput>;
export const ProxyEdit = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    type: Type.Optional(ProxyType),
    host: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    login: Type.Optional(ProxyLogin),
    remove_login: Type.Optional(Type.Boolean()),
    expires_at: Type.Optional(ProxyDate),
    clear_expiry: Type.Optional(Type.Boolean()),
    notes: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type ProxyEdit = Static<typeof ProxyEdit>;
export const NetworkCheck = Type.Object({
  id: Type.String({ pattern: NetworkCheckIdPattern }),
  proxy_id: Type.String({ pattern: ProxyIdPattern }),
  result: Type.Enum(['ok', 'error']),
  error_code: Nullable(Type.String({ maxLength: 64 })),
  latency_ms: Nullable(Type.Integer({ minimum: 0 })),
  egress_ip: Nullable(Type.String({ maxLength: 45, description: 'The address the check service saw.' })),
  checked_at: Type.String(),
});
export type NetworkCheck = Static<typeof NetworkCheck>;
export const ProxyView = Type.Object({
  id: Type.String({ pattern: ProxyIdPattern }),
  workspace_id: Type.String({ pattern: WorkspaceIdPattern }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  type: ProxyType,
  host: Type.String(),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  has_login: Type.Boolean({ description: 'A login is saved in the keychain (never returned).' }),
  expires_at: Nullable(ProxyDate),
  expiry: Nullable(Type.Enum(['expired', 'expires_soon'])),
  days_left: Nullable(Type.Integer()),
  notes: Type.String({ maxLength: 500 }),
  version: Type.Integer({ minimum: 1 }),
  created_at: Type.String(),
  updated_at: Type.String(),
  profiles: Type.Integer({ minimum: 0 }),
  last_check: Nullable(NetworkCheck),
});
export type ProxyView = Static<typeof ProxyView>;
const Support = Type.Enum(['applied', 'partial', 'unavailable']);
export const FieldReport = Type.Object({ field: Type.String(), support: Support, message: Type.String() });
export type FieldReport = Static<typeof FieldReport>;
export const PrivacyValidation = Type.Object({
  valid: Type.Boolean(),
  error: Nullable(IpcError),
  platform: Type.Enum(['windows', 'macos', 'linux']),
  report: Type.Array(FieldReport),
});
export type PrivacyValidation = Static<typeof PrivacyValidation>;
export const Preset = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  config: PrivacyConfig,
});
export type Preset = Static<typeof Preset>;
export const PrivacyOptions = Type.Object({
  platform: Type.Enum(['windows', 'macos', 'linux']),
  languages: Type.Array(Type.Object({ tag: Type.String(), name: Type.String() })),
  time_zones: Type.Array(Type.String()),
  window_min: Type.Tuple([Type.Integer(), Type.Integer()]),
  window_max: Type.Tuple([Type.Integer(), Type.Integer()]),
  presets: Type.Array(Preset),
});
export type PrivacyOptions = Static<typeof PrivacyOptions>;

// ---------------------------------------------------------------- account and organizations (milestone 06)
/** The signed-in account as the manager shows it. Tokens never cross into the window. */
export const AccountView = Type.Object({
  server_url: Nullable(Type.String()),
  status: Type.Enum(['signed_out', 'signed_in', 'expired']),
  signing_in: Type.Boolean(),
  user: Nullable(
    Type.Object({
      id: Type.String(),
      display_name: Type.String(),
      email: Nullable(Type.String()),
      email_verified: Type.Boolean(),
    }),
  ),
  device_id: Nullable(Type.String()),
  /** False when no keychain works: the session ends when the manager closes. */
  session_saved: Type.Boolean(),
});
export type AccountView = Static<typeof AccountView>;
/**
 * An organization API answer relayed by the shell. `body` follows the API contract (packages/contracts resources,
 * docs/openapi.json); error statuses carry the API error envelope. `stale`: served from the offline cache.
 */
export const CloudResponse = Type.Object({
  status: Type.Integer(),
  body: Type.Unknown(),
  stale: Type.Boolean(),
  fetched_at: Nullable(Type.String()),
});
export type CloudResponse = Static<typeof CloudResponse>;
export const OrgImportView = Type.Object({
  status: Type.Integer(),
  body: Type.Unknown(),
  clients: Type.Array(Type.Object({ ref: Type.String(), name: Type.String() })),
  profiles: Type.Integer({ minimum: 0 }),
  linked: Type.Integer({ minimum: 0 }),
});
export type OrgImportView = Static<typeof OrgImportView>;
export const OrgLink = Type.Object({
  local_profile_id: Type.String({ pattern: ProfileIdPattern }),
  org_id: Type.String(),
  org_profile_id: Type.String(),
  linked_at: Type.String(),
});
export type OrgLink = Static<typeof OrgLink>;
const OrgIdPattern = '^org_[0-9A-HJKMNP-TV-Z]{26}$';
const ClientRef = Type.String({ pattern: ClientIdPattern });

// ---------------------------------------------------------------- encrypted backups and sync (milestone 07)
/** What a restored backup keeps on this computer (ADR-0002): sign-ins only on the computer that made it. */
export const Portability = Type.Enum(['supported', 'sign_in_required', 'unsupported']);
export type Portability = Static<typeof Portability>;
export const UPLOAD_STATES = [
  'local_dirty',
  'preparing',
  'uploading',
  'verifying',
  'committed',
  'conflict',
  'failed',
  'canceled',
] as const;
export const RESTORE_STATES = [
  'planning',
  'downloading',
  'opening',
  'ready',
  'done',
  'failed',
  'canceled',
] as const;
export const SyncJobView = Type.Object({
  id: Type.String(),
  kind: Type.Enum(['upload', 'restore']),
  state: Type.Enum([...UPLOAD_STATES, ...RESTORE_STATES]),
  error_code: Nullable(Type.String()),
  updated_at: Type.String(),
  /** Upload: the version it became. Restore: the version restored. */
  version: Nullable(Type.Integer()),
  head_version: Nullable(Type.Integer()),
  portability: Nullable(Portability),
});
export type SyncJobView = Static<typeof SyncJobView>;
export const SyncProgress = Type.Object({
  phase: Nullable(Type.Enum(['sealing', 'uploading', 'downloading', 'opening'])),
  done: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
  /** Why an unfinished job is waiting (CLOUD_OFFLINE, STORAGE_OFFLINE, CLOUD_SIGNED_OUT, PROFILE_NOT_CLOSED, …). */
  waiting_for: Nullable(Type.String()),
});
export type SyncProgress = Static<typeof SyncProgress>;
export const SyncStatus = Type.Object({
  profile_id: Type.String({ pattern: ProfileIdPattern }),
  linked: Type.Boolean(),
  org_id: Nullable(Type.String()),
  org_profile_id: Nullable(Type.String()),
  /** The organization version this computer's copy is based on (0: never backed up). */
  synced_version: Type.Integer({ minimum: 0 }),
  synced_at: Nullable(Type.String()),
  /** Changed since its last backup. */
  dirty: Type.Boolean(),
  auto_backup: Type.Boolean(),
  /** A newer version made on another computer; nothing was overwritten. */
  conflict_head: Nullable(Type.Integer()),
  job: Nullable(SyncJobView),
  progress: SyncProgress,
  /** A restore is pending: the profile cannot be opened until it finishes. */
  restoring: Type.Boolean(),
  local_backup: Nullable(
    Type.Object({
      created_at_unix: Type.Integer(),
      sealed: Type.Boolean(),
      /** False when it was sealed with a key this computer's keychain no longer has. */
      openable: Type.Boolean(),
      bytes: Type.Integer(),
      files: Type.Integer(),
    }),
  ),
  /** New local backups are encrypted with this computer's keychain key. */
  local_backups_sealed: Type.Boolean(),
});
export type SyncStatus = Static<typeof SyncStatus>;
export const CONFLICT_CHOICES = ['upload_mine', 'use_newer', 'open_newer_as_copy'] as const;
export type ConflictChoice = (typeof CONFLICT_CHOICES)[number];
const ProfileArg = Type.Object({ profileId: Type.String({ pattern: ProfileIdPattern }) });

// ------------------------------------------------------------------------------------------------ milestone 08
/**
 * Phases of a shared session on this computer: opening (lease taken; restoring the newest backup, starting the
 * browser), running (heartbeats every 15 s), closing, handing_off (the closing backup uploads under the session's
 * lease; released after the commit), pending (waiting for a decision: upload failed or canceled, or the browser did
 * not close normally), lost (the connection dropped and the browser was closed before the lease could run out),
 * taken_over (an admin took it; this copy was kept aside and offered as a recovery copy), revoked (access removed;
 * this copy was kept aside on this computer).
 */
export const TEAM_PHASES = [
  'opening',
  'running',
  'closing',
  'handing_off',
  'pending',
  'lost',
  'taken_over',
  'revoked',
] as const;
export type TeamPhase = (typeof TEAM_PHASES)[number];
export const TeamRequest = Type.Object({
  id: Type.String({ pattern: '^hrq_[0-9A-HJKMNP-TV-Z]{26}$' }),
  profile_id: Type.String(),
  requested_by: Type.String(),
  requested_by_name: Type.String(),
  holder_user_id: Nullable(Type.String()),
  note: Type.String({ maxLength: 500 }),
  status: Type.Enum(['open', 'declined', 'canceled', 'fulfilled', 'expired']),
  created_at: Type.String(),
  responded_at: Nullable(Type.String()),
  expires_at: Type.String(),
  mine: Type.Boolean(),
});
export type TeamRequest = Static<typeof TeamRequest>;
export const TeamNote = Type.Object({
  text: Type.String({ maxLength: 500 }),
  by_user_id: Type.String(),
  by_name: Type.String(),
  at: Type.String(),
});
export type TeamNote = Static<typeof TeamNote>;
export const TeamStatus = Type.Object({
  profile_id: Type.String({ pattern: ProfileIdPattern }),
  /** Linked to an organization profile (opens through a session lease). */
  shared: Type.Boolean(),
  /** null: no session on this computer. */
  phase: Nullable(Type.Enum(TEAM_PHASES)),
  /** CONNECTION_LOST, PROFILE_CLOSED_UNCLEANLY, UPLOAD_CANCELED, HANDOFF_STALLED, RELEASE_PENDING, TAKEN_OVER,
   *  ACCESS_REMOVED, RECOVERY_COPY_KEPT, VERSION_CONFLICT, … */
  error_code: Nullable(Type.String()),
  /** Open requests from teammates (the holder's view); they never close the session by themselves. */
  requests: Type.Array(TeamRequest, { maxItems: 50 }),
  /** The note the previous person left (shown when the profile opened here). */
  received_note: Nullable(TeamNote),
  /** The note this person will leave. */
  handoff_note: Nullable(Type.String({ maxLength: 500 })),
  /** A copy kept aside on this computer (taken over, access removed, or unsynced changes before a restore). */
  kept_aside: Nullable(Type.String()),
  /** Why the last open was refused (who has it). */
  refusal: Nullable(
    Type.Object({
      code: Type.Enum(['PROFILE_IN_USE_ELSEWHERE', 'PROFILE_SESSION_UNCERTAIN']),
      holder_name: Type.String(),
      device_name: Type.String(),
      since: Nullable(Type.String()),
    }),
  ),
  /** What this person may do with it (launch, edit, backup_download); null until known. */
  capabilities: Nullable(Type.Array(Type.Enum(['launch', 'edit', 'backup_download']))),
  heartbeat_age_seconds: Nullable(Type.Integer({ minimum: 0 })),
});
export type TeamStatus = Static<typeof TeamStatus>;

/** Command name -> argument object and result. Argument keys are camelCase (Tauri converts to snake_case in Rust). */
export const COMMANDS = {
  get_app_state: { args: Type.Object({}), result: AppView },
  create_workspace: {
    args: Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }) }),
    result: Workspace,
  },
  set_active_workspace: {
    args: Type.Object({ workspaceId: Type.String({ pattern: WorkspaceIdPattern }) }),
    result: Type.Null(),
  },
  list_profiles: {
    args: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 200 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
    }),
    result: Type.Array(ProfileView, { maxItems: 10000 }),
  },
  create_profile: {
    args: Type.Object({
      name: Label,
      client: Type.Optional(Label),
      templateId: Type.Optional(Type.String({ pattern: TemplateIdPattern })),
    }),
    result: ProfileView,
  },
  update_profile: {
    args: Type.Object({
      profileId: Type.String({ pattern: ProfileIdPattern }),
      expectedVersion: Type.Integer({ minimum: 1 }),
      name: Type.Optional(Label),
      clientId: Type.Optional(Type.String({ pattern: ClientIdPattern })),
      clearClient: Type.Optional(Type.Boolean()),
      notes: Type.Optional(Type.String({ maxLength: 2000 })),
      favourite: Type.Optional(Type.Boolean()),
      tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 20 })),
      startUrls: Type.Optional(Type.Array(StartUrl, { maxItems: 10 })),
      clearDownloadDir: Type.Optional(Type.Boolean()),
      camera: Type.Optional(PermissionDefault),
      microphone: Type.Optional(PermissionDefault),
      location: Type.Optional(PermissionDefault),
      privacy: Type.Optional(PrivacyConfig),
    }),
    result: ProfileView,
  },
  launch_profile: {
    args: Type.Object({
      profileId: Type.String({ pattern: ProfileIdPattern }),
      startUrl: Type.Optional(Type.String({ maxLength: 2048, pattern: '^https?://' })),
    }),
    result: Started,
  },
  stop_profile: {
    args: Type.Object({
      profileId: Type.String({ pattern: ProfileIdPattern }),
      force: Type.Optional(
        Type.Boolean({ description: 'Explicit force close, offered after a graceful timeout.' }),
      ),
    }),
    result: Started,
  },
  close_all_profiles: { args: Type.Object({ force: Type.Optional(Type.Boolean()) }), result: Started },
  get_profile_status: {
    args: Type.Object({ profileId: Type.String({ pattern: ProfileIdPattern }) }),
    result: ProfileStatus,
  },
  recover_profile: {
    args: Type.Object({
      profileId: Type.String({ pattern: ProfileIdPattern }),
      action: Type.Enum(['reopen', 'restore_backup', 'start_fresh', 'backup_now']),
    }),
    result: Started,
  },
  install_runtime: {
    args: Type.Object({ version: Type.String({ maxLength: 32, pattern: '^[0-9]+(\\.[0-9]+){3}$' }) }),
    result: Started,
  },
  select_profile_download_directory: {
    args: Type.Object({ profileId: Type.String({ pattern: ProfileIdPattern }) }),
    result: ChosenPath,
  },
  get_runtime_status: { args: Type.Object({}), result: RuntimeStatus },
  select_download_directory: { args: Type.Object({}), result: ChosenPath },
  update_setting: {
    args: Type.Object({
      key: Type.String(),
      value: Type.Unknown(),
      expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    result: SettingValue,
  },
  get_diagnostics: { args: Type.Object({}), result: Type.Record(Type.String(), Type.Unknown()) },
  export_diagnostics: { args: Type.Object({}), result: ChosenPath },
  report_ui_ready: { args: Type.Object({}), result: Type.Union([Type.Number(), Type.Null()]) },
  recovery_action: {
    args: Type.Object({
      action: Type.Enum(['dismiss_crash', 'retry_open', 'restore_backup', 'discard_interrupted']),
      target: Type.Optional(Type.String({ maxLength: 64, pattern: '^[A-Za-z0-9.-]+$' })),
    }),
    result: Type.Null(),
  },
  resolve_quit: {
    args: Type.Object({ choice: Type.Enum(['cancel', 'leave_running', 'close_all', 'force_close_all']) }),
    result: Type.Null(),
  },
  open_external: {
    args: Type.Object({ url: Type.String({ maxLength: 2048, pattern: '^https://github\\.com/' }) }),
    result: Type.Null(),
  },
  remove_local_data: { args: Type.Object({ confirm: Type.Literal('DELETE') }), result: Type.Null() },

  // milestone 04 (roadmap names: profiles.query / profiles.update / profiles.bulk / imports.preview /
  // imports.commit / exports.configuration)
  query_profiles: {
    args: Type.Object({
      filter: Type.Optional(ProfileFilter),
      sort: Type.Optional(Sort),
      cursor: Type.Optional(Type.String({ maxLength: 64, description: 'Continue after the previous page.' })),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 10000, description: 'Jump to a row (ignored with a cursor).' }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    result: ProfilePage,
  },
  get_library: { args: Type.Object({}), result: Library },
  create_client: { args: Type.Object({ name: Label, colour: Type.Optional(Colour) }), result: Client },
  update_client: {
    args: Type.Object({
      clientId: Type.String({ pattern: ClientIdPattern }),
      expectedVersion: Type.Integer({ minimum: 1 }),
      name: Type.Optional(Label),
      colour: Type.Optional(Colour),
      clearColour: Type.Optional(Type.Boolean()),
      archived: Type.Optional(Type.Boolean()),
    }),
    result: Client,
  },
  create_tag: { args: Type.Object({ name: Type.String({ minLength: 1, maxLength: 40 }) }), result: TagRef },
  rename_tag: {
    args: Type.Object({
      tagId: Type.String({ pattern: TagIdPattern }),
      name: Type.String({ minLength: 1, maxLength: 40 }),
    }),
    result: Type.Null(),
  },
  delete_tag: { args: Type.Object({ tagId: Type.String({ pattern: TagIdPattern }) }), result: Type.Null() },
  save_filter: {
    args: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 60 }),
      filter: ProfileFilter,
      sort: Type.Optional(Sort),
    }),
    result: SavedFilter,
  },
  delete_filter: {
    args: Type.Object({ filterId: Type.String({ pattern: FilterIdPattern }) }),
    result: Type.Null(),
  },
  save_template: {
    args: Type.Object({ profileId: Type.String({ pattern: ProfileIdPattern }), name: Label }),
    result: Template,
  },
  delete_template: {
    args: Type.Object({ templateId: Type.String({ pattern: TemplateIdPattern }) }),
    result: Type.Null(),
  },
  duplicate_profile: {
    args: Type.Object({ profileId: Type.String({ pattern: ProfileIdPattern }), name: Label }),
    result: ProfileView,
  },
  bulk_profiles: { args: Type.Object({ action: BulkAction, selection: Selection }), result: BulkResult },
  undo_action: {
    args: Type.Object({ token: Type.String({ pattern: '^[0-9a-f]{32}$' }) }),
    result: Type.Object({ restored: Type.Integer(), skipped: Type.Integer() }),
  },
  delete_profiles: {
    args: Type.Object({
      selection: Selection,
      confirm: Type.Literal('DELETE'),
      expectedCount: Type.Integer({ minimum: 1, maximum: 10000 }),
    }),
    result: BulkResult,
  },
  choose_import_file: {
    args: Type.Object({}),
    result: Type.Object({
      file_ref: Nullable(Type.String({ pattern: '^[0-9a-f]{32}$' })),
      name: Nullable(Type.String()),
      size: Nullable(Type.Integer()),
    }),
  },
  preview_import: {
    args: Type.Object({
      fileRef: Type.String({ pattern: '^[0-9a-f]{32}$' }),
      settings: Type.Optional(ImportSettings),
    }),
    result: ImportPreview,
  },
  commit_import: {
    args: Type.Object({ previewId: Type.String({ pattern: ImportJobIdPattern }) }),
    result: Started,
  },
  cancel_import: {
    args: Type.Object({ jobId: Type.String({ pattern: ImportJobIdPattern }) }),
    result: Type.Null(),
  },
  list_imports: { args: Type.Object({}), result: Type.Array(ImportJob, { maxItems: 50 }) },
  export_profiles: {
    args: Type.Object({
      selection: Selection,
      format: Type.Enum(['csv', 'json', 'bundle']),
      includeNotes: Type.Optional(Type.Boolean()),
    }),
    result: Type.Object({
      path: Nullable(Type.String()),
      exported: Type.Integer(),
      notes_withheld: Type.Integer(),
    }),
  },

  // milestone 05 (roadmap names: proxies.test / profiles.assign_proxy / privacy.validate)
  list_proxies: { args: Type.Object({}), result: Type.Array(ProxyView, { maxItems: 1000 }) },
  create_proxy: { args: Type.Object({ proxy: ProxyInput }), result: ProxyView },
  update_proxy: {
    args: Type.Object({
      proxyId: Type.String({ pattern: ProxyIdPattern }),
      expectedVersion: Type.Integer({ minimum: 1 }),
      changes: ProxyEdit,
    }),
    result: ProxyView,
  },
  delete_proxy: {
    args: Type.Object({ proxyId: Type.String({ pattern: ProxyIdPattern }) }),
    result: Type.Null(),
  },
  test_proxy: {
    args: Type.Object({ proxyId: Type.String({ pattern: ProxyIdPattern }) }),
    result: NetworkCheck,
  },
  list_proxy_checks: {
    args: Type.Object({ proxyId: Type.String({ pattern: ProxyIdPattern }) }),
    result: Type.Array(NetworkCheck, { maxItems: 50 }),
  },
  assign_proxy: {
    args: Type.Object({
      profileId: Type.String({ pattern: ProfileIdPattern }),
      proxyId: Nullable(Type.String({ pattern: ProxyIdPattern })),
      failClosed: Type.Boolean(),
      expectedVersion: Type.Integer({ minimum: 1 }),
    }),
    result: ProfileView,
  },
  validate_privacy: {
    args: Type.Object({ config: PrivacyConfig, failClosedProxy: Type.Optional(Type.Boolean()) }),
    result: PrivacyValidation,
  },
  get_privacy_options: { args: Type.Object({}), result: PrivacyOptions },
  // Milestone 06: account and organizations.
  get_account: { args: Type.Object({}), result: AccountView },
  set_cloud_server: {
    args: Type.Object({ url: Nullable(Type.String({ maxLength: 300 })) }),
    result: AccountView,
  },
  begin_sign_in: {
    args: Type.Object({ reauth: Type.Optional(Type.Boolean()) }),
    result: Type.Object({ opened: Type.Boolean() }),
  },
  cancel_sign_in: { args: Type.Object({}), result: AccountView },
  sign_out: { args: Type.Object({}), result: AccountView },
  cloud_request: {
    args: Type.Object({
      method: Type.Enum(['GET', 'POST', 'PATCH', 'DELETE']),
      path: Type.String({ maxLength: 200, pattern: '^/v1/' }),
      query: Type.Optional(Type.Array(Type.Tuple([Type.String(), Type.String()]), { maxItems: 10 })),
      body: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      ifMatch: Type.Optional(Type.String({ maxLength: 12 })),
    }),
    result: CloudResponse,
  },
  org_import: {
    args: Type.Object({
      workspaceId: Type.String({ pattern: WorkspaceIdPattern }),
      orgId: Type.String({ pattern: OrgIdPattern }),
      dryRun: Type.Boolean(),
      mapping: Type.Optional(Type.Record(Type.String({ pattern: ClientIdPattern }), ClientRef)),
    }),
    result: OrgImportView,
  },
  list_org_links: {
    args: Type.Object({ orgId: Type.Optional(Type.String({ pattern: OrgIdPattern })) }),
    result: Type.Array(OrgLink, { maxItems: 10000 }),
  },
  // Milestone 07: encrypted backups and restores. Data keys, signed URLs and tokens never reach the window.
  get_sync_status: { args: ProfileArg, result: SyncStatus },
  sync_backup_now: { args: ProfileArg, result: SyncStatus },
  sync_cancel: { args: ProfileArg, result: SyncStatus },
  sync_set_auto_backup: {
    args: Type.Object({ profileId: Type.String({ pattern: ProfileIdPattern }), enabled: Type.Boolean() }),
    result: SyncStatus,
  },
  sync_resolve_conflict: {
    args: Type.Object({
      profileId: Type.String({ pattern: ProfileIdPattern }),
      choice: Type.Enum(CONFLICT_CHOICES),
    }),
    result: SyncStatus,
  },
  sync_restore: {
    args: Type.Object({
      profileId: Type.String({ pattern: ProfileIdPattern }),
      snapshotId: Type.Optional(Type.String({ pattern: '^snp_[0-9A-HJKMNP-TV-Z]{26}$' })),
      asCopy: Type.Boolean(),
    }),
    result: SyncStatus,
  },
  sync_restore_here: {
    args: Type.Object({
      orgId: Type.String({ pattern: OrgIdPattern }),
      orgProfileId: Type.String({ pattern: '^prf_[0-9A-HJKMNP-TV-Z]{26}$' }),
      name: Label,
    }),
    result: ProfileView,
  },
  // Milestone 08: shared sessions. Opening goes through launch_profile (a linked profile takes the session lease
  // first; errors SHARED_OFFLINE, PROFILE_IN_USE_ELSEWHERE, PROFILE_SESSION_UNCERTAIN, NO_ACCESS, RUNTIME_TOO_OLD,
  // ENTITLEMENT_REQUIRED, SESSION_RESTORE_FAILED). The lease id and fencing token never reach the window.
  get_team_status: { args: ProfileArg, result: TeamStatus },
  /** Close and hand off: the browser closes, the closing backup uploads, the lease is released with the note. */
  team_close: {
    args: Type.Object({
      profileId: Type.String({ pattern: ProfileIdPattern }),
      note: Type.Optional(Nullable(Type.String({ maxLength: 500 }))),
    }),
    result: TeamStatus,
  },
  /** Give the handoff up: the newest backup stays as it was, this computer keeps its copy (unsynced). */
  team_abort: { args: ProfileArg, result: TeamStatus },
  team_retry: { args: ProfileArg, result: TeamStatus },
  /** Clears the notice of a session that ended (taken over, access removed). */
  team_dismiss: { args: ProfileArg, result: TeamStatus },
  /** Owners and admins: a recovery copy restored as a new, unlinked local profile. */
  team_restore_recovery_copy: {
    args: Type.Object({
      orgId: Type.String({ pattern: OrgIdPattern }),
      orgProfileId: Type.String({ pattern: '^prf_[0-9A-HJKMNP-TV-Z]{26}$' }),
      snapshotId: Type.String({ pattern: '^snp_[0-9A-HJKMNP-TV-Z]{26}$' }),
      name: Label,
    }),
    result: ProfileView,
  },
} satisfies Record<string, { args: TSchema; result: TSchema }>;

export type CommandName = keyof typeof COMMANDS;
export type CommandArgs<C extends CommandName> = Static<(typeof COMMANDS)[C]['args']>;
export type CommandResult<C extends CommandName> = Static<(typeof COMMANDS)[C]['result']>;

export const EVENTS = {
  operation: Operation,
  'profiles-changed': Type.Object({ running: Type.Integer() }),
  'quit-requested': Type.Object({ running: Type.Integer(), unresponsive: Type.Integer() }),
  'deep-link': Type.Object({ kind: Type.Literal('auth-callback'), outcome: Type.Unknown() }),
  /** A sync job changed state (`state`), or a restore finished switching folders (`restored`). */
  sync: Type.Object({
    profile_id: Type.String({ pattern: ProfileIdPattern }),
    job_id: Type.String(),
    kind: Type.Enum(['upload', 'restore']),
    state: Type.String(),
    version: Type.Optional(Type.Integer()),
    portability: Type.Optional(Portability),
  }),
  /**
   * A shared session moved on (milestone 08): `phase` (with `error_code`; phase null when it ended here),
   * `requests` (new requests from teammates), `reconnected`, `handoff_ready` (the closing backup committed and the
   * lease was released), `kept_aside` and `recovery_kept`.
   */
  team: Type.Object({
    profile_id: Type.String({ pattern: ProfileIdPattern }),
    kind: Type.Enum(['phase', 'requests', 'reconnected', 'handoff_ready', 'kept_aside', 'recovery_kept']),
    phase: Type.Optional(Nullable(Type.String())),
    error_code: Type.Optional(Nullable(Type.String())),
    requests: Type.Optional(Type.Array(TeamRequest, { maxItems: 50 })),
  }),
  account: Type.Object({
    status: Type.Enum(['signed_in', 'signed_out', 'expired', 'failed']),
    reauth: Type.Optional(Type.Boolean()),
    code: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
  }),
  warning: Type.Union([
    Type.Object({ code: Type.Literal('LOW_DISK_SPACE'), free_bytes: Type.Integer() }),
    Type.Object({
      code: Type.Literal('PROXY_FAILING'),
      profile_id: Type.String({ pattern: ProfileIdPattern }),
      error: Type.String(),
      fail_closed: Type.Boolean(),
    }),
    Type.Object({
      code: Type.Literal('PROXY_BYPASSED'),
      profile_id: Type.String({ pattern: ProfileIdPattern }),
      direct_connections: Type.Integer(),
    }),
    Type.Object({
      code: Type.Literal('PROXY_CONNECTION_LOST'),
      profile_id: Type.String({ pattern: ProfileIdPattern }),
      reason: Type.String(),
    }),
    Type.Object({
      code: Type.Union([Type.Literal('PROXY_EXPIRING'), Type.Literal('PROXY_EXPIRED')]),
      proxy_id: Type.String({ pattern: ProxyIdPattern }),
      profile_id: Type.Optional(Type.String({ pattern: ProfileIdPattern })),
      expires_at: Nullable(Type.String()),
      days_left: Type.Optional(Nullable(Type.Integer())),
    }),
  ]),
} satisfies Record<string, TSchema>;

export type EventName = keyof typeof EVENTS;
export type EventPayload<E extends EventName> = Static<(typeof EVENTS)[E]>;
