/**
 * Desktop IPC contract (milestone 02 deliverable "IPC schemas").
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

export const ProfileView = Type.Object({
  id: Type.String({ pattern: ProfileIdPattern }),
  workspace_id: Type.Union([Type.String({ pattern: WorkspaceIdPattern }), Type.Null()]),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  client_label: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
  notes: Type.String({ maxLength: 2000 }),
  version: Type.Integer({ minimum: 1 }),
  created_at: Type.String(),
  updated_at: Type.String(),
  status: Type.Enum(['closed', 'running', 'stopping']),
  pid: Type.Union([Type.Integer(), Type.Null()]),
  adopted: Type.Boolean({ description: 'Running since before this manager instance started.' }),
});
export type ProfileView = Static<typeof ProfileView>;

export const SettingValue = Type.Object({
  key: Type.Enum([
    'appearance.theme',
    'manager.close_behavior',
    'privacy.crash_reports',
    'downloads.directory',
    'workspace.active',
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
    interrupted_installs: Type.Integer(),
  }),
  keychain: KeychainStatus,
  running_count: Type.Integer(),
});
export type AppView = Static<typeof AppView>;

export const Operation = Type.Object({
  operation_id: Type.String({ pattern: '^op_[0-9]+$' }),
  kind: Type.Enum(['launch_profile', 'stop_profile', 'close_all', 'verify_runtime']),
  status: Type.Enum(['running', 'succeeded', 'failed']),
  progress: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  target: Type.Union([Type.String(), Type.Null()]),
  error_code: Type.Union([Type.String(), Type.Null()]),
  message: Type.Union([Type.String(), Type.Null()]),
});
export type Operation = Static<typeof Operation>;

export const Started = Type.Object({ operation_id: Type.String() });
export type Started = Static<typeof Started>;

export const RuntimeStatus = Type.Object({
  browser: Type.Object({
    configured: Type.Boolean(),
    source: Type.Enum(['development_override', 'none']),
    revision: Type.Union([Type.String(), Type.Null()]),
  }),
  installations: Type.Array(
    Type.Object({
      version: Type.String(),
      platform: Type.String(),
      digest: Type.String(),
      verified_at: Type.Union([Type.String(), Type.Null()]),
      path: Type.String(),
      status: Type.Enum(['staged', 'verified', 'quarantined', 'failed', 'removed', 'dev']),
    }),
  ),
  interrupted: Type.Array(
    Type.Object({
      id: Type.String(),
      stage: Type.Enum(['copying', 'verifying', 'extracting', 'finalizing']),
    }),
  ),
  quarantined: Type.Integer(),
  running: Type.Array(
    Type.Object({
      profile_id: Type.String(),
      pid: Type.Integer(),
      adopted: Type.Boolean(),
      stopping: Type.Boolean(),
    }),
  ),
  operations: Type.Array(Operation),
  manager_updates: Type.Object({ channel: Type.String(), automatic: Type.Boolean(), note: Type.String() }),
});
export type RuntimeStatus = Static<typeof RuntimeStatus>;

export const ChosenPath = Type.Object({ path: Type.Union([Type.String(), Type.Null()]) });

const Label = Type.String({ minLength: 1, maxLength: 120 });

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
    result: Type.Array(ProfileView, { maxItems: 100 }),
  },
  create_profile: {
    args: Type.Object({ name: Label, clientLabel: Type.Optional(Label) }),
    result: ProfileView,
  },
  update_profile: {
    args: Type.Object({
      profileId: Type.String({ pattern: ProfileIdPattern }),
      expectedVersion: Type.Integer({ minimum: 1 }),
      name: Type.Optional(Label),
      clientLabel: Type.Optional(Label),
      clearClientLabel: Type.Optional(Type.Boolean()),
      notes: Type.Optional(Type.String({ maxLength: 2000 })),
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
    args: Type.Object({ profileId: Type.String({ pattern: ProfileIdPattern }) }),
    result: Started,
  },
  close_all_profiles: { args: Type.Object({}), result: Started },
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
    args: Type.Object({ choice: Type.Enum(['cancel', 'leave_running', 'close_all']) }),
    result: Type.Null(),
  },
  open_external: {
    args: Type.Object({ url: Type.String({ maxLength: 2048, pattern: '^https://github\\.com/' }) }),
    result: Type.Null(),
  },
  remove_local_data: { args: Type.Object({ confirm: Type.Literal('DELETE') }), result: Type.Null() },
} satisfies Record<string, { args: TSchema; result: TSchema }>;

export type CommandName = keyof typeof COMMANDS;
export type CommandArgs<C extends CommandName> = Static<(typeof COMMANDS)[C]['args']>;
export type CommandResult<C extends CommandName> = Static<(typeof COMMANDS)[C]['result']>;

export const EVENTS = {
  operation: Operation,
  'profiles-changed': Type.Object({ running: Type.Integer() }),
  'quit-requested': Type.Object({ running: Type.Integer() }),
  'deep-link': Type.Object({ kind: Type.Literal('auth-callback'), outcome: Type.Unknown() }),
} satisfies Record<string, TSchema>;

export type EventName = keyof typeof EVENTS;
export type EventPayload<E extends EventName> = Static<(typeof EVENTS)[E]>;
