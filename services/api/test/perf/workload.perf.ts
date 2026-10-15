/**
 * R7 performance: the API's metadata reads and a realistic mixed workload over real HTTP (the API listening on
 * 127.0.0.1, PostgreSQL behind it), plus an optional soak. It measures THIS machine; the report names it. Targets
 * (proposals until measured on the declared hardware): metadata read p95 <= 250 ms in the primary region.
 *
 *   PB_PERF_SECONDS      seconds per phase (default 30)
 *   PB_PERF_CONCURRENCY  parallel clients (default 16)
 *   PB_PERF_PROFILES     profiles in the measured workspace (default 10000)
 *   PB_PERF_SOAK_MINUTES soak length, mixed workload with a p95 per minute (default 0: no soak)
 *   PB_PERF_OUT          JSON report path (default: printed only)
 */
import { writeFileSync } from 'node:fs';
import { cpus, freemem, hostname, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, harness, idemKey, internalPlan, type SignedIn } from '../helpers.ts';

const SECONDS = Number(process.env.PB_PERF_SECONDS ?? 30);
const CONCURRENCY = Number(process.env.PB_PERF_CONCURRENCY ?? 16);
const PROFILES = Number(process.env.PB_PERF_PROFILES ?? 10_000);
const SOAK_MINUTES = Number(process.env.PB_PERF_SOAK_MINUTES ?? 0);

let h: Harness;
let base = '';
let owner: SignedIn;
let orgId = '';
let ids: string[] = [];
const report: Record<string, unknown> = {};
const seen = new Set<string>();

const crockford = (n: number): string => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  do {
    out = alphabet[n % 32] + out;
    n = Math.floor(n / 32);
  } while (n > 0);
  return out.padStart(16, '0');
};

function stats(samples: number[], errors: number, seconds: number) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => Math.round((s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0) * 10) / 10;
  return {
    requests: s.length,
    errors,
    per_second: Math.round(s.length / seconds),
    p50_ms: q(0.5),
    p95_ms: q(0.95),
    p99_ms: q(0.99),
    max_ms: Math.round((s.at(-1) ?? 0) * 10) / 10,
  };
}

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const t = performance.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...owner.headers, ...(body ? { 'content-type': 'application/json' } : {}), ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (res.status >= 400) {
    const key = `${method} ${path.replace(/prf_[0-9A-Z]+|lse_[0-9A-Z]+|org_[0-9A-Z]+/g, ':id').split('?')[0]} ${res.status}`;
    if (!seen.has(key)) {
      seen.add(key);
      console.log(`  first ${key}: ${text.slice(0, 200)}`);
    }
  }
  return { ms: performance.now() - t, status: res.status, json: () => JSON.parse(text) };
}

function save() {
  if (process.env.PB_PERF_OUT) writeFileSync(process.env.PB_PERF_OUT, `${JSON.stringify(report, null, 2)}\n`);
}

/** Like the desktop app: a new access token before the old one (10 minutes) runs out. */
let refreshing: ReturnType<typeof setInterval> | null = null;
async function refreshToken() {
  const res = await fetch(`${base}/v1/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: owner.session.refresh_token }),
  });
  if (res.status !== 200) throw new Error(`refresh failed: ${res.status}`);
  const next = (await res.json()) as { access_token: string; refresh_token: string };
  owner.session.refresh_token = next.refresh_token;
  owner.headers.authorization = `Bearer ${next.access_token}`;
}

/** Runs `op` from CONCURRENCY clients for `seconds`; each op returns its own timings. */
type Sample = { ms: number; ok: boolean; label?: string | undefined };
function phase(name: string, seconds: number, op: (i: number) => Promise<Sample[]>) {
  return phaseWith(CONCURRENCY, name, seconds, op);
}
async function phaseWith(
  clients: number,
  name: string,
  seconds: number,
  op: (i: number) => Promise<Sample[]>,
) {
  const samples: number[] = [];
  const byLabel = new Map<string, number[]>();
  let errors = 0;
  const end = Date.now() + seconds * 1000;
  let n = 0;
  await Promise.all(
    Array.from({ length: clients }, async () => {
      while (Date.now() < end) {
        for (const r of await op(n++)) {
          samples.push(r.ms);
          if (r.label) byLabel.set(r.label, [...(byLabel.get(r.label) ?? []), r.ms]);
          if (!r.ok) errors++;
        }
      }
    }),
  );
  const out: Record<string, unknown> = stats(samples, errors, seconds);
  if (byLabel.size > 0) {
    out.by_request = Object.fromEntries(
      [...byLabel].map(([k, v]) => {
        const { p50_ms, p95_ms, p99_ms } = stats(v, 0, seconds);
        return [k, { p50_ms, p95_ms, p99_ms }];
      }),
    );
  }
  report[name] = out;
  console.log(`${name.padEnd(28)} ${JSON.stringify(out)}`);
  save();
  return out;
}

const reads = async (i: number) => {
  const pick = ids[(i * 7919) % ids.length];
  const r = await Promise.all([
    call('GET', `/v1/orgs/${orgId}/profiles?limit=50`),
    call(
      'GET',
      `/v1/orgs/${orgId}/profiles?limit=50&q=${encodeURIComponent(`Profile ${(i * 31) % PROFILES}`)}`,
    ),
    call('GET', `/v1/orgs/${orgId}/profiles/${pick}`),
    call('GET', '/v1/me/workspaces'),
  ]);
  const labels = ['list 50 of 10,000', 'search by name', 'one profile', 'my workspaces'];
  return r.map((x, k): Sample => ({ ms: x.ms, ok: x.status === 200, label: labels[k] ?? 'read' }));
};

/** Open a profile, renew twice, close it, plus a list read: what a desktop does around a session. */
const sessionCycle = async (i: number) => {
  const profile = ids[(i * 104729) % ids.length];
  const out: { ms: number; ok: boolean }[] = [];
  const open = await call(
    'POST',
    `/v1/orgs/${orgId}/profiles/${profile}/leases`,
    { device_id: owner.session.device.id, platform: 'windows-x64', browser_version: '155.0.8059.39' },
    { 'idempotency-key': idemKey() },
  );
  out.push({ ms: open.ms, ok: open.status === 201 || open.status === 409 });
  if (open.status === 201) {
    const l = open.json().lease;
    for (let k = 0; k < 2; k++) {
      const hb = await call('POST', `/v1/orgs/${orgId}/profiles/${profile}/leases/${l.id}/heartbeat`, {
        fencing_token: l.fencing_token,
      });
      out.push({ ms: hb.ms, ok: hb.status === 200 });
    }
    const rel = await call('POST', `/v1/orgs/${orgId}/profiles/${profile}/leases/${l.id}/release`, {
      fencing_token: l.fencing_token,
      outcome: 'closed',
    });
    out.push({ ms: rel.ms, ok: rel.status === 200 || rel.status === 204 });
  }
  const list = await call('GET', `/v1/orgs/${orgId}/profiles?limit=50`);
  out.push({ ms: list.ms, ok: list.status === 200 });
  return out;
};

beforeAll(async () => {
  h = await harness({ poolMax: Math.max(20, CONCURRENCY + 4) });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = h.app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  owner = await h.signIn();
  orgId = (
    await h.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Performance' },
    })
  ).json().id;
  await internalPlan(h.owner, orgId);
  const t = performance.now();
  const imported = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${orgId}/local-import`,
    headers: { ...owner.headers, 'idempotency-key': idemKey() },
    payload: {
      dry_run: false,
      clients: [{ ref: 'bulk', name: 'Bulk client' }],
      profiles: Array.from({ length: PROFILES }, (_, i) => ({
        local_id: `prf_01J9ZPERF0${crockford(i)}`,
        name: `Profile ${i}`,
        client_ref: 'bulk',
      })),
    },
  });
  expect(imported.statusCode, imported.body.slice(0, 300)).toBe(201);
  ids = (imported.json().profiles as { profile_id: string | null }[])
    .map((p) => p.profile_id ?? '')
    .filter(Boolean);
  refreshing = setInterval(() => void refreshToken().catch((e) => console.error(e)), 4 * 60_000);
  report.setup = { profiles: ids.length, import_ms: Math.round(performance.now() - t) };
  const cpu = cpus();
  report.machine = {
    host: hostname(),
    os: `${process.platform} ${release()}`,
    cpu: `${cpu.length} × ${cpu[0]?.model ?? '?'}`,
    memory_gb: Math.round(totalmem() / 2 ** 30),
    free_memory_gb_at_start: Math.round((freemem() / 2 ** 30) * 10) / 10,
    node: process.version,
    database: (await h.owner.query<{ v: string }>("select current_setting('server_version') as v")).rows[0]
      ?.v,
    concurrency: CONCURRENCY,
    seconds_per_phase: SECONDS,
  };
}, 600_000);

afterAll(async () => {
  if (refreshing) clearInterval(refreshing);
  report.generated_at = new Date().toISOString();
  save();
  await h?.close();
});

describe('API performance (R7)', () => {
  it('metadata reads over a 10,000-profile workspace', async () => {
    await phase('warm-up', Math.min(5, SECONDS), reads);
    const r = await phase('metadata_reads', SECONDS, reads);
    expect(r.errors).toBe(0);
  });

  it('metadata reads at light load (4 clients, one request at a time)', async () => {
    // Each client: the four reads one after another (what one person's app does), four people at once.
    const sequential = async (i: number): Promise<Sample[]> => {
      const pick = ids[(i * 7919) % ids.length];
      const out: Sample[] = [];
      for (const [label, path] of [
        ['list 50 of 10,000', `/v1/orgs/${orgId}/profiles?limit=50`],
        [
          'search by name',
          `/v1/orgs/${orgId}/profiles?limit=50&q=${encodeURIComponent(`Profile ${(i * 31) % PROFILES}`)}`,
        ],
        ['one profile', `/v1/orgs/${orgId}/profiles/${pick}`],
        ['my workspaces', '/v1/me/workspaces'],
      ] as const) {
        const x = await call('GET', path);
        out.push({ ms: x.ms, ok: x.status === 200, label });
      }
      return out;
    };
    const r = await phaseWith(4, 'metadata_reads_light', SECONDS, sequential);
    expect(r.errors).toBe(0);
  });

  it('mixed session workload (open, renew, close, list)', async () => {
    const r = await phase('session_cycle', SECONDS, sessionCycle);
    expect(r.errors).toBe(0);
  });

  it.runIf(SOAK_MINUTES > 0)('soak: mixed workload, p95 per minute and process memory', async () => {
    const minutes: unknown[] = [];
    for (let m = 0; m < SOAK_MINUTES; m++) {
      const r = await phase(`soak_minute_${m + 1}`, 60, async (i) => [
        ...(await sessionCycle(i)),
        ...(await reads(i)),
      ]);
      minutes.push({ minute: m + 1, ...r, rss_mb: Math.round(process.memoryUsage().rss / 2 ** 20) });
      delete report[`soak_minute_${m + 1}`];
    }
    report.soak = minutes;
    expect(minutes.every((x) => (x as { errors: number }).errors === 0)).toBe(true);
  });
});
