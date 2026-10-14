/**
 * In-memory backend used when the UI runs outside the desktop shell (plain `vite`, UI tests). It mimics the Rust
 * validation rules, the run-state machine and the milestone 04 library rules (clients, tags, templates, trash,
 * bulk actions with undo, import preview/commit) closely enough for UI development; it is never used inside the
 * installed app.
 *
 * Query parameters (`?demo=`): `fresh` (first run), `rows:N` (large list), `crash` (manager crash prompt),
 * `migration` (database recovery screen), `running` (a profile left open, for the quit prompt), `crashed` (a profile
 * that closed unexpectedly, with a backup), `stuck` (closing times out and offers a force close), `noruntime` (the
 * browser is not installed yet), `bigimport` (the import file has 10,000 rows), `unsafeimport` (the import file is
 * an unsafe archive), `proxydown` (the first proxy does not answer), `nologin` (a proxy's saved login is missing from
 * the keychain), `win` (Windows: the time zone setting is unavailable). Organization modes: demo-cloud.ts,
 * demo-sync.ts and demo-team.ts.
 */
import type {
  BulkAction,
  BulkResult,
  Client,
  EventName,
  EventPayload,
  ImportJob,
  ImportPreview,
  ImportSettings,
  Library,
  NetworkCheck,
  Operation,
  PrivacyConfig,
  PrivacyValidation,
  ProfileFilter,
  ProfileStatus,
  ProxyEdit,
  ProxyInput,
  ProxyView,
  SavedFilter,
  Selection,
  Sort,
  TagRef,
  Template,
} from '@pb/contracts/ipc';
import { nameKey, sanitizeNotes, secretHint } from '../notes.ts';
import { announceDemoExtensionUpdate, demoAgency } from './demo-agency.ts';
import { demoCloud } from './demo-cloud.ts';
import { demoSync } from './demo-sync.ts';
import { demoTeam } from './demo-team.ts';
import type {
  AppView,
  Backend,
  IpcError,
  ProfileUpdate,
  ProfileView,
  RunState,
  RuntimeStatus,
  SettingValue,
  Workspace,
} from './types.ts';

const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const id = (prefix: string) =>
  `${prefix}_${Array.from({ length: 26 }, () => CROCK[Math.floor(Math.random() * 32)]).join('')}`;
const hex = (n: number) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const now = () => new Date().toISOString();
const err = (code: string, message: string): IpcError => ({ code, message });
const RUNTIME_VERSION = '155.0.8059.39';
const STATUS: Record<RunState, ProfileView['status']> = {
  stopped: 'closed',
  starting: 'starting',
  running: 'running',
  stopping: 'stopping',
  crashed: 'crashed',
  recovering: 'recovering',
};
const validUrl = (u: string) => /^https?:\/\/\S{1,2040}$/i.test(u);
const MAX_BULK = 10_000;
const HIDDEN = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;
const BATCH = 250;

const E = {
  INVALID_LABEL: err('INVALID_LABEL', 'Names must be 1-120 visible characters.'),
  INVALID_TAG: err('INVALID_TAG', 'Tags must be 1-40 visible characters (at most 20 per profile).'),
  NOTES_TOO_LONG: err('NOTES_TOO_LONG', 'Notes can be at most 2,000 characters.'),
  NOTES_LOOK_SECRET: err(
    'NOTES_LOOK_SECRET',
    'These notes look like they contain a password, key or card number. Notes are not encrypted: keep secrets in a password manager.',
  ),
  UNKNOWN_PROFILE: err('UNKNOWN_PROFILE', 'This profile does not exist on this device.'),
  UNKNOWN_CLIENT: err('UNKNOWN_CLIENT', 'That client does not exist in this workspace.'),
  UNKNOWN_TAG: err('UNKNOWN_TAG', 'That tag does not exist in this workspace.'),
  UNKNOWN_TEMPLATE: err('UNKNOWN_TEMPLATE', 'That template does not exist in this workspace.'),
  DUPLICATE_NAME: err('DUPLICATE_NAME', 'That name is already used in this workspace.'),
  INVALID_FILTER: err('INVALID_FILTER', 'That filter is not valid.'),
  CURSOR_STALE: err('CURSOR_STALE', 'The list changed its filter; load it again from the start.'),
  SELECTION_TOO_LARGE: err('SELECTION_TOO_LARGE', 'Select at most 10,000 profiles at a time.'),
  SELECTION_CHANGED: err(
    'SELECTION_CHANGED',
    'The matching profiles changed since you selected them. Check the selection and try again.',
  ),
  NOTHING_SELECTED: err('NOTHING_SELECTED', 'Select at least one profile.'),
  UNDO_EXPIRED: err('UNDO_EXPIRED', 'This action can no longer be undone.'),
  DELETE_CONFIRMATION: err(
    'CONFIRMATION_REQUIRED',
    'Confirm the permanent deletion of exactly the selected profiles.',
  ),
  PROFILE_IN_TRASH: err('PROFILE_IN_TRASH', 'This profile is in the trash. Restore it first.'),
  PROFILE_RUNNING: err('PROFILE_RUNNING', 'This profile is open. Close it first.'),
  PROFILE_BUSY: err(
    'PROFILE_BUSY',
    'This profile is busy (backup or recovery in progress). Try again in a moment.',
  ),
  NOT_IN_TRASH: err('NOT_IN_TRASH', 'Only profiles in the trash can be deleted permanently.'),
  UNKNOWN_FILE: err('UNKNOWN_FILE', 'Choose the file again.'),
  UNKNOWN_IMPORT: err('UNKNOWN_IMPORT', 'That import does not exist or has expired. Preview the file again.'),
  IMPORT_IN_PROGRESS: err('IMPORT_IN_PROGRESS', 'An import is already running.'),
  UNKNOWN_PROXY: err('UNKNOWN_PROXY', 'That proxy does not exist in this workspace.'),
  PROXY_IN_USE: err(
    'PROXY_IN_USE',
    'Profiles still use this proxy. Give them another proxy (or none) first.',
  ),
  INVALID_PROXY_TYPE: err('INVALID_PROXY_TYPE', 'Choose HTTP, HTTPS or SOCKS5.'),
  INVALID_PROXY_NAME: err('INVALID_PROXY_NAME', 'Proxy names must be 1-80 visible characters.'),
  PROXY_BAD_HOST: err(
    'PROXY_BAD_HOST',
    "Enter the proxy's host name or IP address only (no http://, path or login).",
  ),
  PROXY_BAD_PORT: err('PROXY_BAD_PORT', 'The port must be between 1 and 65535.'),
  PROXY_BAD_CREDENTIALS: err(
    'PROXY_BAD_CREDENTIALS',
    'Usernames and passwords can be at most 255 bytes without control characters; HTTP usernames cannot contain a colon.',
  ),
  PROXY_PRIVATE_ADDRESS: err(
    'PROXY_PRIVATE_ADDRESS',
    'This proxy is on this computer or the local network. Allow local proxies in Settings to use it.',
  ),
  PROXY_FORBIDDEN_ADDRESS: err(
    'PROXY_FORBIDDEN_ADDRESS',
    'This address can never be used as a proxy (link-local, multicast or unspecified).',
  ),
  INVALID_DATE: err('INVALID_DATE', 'Enter the date as YYYY-MM-DD.'),
  PROXY_CREDENTIALS_MISSING: err(
    'PROXY_CREDENTIALS_MISSING',
    "The proxy's saved login is missing from this computer's secure storage. Enter it again.",
  ),
  INVALID_LANGUAGE: err('INVALID_LANGUAGE', 'Choose one of the listed page languages.'),
  INVALID_TIMEZONE: err('INVALID_TIMEZONE', 'Choose one of the listed time zones.'),
  INVALID_WINDOW_SIZE: err('INVALID_WINDOW_SIZE', 'Window size must be between 800×600 and 3840×2160.'),
} as const;

/** Stored profile: the client, tags and proxy are references, resolved when a view is built. */
type Rec = Omit<ProfileView, 'client_name' | 'client_colour' | 'tags' | 'proxy_label' | 'network'> & {
  tag_ids: string[];
  import_ref: string | null;
  /** Routing and environment the open browser was started with (restart-required detection). */
  launched_key: string | null;
};

// ---------------------------------------------------------------------------------------- milestone 05
type FullPrivacy = Required<PrivacyConfig>;
const DEFAULT_PRIVACY: FullPrivacy = {
  webrtc: 'default',
  block_third_party_cookies: false,
  do_not_track: false,
  language: null,
  timezone: null,
  window: null,
  text_size: 'default',
  reduced_motion: false,
  preset: null,
};
const LANGUAGES: [string, string][] = [
  ['en-US', 'English (United States)'],
  ['en-GB', 'English (United Kingdom)'],
  ['de-DE', 'German (Germany)'],
  ['fr-FR', 'French (France)'],
  ['es-ES', 'Spanish (Spain)'],
  ['es-MX', 'Spanish (Mexico)'],
  ['it-IT', 'Italian (Italy)'],
  ['pt-BR', 'Portuguese (Brazil)'],
  ['nl-NL', 'Dutch (Netherlands)'],
  ['pl-PL', 'Polish (Poland)'],
  ['sv-SE', 'Swedish (Sweden)'],
  ['tr-TR', 'Turkish (Turkey)'],
  ['ru-RU', 'Russian (Russia)'],
  ['ar-SA', 'Arabic (Saudi Arabia)'],
  ['hi-IN', 'Hindi (India)'],
  ['ne-NP', 'Nepali (Nepal)'],
  ['id-ID', 'Indonesian (Indonesia)'],
  ['ja-JP', 'Japanese (Japan)'],
  ['ko-KR', 'Korean (South Korea)'],
  ['zh-CN', 'Chinese (Simplified, China)'],
];
const TIME_ZONES = [
  'UTC',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Amsterdam',
  'Europe/Stockholm',
  'Europe/Warsaw',
  'Europe/Istanbul',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
];
const preset = (id: string, name: string, description: string, config: PrivacyConfig) => ({
  id,
  name,
  description,
  config: { ...DEFAULT_PRIVACY, ...config, preset: id },
});
const PRESETS = [
  preset('standard', 'Standard', "The browser's own defaults.", {}),
  preset(
    'privacy',
    'Stricter privacy',
    'Blocks third-party cookies, sends Do Not Track and limits the addresses WebRTC shares.',
    { webrtc: 'public_interface_only', block_third_party_cookies: true, do_not_track: true },
  ),
  preset(
    'accessibility',
    'Accessibility review',
    'Larger text, reduced motion and a 1280×800 window, for checking pages with these needs.',
    { text_size: 'larger', reduced_motion: true, window: { width: 1280, height: 800 } },
  ),
  preset('laptop', 'Small laptop window', 'Opens at 1366×768 to check layouts on common laptop sizes.', {
    window: { width: 1366, height: 768 },
  }),
  preset('desktop', 'Full HD window', 'Opens at 1920×1080.', { window: { width: 1920, height: 1080 } }),
  preset(
    'locale-en-us',
    'English (US), New York time',
    'Pages in US English with Eastern time, for checking dates and formats.',
    { language: 'en-US', timezone: 'America/New_York' },
  ),
  preset('locale-en-gb', 'English (UK), London time', 'Pages in UK English with London time.', {
    language: 'en-GB',
    timezone: 'Europe/London',
  }),
  preset('locale-de-de', 'German, Berlin time', 'Pages in German with Central European time.', {
    language: 'de-DE',
    timezone: 'Europe/Berlin',
  }),
  preset('locale-ja-jp', 'Japanese, Tokyo time', 'Pages in Japanese with Japan time.', {
    language: 'ja-JP',
    timezone: 'Asia/Tokyo',
  }),
  preset('locale-ne-np', 'Nepali, Kathmandu time', 'Pages in Nepali with Nepal time.', {
    language: 'ne-NP',
    timezone: 'Asia/Kathmandu',
  }),
];
interface ProxyRec {
  id: string;
  workspace_id: string;
  name: string;
  type: ProxyView['type'];
  host: string;
  port: number;
  /** Stands in for the OS keychain entry. */
  login: { username: string; password: string } | null;
  /** The keychain entry was removed outside the app. */
  login_missing: boolean;
  expires_at: string | null;
  notes: string;
  version: number;
  created_at: string;
  updated_at: string;
  /** Demo: the proxy does not answer. */
  down: boolean;
}
const ipv4 = (h: string) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m ? m.slice(1).map(Number) : null;
};
/** Mirrors the Rust address policy: public always; private with the setting; link-local etc. never. */
const addressClass = (host: string): 'public' | 'private' | 'forbidden' => {
  const h = host.toLowerCase();
  const v4 = ipv4(h);
  if (v4) {
    const [a = 0, b = 0] = v4;
    if (a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 192 && b === 0 && v4[2] === 2))
      return 'forbidden';
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
      return 'private';
    if (a === 100 && b >= 64 && b <= 127) return 'private';
    return 'public';
  }
  if (h.includes(':')) {
    if (h === '::' || h.startsWith('fe80') || h.startsWith('ff')) return 'forbidden';
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd')) return 'private';
    return 'public';
  }
  if (h === 'localhost' || h.endsWith('.localhost')) return 'private';
  return 'public';
};
const daysLeft = (date: string | null) =>
  date
    ? Math.floor(
        (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${now().slice(0, 10)}T00:00:00Z`)) / 86_400_000,
      )
    : null;
const demoPlatform = (mode: string): PrivacyValidation['platform'] =>
  mode === 'win' || navigator.userAgent.includes('Windows')
    ? 'windows'
    : navigator.userAgent.includes('Mac')
      ? 'macos'
      : 'linux';
interface TagRec {
  id: string;
  workspace_id: string;
  name: string;
}
interface TemplateRec extends Template {
  workspace_id: string;
}
interface FilterRec extends SavedFilter {
  workspace_id: string;
}
type Prior = Partial<
  Pick<
    Rec,
    'client_id' | 'archived_at' | 'favourite' | 'trashed_at' | 'purge_after' | 'proxy_id' | 'fail_closed'
  >
> & {
  tag_ids?: string[];
};
interface UndoEntry {
  token: string;
  workspace: string;
  restore: boolean;
  items: { id: string; prior: Prior; version: number }[];
  created: number;
}

// ---------------------------------------------------------------------------------------- demo import files
interface RawRow {
  name?: string;
  client?: string | null;
  tags?: string;
  notes?: string;
  start_urls?: string;
  favourite?: string;
  template?: string;
}
const SAMPLE_ROWS: RawRow[] = [
  { name: 'Shop admin', client: 'Client North', tags: 'ecommerce' },
  { name: 'Café orders', client: 'Client Süd', tags: 'ecommerce;new' },
  { name: 'Ads review', client: 'Client South', tags: 'ads', notes: '=SUM(A1) stays plain text' },
  { name: '', client: 'Client East' },
  { name: 'Support inbox', client: 'Client East', start_urls: 'ftp://files.example/' },
  { name: 'Social', client: 'Client North', notes: 'Password: hunter2' },
  { name: 'Shop admin', client: 'Client North' },
  { name: '日本ストア', client: 'Client Japan', tags: 'ecommerce', favourite: 'yes' },
  { name: 'Analytics', template: 'Missing template' },
  { name: 'Long notes', client: 'Client South', notes: 'Weekly checklist. '.repeat(100).trim() },
];
const bigRows = (): RawRow[] =>
  Array.from({ length: 10_000 }, (_, i) => ({
    name: i === 4999 ? '' : `Imported ${String(i).padStart(5, '0')}`,
    client: `Client ${String(i % 20).padStart(2, '0')}`,
    tags: i % 3 === 0 ? 'bulk' : '',
  }));

interface Planned {
  row: number;
  status: ImportPreview['rows'][number]['status'];
  name: string;
  client: string | null;
  tags: string[];
  notes: string;
  favourite: boolean;
  start_urls: string[];
  template: string | null;
  warnings: string[];
  errors: { field: string; code: string; message: string }[];
  update?: { id: string; version: number };
}

export function demoBackend(mode = ''): Backend {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emit = <E extends EventName>(e: E, p: EventPayload<E>) => {
    for (const l of listeners.get(e) ?? []) l(p);
  };

  const workspaces: Workspace[] = [];
  const recs: Rec[] = [];
  const clients: Client[] = [];
  const tags: TagRec[] = [];
  const templates: TemplateRec[] = [];
  const filters: FilterRec[] = [];
  const jobs: (ImportJob & { workspace_id: string })[] = [];
  const undo: UndoEntry[] = [];
  const backups = new Map<string, { created_at_unix: number; files: number }>();
  const proxies: ProxyRec[] = [];
  const checks: NetworkCheck[] = [];
  const platform = demoPlatform(mode);
  const ops: Operation[] = [];
  let opSeq = 0;
  let crashed = mode === 'crash';
  let storeFailed = mode === 'migration';
  let runtimeInstalled = mode !== 'noruntime';
  let installing = false;
  const settings: Record<string, SettingValue> = {
    'appearance.theme': { key: 'appearance.theme', value: 'system', version: 0, ui_settable: true },
    'manager.close_behavior': { key: 'manager.close_behavior', value: 'ask', version: 0, ui_settable: true },
    'privacy.crash_reports': { key: 'privacy.crash_reports', value: false, version: 0, ui_settable: true },
    'downloads.directory': { key: 'downloads.directory', value: null, version: 0, ui_settable: false },
    'workspace.active': { key: 'workspace.active', value: null, version: 0, ui_settable: true },
    'profiles.trash_retention_days': {
      key: 'profiles.trash_retention_days',
      value: '30',
      version: 0,
      ui_settable: true,
    },
    'proxies.allow_private_addresses': {
      key: 'proxies.allow_private_addresses',
      value: false,
      version: 0,
      ui_settable: true,
    },
    'downloads.per_client_folders': {
      key: 'downloads.per_client_folders',
      value: false,
      version: 0,
      ui_settable: true,
    },
    'profiles.open_reminder_hours': {
      key: 'profiles.open_reminder_hours',
      value: 'off',
      version: 0,
      ui_settable: true,
    },
    'resources.memory_warning': {
      key: 'resources.memory_warning',
      value: true,
      version: 0,
      ui_settable: true,
    },
  };
  const ENUMS: Record<string, unknown[]> = {
    'proxies.allow_private_addresses': [true, false],
    'downloads.per_client_folders': [true, false],
    'profiles.open_reminder_hours': ['off', '4', '8', '12', '24'],
    'resources.memory_warning': [true, false],
    'appearance.theme': ['system', 'light', 'dark'],
    'manager.close_behavior': ['ask', 'keep_running', 'close_all'],
    'profiles.trash_retention_days': ['7', '30', '90'],
  };

  const activeWs = () => settings['workspace.active']?.value as string | null;
  const retention = () => Number(settings['profiles.trash_retention_days']?.value ?? 30);
  const inWs = (r: Rec) => r.workspace_id === activeWs();

  // ------------------------------------------------------------------ library helpers
  const ensureClient = (ws: string, name: string): Client => {
    const n = clean(name, 120, E.INVALID_LABEL);
    const found = clients.find((c) => c.workspace_id === ws && nameKey(c.name) === nameKey(n));
    if (found) return found;
    const c: Client = {
      id: id('cli'),
      workspace_id: ws,
      name: n,
      colour: null,
      archived_at: null,
      version: 1,
      created_at: now(),
    };
    clients.push(c);
    return c;
  };
  const ensureTag = (ws: string, name: string): TagRec => {
    const n = clean(name, 40, E.INVALID_TAG);
    const found = tags.find((t) => t.workspace_id === ws && nameKey(t.name) === nameKey(n));
    if (found) return found;
    const t: TagRec = { id: id('tag'), workspace_id: ws, name: n };
    tags.push(t);
    return t;
  };
  const netKey = (r: Rec) =>
    JSON.stringify([
      r.proxy_id,
      r.fail_closed,
      r.privacy,
      proxies.find((x) => x.id === r.proxy_id)?.version ?? 0,
    ]);
  const networkOf = (r: Rec): ProfileView['network'] => {
    const px = proxies.find((x) => x.id === r.proxy_id);
    const open = r.state === 'starting' || r.state === 'running' || r.state === 'stopping';
    const restart_required = open && r.launched_key !== null && r.launched_key !== netKey(r);
    if (!open || !r.launched_key) {
      return { status: px ? 'ready' : 'off', last_error: null, direct_connections: 0, restart_required };
    }
    const launchedProxy = (JSON.parse(r.launched_key) as [string | null, boolean])[0];
    const lp = proxies.find((x) => x.id === launchedProxy);
    if (!lp) return { status: 'off', last_error: null, direct_connections: 0, restart_required };
    if (!lp.down) return { status: 'active', last_error: null, direct_connections: 0, restart_required };
    return r.fail_closed
      ? { status: 'failing', last_error: 'PROXY_UNREACHABLE', direct_connections: 0, restart_required }
      : { status: 'bypassing', last_error: 'PROXY_UNREACHABLE', direct_connections: 3, restart_required };
  };
  /** Shared sessions (milestone 08) and organization links; set once the demo server exists. */
  let teamHooks: ReturnType<typeof demoTeam> | null = null;
  let linkHook: ((pid: string) => boolean) | null = null;
  const view = (r: Rec): ProfileView => {
    const { tag_ids, import_ref: _ref, launched_key: _launched, ...rest } = r;
    const c = clients.find((x) => x.id === r.client_id);
    return {
      ...rest,
      proxy_label: proxies.find((x) => x.id === r.proxy_id)?.name ?? null,
      network: networkOf(r),
      sync_status: linkHook?.(r.id) ? 'shared' : 'local_only',
      team_phase: teamHooks?.phase(r.id) ?? null,
      client_name: c?.name ?? null,
      client_colour: c?.colour ?? null,
      tags: tag_ids
        .map((t) => tags.find((x) => x.id === t))
        .filter((t): t is TagRec => Boolean(t))
        .map((t) => ({ id: t.id, name: t.name }))
        .sort((a, b) => nameKey(a.name).localeCompare(nameKey(b.name))),
    };
  };

  const addProfile = (name: string, client: string | null, wsId: string, extra: Partial<Rec> = {}): Rec => {
    const r: Rec = {
      id: id('prf'),
      workspace_id: wsId,
      name,
      client_id: client ? ensureClient(wsId, client).id : null,
      notes: '',
      favourite: false,
      archived_at: null,
      trashed_at: null,
      purge_after: null,
      template_id: null,
      proxy_id: null,
      fail_closed: true,
      privacy: { ...DEFAULT_PRIVACY },
      launched_key: null,
      sync_status: 'local_only',
      team_phase: null,
      version: 1,
      created_at: now(),
      updated_at: now(),
      status: 'closed',
      state: 'stopped',
      pid: null,
      adopted: false,
      ready: false,
      window_open: false,
      force_available: false,
      start_urls: [],
      download_dir: null,
      permissions: { camera: 'ask', microphone: 'ask', location: 'ask' },
      runtime_version: null,
      last_error: null,
      crash_count: 0,
      last_started_at: null,
      last_clean_shutdown_at: null,
      last_backup_at: null,
      tag_ids: [],
      import_ref: null,
      ...extra,
    };
    recs.push(r);
    return r;
  };

  const set = (pid: string, patch: Partial<Rec>) => {
    const i = recs.findIndex((x) => x.id === pid);
    const p = recs[i];
    if (!p) return;
    const next = { ...p, ...patch };
    next.status = STATUS[next.state];
    recs[i] = next;
  };

  if (mode !== 'fresh' && mode !== 'migration') {
    const ws: Workspace = { id: id('wsp'), name: 'Demo agency', kind: 'local', created_at: now() };
    workspaces.push(ws);
    settings['workspace.active'] = {
      ...(settings['workspace.active'] as SettingValue),
      value: ws.id,
      version: 1,
    };
    const rows = mode.startsWith('rows:') ? Number(mode.slice(5)) : 3;
    const clientNames = ['Client North', 'Client South', 'Client East', null];
    const tagSets = [['ecommerce'], ['ads', 'qa'], [], ['qa']];
    const day = 86_400_000;
    for (let i = 0; i < rows; i++) {
      const r = addProfile(
        rows === 3
          ? (['Shop admin', 'Ads QA', 'Support desk'][i] as string)
          : `Profile ${String(i).padStart(5, '0')}`,
        clientNames[i % clientNames.length] ?? null,
        ws.id,
        {
          favourite: i === 0,
          last_started_at: i % 2 === 0 ? new Date(Date.now() - (i + 1) * day).toISOString() : null,
        },
      );
      r.tag_ids = (tagSets[i % tagSets.length] ?? []).map((t) => ensureTag(ws.id, t).id);
    }
    if (mode === '') {
      addProfile('Old campaign', 'Client South', ws.id, { archived_at: now() });
      addProfile('Test account', null, ws.id, {
        trashed_at: now(),
        purge_after: new Date(Date.now() + 30 * day).toISOString(),
      });
      templates.push({
        id: id('tpl'),
        workspace_id: ws.id,
        name: 'Store manager',
        schema_version: 1,
        config: {
          start_urls: ['https://shop.example/admin'],
          camera: 'block',
          microphone: 'block',
          location: 'ask',
          tags: ['ecommerce'],
          notes: '',
        },
        version: 1,
        updated_at: now(),
      });
      const north = clients.find((c) => c.name === 'Client North');
      if (north) north.colour = '#0e7490';
    }
    if (mode === '' || mode === 'proxydown' || mode === 'nologin' || mode === 'win') {
      const soon = new Date(Date.now() + 5 * day).toISOString().slice(0, 10);
      const de: ProxyRec = {
        id: id('prx'),
        workspace_id: ws.id,
        name: 'Residential DE',
        type: 'http',
        host: 'de.proxy-provider.example',
        port: 8080,
        login: { username: 'agency-de', password: 'demo-only' },
        login_missing: mode === 'nologin',
        expires_at: soon,
        notes: 'Provider plan renews monthly.',
        version: 1,
        created_at: now(),
        updated_at: now(),
        down: mode === 'proxydown',
      };
      const socks: ProxyRec = {
        ...de,
        id: id('prx'),
        name: 'SOCKS backup',
        type: 'socks5',
        host: '203.0.113.40',
        port: 1080,
        login: null,
        login_missing: false,
        expires_at: null,
        notes: '',
        down: false,
      };
      proxies.push(de, socks);
      const shop = recs.find((r) => r.name === 'Shop admin');
      if (shop) shop.proxy_id = de.id;
      checks.push({
        id: id('nck'),
        proxy_id: socks.id,
        result: 'ok',
        error_code: null,
        latency_ms: 182,
        egress_ip: '203.0.113.40',
        checked_at: new Date(Date.now() - 3_600_000).toISOString(),
      });
    }
    const first = recs[0];
    if (first && (mode === 'running' || mode === 'stuck')) {
      set(first.id, {
        state: 'running',
        pid: 4242,
        adopted: mode === 'running',
        ready: true,
        window_open: true,
        runtime_version: RUNTIME_VERSION,
      });
    }
    if (first && mode === 'crashed') {
      set(first.id, {
        state: 'crashed',
        last_error: 'CRASHED',
        crash_count: 3,
        runtime_version: RUNTIME_VERSION,
        last_backup_at: now(),
      });
      backups.set(first.id, { created_at_unix: Math.floor(Date.now() / 1000) - 3600, files: 412 });
    }
  }

  const isOpen = (p: Rec) => p.state === 'starting' || p.state === 'running' || p.state === 'stopping';
  const running = () => recs.filter(isOpen).length;
  function clean(v: string, max: number, e: IpcError) {
    const t = v.trim();
    if (!t || [...t].length > max || HIDDEN.test(t)) throw e;
    return t;
  }
  const cleanNotes = (v: string) => {
    const n = sanitizeNotes(v);
    if ([...n].length > 2000) throw E.NOTES_TOO_LONG;
    if (secretHint(n)) throw E.NOTES_LOOK_SECRET;
    return n;
  };
  const startOp = (kind: Operation['kind'], target: string | null): Operation => {
    const op: Operation = {
      operation_id: `op_${++opSeq}`,
      kind,
      status: 'running',
      progress: null,
      target,
      error_code: null,
      message: null,
    };
    ops.unshift(op);
    emit('operation', { ...op });
    return op;
  };
  const changed = () => emit('profiles-changed', { running: running() });
  const finish = (op: Operation, patch: Partial<Operation>) => {
    Object.assign(op, patch);
    emit('operation', { ...op });
    changed();
  };
  const requireStore = () => {
    if (storeFailed)
      throw err('STORE_UNAVAILABLE', 'Local data could not be opened. Use the recovery options to continue.');
  };
  const requireWs = () => {
    requireStore();
    const ws = activeWs();
    if (!ws) throw err('NO_WORKSPACE', 'Create a workspace first.');
    return ws;
  };
  const find = (pid: string) => {
    const p = recs.find((x) => x.id === pid);
    if (!p) throw E.UNKNOWN_PROFILE;
    return p;
  };
  /** Organization backups (milestone 07); set once the demo server exists. */
  let syncHooks: { afterCleanClose(id: string): void; restoring(id: string): boolean } | null = null;
  const stopNow = (pid: string, outcome: 'clean' | 'forced') => {
    set(pid, {
      state: 'stopped',
      pid: null,
      adopted: false,
      ready: false,
      window_open: false,
      force_available: false,
      launched_key: null,
      ...(outcome === 'clean' ? { last_clean_shutdown_at: now(), crash_count: 0 } : {}),
    });
    // A shared session hands off (or waits for a decision); other linked profiles back up automatically.
    if (teamHooks?.closed(pid, outcome === 'clean')) return;
    if (outcome === 'clean') syncHooks?.afterCleanClose(pid);
  };
  const launchOps = new Map<string, Operation>();

  // ------------------------------------------------------------------ proxies and privacy (milestone 05)
  const allowPrivate = () => settings['proxies.allow_private_addresses']?.value === true;
  const checkHost = (raw: string) => {
    let h = raw.trim().toLowerCase().replace(/\.$/, '');
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    if (!h || h.length > 253 || /[\s/@?#]/.test(h) || h.includes('://')) throw E.PROXY_BAD_HOST;
    if (!h.includes(':') && !/^[a-z0-9.-]+$/.test(h)) throw E.PROXY_BAD_HOST;
    const cls = addressClass(h);
    if (cls === 'forbidden') throw E.PROXY_FORBIDDEN_ADDRESS;
    if (cls === 'private' && !allowPrivate()) throw E.PROXY_PRIVATE_ADDRESS;
    return h;
  };
  const checkLogin = (type: string, login: { username: string; password: string } | undefined) => {
    if (!login) return null;
    const bad = (v: string) => new TextEncoder().encode(v).length > 255 || /\p{Cc}/u.test(v);
    if (!login.username || bad(login.username) || bad(login.password)) throw E.PROXY_BAD_CREDENTIALS;
    if (type !== 'socks5' && login.username.includes(':')) throw E.PROXY_BAD_CREDENTIALS;
    return { username: login.username, password: login.password };
  };
  const checkDate = (d: string | undefined) => {
    if (d === undefined) return;
    const t = Date.parse(`${d}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(t)) throw E.INVALID_DATE;
  };
  const proxyNotes = (v: string | undefined) => {
    const n = cleanNotes(v ?? '');
    if ([...n].length > 500) throw err('NOTES_TOO_LONG', 'Proxy notes can be at most 500 characters.');
    return n;
  };
  const proxyView = (x: ProxyRec): ProxyView => {
    const left = daysLeft(x.expires_at);
    return {
      id: x.id,
      workspace_id: x.workspace_id,
      name: x.name,
      type: x.type,
      host: x.host,
      port: x.port,
      has_login: x.login !== null,
      expires_at: x.expires_at,
      expiry: left === null ? null : left < 0 ? 'expired' : left <= 7 ? 'expires_soon' : null,
      days_left: left,
      notes: x.notes,
      version: x.version,
      created_at: x.created_at,
      updated_at: x.updated_at,
      profiles: recs.filter((r) => r.proxy_id === x.id).length,
      last_check: checks.find((c) => c.proxy_id === x.id) ?? null,
    };
  };
  const ownProxy = (pid: string) => {
    const ws = requireWs();
    const x = proxies.find((p) => p.id === pid && p.workspace_id === ws);
    if (!x) throw E.UNKNOWN_PROXY;
    return x;
  };
  function checkPrivacy(c: PrivacyConfig): FullPrivacy {
    const known = Object.keys(DEFAULT_PRIVACY);
    if (Object.keys(c).some((k) => !known.includes(k)))
      throw err('INVALID_ARGUMENT', 'The request was not valid.');
    const full: FullPrivacy = { ...DEFAULT_PRIVACY, ...c };
    if (full.language && !LANGUAGES.some(([t]) => t === full.language)) throw E.INVALID_LANGUAGE;
    if (full.timezone && !TIME_ZONES.includes(full.timezone)) throw E.INVALID_TIMEZONE;
    const w = full.window;
    if (w && (w.width < 800 || w.width > 3840 || w.height < 600 || w.height > 2160))
      throw E.INVALID_WINDOW_SIZE;
    return full;
  }
  const report = (c: FullPrivacy, failClosed: boolean): PrivacyValidation['report'] => {
    const out: PrivacyValidation['report'] = [];
    if (c.timezone)
      out.push(
        platform === 'windows'
          ? {
              field: 'timezone',
              support: 'unavailable',
              message: "On Windows the browser always uses the computer's time zone.",
            }
          : { field: 'timezone', support: 'applied', message: 'Pages see this time zone (Date and Intl).' },
      );
    if (c.language)
      out.push(
        platform === 'macos'
          ? {
              field: 'language',
              support: 'partial',
              message: "Websites get this language; the browser's own menus follow macOS.",
            }
          : {
              field: 'language',
              support: 'applied',
              message: "Websites get this language, and the browser's menus use it where available.",
            },
      );
    if (c.window)
      out.push({
        field: 'window',
        support: 'applied',
        message: 'The window opens at this size. It is not a screen or device size.',
      });
    if (c.text_size !== 'default')
      out.push({ field: 'text_size', support: 'applied', message: 'Default text size for pages.' });
    if (c.reduced_motion)
      out.push({
        field: 'reduced_motion',
        support: 'applied',
        message: 'Pages are told the user prefers reduced motion.',
      });
    if (failClosed)
      out.push({
        field: 'webrtc',
        support: 'applied',
        message: 'WebRTC can use only the proxy (set by fail-closed routing).',
      });
    else if (c.webrtc !== 'default')
      out.push({
        field: 'webrtc',
        support: 'applied',
        message: "Applied by the browser's WebRTC address handling.",
      });
    if (c.block_third_party_cookies)
      out.push({
        field: 'block_third_party_cookies',
        support: 'applied',
        message: 'Cookies of embedded third-party sites are blocked; some sign-in widgets may stop working.',
      });
    if (c.do_not_track)
      out.push({
        field: 'do_not_track',
        support: 'applied',
        message: 'Sends a Do Not Track request; websites may ignore it.',
      });
    return out;
  };

  // ------------------------------------------------------------------ query
  const validateFilter = (f: ProfileFilter) => {
    if (f.text && [...f.text].length > 200) throw E.INVALID_FILTER;
    if (f.client?.kind === 'ids' && (f.client.ids.length === 0 || f.client.ids.length > 50))
      throw E.INVALID_FILTER;
    if ((f.tags?.length ?? 0) > 20) throw E.INVALID_FILTER;
    const known = ['text', 'view', 'client', 'tags', 'states', 'favourites_only', 'template', 'proxy'];
    if (Object.keys(f).some((k) => !known.includes(k))) throw E.INVALID_FILTER;
  };
  const matches = (r: Rec, f: ProfileFilter) => {
    if (!inWs(r)) return false;
    const v = f.view ?? 'active';
    if (v === 'active' && (r.archived_at || r.trashed_at)) return false;
    if (v === 'archived' && (!r.archived_at || r.trashed_at)) return false;
    if (v === 'trash' && !r.trashed_at) return false;
    if (f.client?.kind === 'none' && r.client_id) return false;
    if (f.client?.kind === 'ids' && !f.client.ids.includes(r.client_id ?? '')) return false;
    if (f.tags?.some((t) => !r.tag_ids.includes(t))) return false;
    if (f.states?.length && !f.states.includes(r.state)) return false;
    if (f.favourites_only && !r.favourite) return false;
    if (f.template && r.template_id !== f.template) return false;
    if (f.proxy && r.proxy_id !== f.proxy) return false;
    const text = f.text?.trim();
    if (text) {
      const k = nameKey(text);
      const c = clients.find((x) => x.id === r.client_id);
      const hit =
        nameKey(r.name).includes(k) ||
        (c ? nameKey(c.name).includes(k) : false) ||
        r.tag_ids.some((t) => nameKey(tags.find((x) => x.id === t)?.name ?? '').includes(k)) ||
        r.id === text;
      if (!hit) return false;
    }
    return true;
  };
  const STATE_ORDER: Record<RunState, number> = {
    running: 0,
    starting: 1,
    stopping: 2,
    crashed: 3,
    recovering: 4,
    stopped: 5,
  };
  const sorted = (rows: Rec[], sort: Sort) => {
    const dir = sort.descending ? -1 : 1;
    const clientKey = (r: Rec) => {
      const c = clients.find((x) => x.id === r.client_id);
      return c ? nameKey(c.name) : null;
    };
    const byName = (a: Rec, b: Rec) =>
      nameKey(a.name).localeCompare(nameKey(b.name)) || (a.id < b.id ? -1 : 1);
    return [...rows].sort((a, b) => {
      switch (sort.key) {
        case 'client': {
          const [x, y] = [clientKey(a), clientKey(b)];
          if (x === null || y === null) return x === y ? byName(a, b) : x === null ? 1 : -1;
          return dir * x.localeCompare(y) || byName(a, b);
        }
        case 'last_used': {
          const [x, y] = [a.last_started_at, b.last_started_at];
          if (!x || !y) return x === y ? byName(a, b) : !x ? 1 : -1;
          return dir * x.localeCompare(y) || byName(a, b);
        }
        case 'created':
          return dir * a.created_at.localeCompare(b.created_at) || (a.id < b.id ? -1 : 1);
        case 'state':
          return dir * (STATE_ORDER[a.state] - STATE_ORDER[b.state]) || byName(a, b);
        default:
          return dir * nameKey(a.name).localeCompare(nameKey(b.name)) || (a.id < b.id ? -1 : 1);
      }
    });
  };
  const fingerprint = (f: ProfileFilter, s: Sort) => {
    let h = 0;
    for (const ch of JSON.stringify([f, s])) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h.toString(16).padStart(8, '0');
  };
  const queryAll = (f: ProfileFilter, s: Sort = { key: 'name', descending: false }) =>
    sorted(
      recs.filter((r) => matches(r, f)),
      s,
    );

  const resolve = (selection: Selection): { ids: string[]; missing: string[] } => {
    const ws = requireWs();
    if (selection.kind === 'ids') {
      if (selection.ids.length > MAX_BULK) throw E.SELECTION_TOO_LARGE;
      const ids = [...new Set(selection.ids)];
      if (!ids.length) throw E.NOTHING_SELECTED;
      return {
        ids: ids.filter((i) => recs.some((r) => r.id === i && r.workspace_id === ws)),
        missing: ids.filter((i) => !recs.some((r) => r.id === i && r.workspace_id === ws)),
      };
    }
    validateFilter(selection.filter);
    const all = queryAll(selection.filter);
    if (all.length !== selection.expected_total) throw E.SELECTION_CHANGED;
    if (all.length > MAX_BULK) throw E.SELECTION_TOO_LARGE;
    if (!all.length) throw E.NOTHING_SELECTED;
    return { ids: all.map((r) => r.id), missing: [] };
  };
  const failure = (pid: string, e: IpcError) => ({
    id: pid,
    name: recs.find((r) => r.id === pid)?.name ?? null,
    code: e.code,
    message: e.message,
  });

  /** Applies one bulk change to one profile: the prior values when it changed, `null` when nothing changed. */
  const applyOne = (r: Rec, a: BulkAction, tagId: string | null): Prior | null => {
    switch (a.action) {
      case 'add_tag':
        if (!tagId || r.tag_ids.includes(tagId) || r.tag_ids.length >= 20) return null;
        return { tag_ids: [...r.tag_ids] };
      case 'remove_tag':
        return r.tag_ids.includes(a.tag_id) ? { tag_ids: [...r.tag_ids] } : null;
      case 'move':
        return r.client_id === a.client_id ? null : { client_id: r.client_id };
      case 'archive':
        return r.archived_at || r.trashed_at ? null : { archived_at: r.archived_at };
      case 'unarchive':
        return r.archived_at ? { archived_at: r.archived_at } : null;
      case 'favourite':
        return r.favourite === a.value ? null : { favourite: r.favourite };
      case 'trash':
        return r.trashed_at ? null : { trashed_at: null, purge_after: null };
      case 'restore':
        return r.trashed_at ? { trashed_at: r.trashed_at, purge_after: r.purge_after } : null;
      case 'set_proxy':
        return r.proxy_id === a.proxy_id && r.fail_closed === a.fail_closed
          ? null
          : { proxy_id: r.proxy_id, fail_closed: r.fail_closed };
    }
  };
  const patchFor = (a: BulkAction, r: Rec, tagId: string | null): Partial<Rec> => {
    switch (a.action) {
      case 'add_tag':
        return { tag_ids: [...r.tag_ids, tagId as string] };
      case 'remove_tag':
        return { tag_ids: r.tag_ids.filter((t) => t !== a.tag_id) };
      case 'move':
        return { client_id: a.client_id };
      case 'archive':
        return { archived_at: now() };
      case 'unarchive':
        return { archived_at: null };
      case 'favourite':
        return { favourite: a.value };
      case 'trash':
        return {
          trashed_at: now(),
          purge_after: new Date(Date.now() + retention() * 86_400_000).toISOString(),
        };
      case 'restore':
        return { trashed_at: null, purge_after: null };
      case 'set_proxy':
        return { proxy_id: a.proxy_id, fail_closed: a.fail_closed };
    }
  };

  const libraryOf = (ws: string): Library => {
    const all = recs.filter((r) => r.workspace_id === ws);
    const active = all.filter((r) => !r.archived_at && !r.trashed_at);
    const perClient = new Map<string, number>();
    for (const r of active)
      if (r.client_id) perClient.set(r.client_id, (perClient.get(r.client_id) ?? 0) + 1);
    return {
      counts: {
        active: active.length,
        favourites: active.filter((r) => r.favourite).length,
        running: all.filter((r) => !r.trashed_at && isOpen(r)).length,
        archived: all.filter((r) => r.archived_at && !r.trashed_at).length,
        trash: all.filter((r) => r.trashed_at).length,
        without_client: active.filter((r) => !r.client_id).length,
        per_client: [...perClient.entries()],
      },
      clients: clients
        .filter((c) => c.workspace_id === ws)
        .sort((a, b) => nameKey(a.name).localeCompare(nameKey(b.name)))
        .map((c) => ({ ...c, profiles: perClient.get(c.id) ?? 0 })),
      tags: tags
        .filter((t) => t.workspace_id === ws)
        .sort((a, b) => nameKey(a.name).localeCompare(nameKey(b.name)))
        .map((t) => ({
          id: t.id,
          name: t.name,
          profiles: all.filter((r) => !r.trashed_at && r.tag_ids.includes(t.id)).length,
        })),
      templates: templates
        .filter((t) => t.workspace_id === ws)
        .map(({ workspace_id: _w, ...t }) => t)
        .sort((a, b) => nameKey(a.name).localeCompare(nameKey(b.name))),
      saved_filters: filters.filter((f) => f.workspace_id === ws).map(({ workspace_id: _w, ...f }) => f),
      trash_retention_days: retention(),
    };
  };

  // ------------------------------------------------------------------ import (demo)
  const files = new Map<string, { name: string; rows: RawRow[] | null; size: number }>();
  const previews = new Map<
    string,
    { ws: string; fileRef: string; digest: string; settings: ImportSettings; applied: Set<number> }
  >();
  const importsRunning = new Map<string, { cancel: boolean }>();
  const digestOf = (name: string, rows: RawRow[] | null) => {
    let h = 0;
    for (const ch of `${name}${JSON.stringify(rows)}`) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
    return h.toString(16).padStart(8, '0').repeat(8);
  };
  const plan = (ws: string, rows: RawRow[], digest: string, s: ImportSettings) => {
    const policy = s.duplicates ?? 'skip';
    const existing = new Map<string, Rec>();
    for (const r of recs)
      if (r.workspace_id === ws) {
        const c = clients.find((x) => x.id === r.client_id);
        const key = `${nameKey(r.name)}|${c ? nameKey(c.name) : ''}`;
        if (!existing.has(key)) existing.set(key, r);
      }
    const seen = new Set<string>();
    const newClients: string[] = [];
    const newTags: string[] = [];
    const out: Planned[] = rows.map((raw, i) => {
      const row = i + 2;
      const errors: Planned['errors'] = [];
      const warnings: string[] = [];
      const name = (raw.name ?? '').trim();
      if (!name) errors.push({ field: 'name', code: 'required', message: 'name is required' });
      else if ([...name].length > 120)
        errors.push({ field: 'name', code: 'too_long', message: 'name is longer than 120 characters' });
      const client = (raw.client ?? '').trim() || s.default_client?.trim() || null;
      const rowTags = (raw.tags ?? '')
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean);
      let notes = sanitizeNotes(raw.notes ?? '');
      const hint = secretHint(notes);
      if (hint) {
        warnings.push(`notes left out (${hint})`);
        notes = '';
      }
      // As in the CSV format: tags are separated by ";", start pages by spaces or new lines.
      const urls = (raw.start_urls ?? '').split(/\s+/).filter(Boolean);
      for (const u of urls)
        if (!validUrl(u))
          errors.push({
            field: 'start_urls',
            code: 'invalid_url',
            message: `"${u}" is not an http(s) address`,
          });
      const fav = (raw.favourite ?? '').trim().toLowerCase();
      if (fav && !['true', 'yes', '1', 'false', 'no', '0'].includes(fav))
        errors.push({
          field: 'favourite',
          code: 'invalid_value',
          message: 'favourite must be true or false',
        });
      const template = raw.template?.trim() || null;
      if (
        template &&
        !errors.length &&
        !templates.some((t) => t.workspace_id === ws && nameKey(t.name) === nameKey(template))
      )
        errors.push({
          field: 'template',
          code: 'unknown_template',
          message: `no template named "${template}"`,
        });
      const base = {
        row,
        name,
        client,
        tags: rowTags,
        notes,
        favourite: ['true', 'yes', '1'].includes(fav),
        start_urls: urls,
        template,
        warnings,
        errors,
      };
      if (errors.length) return { ...base, status: 'error' as const };
      if (recs.some((r) => r.import_ref === `${digest.slice(0, 16)}:${row}`))
        return { ...base, status: 'already_imported' as const };
      if (client && !clients.some((c) => c.workspace_id === ws && nameKey(c.name) === nameKey(client))) {
        if (!newClients.some((c) => nameKey(c) === nameKey(client))) newClients.push(client);
      }
      const key = `${nameKey(name)}|${client ? nameKey(client) : ''}`;
      const hit = existing.get(key);
      let status: Planned['status'] = 'create';
      let update: Planned['update'];
      if (seen.has(key) && policy !== 'create') status = 'skip_duplicate';
      else if (hit) {
        if (policy === 'skip') status = 'skip_duplicate';
        else if (policy === 'update') {
          status = 'update';
          update = { id: hit.id, version: hit.version };
        }
      }
      seen.add(key);
      if (status === 'create' || status === 'update')
        for (const t of rowTags)
          if (
            !tags.some((x) => x.workspace_id === ws && nameKey(x.name) === nameKey(t)) &&
            !newTags.some((x) => nameKey(x) === nameKey(t))
          )
            newTags.push(t);
      return { ...base, status, ...(update ? { update } : {}) };
    });
    return { rows: out, newClients, newTags };
  };
  const rowErrors = (rows: Planned[]) =>
    rows.flatMap((p) => p.errors.map((e) => ({ row: p.row, ...e }))).slice(0, 1000);

  const runtimeStatus = (): RuntimeStatus => ({
    browser: {
      configured: runtimeInstalled,
      source: runtimeInstalled ? 'manifest' : 'none',
      version: runtimeInstalled ? RUNTIME_VERSION : null,
      error: runtimeInstalled ? null : 'RUNTIME_NOT_INSTALLED',
      manifest_status: { status: 'verified', version: RUNTIME_VERSION },
      manifest: {
        version: RUNTIME_VERSION,
        channel: 'internal-alpha',
        distribution: 'Chrome for Testing',
        customer_distribution: false,
        platform_supported: true,
        size_bytes: 167_772_160,
      },
      installing,
    },
    installations: runtimeInstalled
      ? [
          {
            version: RUNTIME_VERSION,
            platform: 'macos-arm64',
            digest: 'a'.repeat(64),
            verified_at: now(),
            path: '/demo/runtimes/installed',
            status: 'verified',
            distribution: 'chrome-for-testing',
            executable:
              'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          },
        ]
      : [],
    interrupted: [],
    quarantined: 0,
    running: recs.filter(isOpen).map((p) => ({
      profile_id: p.id,
      run_id: null,
      pid: p.pid,
      state: p.state,
      adopted: p.adopted,
      ready: p.ready,
      window_open: p.window_open,
      helpers: p.ready ? 4 : 0,
      force_available: p.force_available,
    })),
    operations: ops.slice(0, 50),
    manager_updates: {
      channel: 'internal',
      automatic: false,
      note: 'Signed update channels arrive in milestone 12.',
    },
  });

  const cloud = demoCloud({
    mode,
    emit: (e) => emit('account', e),
    emitAutomation: (p) => emit('automation', p),
    localProfiles: (workspaceId) =>
      recs
        .filter((r) => r.workspace_id === workspaceId && !r.trashed_at && !r.archived_at)
        .map((r) => ({
          id: r.id,
          name: r.name,
          client_id: r.client_id,
          client_name: clients.find((c) => c.id === r.client_id)?.name ?? null,
          notes: r.notes,
        })),
  });
  const sync = demoSync({
    mode,
    cloud: cloud.sync,
    links: (orgId) => cloud.links(orgId),
    profile: (pid) => {
      const r = find(pid);
      return { id: r.id, name: r.name, state: r.state, workspace_id: r.workspace_id };
    },
    create: (name, wsId) => {
      const r = addProfile(name, null, wsId ?? requireWs());
      changed();
      return view(r);
    },
    emit: (p) => emit('sync', p),
    changed: () => changed(),
    teamPhase: (pid) => teamHooks?.phase(pid) ?? null,
  });
  syncHooks = sync;
  const team = demoTeam({
    mode,
    cloud: cloud.team,
    linkOf: (pid) => cloud.sync.linkOf(pid),
    isOpen: (pid) => {
      const r = recs.find((x) => x.id === pid);
      return !!r && isOpen(r);
    },
    stop: (pid) => {
      void backend.profiles.stop(pid).catch(() => undefined);
    },
    closingBackup: (pid) => sync.closingBackup(pid),
    createCopy: (name) => {
      const r = addProfile(name, null, requireWs());
      changed();
      return view(r);
    },
    emit: (p) => emit('team', p),
    changed: () => changed(),
  });
  teamHooks = team;
  linkHook = (pid) => !!cloud.sync.linkOf(pid);
  if (mode.includes('linked')) {
    const first = recs.find((r) => !r.trashed_at && !r.archived_at);
    const target = cloud.sync.firstProfile();
    if (first && target) {
      cloud.sync.link(first.id, target.orgId, target.profileId);
      sync.seed(
        first.id,
        mode.includes('conflict') ? 0 : cloud.sync.head(target.orgId, target.profileId).version,
      );
    }
  }

  const agencyCtx = {
    mode,
    profiles: () => recs.filter((r) => inWs(r)).map(view),
    clients: () => clients.filter((c) => c.workspace_id === activeWs()),
    setting: (key: string) => settings[key]?.value,
    proxies: () =>
      proxies
        .filter((p) => p.workspace_id === activeWs())
        .map((p) => ({
          name: p.name,
          last_check:
            checks
              .filter((c) => c.proxy_id === p.id)
              .sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0] ?? null,
        })),
    runtimeInstalled: () => runtimeInstalled,
    linkOf: (pid: string) => cloud.sync.linkOf(pid),
    policy: (orgId: string) => cloud.sync.extensionPolicy(orgId),
    signedIn: () => cloud.sync.signedIn(),
    resolve: (sel: Selection) => resolve(sel).ids,
    emit: (w: EventPayload<'warning'>) => emit('warning', w),
  };
  const agency = demoAgency(agencyCtx);
  announceDemoExtensionUpdate(agencyCtx);

  const backend = {
    kind: 'demo',
    agency,
    automation: cloud.automation,
    billing: cloud.billing,
    account: cloud,
    sync,
    team,
    workspaces: {
      async appState(): Promise<AppView> {
        return {
          app: { version: '0.10.0-demo', platform: 'demo', arch: 'demo' },
          store: storeFailed
            ? {
                status: 'failed',
                failure: { code: 'MIGRATION_FAILED', from_version: 3, to_version: 4, backup_available: true },
              }
            : { status: 'ready' },
          first_run: !storeFailed && workspaces.length === 0,
          workspaces: [...workspaces],
          active_workspace_id: activeWs(),
          settings: Object.values(settings),
          recovery: {
            previous_session_crashed: crashed,
            crash_reports: crashed ? 1 : 0,
            adopted_profiles: mode === 'running' ? 1 : 0,
            cleared_stale_processes: 0,
            interrupted_profiles: 0,
            interrupted_installs: 0,
          },
          keychain: { available: true, reason: null },
          running_count: running(),
        };
      },
      async createWorkspace(name: string) {
        requireStore();
        const ws: Workspace = {
          id: id('wsp'),
          name: clean(
            name,
            80,
            err('INVALID_WORKSPACE_NAME', 'Workspace names must be 1-80 visible characters.'),
          ),
          kind: 'local',
          created_at: now(),
        };
        workspaces.push(ws);
        if (!activeWs())
          settings['workspace.active'] = { ...(settings['workspace.active'] as SettingValue), value: ws.id };
        return ws;
      },
      async setActiveWorkspace(wsId: string) {
        if (!workspaces.some((w) => w.id === wsId))
          throw err('UNKNOWN_WORKSPACE', 'That workspace does not exist on this device.');
        settings['workspace.active'] = { ...(settings['workspace.active'] as SettingValue), value: wsId };
      },
    },
    profiles: {
      async query(q: {
        filter?: ProfileFilter;
        sort?: Sort;
        cursor?: string;
        offset?: number;
        limit?: number;
      }) {
        requireStore();
        if (!activeWs()) return { rows: [], total: 0, next_cursor: null };
        const filter = q.filter ?? {};
        validateFilter(filter);
        const sort = q.sort ?? { key: 'name', descending: false };
        const print = fingerprint(filter, sort);
        let offset = Math.min(q.offset ?? 0, MAX_BULK);
        if (q.cursor) {
          const [o, f] = q.cursor.split('.');
          if (f !== print || !o || !/^\d+$/.test(o)) throw E.CURSOR_STALE;
          offset = Number(o);
        }
        const limit = Math.min(500, Math.max(1, q.limit ?? 200));
        const all = queryAll(filter, sort);
        const rows = all.slice(offset, offset + limit).map(view);
        const next = offset + rows.length;
        return { rows, total: all.length, next_cursor: next < all.length ? `${next}.${print}` : null };
      },
      async create(name: string, client?: string, templateId?: string) {
        const ws = requireWs();
        const n = clean(name, 120, E.INVALID_LABEL);
        const c = client?.trim() ? clean(client, 120, E.INVALID_LABEL) : null;
        const t = templateId ? templates.find((x) => x.id === templateId && x.workspace_id === ws) : null;
        if (templateId && !t) throw E.UNKNOWN_TEMPLATE;
        const r = addProfile(n, c, ws);
        if (t)
          set(r.id, {
            start_urls: [...t.config.start_urls],
            permissions: {
              camera: t.config.camera,
              microphone: t.config.microphone,
              location: t.config.location,
            },
            notes: t.config.notes,
            tag_ids: t.config.tags.map((x) => ensureTag(ws, x).id),
            template_id: t.id,
          });
        changed();
        return view(find(r.id));
      },
      async update(pid: string, c: ProfileUpdate) {
        const ws = requireWs();
        const p = find(pid);
        teamHooks?.guardEdit(pid, !!(c.startUrls || c.camera || c.microphone || c.location || c.privacy));
        if (p.workspace_id !== ws) throw E.UNKNOWN_PROFILE;
        if (p.version !== c.expectedVersion) {
          throw {
            ...err('VERSION_CONFLICT', 'This was changed elsewhere. Reload and try again.'),
            current_version: p.version,
          };
        }
        if (p.trashed_at) throw E.PROFILE_IN_TRASH;
        const notes = c.notes !== undefined ? cleanNotes(c.notes) : p.notes;
        if (c.startUrls && (c.startUrls.length > 10 || !c.startUrls.every(validUrl)))
          throw err('BAD_START_URL', 'Start address must begin with http:// or https://.');
        if (c.clientId && !clients.some((x) => x.id === c.clientId && x.workspace_id === ws))
          throw E.UNKNOWN_CLIENT;
        if (c.tags && c.tags.length > 20) throw E.INVALID_TAG;
        const privacy = c.privacy ? checkPrivacy(c.privacy) : p.privacy;
        const tagIds = c.tags?.map((t) => ensureTag(ws, t).id);
        set(pid, {
          name: c.name !== undefined ? clean(c.name, 120, E.INVALID_LABEL) : p.name,
          client_id: c.clearClient ? null : (c.clientId ?? p.client_id),
          favourite: c.favourite ?? p.favourite,
          tag_ids: tagIds ? [...new Set(tagIds)] : p.tag_ids,
          start_urls: c.startUrls ?? p.start_urls,
          download_dir: c.clearDownloadDir ? null : p.download_dir,
          permissions: {
            camera: c.camera ?? p.permissions.camera,
            microphone: c.microphone ?? p.permissions.microphone,
            location: c.location ?? p.permissions.location,
          },
          notes,
          privacy,
          version: p.version + 1,
          updated_at: now(),
        });
        changed();
        return view(find(pid));
      },
      async duplicate(pid: string, name: string) {
        const ws = requireWs();
        const src = find(pid);
        if (src.workspace_id !== ws) throw E.UNKNOWN_PROFILE;
        const r = addProfile(clean(name, 120, E.INVALID_LABEL), null, ws, {
          client_id: src.client_id,
          start_urls: [...src.start_urls],
          permissions: { ...src.permissions },
          tag_ids: [...src.tag_ids],
          template_id: src.template_id,
          proxy_id: src.proxy_id,
          fail_closed: src.fail_closed,
          privacy: { ...src.privacy },
        });
        changed();
        return view(r);
      },
      async bulk(action: BulkAction, selection: Selection): Promise<BulkResult> {
        const ws = requireWs();
        const { ids, missing } = resolve(selection);
        let tagId: string | null = null;
        if (action.action === 'add_tag') {
          if (action.tag_id) {
            if (!tags.some((t) => t.id === action.tag_id && t.workspace_id === ws)) throw E.UNKNOWN_TAG;
            tagId = action.tag_id;
          } else if (action.tag_name) tagId = ensureTag(ws, action.tag_name).id;
          else throw E.INVALID_TAG;
        }
        if (
          action.action === 'remove_tag' &&
          !tags.some((t) => t.id === action.tag_id && t.workspace_id === ws)
        )
          throw E.UNKNOWN_TAG;
        if (
          action.action === 'move' &&
          action.client_id &&
          !clients.some((c) => c.id === action.client_id && c.workspace_id === ws)
        )
          throw E.UNKNOWN_CLIENT;
        if (
          action.action === 'set_proxy' &&
          action.proxy_id &&
          !proxies.some((x) => x.id === action.proxy_id && x.workspace_id === ws)
        )
          throw E.UNKNOWN_PROXY;
        const failed = missing.map((m) => failure(m, E.UNKNOWN_PROFILE));
        const items: UndoEntry['items'] = [];
        let unchanged = 0;
        for (let i = 0; i < ids.length; i += BATCH) {
          for (const pid of ids.slice(i, i + BATCH)) {
            const r = find(pid);
            if (action.action === 'trash' && isOpen(r)) {
              failed.push(failure(pid, E.PROFILE_RUNNING));
              continue;
            }
            if (action.action === 'trash' && r.state === 'recovering') {
              failed.push(failure(pid, E.PROFILE_BUSY));
              continue;
            }
            const prior = applyOne(r, action, tagId);
            if (!prior) {
              unchanged++;
              continue;
            }
            set(pid, { ...patchFor(action, r, tagId), version: r.version + 1, updated_at: now() });
            items.push({ id: pid, prior, version: r.version + 1 });
          }
        }
        let token: string | null = null;
        if (items.length) {
          token = hex(32);
          undo.push({
            token,
            workspace: ws,
            restore: action.action === 'restore',
            items,
            created: Date.now(),
          });
          if (undo.length > 20) undo.shift();
        }
        changed();
        return {
          action: action.action,
          requested: ids.length + missing.length,
          changed: items.length,
          unchanged,
          failed,
          undo_token: token,
        };
      },
      async undo(token: string) {
        const ws = requireWs();
        const i = undo.findIndex((u) => u.token === token && Date.now() - u.created < 600_000);
        const entry = undo[i];
        if (!entry || entry.workspace !== ws) throw E.UNDO_EXPIRED;
        undo.splice(i, 1);
        let restored = 0;
        let skipped = 0;
        for (const it of entry.items) {
          const r = recs.find((x) => x.id === it.id);
          // Only profiles nobody changed since the action are put back; undoing a restore never trashes open ones.
          if (!r || r.version !== it.version || (entry.restore && isOpen(r))) {
            skipped++;
            continue;
          }
          set(it.id, { ...it.prior, version: r.version + 1, updated_at: now() });
          restored++;
        }
        changed();
        return { restored, skipped };
      },
      async deletePermanently(selection: Selection, count: number) {
        requireWs();
        const { ids, missing } = resolve(selection);
        if (ids.length + missing.length !== count) throw E.DELETE_CONFIRMATION;
        const failed = missing.map((m) => failure(m, E.UNKNOWN_PROFILE));
        let deleted = 0;
        for (const pid of ids) {
          const r = find(pid);
          if (!r.trashed_at) failed.push(failure(pid, E.NOT_IN_TRASH));
          else if (isOpen(r)) failed.push(failure(pid, E.PROFILE_RUNNING));
          else if (r.state === 'recovering') failed.push(failure(pid, E.PROFILE_BUSY));
          else {
            recs.splice(recs.indexOf(r), 1);
            backups.delete(pid);
            deleted++;
          }
        }
        changed();
        return {
          action: 'delete',
          requested: count,
          changed: deleted,
          unchanged: 0,
          failed,
          undo_token: null,
        };
      },
      async launch(pid: string) {
        const p = find(pid);
        if (p.trashed_at) throw E.PROFILE_IN_TRASH;
        if (syncHooks?.restoring(pid))
          throw err(
            'PROFILE_RESTORING',
            'This profile is being restored from a backup. It opens when the restore is finished.',
          );
        if (p.state === 'starting' || p.state === 'running') {
          const existing = launchOps.get(pid);
          if (existing) return { operation_id: existing.operation_id };
          const op = startOp('launch_profile', pid);
          finish(op, { status: 'succeeded', progress: 1 });
          return { operation_id: op.operation_id };
        }
        if (p.state === 'stopping')
          throw err('PROFILE_STOPPING', 'This profile is still closing. Try again when it has closed.');
        if (p.state === 'recovering') throw E.PROFILE_BUSY;
        if (!runtimeInstalled)
          throw err(
            'RUNTIME_NOT_INSTALLED',
            'The browser is not installed yet. Install it from Downloads and updates.',
          );
        const px = proxies.find((x) => x.id === p.proxy_id);
        if (px?.login_missing) throw E.PROXY_CREDENTIALS_MISSING;
        if (px && addressClass(px.host) === 'private' && !settings['proxies.allow_private_addresses']?.value)
          throw E.PROXY_PRIVATE_ADDRESS;
        // Milestone 08: an organization profile opens only with its session lease.
        const refused = teamHooks?.open(pid) ?? null;
        if (refused) {
          const op = startOp('launch_profile', pid);
          setTimeout(
            () => finish(op, { status: 'failed', error_code: refused.code, message: refused.message }),
            250,
          );
          return { operation_id: op.operation_id };
        }
        const op = startOp('launch_profile', pid);
        launchOps.set(pid, op);
        set(pid, {
          state: 'starting',
          last_error: null,
          last_started_at: now(),
          pid: 5000 + opSeq,
          launched_key: netKey(p),
        });
        if (px?.down)
          setTimeout(
            () =>
              emit(
                'warning',
                p.fail_closed
                  ? { code: 'PROXY_FAILING', profile_id: pid, error: 'PROXY_UNREACHABLE', fail_closed: true }
                  : { code: 'PROXY_BYPASSED', profile_id: pid, direct_connections: 3 },
              ),
            900,
          );
        changed();
        setTimeout(() => {
          set(pid, { state: 'running', ready: true, window_open: true, runtime_version: RUNTIME_VERSION });
          launchOps.delete(pid);
          teamHooks?.opened(pid);
          finish(op, { status: 'succeeded', progress: 1 });
        }, 700);
        return { operation_id: op.operation_id };
      },
      async stop(pid: string, force?: boolean) {
        const p = find(pid);
        if (!isOpen(p)) throw err('NOT_RUNNING', 'This profile is not open.');
        const op = startOp('stop_profile', pid);
        if (force) {
          setTimeout(() => {
            stopNow(pid, 'forced');
            finish(op, { status: 'succeeded', progress: 1 });
          }, 300);
          return { operation_id: op.operation_id };
        }
        set(pid, { state: 'stopping' });
        changed();
        setTimeout(() => {
          if (mode === 'stuck') {
            set(pid, { force_available: true });
            finish(op, {
              status: 'failed',
              error_code: 'STOP_TIMED_OUT',
              message: 'The profile is not responding. You can force it to close.',
            });
            return;
          }
          stopNow(pid, 'clean');
          finish(op, { status: 'succeeded', progress: 1 });
        }, 500);
        return { operation_id: op.operation_id };
      },
      async closeAll(force?: boolean) {
        const op = startOp('close_all', null);
        setTimeout(() => {
          for (const p of recs) {
            if (!isOpen(p)) continue;
            if (mode === 'stuck' && !force) set(p.id, { state: 'stopping', force_available: true });
            else stopNow(p.id, force ? 'forced' : 'clean');
          }
          finish(
            op,
            running() > 0
              ? {
                  status: 'failed',
                  error_code: 'STOP_TIMED_OUT',
                  message: 'Some profiles are not responding. You can force them to close.',
                }
              : { status: 'succeeded', progress: 1 },
          );
        }, 500);
        return { operation_id: op.operation_id };
      },
      async status(pid: string): Promise<ProfileStatus> {
        const p = find(pid);
        const backup = backups.get(pid);
        const ended = p.state === 'stopped' || p.state === 'crashed';
        return {
          profile: view(p),
          runs:
            p.last_started_at || p.state === 'crashed'
              ? [
                  {
                    run_id: `run_${'0'.repeat(24)}`,
                    profile_id: p.id,
                    pid: p.pid ?? 4242,
                    identity: { start_time: 1_760_000_000, exe: 'chrome' },
                    runtime_version: RUNTIME_VERSION,
                    exit_code: p.state === 'crashed' ? -11 : null,
                    outcome: p.state === 'crashed' ? 'crashed' : ended ? 'clean' : 'running',
                    started_at: p.last_started_at ?? now(),
                    ended_at: ended ? now() : null,
                  },
                ]
              : [],
          backup: backup
            ? {
                created_at_unix: backup.created_at_unix,
                runtime_version: RUNTIME_VERSION,
                bytes: 48_000_000,
                files: backup.files,
              }
            : null,
          evidence_count: 0,
          suggested_recovery:
            p.state === 'crashed' ? (backup && p.crash_count >= 3 ? 'restore_backup' : 'reopen') : null,
        };
      },
      async recover(
        pid: string,
        action: 'reopen' | 'restore_backup' | 'start_fresh' | 'backup_now',
      ): Promise<{ operation_id: string }> {
        const p = find(pid);
        if (action === 'reopen') return backend.profiles.launch(pid);
        if (p.state !== 'stopped' && p.state !== 'crashed')
          throw err('NOT_RECOVERABLE', 'Close the profile before recovering it.');
        if (action === 'restore_backup' && !backups.has(pid))
          throw err('NO_BACKUP', 'There is no backup of this profile yet.');
        const op = startOp(action === 'backup_now' ? 'backup_profile' : 'recover_profile', pid);
        if (action !== 'backup_now') set(pid, { state: 'recovering' });
        changed();
        setTimeout(() => {
          if (action === 'backup_now') {
            backups.set(pid, { created_at_unix: Math.floor(Date.now() / 1000), files: 412 });
            set(pid, { last_backup_at: now() });
          } else {
            set(pid, { state: 'stopped', last_error: null, crash_count: 0 });
          }
          finish(op, { status: 'succeeded', progress: 1 });
        }, 600);
        return { operation_id: op.operation_id };
      },
      async selectDownloadDirectory(pid: string) {
        const p = find(pid);
        const path = `/Users/demo/Downloads/${p.name}`;
        set(pid, { download_dir: path, version: p.version + 1 });
        return { path };
      },
    },
    library: {
      async library() {
        return libraryOf(requireWs());
      },
      async createClient(name: string, colour?: string) {
        const ws = requireWs();
        const n = clean(name, 120, E.INVALID_LABEL);
        if (colour !== undefined && !/^#[0-9a-f]{6}$/.test(colour))
          throw err('INVALID_COLOUR', 'Colour must look like #7c3aed.');
        if (clients.some((c) => c.workspace_id === ws && nameKey(c.name) === nameKey(n)))
          throw E.DUPLICATE_NAME;
        const c = ensureClient(ws, n);
        c.colour = colour ?? null;
        return { ...c };
      },
      async updateClient(
        cid: string,
        expectedVersion: number,
        ch: { name?: string; colour?: string; clearColour?: boolean; archived?: boolean },
      ) {
        const ws = requireWs();
        const c = clients.find((x) => x.id === cid && x.workspace_id === ws);
        if (!c) throw E.UNKNOWN_CLIENT;
        if (c.version !== expectedVersion)
          throw {
            ...err('VERSION_CONFLICT', 'This was changed elsewhere. Reload and try again.'),
            current_version: c.version,
          };
        if (ch.colour !== undefined && !/^#[0-9a-f]{6}$/.test(ch.colour))
          throw err('INVALID_COLOUR', 'Colour must look like #7c3aed.');
        if (ch.name !== undefined) {
          const n = clean(ch.name, 120, E.INVALID_LABEL);
          if (clients.some((x) => x !== c && x.workspace_id === ws && nameKey(x.name) === nameKey(n)))
            throw E.DUPLICATE_NAME;
          c.name = n;
        }
        if (ch.clearColour) c.colour = null;
        else if (ch.colour !== undefined) c.colour = ch.colour;
        if (ch.archived !== undefined) c.archived_at = ch.archived ? now() : null;
        c.version++;
        changed();
        return { ...c };
      },
      async createTag(name: string): Promise<TagRef> {
        const t = ensureTag(requireWs(), name);
        return { id: t.id, name: t.name };
      },
      async renameTag(tid: string, name: string) {
        const ws = requireWs();
        const t = tags.find((x) => x.id === tid && x.workspace_id === ws);
        if (!t) throw E.UNKNOWN_TAG;
        const n = clean(name, 40, E.INVALID_TAG);
        if (tags.some((x) => x !== t && x.workspace_id === ws && nameKey(x.name) === nameKey(n)))
          throw E.DUPLICATE_NAME;
        t.name = n;
        changed();
      },
      async deleteTag(tid: string) {
        const ws = requireWs();
        const i = tags.findIndex((x) => x.id === tid && x.workspace_id === ws);
        if (i < 0) throw E.UNKNOWN_TAG;
        tags.splice(i, 1);
        for (const r of recs) r.tag_ids = r.tag_ids.filter((t) => t !== tid);
        changed();
      },
      async saveFilter(name: string, filter: ProfileFilter, sort: Sort) {
        const ws = requireWs();
        validateFilter(filter);
        const f: FilterRec = {
          id: id('flt'),
          workspace_id: ws,
          name: clean(name, 60, E.INVALID_LABEL),
          filter: { filter, sort },
          created_at: now(),
        };
        if (filters.filter((x) => x.workspace_id === ws).length >= 200) throw E.INVALID_FILTER;
        filters.push(f);
        const { workspace_id: _w, ...out } = f;
        return out;
      },
      async deleteFilter(fid: string) {
        const ws = requireWs();
        const i = filters.findIndex((f) => f.id === fid && f.workspace_id === ws);
        if (i < 0) throw E.INVALID_FILTER;
        filters.splice(i, 1);
      },
      async saveTemplate(pid: string, name: string) {
        const ws = requireWs();
        const p = find(pid);
        if (p.workspace_id !== ws) throw E.UNKNOWN_PROFILE;
        const n = clean(name, 120, E.INVALID_LABEL);
        if (templates.some((t) => t.workspace_id === ws && nameKey(t.name) === nameKey(n)))
          throw E.DUPLICATE_NAME;
        const t: TemplateRec = {
          id: id('tpl'),
          workspace_id: ws,
          name: n,
          schema_version: 1,
          config: {
            start_urls: [...p.start_urls],
            camera: p.permissions.camera,
            microphone: p.permissions.microphone,
            location: p.permissions.location,
            tags: view(p).tags.map((x) => x.name),
            notes: '',
          },
          version: 1,
          updated_at: now(),
        };
        templates.push(t);
        const { workspace_id: _w, ...out } = t;
        return out;
      },
      async deleteTemplate(tid: string) {
        const ws = requireWs();
        const i = templates.findIndex((t) => t.id === tid && t.workspace_id === ws);
        if (i < 0) throw E.UNKNOWN_TEMPLATE;
        templates.splice(i, 1);
      },
    },
    transfer: {
      async chooseFile() {
        requireWs();
        const ref = hex(32);
        const f =
          mode === 'bigimport'
            ? { name: 'all-profiles.csv', rows: bigRows(), size: 420_000 }
            : mode === 'unsafeimport'
              ? { name: 'shared-export.zip', rows: null, size: 2_048 }
              : { name: 'agency-profiles.csv', rows: SAMPLE_ROWS, size: 1_870 };
        files.set(ref, f);
        return { file_ref: ref, name: f.name, size: f.size };
      },
      async preview(fileRef: string, s: ImportSettings): Promise<ImportPreview> {
        const ws = requireWs();
        const f = files.get(fileRef);
        if (!f) throw E.UNKNOWN_FILE;
        const empty: ImportPreview = {
          preview_id: null,
          file_name: f.name,
          format: null,
          schema_version: null,
          file_error: null,
          total: 0,
          valid: 0,
          invalid: 0,
          will_create: 0,
          will_update: 0,
          will_skip: 0,
          already_imported: 0,
          with_warnings: 0,
          new_clients: [],
          new_tags: [],
          rows: [],
          rows_truncated: false,
          errors: [],
        };
        if (!f.rows)
          return {
            ...empty,
            file_error: {
              code: 'UNSAFE_ARCHIVE',
              message: 'unsafe archive: entry "../../startup/run.sh" points outside the archive',
            },
          };
        const settingsUsed: ImportSettings = {
          duplicates: s.duplicates ?? 'skip',
          default_client: s.default_client?.trim() ? clean(s.default_client, 120, E.INVALID_LABEL) : null,
        };
        const digest = digestOf(f.name, f.rows);
        const p = plan(ws, f.rows, digest, settingsUsed);
        const count = (st: Planned['status']) => p.rows.filter((r) => r.status === st).length;
        const job: ImportJob & { workspace_id: string } = {
          id: id('imp'),
          workspace_id: ws,
          status: 'previewed',
          source_name: f.name,
          source_digest: digest,
          format: 'csv',
          settings: settingsUsed,
          total: p.rows.length,
          succeeded: 0,
          failed: 0,
          skipped: 0,
          errors: [],
          created_at: now(),
          started_at: null,
          finished_at: null,
        };
        jobs.unshift(job);
        previews.set(job.id, { ws, fileRef, digest, settings: settingsUsed, applied: new Set() });
        return {
          ...empty,
          preview_id: job.id,
          format: 'csv',
          schema_version: 1,
          total: p.rows.length,
          invalid: count('error'),
          valid: p.rows.length - count('error'),
          will_create: count('create'),
          will_update: count('update'),
          will_skip: count('skip_duplicate'),
          already_imported: count('already_imported'),
          with_warnings: p.rows.filter((r) => r.status !== 'error' && r.warnings.length).length,
          new_clients: p.newClients.slice(0, 50),
          new_tags: p.newTags.slice(0, 50),
          rows: p.rows.slice(0, 500).map((r) => ({
            row: r.row,
            status: r.status,
            name: r.name,
            client: r.client,
            tags: r.tags,
            warnings: r.warnings,
            errors: r.errors,
          })),
          rows_truncated: p.rows.length > 500,
          errors: rowErrors(p.rows),
        };
      },
      async commit(previewId: string) {
        const ws = requireWs();
        const st = previews.get(previewId);
        const job = jobs.find((j) => j.id === previewId);
        if (!st || !job || st.ws !== ws) throw E.UNKNOWN_IMPORT;
        const f = files.get(st.fileRef);
        if (!f?.rows) throw E.UNKNOWN_FILE;
        if (digestOf(f.name, f.rows) !== st.digest)
          throw err(
            'SOURCE_CHANGED',
            'The file changed after the preview. Preview it again before importing.',
          );
        if (importsRunning.size) throw E.IMPORT_IN_PROGRESS;
        const flag = { cancel: false };
        importsRunning.set(job.id, flag);
        Object.assign(job, { status: 'running', started_at: now(), finished_at: null });
        const op = startOp('import_profiles', job.id);
        const p = plan(ws, f.rows, st.digest, st.settings);
        let [ok, failed, skipped] = [0, p.rows.filter((r) => r.status === 'error').length, 0];
        const errors = rowErrors(p.rows);
        let i = 0;
        const step = () => {
          if (flag.cancel) return done(true);
          for (const r of p.rows.slice(i, i + BATCH)) {
            if (r.status === 'skip_duplicate' || r.status === 'already_imported') skipped++;
            if (r.status === 'create') {
              const rec = addProfile(r.name, r.client, ws, {
                notes: r.notes,
                favourite: r.favourite,
                start_urls: r.start_urls,
                import_ref: `${st.digest.slice(0, 16)}:${r.row}`,
              });
              rec.tag_ids = [...new Set(r.tags.map((t) => ensureTag(ws, t).id))];
              ok++;
            }
            if (r.status === 'update' && r.update) {
              if (st.applied.has(r.row)) {
                skipped++;
                continue;
              }
              const rec = recs.find((x) => x.id === r.update?.id);
              if (!rec) continue;
              rec.tag_ids = [...new Set([...rec.tag_ids, ...r.tags.map((t) => ensureTag(ws, t).id)])];
              if (r.notes) rec.notes = r.notes;
              rec.version++;
              st.applied.add(r.row);
              ok++;
            }
          }
          i += BATCH;
          Object.assign(job, { succeeded: ok, failed, skipped });
          Object.assign(op, { progress: Math.min(1, i / Math.max(1, p.rows.length)) });
          emit('operation', { ...op });
          if (i >= p.rows.length) return done(false);
          setTimeout(step, 40);
        };
        const done = (cancelled: boolean) => {
          importsRunning.delete(job.id);
          Object.assign(job, {
            status: cancelled ? 'cancelled' : failed ? 'completed_with_errors' : 'completed',
            succeeded: ok,
            failed,
            skipped,
            errors,
            finished_at: now(),
          });
          finish(
            op,
            cancelled
              ? {
                  status: 'failed',
                  error_code: 'IMPORT_CANCELLED',
                  message:
                    'Import cancelled. Rows already imported were kept; running the same file again continues safely.',
                }
              : { status: 'succeeded', progress: 1 },
          );
        };
        setTimeout(step, 40);
        return { operation_id: op.operation_id };
      },
      async cancel(jobId: string) {
        const flag = importsRunning.get(jobId);
        if (!flag) throw E.UNKNOWN_IMPORT;
        flag.cancel = true;
      },
      async jobs() {
        const ws = requireWs();
        return jobs
          .filter((j) => j.workspace_id === ws && j.status !== 'previewed')
          .slice(0, 50)
          .map(({ workspace_id: _w, ...j }) => j);
      },
      async export(selection: Selection, format: 'csv' | 'json' | 'bundle', includeNotes: boolean) {
        const { ids } = resolve(selection);
        const withheld = includeNotes ? ids.filter((i) => secretHint(find(i).notes)).length : 0;
        const ext = format === 'bundle' ? 'zip' : format;
        return {
          path: `/Users/demo/Downloads/profiles-${now().slice(0, 10)}.${ext}`,
          exported: ids.length,
          notes_withheld: withheld,
        };
      },
    },
    network: {
      async proxies() {
        const ws = requireWs();
        return proxies
          .filter((x) => x.workspace_id === ws)
          .sort((a, b) => nameKey(a.name).localeCompare(nameKey(b.name)))
          .map(proxyView);
      },
      async createProxy(input: ProxyInput) {
        const ws = requireWs();
        const name = clean(input.name, 80, E.INVALID_PROXY_NAME);
        if (!['http', 'https', 'socks5'].includes(input.type)) throw E.INVALID_PROXY_TYPE;
        const host = checkHost(input.host);
        if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw E.PROXY_BAD_PORT;
        const login = checkLogin(input.type, input.login);
        checkDate(input.expires_at);
        const notes = proxyNotes(input.notes);
        if (proxies.some((x) => x.workspace_id === ws && nameKey(x.name) === nameKey(name)))
          throw E.DUPLICATE_NAME;
        const x: ProxyRec = {
          id: id('prx'),
          workspace_id: ws,
          name,
          type: input.type,
          host,
          port: input.port,
          login,
          login_missing: false,
          expires_at: input.expires_at ?? null,
          notes,
          version: 1,
          created_at: now(),
          updated_at: now(),
          down: false,
        };
        proxies.push(x);
        return proxyView(x);
      },
      async updateProxy(pid: string, expectedVersion: number, c: ProxyEdit) {
        const x = ownProxy(pid);
        if (x.version !== expectedVersion)
          throw {
            ...err('VERSION_CONFLICT', 'This was changed elsewhere. Reload and try again.'),
            current_version: x.version,
          };
        if (c.login && c.remove_login) throw err('INVALID_ARGUMENT', 'The request was not valid.');
        const type = c.type ?? x.type;
        if (!['http', 'https', 'socks5'].includes(type)) throw E.INVALID_PROXY_TYPE;
        const name = c.name !== undefined ? clean(c.name, 80, E.INVALID_PROXY_NAME) : x.name;
        if (
          proxies.some(
            (o) => o.id !== x.id && o.workspace_id === x.workspace_id && nameKey(o.name) === nameKey(name),
          )
        )
          throw E.DUPLICATE_NAME;
        const host = checkHost(c.host ?? x.host);
        const port = c.port ?? x.port;
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw E.PROXY_BAD_PORT;
        const login = c.login ? checkLogin(type, c.login) : c.remove_login ? null : x.login;
        if (!c.login && login) checkLogin(type, login);
        checkDate(c.expires_at);
        const notes = c.notes !== undefined ? proxyNotes(c.notes) : x.notes;
        Object.assign(x, {
          name,
          type,
          host,
          port,
          login,
          login_missing: c.login ? false : c.remove_login ? false : x.login_missing,
          expires_at: c.clear_expiry ? null : (c.expires_at ?? x.expires_at),
          notes,
          version: x.version + 1,
          updated_at: now(),
        });
        changed();
        return proxyView(x);
      },
      async deleteProxy(pid: string) {
        const x = ownProxy(pid);
        if (recs.some((r) => r.proxy_id === x.id)) throw E.PROXY_IN_USE;
        proxies.splice(proxies.indexOf(x), 1);
        for (let i = checks.length - 1; i >= 0; i--) if (checks[i]?.proxy_id === pid) checks.splice(i, 1);
      },
      async testProxy(pid: string) {
        const x = ownProxy(pid);
        await new Promise((r) => setTimeout(r, 400));
        const error = x.login_missing
          ? 'PROXY_CREDENTIALS_MISSING'
          : x.down
            ? 'PROXY_UNREACHABLE'
            : addressClass(x.host) === 'private' && !allowPrivate()
              ? 'PROXY_PRIVATE_ADDRESS'
              : null;
        const c: NetworkCheck = {
          id: id('nck'),
          proxy_id: x.id,
          result: error ? 'error' : 'ok',
          error_code: error,
          latency_ms: error ? null : 120 + Math.floor(Math.random() * 180),
          egress_ip: error ? null : x.type === 'socks5' ? '203.0.113.40' : '198.51.100.23',
          checked_at: now(),
        };
        checks.unshift(c);
        return c;
      },
      async checks(pid: string) {
        ownProxy(pid);
        return checks.filter((c) => c.proxy_id === pid).slice(0, 50);
      },
      async assign(profileId: string, proxyId: string | null, failClosed: boolean, expectedVersion: number) {
        const ws = requireWs();
        const p = find(profileId);
        if (p.workspace_id !== ws) throw E.UNKNOWN_PROFILE;
        if (p.trashed_at) throw E.PROFILE_IN_TRASH;
        if (proxyId) ownProxy(proxyId);
        if (p.version !== expectedVersion)
          throw {
            ...err('VERSION_CONFLICT', 'This was changed elsewhere. Reload and try again.'),
            current_version: p.version,
          };
        set(profileId, {
          proxy_id: proxyId,
          fail_closed: failClosed,
          version: p.version + 1,
          updated_at: now(),
        });
        changed();
        return view(find(profileId));
      },
      async validatePrivacy(config: PrivacyConfig, failClosedProxy: boolean): Promise<PrivacyValidation> {
        try {
          const full = checkPrivacy(config);
          return { valid: true, error: null, platform, report: report(full, failClosedProxy) };
        } catch (e) {
          return {
            valid: false,
            error: e as IpcError,
            platform,
            report: report({ ...DEFAULT_PRIVACY, ...config }, failClosedProxy),
          };
        }
      },
      async privacyOptions() {
        return {
          platform,
          languages: LANGUAGES.map(([tag, name]) => ({ tag, name })),
          time_zones: TIME_ZONES,
          window_min: [800, 600] as [number, number],
          window_max: [3840, 2160] as [number, number],
          presets: PRESETS,
        };
      },
    },
    system: {
      async runtimeStatus() {
        return runtimeStatus();
      },
      async installRuntime(version: string) {
        if (version !== RUNTIME_VERSION)
          throw err('RUNTIME_NOT_IN_MANIFEST', 'That browser version is not approved for this build.');
        if (installing) throw err('INSTALL_IN_PROGRESS', 'A browser install is already in progress.');
        installing = true;
        const op = startOp('install_runtime', version);
        let progress = 0;
        const timer = setInterval(() => {
          progress = Math.min(1, progress + 0.2);
          if (progress < 1) {
            Object.assign(op, { progress });
            emit('operation', { ...op });
            return;
          }
          clearInterval(timer);
          installing = false;
          runtimeInstalled = true;
          finish(op, { status: 'succeeded', progress: 1 });
        }, 250);
        return { operation_id: op.operation_id };
      },
      async updateSetting(key: string, value: unknown, expectedVersion?: number) {
        const s = settings[key];
        if (!s) throw err('UNKNOWN_SETTING', 'That setting does not exist.');
        if (!s.ui_settable)
          throw err('SETTING_READ_ONLY', 'That setting is changed through its own control.');
        if (ENUMS[key] && !ENUMS[key]?.includes(value))
          throw err('INVALID_SETTING_VALUE', 'That value is not allowed for this setting.');
        if (expectedVersion !== undefined && expectedVersion !== s.version) {
          throw {
            ...err('VERSION_CONFLICT', 'This was changed elsewhere. Reload and try again.'),
            current_version: s.version,
          };
        }
        const next = { ...s, value, version: s.version + 1 };
        settings[key] = next;
        return next;
      },
      async selectDownloadDirectory() {
        const path = '/Users/demo/Downloads';
        settings['downloads.directory'] = {
          ...(settings['downloads.directory'] as SettingValue),
          value: path,
          version: 1,
        };
        return { path };
      },
      async diagnostics() {
        return {
          app: { version: '0.10.0-demo', platform: 'demo', os: navigator.userAgent, arch: 'demo' },
          store: {
            status: storeFailed ? 'failed' : 'ready',
            schema_version: 9,
            journal_mode: 'wal',
            foreign_keys: true,
            integrity_ok: true,
          },
          keychain: { available: true, reason: null },
          runtime: { manifest_status: { status: 'verified', version: RUNTIME_VERSION }, platform: 'demo' },
          manager: { uptime_s: Math.round(performance.now() / 1000), rss_bytes: null, startup_ms: null },
          browsers: { running: running(), main_process_rss_bytes: 0 },
          crash_reports: crashed ? 1 : 0,
          recent_activity: [],
        };
      },
      async reportUiReady() {
        return performance.now();
      },
      async recovery(action: string) {
        if (action === 'dismiss_crash') crashed = false;
        if (action === 'restore_backup' || action === 'retry_open') storeFailed = false;
      },
      async resolveQuit(choice: string) {
        if (choice === 'close_all' || choice === 'force_close_all') {
          for (const p of recs) {
            if (isOpen(p)) stopNow(p.id, 'clean');
          }
          emit('profiles-changed', { running: 0 });
        }
      },
      async openExternal(url: string) {
        if (!/^https:\/\/github\.com\//.test(url))
          throw err('DISALLOWED_URL', 'Only https links to approved help sites can be opened.');
      },
      async removeLocalData(confirm: string) {
        if (confirm !== 'DELETE')
          throw err('CONFIRMATION_REQUIRED', 'Type DELETE to confirm removing all local data.');
        if (running() > 0) throw err('PROFILES_RUNNING', 'Close all open profiles before doing this.');
        for (const list of [recs, workspaces, clients, tags, templates, filters, jobs] as unknown[][])
          list.length = 0;
        settings['workspace.active'] = { ...(settings['workspace.active'] as SettingValue), value: null };
      },
    },
    on<E extends EventName>(event: E, handler: (payload: EventPayload<E>) => void) {
      const listenersFor = listeners.get(event) ?? new Set();
      listenersFor.add(handler as (p: unknown) => void);
      listeners.set(event, listenersFor);
      return () => listenersFor.delete(handler as (p: unknown) => void);
    },
    /** Demo-only: lets UI tests trigger the quit prompt like the tray/window close would. */
    simulateQuitRequest(unresponsive = 0) {
      emit('quit-requested', { running: running(), unresponsive });
    },
  } satisfies Backend & { simulateQuitRequest(unresponsive?: number): void };
  return backend;
}
