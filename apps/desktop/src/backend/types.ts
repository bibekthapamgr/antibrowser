/**
 * Repository interfaces the UI depends on (milestone 02: "implement repository interfaces so the eventual cloud
 * adapter does not replace UI logic"). Screens never call Tauri directly.
 *
 * - `TauriBackend`  local manager via IPC (this milestone)
 * - `DemoBackend`   in-memory; used when the UI runs in a plain browser (development, UI tests)
 * - a cloud adapter (milestones 06-08) implements the same interfaces
 */
import type {
  AccountView,
  AppView,
  AutomationStatus,
  BulkAction,
  BulkResult,
  Client,
  ClientOverview,
  CloudResponse,
  DiagnosticsPreview,
  EventName,
  EventPayload,
  ExtensionsView,
  HealthView,
  ImportJob,
  ImportPreview,
  ImportSettings,
  IpcError,
  LaunchCheck,
  Library,
  NetworkCheck,
  OrgImportView,
  OrgLink,
  PrivacyConfig,
  PrivacyOptions,
  PrivacyValidation,
  ProfileFilter,
  ProfilePage,
  ProfileStatus,
  ProfileView,
  ProxyEdit,
  ProxyInput,
  ProxyView,
  ResourcesView,
  RuntimeStatus,
  SavedFilter,
  Selection,
  SelectionSummary,
  SettingValue,
  Sort,
  Started,
  SyncStatus,
  TagRef,
  TeamStatus,
  Template,
  UpdateStatus,
  Workspace,
} from '@pb/contracts/ipc';

export type {
  AccountView,
  AppView,
  AutomationRun,
  AutomationStatus,
  BulkAction,
  BulkResult,
  Client,
  ClientOverview,
  ClientView,
  CloudResponse,
  ConflictChoice,
  DiagnosticsPreview,
  ExtensionsView,
  ExtensionVerdict,
  FieldReport,
  HealthCard,
  HealthView,
  ImportJob,
  ImportPreview,
  ImportSettings,
  IpcError,
  LaunchCheck,
  Library,
  NetworkCheck,
  NetworkView,
  Operation,
  OrgImportView,
  OrgLink,
  Portability,
  Preset,
  PrivacyConfig,
  PrivacyOptions,
  PrivacyValidation,
  ProfileFilter,
  ProfilePage,
  ProfileStatus,
  ProfileView,
  ProxyEdit,
  ProxyInput,
  ProxyView,
  ResourcesView,
  RunState,
  RuntimeStatus,
  SavedFilter,
  Selection,
  SelectionSummary,
  SettingValue,
  Sort,
  SyncJobView,
  SyncStatus,
  Tag,
  TagRef,
  TeamNote,
  TeamPhase,
  TeamRequest,
  TeamStatus,
  Template,
  UpdateStatus,
  Workspace,
} from '@pb/contracts/ipc';

export type Permission = 'ask' | 'block' | 'allow';
export type RecoverAction =
  | 'reopen'
  | 'restore_backup'
  | 'restore_before_upgrade'
  | 'start_fresh'
  | 'backup_now';

export interface ProfileUpdate {
  expectedVersion: number;
  name?: string;
  clientId?: string;
  clearClient?: boolean;
  notes?: string;
  favourite?: boolean;
  /** Replaces the tags (names; new tags are created). */
  tags?: string[];
  startUrls?: string[];
  clearDownloadDir?: boolean;
  camera?: Permission;
  microphone?: Permission;
  location?: Permission;
  /** Privacy and environment settings, replaced as a whole (milestone 05). */
  privacy?: PrivacyConfig;
}

export interface WorkspaceRepository {
  appState(): Promise<AppView>;
  createWorkspace(name: string): Promise<Workspace>;
  setActiveWorkspace(id: string): Promise<void>;
}

export interface ProfileQuery {
  filter?: ProfileFilter;
  sort?: Sort;
  cursor?: string;
  /** Jump to a row; the virtualized table loads the page that scrolls into view. */
  offset?: number;
  limit?: number;
}

export type ExportFormat = 'csv' | 'json' | 'bundle';

export interface ProfileRepository {
  /** `profiles.query(cursor, filters)`: one page of the profile table. */
  query(q: ProfileQuery): Promise<ProfilePage>;
  /** Basic creation: a name and optionally a client (by name; created if new) and a template. */
  create(name: string, client?: string, templateId?: string): Promise<ProfileView>;
  update(id: string, changes: ProfileUpdate): Promise<ProfileView>;
  /** Same configuration, empty browser storage (sign-ins are never copied). */
  duplicate(id: string, name: string): Promise<ProfileView>;
  bulk(action: BulkAction, selection: Selection): Promise<BulkResult>;
  undo(token: string): Promise<{ restored: number; skipped: number }>;
  /** Permanent deletion from the trash; `count` is the number the user confirmed. */
  deletePermanently(selection: Selection, count: number): Promise<BulkResult>;
  launch(id: string): Promise<Started>;
  /** Graceful close; `force` is the explicit force close offered after a timeout. */
  stop(id: string, force?: boolean): Promise<Started>;
  closeAll(force?: boolean): Promise<Started>;
  status(id: string): Promise<ProfileStatus>;
  recover(id: string, action: RecoverAction): Promise<Started>;
  selectDownloadDirectory(id: string): Promise<{ path: string | null }>;
}

export interface LibraryRepository {
  library(): Promise<Library>;
  createClient(name: string, colour?: string): Promise<Client>;
  updateClient(
    id: string,
    expectedVersion: number,
    changes: { name?: string; colour?: string; clearColour?: boolean; archived?: boolean },
  ): Promise<Client>;
  createTag(name: string): Promise<TagRef>;
  renameTag(id: string, name: string): Promise<void>;
  deleteTag(id: string): Promise<void>;
  saveFilter(name: string, filter: ProfileFilter, sort: Sort): Promise<SavedFilter>;
  deleteFilter(id: string): Promise<void>;
  saveTemplate(profileId: string, name: string): Promise<Template>;
  deleteTemplate(id: string): Promise<void>;
}

export interface TransferRepository {
  /** Native file picker; the UI only ever holds the opaque reference. */
  chooseFile(): Promise<{ file_ref: string | null; name: string | null; size: number | null }>;
  /** `imports.preview(file_ref)`: dry run, nothing is written. */
  preview(fileRef: string, settings: ImportSettings): Promise<ImportPreview>;
  /** `imports.commit(preview_id)`: refused if the file changed since the preview. */
  commit(previewId: string): Promise<Started>;
  cancel(jobId: string): Promise<void>;
  jobs(): Promise<ImportJob[]>;
  /** `exports.configuration(ids)`: configuration only, saved through the native dialog. */
  export(
    selection: Selection,
    format: ExportFormat,
    includeNotes: boolean,
  ): Promise<{ path: string | null; exported: number; notes_withheld: number }>;
}

export interface SystemRepository {
  runtimeStatus(): Promise<RuntimeStatus>;
  installRuntime(version: string): Promise<Started>;
  updateSetting(key: string, value: unknown, expectedVersion?: number): Promise<SettingValue>;
  selectDownloadDirectory(): Promise<{ path: string | null }>;
  diagnostics(): Promise<Record<string, unknown>>;
  reportUiReady(): Promise<number | null>;
  recovery(
    action: 'dismiss_crash' | 'retry_open' | 'restore_backup' | 'discard_interrupted',
    target?: string,
  ): Promise<void>;
  resolveQuit(choice: 'cancel' | 'leave_running' | 'close_all' | 'force_close_all'): Promise<void>;
  openExternal(url: string): Promise<void>;
  removeLocalData(confirm: string): Promise<void>;
}

/** Proxies, routing and privacy settings (milestone 05). Proxy logins go in once and never come back out. */
export interface NetworkRepository {
  proxies(): Promise<ProxyView[]>;
  createProxy(proxy: ProxyInput): Promise<ProxyView>;
  updateProxy(id: string, expectedVersion: number, changes: ProxyEdit): Promise<ProxyView>;
  deleteProxy(id: string): Promise<void>;
  /** `proxies.test(id)`: a user-started check (latency, exit address, time). */
  testProxy(id: string): Promise<NetworkCheck>;
  checks(id: string): Promise<NetworkCheck[]>;
  /** `profiles.assign_proxy(id, proxy_id, expected_version)`; `null` removes the proxy. */
  assign(
    profileId: string,
    proxyId: string | null,
    failClosed: boolean,
    expectedVersion: number,
  ): Promise<ProfileView>;
  /** `privacy.validate(config)`. */
  validatePrivacy(config: PrivacyConfig, failClosedProxy: boolean): Promise<PrivacyValidation>;
  privacyOptions(): Promise<PrivacyOptions>;
}

export interface CloudRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** An allow-listed API path, e.g. `/v1/orgs/<id>/profiles`. */
  path: string;
  query?: [string, string][];
  body?: Record<string, unknown>;
  /** Version for optimistic concurrency, e.g. `"3"`. */
  ifMatch?: string;
}

/**
 * The signed-in account and organizations (milestone 06). Sign-in happens in the system browser; the shell keeps the
 * tokens and makes allow-listed API requests for the window (`request`), so the window never holds a token.
 */
export interface AccountRepository {
  get(): Promise<AccountView>;
  setServer(url: string | null): Promise<AccountView>;
  /** Opens the sign-in page in the system browser; the result arrives as an `account` event. */
  signIn(reauth?: boolean): Promise<void>;
  cancelSignIn(): Promise<AccountView>;
  signOut(): Promise<AccountView>;
  request(req: CloudRequest): Promise<CloudResponse>;
  /** Copies a local workspace's profiles (metadata) into an organization; `dryRun` previews. */
  orgImport(
    workspaceId: string,
    orgId: string,
    dryRun: boolean,
    mapping?: Record<string, string>,
  ): Promise<OrgImportView>;
  links(orgId?: string): Promise<OrgLink[]>;
}

/**
 * Encrypted backups of organization profiles and restores (milestone 07). Uploads and restores run in the shell's
 * background worker; progress arrives as `sync` events. The window never sees a data key or a signed URL.
 */
export interface SyncRepository {
  status(profileId: string): Promise<SyncStatus>;
  backupNow(profileId: string): Promise<SyncStatus>;
  cancel(profileId: string): Promise<SyncStatus>;
  setAutoBackup(profileId: string, enabled: boolean): Promise<SyncStatus>;
  resolveConflict(
    profileId: string,
    choice: 'upload_mine' | 'use_newer' | 'open_newer_as_copy',
  ): Promise<SyncStatus>;
  /** The newest backup (or `snapshotId`) into this profile, or `asCopy` into a new local profile. */
  restore(profileId: string, snapshotId: string | null, asCopy: boolean): Promise<SyncStatus>;
  /** Puts an organization profile on this computer: a new local profile, restored from its newest backup. */
  restoreHere(orgId: string, orgProfileId: string, name: string): Promise<ProfileView>;
}

/**
 * Shared sessions of organization profiles (milestone 08). Opening goes through `profiles.launch` (a linked profile
 * takes the session lease first); this repository follows the session on this computer and ends it. Requests to a
 * teammate, who has a profile open, and forced takeovers go through `account.request` (allow-listed API paths).
 */
export interface TeamRepository {
  status(profileId: string): Promise<TeamStatus>;
  /** Close and hand off: the browser closes, the closing backup uploads, the lease is released with the note. */
  close(profileId: string, note: string | null): Promise<TeamStatus>;
  /** Give the handoff up: the newest backup stays as it was, this computer keeps its copy (unsynced). */
  abort(profileId: string): Promise<TeamStatus>;
  retry(profileId: string): Promise<TeamStatus>;
  /** Clears the notice of a session that ended (taken over, access removed). */
  dismiss(profileId: string): Promise<TeamStatus>;
  /** Owners and admins: a recovery copy restored as a new, unlinked local profile. */
  restoreRecoveryCopy(
    orgId: string,
    orgProfileId: string,
    snapshotId: string,
    name: string,
  ): Promise<ProfileView>;
}

/**
 * Agency workspace on this computer (milestone 09): health, resources, extensions, client overviews, selection
 * summaries for bulk confirmations, the pre-open check and diagnostics previews.
 */
export interface AgencyRepository {
  health(): Promise<HealthView>;
  /** Runs a check again: the server and sign-in, every proxy, or the extensions (rescan and policies). */
  runCheck(check: 'server' | 'proxies' | 'extensions'): Promise<HealthView>;
  resources(): Promise<ResourcesView>;
  checkLaunch(profileIds: string[]): Promise<LaunchCheck>;
  selectionSummary(selection: Selection): Promise<SelectionSummary>;
  clientOverview(clientId: string): Promise<ClientOverview>;
  /** Native folder picker for the client's downloads; `clear` returns to the usual folder. */
  selectClientDownloadDirectory(clientId: string, clear?: boolean): Promise<{ path: string | null }>;
  extensions(profileId?: string): Promise<ExtensionsView>;
  rescanExtensions(profileId?: string): Promise<ExtensionsView>;
  reviewExtension(profileId: string, extensionId: string): Promise<ExtensionsView>;
  /** The redacted report, exactly as it would be saved (kept for 10 minutes). */
  previewDiagnostics(): Promise<DiagnosticsPreview>;
  /** Saves a previewed report where the person chooses. */
  exportDiagnostics(previewId: string): Promise<{ path: string | null }>;
}

/**
 * Automation on this computer (milestone 10): which organizations it runs jobs for, "Allow Playwright connections",
 * and the jobs it ran. The organization's job dashboard, computers, API tokens and webhooks go through
 * `account.request` (allow-listed API paths); screenshots are downloaded by the shell.
 */
export interface AutomationRepository {
  status(): Promise<AutomationStatus>;
  enroll(orgId: string, accepts: 'mine' | 'org', maxJobs: number): Promise<AutomationStatus>;
  unenroll(orgId: string): Promise<AutomationStatus>;
  stopJob(jobId: string): Promise<AutomationStatus>;
  setDebugging(allow: boolean): Promise<AutomationStatus>;
  /** A `data:` URL of a job's screenshot. */
  screenshot(orgId: string, jobId: string, artifactId: string): Promise<string>;
}

/**
 * Milestone 11: the payment provider's pages. The shell creates them and opens them in the default browser after
 * checking the host; the window only asks.
 */
export interface BillingRepository {
  openCheckout(orgId: string, planId: string): Promise<null>;
  openPortal(orgId: string): Promise<null>;
  openInvoice(orgId: string, invoiceId: string, pdf: boolean): Promise<null>;
}

/**
 * Milestone 12: the manager's own signed updates. The channel and automatic checks are the settings
 * `updates.channel` and `updates.automatic`; installing restarts the app and needs closed profiles.
 */
export interface UpdatesRepository {
  get(): Promise<UpdateStatus>;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  cancel(): Promise<UpdateStatus>;
  install(): Promise<null>;
}

export interface Backend {
  kind: 'tauri' | 'demo';
  agency: AgencyRepository;
  automation: AutomationRepository;
  billing: BillingRepository;
  updates: UpdatesRepository;
  account: AccountRepository;
  sync: SyncRepository;
  team: TeamRepository;
  workspaces: WorkspaceRepository;
  profiles: ProfileRepository;
  library: LibraryRepository;
  transfer: TransferRepository;
  network: NetworkRepository;
  system: SystemRepository;
  on<E extends EventName>(event: E, handler: (payload: EventPayload<E>) => void): () => void;
}

export function isIpcError(e: unknown): e is IpcError {
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e;
}

export function errorMessage(e: unknown, fallback = 'Something went wrong.'): string {
  return isIpcError(e) ? e.message : fallback;
}
