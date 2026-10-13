/**
 * Developer API and authorized automation (milestone 10, ADR-0017). Browser-safe: no Node imports.
 *
 * - API tokens act for the person who created them and never beyond that person's current access: every request is
 *   authorized as that member (role, grants, capabilities) and additionally limited by the token's scopes and its
 *   client/profile restrictions. Only a SHA-256 digest of the secret is stored; the secret is shown once.
 * - Automation jobs run on computers people enrolled ("agents": the desktop app, signed in as its person). A job opens
 *   an organization profile through a session lease exactly like a person would, runs a few allowlisted steps on
 *   approved sites, and closes it (the closing backup uploads under the same lease). Nothing on a website is changed
 *   by a v1 step: open an approved address, wait for a condition, take a diagnostic screenshot.
 * - Steps are checkpointed. After a lost connection or a restart only steps that are safe to repeat run again; a step
 *   whose outcome cannot be known is reported as such ("outcome unknown") and the job needs reconciliation.
 * - Webhooks follow the Standard Webhooks signature scheme (`webhook-id`, `webhook-timestamp`, `webhook-signature`).
 *   The event id is the delivery's identity: a retried delivery carries the same id, so receivers deduplicate on it.
 */
import Type, { type Static, type TSchema } from 'typebox';
import { ID_PATTERN } from './ids.ts';
import { type Permission, type Role, roleAllows } from './resources.ts';

const Id = (prefix: Parameters<typeof ID_PATTERN>[0]) => Type.String({ pattern: ID_PATTERN(prefix) });
const Timestamp = Type.String({ format: 'date-time', description: 'UTC, RFC 3339' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const Version = Type.Integer({ minimum: 1 });
const Sha256Hex = Type.String({ pattern: '^[0-9a-f]{64}$' });

// ================================================================ API tokens
/**
 * What a token may be used for. A scope never adds anything the creator's role does not have: the token is checked
 * against both on every request (the role as it is *now*, so a demoted or removed member's tokens shrink or stop).
 */
export const API_SCOPES = [
  'profiles:read',
  'profiles:write',
  'automation:read',
  'automation:run',
  'automation:debug',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_PERMISSIONS: Record<ApiScope, readonly Permission[]> = {
  'profiles:read': ['org.read', 'clients.read', 'profile.read'],
  'profiles:write': [
    'org.read',
    'clients.read',
    'profile.read',
    'profile.create',
    'profile.update',
    'profile.delete',
  ],
  'automation:read': ['org.read', 'clients.read', 'profile.read', 'automation.read'],
  // Launching is implied for the profile a job targets (jobs open profiles through a lease like a person would).
  'automation:run': [
    'org.read',
    'clients.read',
    'profile.read',
    'automation.read',
    'automation.run',
    'profile.launch',
  ],
  'automation:debug': ['automation.debug'],
};

export const SCOPE_LABELS: Record<ApiScope, string> = {
  'profiles:read': 'Read profiles and clients',
  'profiles:write': 'Create, edit and trash profiles',
  'automation:read': 'See automation jobs',
  'automation:run': 'Run automation jobs',
  'automation:debug': 'Debugging sessions (Playwright)',
};

export function scopesAllow(scopes: readonly string[], permission: Permission): boolean {
  return scopes.some((s) =>
    (SCOPE_PERMISSIONS as Record<string, readonly Permission[]>)[s]?.includes(permission),
  );
}

/** A role can only hand out a scope whose every permission it has itself. */
export function scopeAllowedForRole(role: Role, scope: ApiScope): boolean {
  return SCOPE_PERMISSIONS[scope].every((p) => roleAllows(role, p));
}

/** `pbt_<token id>_<43 base64url characters>`: the prefix makes leaked tokens easy to find with secret scanning. */
export const API_TOKEN_PATTERN = '^pbt_(tok_[0-9A-HJKMNP-TV-Z]{26})_([A-Za-z0-9_-]{43})$';
export function parseApiToken(value: string): { tokenId: string; secret: string } | null {
  const m = new RegExp(API_TOKEN_PATTERN).exec(value);
  return m?.[1] && m[2] ? { tokenId: m[1], secret: m[2] } : null;
}
export function formatApiToken(tokenId: string, secret: string): string {
  return `pbt_${tokenId}_${secret}`;
}

export const TOKEN_LIMITS = {
  maxClients: 50,
  maxProfiles: 100,
  maxDays: 365,
  maxGraceMinutes: 1440,
  /** Per member and organization (revoked and expired tokens do not count). */
  maxActivePerUser: 25,
} as const;

export const TOKEN_STATES = ['active', 'expired', 'revoked'] as const;
export const ApiToken = Type.Object(
  {
    id: Id('tok'),
    org_id: Id('org'),
    name: Type.String({ minLength: 1, maxLength: 80 }),
    owner_id: Id('usr'),
    owner_name: Type.String(),
    scopes: Type.Array(Type.Enum(API_SCOPES), { minItems: 1, maxItems: API_SCOPES.length }),
    /** null: every client the owner can reach. */
    client_ids: Nullable(Type.Array(Id('cli'), { maxItems: TOKEN_LIMITS.maxClients })),
    /** null: every profile the owner can reach (within client_ids when set). */
    profile_ids: Nullable(Type.Array(Id('prf'), { maxItems: TOKEN_LIMITS.maxProfiles })),
    state: Type.Enum(TOKEN_STATES),
    created_at: Timestamp,
    expires_at: Timestamp,
    last_used_at: Nullable(Timestamp),
    rotated_at: Nullable(Timestamp),
    /** After a rotation, the previous secret keeps working until this time (null: not at all). */
    previous_valid_until: Nullable(Timestamp),
    revoked_at: Nullable(Timestamp),
    mine: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ApiToken = Static<typeof ApiToken>;

export const ApiTokenCreate = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    scopes: Type.Array(Type.Enum(API_SCOPES), {
      minItems: 1,
      maxItems: API_SCOPES.length,
      uniqueItems: true,
    }),
    client_ids: Type.Optional(
      Type.Array(Id('cli'), { minItems: 1, maxItems: TOKEN_LIMITS.maxClients, uniqueItems: true }),
    ),
    profile_ids: Type.Optional(
      Type.Array(Id('prf'), { minItems: 1, maxItems: TOKEN_LIMITS.maxProfiles, uniqueItems: true }),
    ),
    expires_in_days: Type.Integer({ minimum: 1, maximum: TOKEN_LIMITS.maxDays }),
  },
  { additionalProperties: false },
);
export type ApiTokenCreate = Static<typeof ApiTokenCreate>;
/** The only answer that contains the secret. It is not stored anywhere and cannot be shown again. */
export const ApiTokenCreated = Type.Object(
  { token: ApiToken, secret: Type.String({ pattern: API_TOKEN_PATTERN }) },
  { additionalProperties: false },
);
export const ApiTokenRotate = Type.Object(
  { grace_minutes: Type.Optional(Type.Integer({ minimum: 0, maximum: TOKEN_LIMITS.maxGraceMinutes })) },
  { additionalProperties: false },
);
export const ApiTokenQuery = Type.Object(
  {
    all: Type.Optional(Type.Boolean({ description: 'Everyone’s tokens (tokens.manage); default: your own' })),
    state: Type.Optional(Type.Enum(['active', 'all'] as const)),
  },
  { additionalProperties: false },
);

// ================================================================ approved sites
/**
 * An approved site: `https://app.example.com`, `https://*.example.com` (any subdomain, not the name itself),
 * `http://localhost:3000`. Scheme and host only (lowercase ASCII; punycode for international names), optional port.
 * Wildcards need at least two labels after `*.`. The same grammar and matching run in the API and on the computer
 * that runs the job (shared vectors: packages/contracts/fixtures/automation-cases.json).
 */
export const ORIGIN_PATTERN_MAX = 50;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const ORIGIN_PATTERN_RE = new RegExp(`^(https?)://(\\*\\.)?(${LABEL}(?:\\.${LABEL})*)(?::(\\d{1,5}))?$`);

interface ParsedOrigin {
  scheme: 'http' | 'https';
  wildcard: boolean;
  host: string;
  port: number;
}

export function parseOriginPattern(pattern: string): ParsedOrigin | null {
  if (pattern.length > 260) return null;
  const m = ORIGIN_PATTERN_RE.exec(pattern);
  if (!m?.[1] || !m[3]) return null;
  const scheme = m[1] as 'http' | 'https';
  const wildcard = m[2] !== undefined;
  const host = m[3];
  if (host.length > 253) return null;
  if (wildcard && host.split('.').length < 2) return null;
  const port = m[4] === undefined ? defaultPort(scheme) : Number(m[4]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (m[4]?.startsWith('0')) return null;
  return { scheme, wildcard, host, port };
}

function defaultPort(scheme: 'http' | 'https'): number {
  return scheme === 'https' ? 443 : 80;
}

/**
 * The scheme, host and port of an address, by a deliberately strict grammar (no user names, no backslashes, no
 * whitespace, lowercase ASCII host). Addresses outside the grammar are refused rather than interpreted, so what is
 * checked is what the browser opens.
 */
export function addressOrigin(url: string): { scheme: 'http' | 'https'; host: string; port: number } | null {
  if (url.length > 2048) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
  if (/[\s\\\u0000-\u001F\u007F]/u.test(url)) return null;
  const m = /^(https?):\/\/([^/?#]*)(.*)$/.exec(url);
  if (!m?.[1] || m[2] === undefined) return null;
  const scheme = m[1] as 'http' | 'https';
  const authority = m[2];
  const rest = m[3] ?? '';
  if (rest !== '' && !/^[/?#]/.test(rest)) return null;
  if (authority.includes('@')) return null;
  const am = new RegExp(`^(${LABEL}(?:\\.${LABEL})*)(?::(\\d{1,5}))?$`).exec(authority);
  if (!am?.[1]) return null;
  const host = am[1];
  if (am[2]?.startsWith('0')) return null;
  const port = am[2] === undefined ? defaultPort(scheme) : Number(am[2]);
  if (port < 1 || port > 65535) return null;
  return { scheme, host, port };
}

export function originAllowed(url: string, patterns: readonly string[]): boolean {
  const o = addressOrigin(url);
  if (!o) return false;
  return patterns.some((p) => {
    const q = parseOriginPattern(p);
    if (!q || q.scheme !== o.scheme || q.port !== o.port) return false;
    return q.wildcard
      ? o.host.endsWith(`.${q.host}`) && o.host.length > q.host.length + 1
      : o.host === q.host;
  });
}

export const AutomationSettings = Type.Object(
  {
    org_id: Id('org'),
    allowed_origins: Type.Array(Type.String({ maxLength: 260 }), { maxItems: ORIGIN_PATTERN_MAX }),
    /** Jobs of this organization running at the same time, on all its computers together. */
    max_running_jobs: Type.Integer({ minimum: 1, maximum: 50 }),
    version: Version,
    updated_at: Nullable(Timestamp),
  },
  { additionalProperties: false },
);
export type AutomationSettings = Static<typeof AutomationSettings>;
export const AutomationSettingsUpdate = Type.Object(
  {
    expected_version: Type.Optional(Version),
    allowed_origins: Type.Optional(
      Type.Array(Type.String({ maxLength: 260 }), { maxItems: ORIGIN_PATTERN_MAX }),
    ),
    max_running_jobs: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

// ================================================================ steps
/**
 * The steps a job may contain. Each has an effect class that decides what happens when its outcome is lost:
 * - `read`: observes the page only; safe to run again.
 * - `navigation`: a top-level GET of an approved address; safe to run again.
 * - `session`: opens or closes the profile; protected by the lease (same idempotency key, fenced writes).
 * - `external_mutation`: would change something on a website. None exists in v1; adding one needs a preview/approval
 *   boundary and an idempotency strategy first (ADR-0017). Such a step is never repeated: a lost outcome is reported
 *   as `outcome_unknown` and the job needs reconciliation.
 */
export const STEP_EFFECTS = ['read', 'navigation', 'session', 'external_mutation'] as const;
export type StepEffect = (typeof STEP_EFFECTS)[number];
export const USER_STEP_ACTIONS = ['open_url', 'wait_for', 'screenshot'] as const;
export const SYSTEM_STEP_ACTIONS = ['open_profile', 'debug_bridge', 'hold_open', 'close_profile'] as const;
export const STEP_ACTIONS = [...USER_STEP_ACTIONS, ...SYSTEM_STEP_ACTIONS] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

export const STEP_REGISTRY: Record<StepAction, { effect: StepEffect }> = {
  open_profile: { effect: 'session' },
  open_url: { effect: 'navigation' },
  wait_for: { effect: 'read' },
  screenshot: { effect: 'read' },
  debug_bridge: { effect: 'session' },
  hold_open: { effect: 'session' },
  close_profile: { effect: 'session' },
};

export function safeToRepeat(effect: StepEffect): boolean {
  return effect !== 'external_mutation';
}

export const STEP_LIMITS = {
  maxSteps: 20,
  openUrlTimeoutMs: { min: 1000, max: 60_000, default: 30_000 },
  waitTimeoutMs: { min: 100, max: 120_000, default: 15_000 },
  maxScreenshots: 5,
  /** A screenshot larger than this is retaken at lower quality, then refused. */
  maxArtifactBytes: 1_572_864,
  keepOpenMinutes: { min: 1, max: 480 },
  queueTimeoutSeconds: { min: 30, max: 86_400, default: 3600 },
  /** Artifacts (screenshots) are deleted after this many days; job records after JOB_RETENTION_DAYS. */
  artifactRetentionDays: 7,
} as const;
export const JOB_RETENTION_DAYS = 30;

const StepUrl = Type.String({ minLength: 10, maxLength: 2048, pattern: '^https?://' });
export const WaitCondition = Type.Union([
  Type.Object(
    { type: Type.Literal('selector'), selector: Type.String({ minLength: 1, maxLength: 300 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('text'), text: Type.String({ minLength: 1, maxLength: 200 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('title_contains'), text: Type.String({ minLength: 1, maxLength: 200 }) },
    { additionalProperties: false },
  ),
  Type.Object({ type: Type.Literal('url_prefix'), prefix: StepUrl }, { additionalProperties: false }),
]);
export type WaitCondition = Static<typeof WaitCondition>;

export const StepInput = Type.Union([
  Type.Object(
    {
      action: Type.Literal('open_url'),
      url: StepUrl,
      timeout_ms: Type.Optional(
        Type.Integer({
          minimum: STEP_LIMITS.openUrlTimeoutMs.min,
          maximum: STEP_LIMITS.openUrlTimeoutMs.max,
        }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal('wait_for'),
      condition: WaitCondition,
      timeout_ms: Type.Optional(
        Type.Integer({ minimum: STEP_LIMITS.waitTimeoutMs.min, maximum: STEP_LIMITS.waitTimeoutMs.max }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal('screenshot'),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    },
    { additionalProperties: false },
  ),
]);
export type StepInput = Static<typeof StepInput>;

/** Why a list of steps is refused (beyond the schema), or null. */
export function stepsProblem(
  steps: readonly StepInput[],
  allowedOrigins: readonly string[],
): { code: 'URL_NOT_APPROVED' | 'VALIDATION_FAILED'; index: number; reason: string } | null {
  if (steps.length > STEP_LIMITS.maxSteps)
    return { code: 'VALIDATION_FAILED', index: -1, reason: 'too_many_steps' };
  let screenshots = 0;
  for (const [index, s] of steps.entries()) {
    if (s.action === 'open_url' && !originAllowed(s.url, allowedOrigins)) {
      return { code: 'URL_NOT_APPROVED', index, reason: 'url' };
    }
    if (s.action === 'wait_for') {
      const c = s.condition;
      if (c.type === 'url_prefix' && !originAllowed(c.prefix, allowedOrigins)) {
        return { code: 'URL_NOT_APPROVED', index, reason: 'url_prefix' };
      }
      const text = c.type === 'selector' ? c.selector : c.type === 'url_prefix' ? c.prefix : c.text;
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
      if (/[\u0000-\u001F\u007F]/u.test(text))
        return { code: 'VALIDATION_FAILED', index, reason: 'control_characters' };
    }
    if (s.action === 'screenshot' && ++screenshots > STEP_LIMITS.maxScreenshots) {
      return { code: 'VALIDATION_FAILED', index, reason: 'too_many_screenshots' };
    }
    // The first page action must open an address: conditions and screenshots need a page from the approved sites.
    if (index === 0 && s.action !== 'open_url') {
      return { code: 'VALIDATION_FAILED', index, reason: 'first_step_must_open_url' };
    }
  }
  return null;
}

// ================================================================ jobs
export const JOB_STATES = ['QUEUED', 'CLAIMED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED'] as const;
export type JobState = (typeof JOB_STATES)[number];
export const FINISHED_JOB_STATES: readonly JobState[] = ['SUCCEEDED', 'FAILED', 'CANCELED'];

/** Allowed transitions; anything else is refused (the database enforces the same with a trigger). */
export const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  QUEUED: ['CLAIMED', 'FAILED', 'CANCELED'],
  // A claim given back before anything ran (lost computer, refused lease) returns to the queue.
  CLAIMED: ['RUNNING', 'QUEUED', 'FAILED', 'CANCELED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELED: [],
};
export function jobTransitionAllowed(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export const STEP_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'canceled',
  'outcome_unknown',
] as const;
export type StepState = (typeof STEP_STATES)[number];

/** Codes a step or job may finish with (fixed list: page text never reaches the job record). */
export const JOB_ERROR_CODES = [
  'TIMEOUT',
  'NAVIGATION_FAILED',
  'PAGE_LEFT_APPROVED_SITES',
  'CONDITION_NOT_MET',
  'BROWSER_CLOSED',
  'LEASE_LOST',
  'PROFILE_IN_USE',
  'PROFILE_NOT_AVAILABLE',
  'RESTORE_FAILED',
  'LAUNCH_FAILED',
  'BACKUP_PENDING',
  'AGENT_LOST',
  'CANCELED',
  'OUTCOME_UNKNOWN',
  'QUEUE_EXPIRED',
  'UNSUPPORTED_BROWSER',
  'DEBUG_NOT_ALLOWED',
  'ARTIFACT_TOO_LARGE',
  'ACCESS_REMOVED',
  'URL_NOT_APPROVED',
  'TOO_MANY_ATTEMPTS',
  'INTERNAL',
] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

/** What a finished step may report: small, typed values only (no page text, titles or full addresses). */
export const StepOutput = Type.Object(
  {
    /** open_profile */
    restored: Type.Optional(Type.Boolean()),
    browser_version: Type.Optional(Type.String({ maxLength: 64, pattern: '^[0-9.]+$' })),
    /** open_url: the origin the page ended on (scheme, host, port), the HTTP status, how long it took */
    final_origin: Type.Optional(Type.String({ maxLength: 300 })),
    http_status: Type.Optional(Type.Integer({ minimum: 0, maximum: 999 })),
    elapsed_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400_000 })),
    /** screenshot */
    artifact_id: Type.Optional(Id('art')),
    width: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
    height: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
    /** close_profile: the closing backup */
    backup: Type.Optional(Type.Enum(['committed', 'not_needed', 'pending'] as const)),
    /** debug_bridge: the loopback address a Playwright script connects to (on the computer running the job) */
    endpoint: Type.Optional(
      Type.String({
        maxLength: 120,
        pattern: '^ws://127\\.0\\.0\\.1:[0-9]{1,5}/cdp/job_[0-9A-HJKMNP-TV-Z]{26}$',
      }),
    ),
    /** debug_bridge: commands relayed (count only) */
    commands: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type StepOutput = Static<typeof StepOutput>;

export const JobStep = Type.Object(
  {
    seq: Type.Integer({ minimum: 0, maximum: 64 }),
    action: Type.Enum(STEP_ACTIONS),
    effect: Type.Enum(STEP_EFFECTS),
    /** The step as requested (system steps: {}). */
    input: Type.Record(Type.String(), Type.Unknown()),
    state: Type.Enum(STEP_STATES),
    attempt: Type.Integer({ minimum: 0 }),
    started_at: Nullable(Timestamp),
    finished_at: Nullable(Timestamp),
    error_code: Nullable(Type.Enum(JOB_ERROR_CODES)),
    output: Nullable(StepOutput),
  },
  { additionalProperties: false },
);
export type JobStep = Static<typeof JobStep>;

export const DebugRequest = Type.Object(
  {
    /**
     * SHA-256 (hex) of a secret you generated (the SDK's `newDebugCapability()`). The computer running the job only
     * accepts a Playwright connection presenting that secret; the server never sees it.
     */
    capability_sha256: Sha256Hex,
  },
  { additionalProperties: false },
);

export const JobCreate = Type.Object(
  {
    profile_id: Id('prf'),
    /** A specific enrolled computer; otherwise any enrolled computer that may run it. */
    agent_id: Type.Optional(Id('agt')),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    steps: Type.Array(StepInput, { maxItems: STEP_LIMITS.maxSteps }),
    /** Keep the profile open after the steps (a launch request), until canceled or this many minutes passed. */
    keep_open_minutes: Type.Optional(
      Type.Integer({ minimum: STEP_LIMITS.keepOpenMinutes.min, maximum: STEP_LIMITS.keepOpenMinutes.max }),
    ),
    /** A Playwright debugging session (needs automation.debug and keep_open_minutes). */
    debug: Type.Optional(DebugRequest),
    /** Fail the job if no computer started it within this time. */
    queue_timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: STEP_LIMITS.queueTimeoutSeconds.min,
        maximum: STEP_LIMITS.queueTimeoutSeconds.max,
      }),
    ),
  },
  { additionalProperties: false },
);
export type JobCreate = Static<typeof JobCreate>;

export const Job = Type.Object(
  {
    id: Id('job'),
    org_id: Id('org'),
    profile_id: Id('prf'),
    profile_name: Type.String(),
    client_id: Nullable(Id('cli')),
    client_name: Nullable(Type.String()),
    label: Nullable(Type.String()),
    state: Type.Enum(JOB_STATES),
    agent_id: Nullable(Id('agt')),
    agent_name: Nullable(Type.String()),
    requested_agent_id: Nullable(Id('agt')),
    requested_by: Id('usr'),
    requested_by_name: Type.String(),
    token_id: Nullable(Id('tok')),
    token_name: Nullable(Type.String()),
    steps_total: Type.Integer({ minimum: 0 }),
    steps_done: Type.Integer({ minimum: 0 }),
    keep_open_minutes: Nullable(Type.Integer()),
    debug: Type.Boolean(),
    /** Claims so far (a job given back to the queue before anything ran is claimed again). */
    attempt: Type.Integer({ minimum: 0 }),
    lease_id: Nullable(Id('lse')),
    error_code: Nullable(Type.Enum(JOB_ERROR_CODES)),
    /** A step's outcome could not be known (for example a lost connection after an external change): check by hand. */
    reconciliation_required: Type.Boolean(),
    holding: Type.Boolean(),
    created_at: Timestamp,
    queue_expires_at: Timestamp,
    claimed_at: Nullable(Timestamp),
    started_at: Nullable(Timestamp),
    finished_at: Nullable(Timestamp),
    cancel_requested_at: Nullable(Timestamp),
    version: Version,
    mine: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type Job = Static<typeof Job>;
export const JobDetail = Type.Object(
  {
    job: Job,
    steps: Type.Array(JobStep),
    artifacts: Type.Array(
      Type.Object(
        {
          id: Id('art'),
          seq: Type.Integer(),
          content_type: Type.Enum(['image/jpeg', 'image/png'] as const),
          size_bytes: Type.Integer(),
          width: Type.Integer(),
          height: Type.Integer(),
          label: Nullable(Type.String()),
          created_at: Timestamp,
          expires_at: Timestamp,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type JobDetail = Static<typeof JobDetail>;
export const JobQuery = Type.Object(
  {
    state: Type.Optional(Type.Enum([...JOB_STATES, 'active', 'finished'] as const)),
    profile_id: Type.Optional(Id('prf')),
    agent_id: Type.Optional(Id('agt')),
    mine: Type.Optional(Type.Boolean()),
    cursor: Type.Optional(Type.String({ maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
export const JobCancel = Type.Object(
  { reason: Type.Optional(Type.String({ maxLength: 200 })) },
  { additionalProperties: false },
);

// ---------------------------------------------------------------- resume after a lost connection or restart
export interface StepRecord {
  seq: number;
  action: StepAction;
  state: StepState;
  /** The effect recorded with the step (takes precedence over the registry). */
  effect?: StepEffect;
}

export interface ResumePlan {
  /** First step to run (again); null when nothing is left. */
  resumeFrom: number | null;
  /** Steps whose outcome cannot be known: reported as outcome_unknown; the job fails and needs reconciliation. */
  unknown: number[];
}

/**
 * Where a job continues after its computer lost the connection or restarted. Finished steps are checkpoints and are
 * never repeated. A step that started without a reported result is repeated only if its effect is safe to repeat;
 * otherwise its outcome is unknown and nothing after it runs. `registry` exists for tests of future step kinds.
 */
export function planResume(
  steps: readonly StepRecord[],
  registry: Record<string, { effect: StepEffect }> = STEP_REGISTRY,
): ResumePlan {
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  for (const s of ordered) {
    if (s.state === 'succeeded' || s.state === 'skipped') continue;
    if (s.state === 'running') {
      const effect = s.effect ?? registry[s.action]?.effect ?? 'external_mutation';
      return safeToRepeat(effect)
        ? { resumeFrom: s.seq, unknown: [] }
        : { resumeFrom: null, unknown: [s.seq] };
    }
    if (s.state === 'pending') return { resumeFrom: s.seq, unknown: [] };
    // failed, canceled or unknown: nothing more runs
    return { resumeFrom: null, unknown: s.state === 'outcome_unknown' ? [s.seq] : [] };
  }
  return { resumeFrom: null, unknown: [] };
}

// ================================================================ agents (enrolled computers)
export const AGENT_ACCEPTS = ['mine', 'org'] as const;
export type AgentAccepts = (typeof AGENT_ACCEPTS)[number];
export const AGENT_TIMING = {
  /** The app polls this often while idle (seconds); every poll is also the heartbeat of its running jobs. */
  pollSeconds: 5,
  /** Not heard from for this long: offline (no new jobs). */
  onlineSeconds: 30,
  /** A claim not started within this time returns to the queue. */
  claimSeconds: 60,
  /** A running job not heard from for this long is lost; it fails if its computer does not come back in time. */
  lostSeconds: 90,
  resumeWindowSeconds: 600,
  /** Claims of one job before it fails (a job keeps returning to the queue only while nothing ran). */
  maxAttempts: 5,
} as const;

export const Agent = Type.Object(
  {
    id: Id('agt'),
    org_id: Id('org'),
    device_id: Id('dev'),
    user_id: Id('usr'),
    user_name: Type.String(),
    name: Type.String({ minLength: 1, maxLength: 80 }),
    platform: Nullable(Type.String()),
    browser_version: Nullable(Type.String()),
    enabled: Type.Boolean(),
    accepts: Type.Enum(AGENT_ACCEPTS),
    /** Set on that computer only (off by default): may hand sessions to a local Playwright script. */
    debug_allowed: Type.Boolean(),
    max_jobs: Type.Integer({ minimum: 1, maximum: 10 }),
    online: Type.Boolean(),
    last_seen_at: Nullable(Timestamp),
    running_jobs: Type.Integer({ minimum: 0 }),
    created_at: Timestamp,
    version: Version,
    mine: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type Agent = Static<typeof Agent>;
export const AgentEnroll = Type.Object(
  {
    device_id: Id('dev'),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    accepts: Type.Optional(Type.Enum(AGENT_ACCEPTS)),
    max_jobs: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  },
  { additionalProperties: false },
);
export const AgentUpdate = Type.Object(
  {
    expected_version: Type.Optional(Version),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    enabled: Type.Optional(Type.Boolean()),
    accepts: Type.Optional(Type.Enum(AGENT_ACCEPTS)),
    max_jobs: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const AgentPoll = Type.Object(
  {
    /** Jobs this computer is working on (job id and the claim attempt it holds). */
    running: Type.Array(
      Type.Object(
        { job_id: Id('job'), attempt: Type.Integer({ minimum: 1 }) },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
    /** How many more jobs it can take now (0: only heartbeat). */
    capacity: Type.Integer({ minimum: 0, maximum: 10 }),
    browser_version: Type.Optional(Type.String({ maxLength: 64, pattern: '^[0-9.]+$' })),
    platform: Type.Optional(Type.String({ pattern: '^[a-z0-9-]{1,32}$' })),
    debug_allowed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ClaimedJob = Type.Object(
  {
    job: Job,
    steps: Type.Array(JobStep),
    /** Approved sites when the job was claimed (the computer checks every page against them). */
    allowed_origins: Type.Array(Type.String()),
    /** Idempotency-Key for opening the profile: the same for every retry of this job on this computer. */
    lease_key: Type.String({ pattern: '^[A-Za-z0-9_-]{8,128}$' }),
    debug_capability_sha256: Nullable(Sha256Hex),
    /** Where to continue (a computer that restarted, or a job claimed again). */
    resume_from: Nullable(Type.Integer()),
  },
  { additionalProperties: false },
);
export type ClaimedJob = Static<typeof ClaimedJob>;

export const AgentPollResult = Type.Object(
  {
    agent: Agent,
    assigned: Type.Array(ClaimedJob),
    /** Jobs to stop (cancel requested): close the profile safely; the closing backup still uploads. */
    cancel: Type.Array(Id('job')),
    /** Jobs this computer reported that are no longer its own (finished, reassigned): stop without reporting. */
    abandon: Type.Array(Id('job')),
    poll_after_seconds: Type.Integer({ minimum: 1, maximum: 60 }),
    server_time: Timestamp,
  },
  { additionalProperties: false },
);
export type AgentPollResult = Static<typeof AgentPollResult>;

/** What the computer running a job reports. Every report names the claim (attempt) it holds. */
export const JobReport = Type.Union([
  Type.Object(
    {
      type: Type.Literal('started'),
      attempt: Type.Integer({ minimum: 1 }),
      lease_id: Id('lse'),
      fencing_token: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }),
    },
    { additionalProperties: false },
  ),
  /** Before a step runs: recorded first, so a lost result is known to be lost (never silently repeated). */
  Type.Object(
    {
      type: Type.Literal('step_started'),
      attempt: Type.Integer({ minimum: 1 }),
      seq: Type.Integer({ minimum: 0, maximum: 64 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('step_finished'),
      attempt: Type.Integer({ minimum: 1 }),
      seq: Type.Integer({ minimum: 0, maximum: 64 }),
      state: Type.Enum(['succeeded', 'failed', 'skipped', 'canceled', 'outcome_unknown'] as const),
      error_code: Type.Optional(Type.Enum(JOB_ERROR_CODES)),
      output: Type.Optional(StepOutput),
    },
    { additionalProperties: false },
  ),
  /** Gives the job back before anything ran (the profile is in use, the lease was refused): it returns to the queue. */
  Type.Object(
    {
      type: Type.Literal('released'),
      attempt: Type.Integer({ minimum: 1 }),
      error_code: Type.Enum(JOB_ERROR_CODES),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('finished'),
      attempt: Type.Integer({ minimum: 1 }),
      state: Type.Enum(['SUCCEEDED', 'FAILED', 'CANCELED'] as const),
      error_code: Type.Optional(Type.Enum(JOB_ERROR_CODES)),
    },
    { additionalProperties: false },
  ),
]);
export type JobReport = Static<typeof JobReport>;
export const JobReportResult = Type.Object(
  {
    job: Job,
    /** Stop working on the job (canceled meanwhile): close the profile safely. */
    cancel_requested: Type.Boolean(),
  },
  { additionalProperties: false },
);

// ================================================================ webhooks
export const WEBHOOK_EVENTS = [
  'automation.job.queued',
  'automation.job.started',
  'automation.job.succeeded',
  'automation.job.failed',
  'automation.job.canceled',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
/** Sent only by "Send test event". */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

export const WEBHOOK_LIMITS = {
  endpointsPerOrg: 10,
  /** Seconds between attempts: 30 s, 2 min, 10 min, 30 min, 2 h, 6 h, 12 h; then the delivery is dead (kept 30 days). */
  retrySchedule: [30, 120, 600, 1800, 7200, 21_600, 43_200],
  timeoutMs: 10_000,
  /** Receivers should refuse signatures older than this. */
  toleranceSeconds: 300,
  /** Consecutive dead deliveries before an endpoint is turned off. */
  disableAfterDead: 20,
} as const;

/** `whsec_` + base64 of 32 random bytes (Standard Webhooks). */
export const WEBHOOK_SECRET_PATTERN = '^whsec_[A-Za-z0-9+/]{43}=$';

export const WebhookEndpoint = Type.Object(
  {
    id: Id('whk'),
    org_id: Id('org'),
    url: Type.String({ maxLength: 2048 }),
    description: Type.String({ maxLength: 200 }),
    events: Type.Array(Type.Enum(WEBHOOK_EVENTS), { minItems: 1 }),
    state: Type.Enum(['active', 'disabled'] as const),
    disabled_reason: Nullable(Type.Enum(['manual', 'failing'] as const)),
    created_at: Timestamp,
    updated_at: Timestamp,
    secret_rotated_at: Nullable(Timestamp),
    last_success_at: Nullable(Timestamp),
    last_failure_at: Nullable(Timestamp),
    dead_deliveries: Type.Integer({ minimum: 0 }),
    pending_deliveries: Type.Integer({ minimum: 0 }),
    version: Version,
  },
  { additionalProperties: false },
);
export type WebhookEndpoint = Static<typeof WebhookEndpoint>;
export const WebhookEndpointCreate = Type.Object(
  {
    url: Type.String({ minLength: 10, maxLength: 2048 }),
    description: Type.Optional(Type.String({ maxLength: 200 })),
    events: Type.Array(Type.Enum(WEBHOOK_EVENTS), { minItems: 1, uniqueItems: true }),
  },
  { additionalProperties: false },
);
export const WebhookEndpointUpdate = Type.Object(
  {
    expected_version: Type.Optional(Version),
    url: Type.Optional(Type.String({ minLength: 10, maxLength: 2048 })),
    description: Type.Optional(Type.String({ maxLength: 200 })),
    events: Type.Optional(Type.Array(Type.Enum(WEBHOOK_EVENTS), { minItems: 1, uniqueItems: true })),
    state: Type.Optional(Type.Enum(['active', 'disabled'] as const)),
  },
  { additionalProperties: false, minProperties: 1 },
);
export const WebhookEndpointCreated = Type.Object(
  { endpoint: WebhookEndpoint, secret: Type.String({ pattern: WEBHOOK_SECRET_PATTERN }) },
  { additionalProperties: false },
);

export const DELIVERY_STATES = ['pending', 'delivered', 'dead'] as const;
export const WebhookDelivery = Type.Object(
  {
    id: Id('dlv'),
    endpoint_id: Id('whk'),
    event_id: Id('evt'),
    event_type: Type.String(),
    state: Type.Enum(DELIVERY_STATES),
    attempts: Type.Integer({ minimum: 0 }),
    next_attempt_at: Nullable(Timestamp),
    last_status: Nullable(Type.Integer()),
    /** A fixed code: timeout, connection, tls, status_4xx, status_5xx, redirect, blocked_destination, dns */
    last_error: Nullable(Type.String({ maxLength: 40 })),
    created_at: Timestamp,
    delivered_at: Nullable(Timestamp),
  },
  { additionalProperties: false },
);
export type WebhookDelivery = Static<typeof WebhookDelivery>;
export const DeliveryQuery = Type.Object(
  {
    state: Type.Optional(Type.Enum(DELIVERY_STATES)),
    cursor: Type.Optional(Type.String({ maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------- destinations (SSRF)
/** Ports a webhook may use: 443 and the unprivileged range (no SSH, SMTP, databases on well-known ports). */
export function webhookPortAllowed(port: number): boolean {
  return port === 443 || (port >= 1024 && port <= 65535);
}

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.localdomain',
];

/**
 * Why a webhook address is refused at registration, or null. HTTPS only, no user names, no fragments, a public DNS
 * name or a public IP address. `allowPrivate` exists for development and tests only (configuration refuses it in
 * production). The worker checks the *resolved* addresses again at every delivery and connects to the address it
 * checked.
 */
export function webhookUrlProblem(url: string, allowPrivate = false): string | null {
  if (url.length > 2048) return 'too_long';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
  if (/[\s\\\u0000-\u001F\u007F]/u.test(url)) return 'whitespace';
  const m = /^(https?):\/\/([^/?#]*)([^#]*)(#.*)?$/i.exec(url);
  if (!m?.[1] || m[2] === undefined) return 'invalid';
  if (m[4] !== undefined) return 'fragment';
  const scheme = m[1].toLowerCase();
  if (scheme !== 'https' && !(allowPrivate && scheme === 'http')) return 'scheme';
  const authority = m[2];
  if (authority.includes('@')) return 'credentials';
  let host: string;
  let portText: string | undefined;
  const v6 = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(authority);
  if (v6?.[1]) {
    host = v6[1].toLowerCase();
    portText = v6[2];
    if (parseIPv6(host) === null) return 'invalid';
  } else {
    const hm = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(authority);
    if (!hm?.[1]) return 'invalid';
    host = hm[1].toLowerCase();
    portText = hm[2];
  }
  const port = portText === undefined ? (scheme === 'https' ? 443 : 80) : Number(portText);
  if (!allowPrivate && !webhookPortAllowed(port)) return 'port';
  if (port < 1 || port > 65535) return 'port';
  if (allowPrivate) return null;
  if (isIpLiteral(host)) return isBlockedAddress(host) ? 'blocked_address' : null;
  if (!host.includes('.') || host.endsWith('.')) return 'host';
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return 'blocked_name';
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) return 'host';
  return null;
}

function isIpLiteral(host: string): boolean {
  return parseIPv4(host) !== null || parseIPv6(host) !== null;
}

/** Strict dotted-quad IPv4 (no octal, hex or shortened forms). */
export function parseIPv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** IPv6 as 8 groups of 16 bits (accepts `::` and an embedded IPv4 tail). */
export function parseIPv6(text: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(text) || !text.includes(':')) return null;
  let head = text;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    tail = [((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)];
    head = text.slice(0, lastColon + 1);
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (s === '') return [];
    const groups = s.split(':');
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const left = parse(halves[0] ?? '');
  const right = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (!left || !right) return null;
  const total = left.length + right.length + tail.length;
  if (halves.length === 1) {
    return total === 8 ? [...left, ...tail] : null;
  }
  if (total > 7) return null;
  return [...left, ...new Array(8 - total).fill(0), ...right, ...tail];
}

const V4_BLOCKED: [number, number, number, number, number][] = [
  [0, 0, 0, 0, 8], // "this" network
  [10, 0, 0, 0, 8], // private
  [100, 64, 0, 0, 10], // carrier-grade NAT
  [127, 0, 0, 0, 8], // loopback
  [169, 254, 0, 0, 16], // link-local (cloud metadata services live here)
  [172, 16, 0, 0, 12], // private
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 0, 24], // documentation
  [192, 88, 99, 0, 24], // 6to4 relay
  [192, 168, 0, 0, 16], // private
  [198, 18, 0, 0, 15], // benchmarking
  [198, 51, 100, 0, 24], // documentation
  [203, 0, 113, 0, 24], // documentation
  [224, 0, 0, 0, 4], // multicast
  [240, 0, 0, 0, 4], // reserved and broadcast
];

function v4Blocked(v4: number[]): boolean {
  const value = (((v4[0] ?? 0) << 24) | ((v4[1] ?? 0) << 16) | ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)) >>> 0;
  return V4_BLOCKED.some(([a, b, c, d, bits]) => {
    const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (base & mask) >>> 0;
  });
}

/**
 * Whether an address (IPv4 or IPv6 text) is private, loopback, link-local, reserved, multicast or otherwise not a
 * public unicast destination. IPv4 embedded in IPv6 (mapped, NAT64, 6to4) is judged as IPv4. Unparseable text is
 * blocked.
 */
export function isBlockedAddress(text: string): boolean {
  const v4 = parseIPv4(text);
  if (v4) return v4Blocked(v4);
  const v6 = parseIPv6(text);
  if (!v6) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = v6;
  const embedded = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  if (v6.every((g) => g === 0)) return true; // unspecified
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1)
    return true;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return v4Blocked(embedded);
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true; // IPv4-compatible (deprecated)
  if (g0 === 0x64 && g1 === 0xff9b) return v4Blocked(embedded); // NAT64 well-known prefix
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard-only
  if (g0 === 0x2001 && g1 < 0x0200) return true; // IETF protocol assignments (Teredo, ORCHID, …)
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2002) return true; // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

// ---------------------------------------------------------------- event payloads (what a webhook body contains)
/** `data` of automation.job.* events: identifiers and states only; never step inputs, page data or secrets. */
export const JobEventData = Type.Object(
  {
    job_id: Id('job'),
    profile_id: Id('prf'),
    state: Type.Enum(JOB_STATES),
    agent_id: Nullable(Id('agt')),
    error_code: Nullable(Type.Enum(JOB_ERROR_CODES)),
    reconciliation_required: Type.Boolean(),
    attempt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type JobEventData = Static<typeof JobEventData>;
