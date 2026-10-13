/**
 * Project Browser developer API — TypeScript SDK (milestone 10, ADR-0017).
 *
 * ```ts
 * import { ProjectBrowser } from '@pb/sdk';
 * const pb = new ProjectBrowser({ baseUrl: 'https://api.example.com', orgId: 'org_…', token: process.env.PB_TOKEN! });
 * const { job } = await pb.jobs.create({ profile_id: 'prf_…', steps: [{ action: 'open_url', url: 'https://app.example.com/' }] });
 * const done = await pb.jobs.wait(job.id);
 * ```
 *
 * - Authentication: an API token (`pbt_…`, created in the app by a member; it acts as that member within its scopes
 *   and restrictions). Keep it in a secret manager; it is sent only in the Authorization header.
 * - Job creation always carries an Idempotency-Key (generated when you do not pass one) and is retried with the same
 *   key on network errors, 429 and 5xx: a retried request answers the same job, never a second one.
 * - Webhooks: `verifyWebhook` checks Standard Webhooks signatures (constant time, timestamp tolerance). Deduplicate on
 *   the `webhook-id` header: retries and redeliveries carry the same id.
 * - Debugging sessions: `newDebugCapability()` makes the secret; send only its `sha256` with the job; after the job's
 *   `debug_bridge` step reports its endpoint, connect Playwright on the computer running the job with
 *   `connectPlaywright`.
 *
 * Uses only `fetch` and WebCrypto: no dependencies.
 */
import type {
  Agent,
  ApiToken,
  AutomationSettings,
  Job,
  JobCreate,
  JobDetail,
  JobState,
  Profile,
  WebhookEvent,
} from '@pb/contracts';

export type {
  Agent,
  ApiToken,
  AutomationSettings,
  Job,
  JobCreate,
  JobDetail,
  JobState,
  Profile,
  WebhookEvent,
};

export interface ClientOptions {
  /** e.g. `https://api.example.com` (the `/v1` prefix is added). */
  baseUrl: string;
  /** The organization the token belongs to (`org_…`). */
  orgId: string;
  /** `pbt_…` */
  token: string;
  /** Retries for network errors, 429 and 5xx (GET requests and job creation only). Default 4. */
  retries?: number;
  fetch?: typeof fetch;
}

/** An error answer from the API (the milestone 01 error envelope). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string | null,
    retryable: boolean,
    details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryable = retryable;
    this.details = details;
  }
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

const FINISHED: readonly JobState[] = ['SUCCEEDED', 'FAILED', 'CANCELED'];

/** A random Idempotency-Key (keep it with your own record to retry safely later). */
export function newIdempotencyKey(): string {
  return `sdk-${crypto.randomUUID()}`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    });
  });

export class ProjectBrowser {
  readonly #base: string;
  readonly #org: string;
  readonly #token: string;
  readonly #retries: number;
  readonly #fetch: typeof fetch;

  constructor(opts: ClientOptions) {
    if (!/^pbt_tok_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$/.test(opts.token)) {
      throw new Error('token must be an API token (pbt_…)');
    }
    this.#base = `${opts.baseUrl.replace(/\/+$/, '')}/v1/orgs/${encodeURIComponent(opts.orgId)}`;
    this.#org = opts.orgId;
    this.#token = opts.token;
    this.#retries = opts.retries ?? 4;
    this.#fetch = opts.fetch ?? fetch;
  }

  get orgId(): string {
    return this.#org;
  }

  /** One request; `retry` for safe requests (GET, or a POST with an Idempotency-Key). */
  async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; retry?: boolean; raw?: boolean } = {},
  ): Promise<T> {
    const retry = opts.retry ?? method === 'GET';
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(`${this.#base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.#token}`,
            accept: 'application/json',
            ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...opts.headers,
          },
          ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        });
      } catch (err) {
        if (retry && attempt < this.#retries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw err;
      }
      if (res.ok) {
        if (opts.raw) return new Uint8Array(await res.arrayBuffer()) as T;
        return (res.status === 204 ? undefined : await res.json()) as T;
      }
      const body = (await res.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
        request_id?: string;
        retryable?: boolean;
        safe_details?: Record<string, unknown>;
      };
      const transient = res.status === 429 || res.status >= 500 || body.code === 'IDEMPOTENCY_IN_PROGRESS';
      if (retry && transient && attempt < this.#retries) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : backoff(attempt));
        continue;
      }
      throw new ApiError(
        res.status,
        body.code ?? 'UNKNOWN',
        body.message ?? res.statusText,
        body.request_id ?? null,
        body.retryable ?? false,
        body.safe_details ?? {},
      );
    }
  }

  /** The calling token: scopes, restrictions, expiry. */
  readonly token = {
    current: () => this.request<ApiToken>('GET', '/api-tokens/current'),
  };

  readonly profiles = {
    list: (q: { q?: string; client_id?: string; cursor?: string; limit?: number } = {}) =>
      this.request<Page<Profile>>('GET', `/profiles${query(q)}`),
    get: (id: string) => this.request<Profile>('GET', `/profiles/${encodeURIComponent(id)}`),
    create: (body: { name: string; client_id?: string | null; notes?: string }) =>
      this.request<Profile>('POST', '/profiles', { body }),
    update: (
      id: string,
      version: number,
      body: { name?: string; notes?: string; client_id?: string | null },
    ) =>
      this.request<Profile>('PATCH', `/profiles/${encodeURIComponent(id)}`, {
        body: { ...body, expected_version: version },
      }),
    /** Moves the profile to the trash (restorable by an owner or admin in the app). */
    trash: (id: string, version: number) =>
      this.request<void>('DELETE', `/profiles/${encodeURIComponent(id)}`, {
        headers: { 'if-match': `"${version}"` },
      }),
  };

  readonly clients = {
    list: (q: { cursor?: string; limit?: number } = {}) =>
      this.request<Page<{ id: string; name: string; colour: string | null }>>('GET', `/clients${query(q)}`),
  };

  readonly automation = {
    settings: () => this.request<AutomationSettings>('GET', '/automation/settings'),
    agents: () => this.request<{ items: Agent[] }>('GET', '/automation/agents'),
  };

  readonly jobs = {
    /**
     * Asks for a job. Pass your own `idempotencyKey` (stored with your record) to make retries across process
     * restarts safe; otherwise one is generated for this call and its retries.
     */
    create: (body: JobCreate, opts: { idempotencyKey?: string } = {}) =>
      this.request<JobDetail>('POST', '/automation/jobs', {
        body,
        headers: { 'idempotency-key': opts.idempotencyKey ?? newIdempotencyKey() },
        retry: true,
      }),
    get: (id: string) => this.request<JobDetail>('GET', `/automation/jobs/${encodeURIComponent(id)}`),
    list: (
      q: {
        state?: JobState | 'active' | 'finished';
        profile_id?: string;
        mine?: boolean;
        cursor?: string;
        limit?: number;
      } = {},
    ) => this.request<Page<Job>>('GET', `/automation/jobs${query(q)}`),
    /** A queued job ends at once; a running one closes its profile safely (a kept-open profile: a stop). */
    cancel: (id: string, reason?: string) =>
      this.request<Job>('POST', `/automation/jobs/${encodeURIComponent(id)}/cancel`, {
        body: reason ? { reason } : {},
      }),
    /** Polls until the job finished (or `until` says so). */
    wait: async (
      id: string,
      opts: {
        timeoutMs?: number;
        intervalMs?: number;
        signal?: AbortSignal;
        until?: (d: JobDetail) => boolean;
      } = {},
    ): Promise<JobDetail> => {
      const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
      for (;;) {
        const d = await this.jobs.get(id);
        if (opts.until ? opts.until(d) : FINISHED.includes(d.job.state)) return d;
        if (Date.now() > deadline) throw new Error(`job ${id} did not finish in time (state ${d.job.state})`);
        await sleep(opts.intervalMs ?? 2000, opts.signal);
      }
    },
    /** A screenshot's bytes (JPEG or PNG). */
    screenshot: (jobId: string, artifactId: string) =>
      this.request<Uint8Array>(
        'GET',
        `/automation/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { raw: true },
      ),
  };
}

function query(q: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

function backoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2);
}

// ---------------------------------------------------------------- debugging sessions (Playwright)
/**
 * A capability for a debugging job: keep `secret` on the computer that will run Playwright; send only `sha256`
 * (`debug: { capability_sha256 }`). The computer running the job accepts a connection only with this secret.
 */
export async function newDebugCapability(): Promise<{ secret: string; sha256: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = `pbcap_${base64url(bytes)}`;
  return { secret, sha256: await sha256Hex(secret) };
}

/** The loopback endpoint a debugging job reported (its `debug_bridge` step), or null while it is not ready. */
export function debugEndpoint(detail: JobDetail): string | null {
  const step = detail.steps.find((s) => s.action === 'debug_bridge');
  return step?.state === 'succeeded' && step.output?.endpoint ? step.output.endpoint : null;
}

/**
 * Connects Playwright (`import { chromium } from 'playwright-core'`) to a debugging job's session, on the computer
 * running the job. The browser stays the job's: close the job (cancel) to close it; `browser.close()` here only
 * disconnects.
 */
export async function connectPlaywright<B>(
  chromium: { connectOverCDP(endpoint: string, options: { headers: Record<string, string> }): Promise<B> },
  endpoint: string,
  secret: string,
): Promise<B> {
  if (!/^ws:\/\/127\.0\.0\.1:\d{1,5}\/cdp\/job_[0-9A-HJKMNP-TV-Z]{26}$/.test(endpoint)) {
    throw new Error('not a debugging endpoint of a job on this computer');
  }
  return chromium.connectOverCDP(endpoint, { headers: { authorization: `Bearer ${secret}` } });
}

// ---------------------------------------------------------------- webhooks
export interface WebhookEnvelope<T = Record<string, unknown>> {
  type: WebhookEvent | 'webhook.test';
  timestamp: string;
  data: T;
}

/**
 * Verifies a webhook (Standard Webhooks): the `webhook-signature` must match the HMAC-SHA256 of
 * `<webhook-id>.<webhook-timestamp>.<raw body>` with your endpoint secret (`whsec_…`), and the timestamp must be
 * within `toleranceSeconds` (default 300) of now. Pass the raw body exactly as received. During a secret rotation the
 * header carries two signatures; either may match.
 */
export async function verifyWebhook(
  secret: string,
  headers: Record<string, string | string[] | undefined> | Headers,
  rawBody: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): Promise<boolean> {
  const get = (k: string) => {
    const v = headers instanceof Headers ? headers.get(k) : headers[k];
    return Array.isArray(v) ? v[0] : (v ?? undefined);
  };
  const id = get('webhook-id');
  const ts = Number(get('webhook-timestamp'));
  const sigs = get('webhook-signature');
  if (!id || !Number.isInteger(ts) || !sigs || !secret.startsWith('whsec_')) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (opts.toleranceSeconds ?? 300)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    base64Bytes(secret.slice('whsec_'.length)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${rawBody}`)),
  );
  return sigs.split(' ').some((s) => {
    const [version, value] = s.split(',');
    if (version !== 'v1' || !value) return false;
    let got: Uint8Array;
    try {
      got = base64Bytes(value);
    } catch {
      return false;
    }
    return constantTimeEqual(got, expected);
  });
}

/** Parses a verified webhook body. */
export function parseWebhook<T = Record<string, unknown>>(rawBody: string): WebhookEnvelope<T> {
  return JSON.parse(rawBody) as WebhookEnvelope<T>;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function base64Bytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
