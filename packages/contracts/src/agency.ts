/**
 * Agency workspace (milestone 09, ADR-0016): client dashboards, app-owned tasks, shared bookmarks (start-page
 * templates) and the organization's browser extension policy. Browser-safe: no Node imports.
 *
 * A task records that someone in the app planned or ticked off work; completing it never means anything happened on a
 * website. A dashboard shows only what the caller may see: counts are over visible profiles only, so hidden profiles
 * of a client never show up, not even as a number.
 */
import Type, { type Static, type TSchema } from 'typebox';
import { ID_PATTERN } from './ids.ts';
import { sanitizeNotes } from './notes.ts';
import { Client, GRANT_CAPABILITIES, ProfileInUse, ROLES } from './resources.ts';

const Id = (prefix: Parameters<typeof ID_PATTERN>[0]) => Type.String({ pattern: ID_PATTERN(prefix) });
const Timestamp = Type.String({ format: 'date-time', description: 'UTC, RFC 3339' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const Version = Type.Integer({ minimum: 1 });

// ---------------------------------------------------------------- labels and links
/** Display labels: hidden control and bidi characters removed, whitespace collapsed (rendered as text only). */
export function cleanLabel(text: string): string {
  return sanitizeNotes(text).replace(/\s+/gu, ' ').trim();
}

export const BOOKMARK_URL_MAX = 2048;
/**
 * Why a bookmark URL is refused, or null. Only http and https; no user names or passwords in the address; no
 * whitespace or control characters. Executable or local schemes (javascript:, data:, file:, chrome:, …) never pass.
 */
export function bookmarkUrlProblem(url: string): string | null {
  if (url.length > BOOKMARK_URL_MAX) return 'too_long';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\s\u0000-\u001F\u007F]/u.test(url)) return 'whitespace';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return 'scheme';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'scheme';
  if (parsed.username || parsed.password || /^https?:\/\/[^/]*@/i.test(url)) return 'credentials';
  if (!parsed.hostname) return 'invalid';
  return null;
}

// ---------------------------------------------------------------- tasks
export const TASK_STATUSES = ['open', 'in_progress', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
const TaskTitle = Type.String({ minLength: 1, maxLength: 200 });
const TaskNotes = Type.String({ maxLength: 2000 });

export const ClientTask = Type.Object(
  {
    id: Id('tsk'),
    org_id: Id('org'),
    client_id: Id('cli'),
    profile_id: Nullable(Id('prf')),
    profile_name: Nullable(Type.String()),
    assignee_id: Nullable(Id('usr')),
    assignee_name: Nullable(Type.String()),
    title: TaskTitle,
    notes: TaskNotes,
    status: Type.Enum(TASK_STATUSES),
    due_at: Nullable(Timestamp),
    overdue: Type.Boolean(),
    created_by: Id('usr'),
    completed_by: Nullable(Id('usr')),
    completed_at: Nullable(Timestamp),
    version: Version,
    created_at: Timestamp,
    updated_at: Timestamp,
  },
  { additionalProperties: false },
);
export type ClientTask = Static<typeof ClientTask>;
export const TaskCreate = Type.Object(
  {
    title: TaskTitle,
    notes: Type.Optional(TaskNotes),
    profile_id: Type.Optional(Nullable(Id('prf'))),
    assignee_id: Type.Optional(Nullable(Id('usr'))),
    due_at: Type.Optional(Nullable(Timestamp)),
    status: Type.Optional(Type.Enum(TASK_STATUSES)),
  },
  { additionalProperties: false },
);
export const TaskUpdate = Type.Object(
  {
    expected_version: Type.Optional(Version),
    title: Type.Optional(TaskTitle),
    notes: Type.Optional(TaskNotes),
    profile_id: Type.Optional(Nullable(Id('prf'))),
    assignee_id: Type.Optional(Nullable(Id('usr'))),
    due_at: Type.Optional(Nullable(Timestamp)),
    status: Type.Optional(Type.Enum(TASK_STATUSES)),
  },
  { additionalProperties: false, minProperties: 1 },
);
export const TaskQuery = Type.Object(
  {
    status: Type.Optional(Type.Enum(['open', 'done', 'all'] as const)),
    cursor: Type.Optional(Type.String({ maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------- bookmarks (start-page templates)
const BookmarkTitle = Type.String({ minLength: 1, maxLength: 120 });
const BookmarkUrl = Type.String({ minLength: 8, maxLength: BOOKMARK_URL_MAX, pattern: '^https?://' });
export const Bookmark = Type.Object(
  {
    id: Id('bkm'),
    org_id: Id('org'),
    client_id: Id('cli'),
    title: BookmarkTitle,
    url: BookmarkUrl,
    position: Type.Integer({ minimum: 0, maximum: 999 }),
    version: Version,
    created_at: Timestamp,
    updated_at: Timestamp,
  },
  { additionalProperties: false },
);
export type Bookmark = Static<typeof Bookmark>;
export const BookmarkCreate = Type.Object(
  {
    title: BookmarkTitle,
    url: BookmarkUrl,
    position: Type.Optional(Type.Integer({ minimum: 0, maximum: 999 })),
  },
  { additionalProperties: false },
);
export const BookmarkUpdate = Type.Object(
  {
    expected_version: Type.Optional(Version),
    title: Type.Optional(BookmarkTitle),
    url: Type.Optional(BookmarkUrl),
    position: Type.Optional(Type.Integer({ minimum: 0, maximum: 999 })),
  },
  { additionalProperties: false, minProperties: 1 },
);
/** At most this many bookmarks per client (they double as start pages, of which a profile opens at most 10). */
export const BOOKMARKS_PER_CLIENT = 50;

// ---------------------------------------------------------------- client dashboard
export const DashboardProfile = Type.Object(
  {
    id: Id('prf'),
    name: Type.String(),
    in_use: Nullable(ProfileInUse),
    snapshot_version: Type.Integer({ minimum: 0 }),
    last_snapshot_at: Nullable(Timestamp),
    /** When someone last opened it in the app (a session lease), not website activity. */
    last_opened_at: Nullable(Timestamp),
  },
  { additionalProperties: false },
);
export const DashboardPerson = Type.Object(
  {
    user_id: Id('usr'),
    display_name: Type.String(),
    role: Type.Enum(ROLES),
    /** client: a grant on the whole client; profiles: grants on some of its profiles. Owners and admins work on every
     *  client and are not listed. */
    access: Type.Enum(['client', 'profiles'] as const),
    profiles: Type.Integer({ minimum: 0 }),
    capabilities: Type.Array(Type.Enum(GRANT_CAPABILITIES)),
  },
  { additionalProperties: false },
);
export const DashboardActivity = Type.Object(
  {
    id: Id('aud'),
    action: Type.String(),
    actor_name: Type.String(),
    target_type: Nullable(Type.String()),
    target_id: Nullable(Type.String()),
    target_name: Nullable(Type.String()),
    created_at: Timestamp,
  },
  { additionalProperties: false },
);
export const ClientDashboard = Type.Object(
  {
    client: Client,
    /** Counts over the profiles the caller can see; hidden profiles are never counted. */
    profiles: Type.Object(
      {
        total: Type.Integer({ minimum: 0 }),
        in_use: Type.Integer({ minimum: 0 }),
        never_backed_up: Type.Integer({ minimum: 0 }),
        /** Newest backup older than 7 days. */
        stale_backups: Type.Integer({ minimum: 0 }),
        items: Type.Array(DashboardProfile, { maxItems: 50 }),
        /** More profiles: GET /v1/orgs/{org}/profiles?client_id=… (paged). */
        more: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    /** Who works on this client (owners and admins see it; others get null). */
    people: Nullable(Type.Array(DashboardPerson)),
    tasks: Type.Object(
      {
        open: Type.Integer({ minimum: 0 }),
        overdue: Type.Integer({ minimum: 0 }),
        mine: Type.Integer({ minimum: 0 }),
        items: Type.Array(ClientTask, { maxItems: 20 }),
      },
      { additionalProperties: false },
    ),
    bookmarks: Type.Array(Bookmark, { maxItems: 50 }),
    /** Recent app activity on the client and its profiles (members who may read the audit log; others get null). */
    activity: Nullable(Type.Array(DashboardActivity, { maxItems: 20 })),
  },
  { additionalProperties: false },
);
export type ClientDashboard = Static<typeof ClientDashboard>;

// ---------------------------------------------------------------- browser extension policy
export const EXTENSION_MODES = ['off', 'warn', 'enforce'] as const;
export type ExtensionMode = (typeof EXTENSION_MODES)[number];
export const EXTENSION_ID_PATTERN = '^[a-p]{32}$';
export const EXTENSION_SOURCES = ['web_store', 'policy', 'external', 'unpacked', 'other'] as const;
export type ExtensionSource = (typeof EXTENSION_SOURCES)[number];
const ExtensionId = Type.String({ pattern: EXTENSION_ID_PATTERN });
const VersionRange = Type.String({ minLength: 1, maxLength: 64, pattern: '^[0-9.*<>= ]+$' });
const PermissionName = Type.String({ minLength: 1, maxLength: 200 });

export const ExtensionRule = Type.Object(
  {
    extension_id: ExtensionId,
    name: Type.String({ maxLength: 120 }),
    decision: Type.Enum(['allowed', 'blocked'] as const),
    /** web_store: only when installed from the Chrome Web Store; any: from any supported source. */
    source: Type.Enum(['web_store', 'any'] as const),
    /** Approved versions (null: any). `1.2.3`, `1.2.*`, `>=1.2 <2`. */
    approved_version_range: Nullable(VersionRange),
    /** Sensitive permissions admins approved; an update asking for more waits for review. */
    permissions: Type.Array(PermissionName, { maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type ExtensionRule = Static<typeof ExtensionRule>;
export const ExtensionPolicy = Type.Object(
  {
    org_id: Id('org'),
    mode: Type.Enum(EXTENSION_MODES),
    version: Version,
    updated_at: Nullable(Timestamp),
    extensions: Type.Array(ExtensionRule, { maxItems: 500 }),
  },
  { additionalProperties: false },
);
export type ExtensionPolicy = Static<typeof ExtensionPolicy>;
export const ExtensionPolicyUpdate = Type.Object(
  {
    expected_version: Type.Optional(Version),
    mode: Type.Enum(EXTENSION_MODES),
    extensions: Type.Array(ExtensionRule, { maxItems: 500 }),
  },
  { additionalProperties: false },
);

/** One installed extension as a device reports it (names and permissions as the extension declares them). */
export const ExtensionReportItem = Type.Object(
  {
    id: ExtensionId,
    name: Type.String({ maxLength: 120 }),
    version: Type.String({ maxLength: 32 }),
    source: Type.Enum(EXTENSION_SOURCES),
    enabled: Type.Boolean(),
    permissions: Type.Array(PermissionName, { maxItems: 100 }),
  },
  { additionalProperties: false },
);
export type ExtensionReportItem = Static<typeof ExtensionReportItem>;
export const ExtensionReport = Type.Object(
  { device_id: Id('dev'), extensions: Type.Array(ExtensionReportItem, { maxItems: 200 }) },
  { additionalProperties: false },
);
/** The organization's inventory: every extension devices reported, with where it is installed. */
export const ExtensionInventoryItem = Type.Object(
  {
    id: ExtensionId,
    name: Type.String(),
    versions: Type.Array(Type.String()),
    sources: Type.Array(Type.Enum(EXTENSION_SOURCES)),
    permissions: Type.Array(Type.String()),
    sensitive: Type.Array(Type.String()),
    profiles: Type.Integer({ minimum: 0 }),
    devices: Type.Integer({ minimum: 0 }),
    last_reported_at: Timestamp,
  },
  { additionalProperties: false },
);
export type ExtensionInventoryItem = Static<typeof ExtensionInventoryItem>;

/**
 * Permissions that let an extension read or change what people do on websites, or reach outside the browser. A rule
 * approves them explicitly; an update that asks for one more waits for an admin (ADR-0016). Host patterns that match
 * every site count too. The desktop has the same list (crates/runtime/src/extensions.rs).
 */
export const SENSITIVE_EXTENSION_PERMISSIONS = [
  '<all_urls>',
  'activeTab',
  'bookmarks',
  'browsingData',
  'clipboardRead',
  'contentSettings',
  'cookies',
  'debugger',
  'declarativeNetRequest',
  'declarativeNetRequestWithHostAccess',
  'desktopCapture',
  'downloads',
  'history',
  'identity',
  'management',
  'nativeMessaging',
  'pageCapture',
  'privacy',
  'proxy',
  'scripting',
  'tabCapture',
  'tabs',
  'topSites',
  'webNavigation',
  'webRequest',
  'webRequestBlocking',
] as const;

/** Whether a permission or host pattern is sensitive (every site, any scheme wildcard, or a listed API). */
export function isSensitivePermission(permission: string): boolean {
  if ((SENSITIVE_EXTENSION_PERMISSIONS as readonly string[]).includes(permission)) return true;
  return /^(\*|https?|file):\/\/\*(\.\*)?\/\*?$/.test(permission) || permission === '*://*/*';
}

function parseVersion(v: string): number[] | null {
  if (!/^\d{1,9}(\.\d{1,9}){0,3}$/.test(v)) return null;
  return v.split('.').map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 4; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Whether a Chromium extension version (1 to 4 dot-separated numbers) is inside an approved range: `1.2.3` (exact),
 * `1.2.*` (that prefix), or space-separated comparisons `>=1.2 <2` (all must hold). An invalid range matches nothing.
 */
export function versionInRange(version: string, range: string | null): boolean {
  if (range === null) return true;
  const v = parseVersion(version);
  if (!v) return false;
  const parts = range.trim().split(/\s+/);
  if (parts.length === 0 || parts.length > 4) return false;
  for (const part of parts) {
    const star = /^(\d{1,9}(?:\.\d{1,9}){0,2})\.\*$/.exec(part);
    if (star?.[1]) {
      const prefix = parseVersion(star[1]);
      if (!prefix?.every((n, i) => v[i] === n)) return false;
      continue;
    }
    const cmp = /^(>=|<=|>|<|=)?(\d{1,9}(?:\.\d{1,9}){0,3})$/.exec(part);
    if (!cmp?.[2]) return false;
    const target = parseVersion(cmp[2]);
    if (!target) return false;
    const c = compareVersions(v, target);
    const op = cmp[1] ?? '=';
    const ok =
      op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0;
    if (!ok) return false;
  }
  return true;
}

const RANGE_STAR = /^\d{1,9}(?:\.\d{1,9}){0,2}\.\*$/;
const RANGE_CMP = /^(>=|<=|>|<|=)?\d{1,9}(\.\d{1,9}){0,3}$/;
/** A range admins may save: 1 to 4 space-separated parts, each `1.2.*` or an optional comparison and a version. */
export function validVersionRange(range: string): boolean {
  const parts = range.trim().split(/\s+/);
  return (
    parts.length >= 1 && parts.length <= 4 && parts.every((p) => RANGE_STAR.test(p) || RANGE_CMP.test(p))
  );
}

export type ExtensionVerdict =
  | { status: 'approved' }
  | { status: 'blocked' }
  | { status: 'not_listed' }
  | { status: 'source_not_allowed' }
  | { status: 'version_not_approved'; version: string }
  | { status: 'permissions_need_review'; permissions: string[] };

/** How an organization's policy judges one installed extension (same rules as the desktop). */
export function judgeExtension(
  rules: readonly ExtensionRule[],
  item: Pick<ExtensionReportItem, 'id' | 'version' | 'source' | 'permissions'>,
): ExtensionVerdict {
  const rule = rules.find((r) => r.extension_id === item.id);
  if (!rule) return { status: 'not_listed' };
  if (rule.decision === 'blocked') return { status: 'blocked' };
  if (rule.source === 'web_store' && item.source !== 'web_store') return { status: 'source_not_allowed' };
  if (!versionInRange(item.version, rule.approved_version_range))
    return { status: 'version_not_approved', version: item.version };
  const extra = item.permissions.filter((p) => isSensitivePermission(p) && !rule.permissions.includes(p));
  if (extra.length) return { status: 'permissions_need_review', permissions: extra };
  return { status: 'approved' };
}
