/**
 * Milestone 06 exit gate: organization, client, profile, member, invitation, grant and snapshot ids are swapped across
 * tenants on every endpoint, including bulk, search, export and download paths. Every swap must answer exactly like a
 * nonexistent id (same status, code and message: nothing is disclosed) and must leave the other tenant unchanged.
 * Also: pooled connections never carry one request's tenant context into the next, and same-organization references
 * are enforced by the database itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES, fx } from '../src/fixtures.ts';
import { type Harness, harness, idemKey } from './helpers.ts';
import { backup } from './sync-helpers.ts';

const { acme, beta } = FIXTURES.orgs;
const ACME = {
  org: acme.id,
  client: FIXTURES.clients.acmeNorth.id,
  profile: FIXTURES.profiles.acmeShop.id,
  user: FIXTURES.users.acmeViewer.id,
};
const MISSING = {
  org: fx('org', 'ZZZZ'),
  client: fx('cli', 'ZZZZ'),
  profile: fx('prf', 'ZZZZ'),
  user: fx('usr', 'ZZZZ'),
  invitation: fx('inv', 'ZZZZ'),
  grant: fx('grt', 'ZZZZ'),
  snapshot: fx('snp', 'ZZZZ'),
  operation: fx('syn', 'ZZZZ'),
  lease: fx('lse', 'ZZZZ'),
  request: fx('hrq', 'ZZZZ'),
  task: fx('tsk', 'ZZZZ'),
  bookmark: fx('bkm', 'ZZZZ'),
  token: fx('tok', 'ZZZZ'),
  agent: fx('agt', 'ZZZZ'),
  job: fx('job', 'ZZZZ'),
  artifact: fx('art', 'ZZZZ'),
  webhook: fx('whk', 'ZZZZ'),
  delivery: fx('dlv', 'ZZZZ'),
  seq: '2',
  invoice: 'in_MISSINGZZZZ',
  folder: fx('fld', 'ZZZZ'),
  run: fx('mgr', 'ZZZZ'),
};
type Ids = typeof MISSING;
const FOREIGN: Ids = {
  org: beta.id,
  client: FIXTURES.clients.betaInternal.id,
  profile: FIXTURES.profiles.betaSupport.id,
  user: FIXTURES.users.betaOwner.id,
  invitation: '',
  grant: '',
  snapshot: '',
  operation: '',
  lease: '',
  request: '',
  task: '',
  bookmark: '',
  token: '',
  agent: '',
  job: '',
  artifact: fx('art', 'B1A1'),
  webhook: '',
  delivery: fx('dlv', 'B1D1'),
  seq: '2',
  invoice: 'in_BETAFOREIGN1',
  folder: '',
  run: '',
};

let h: Harness;
let attacker: Record<string, string>;
let betaOwner: Record<string, string>;
let acmeSnapshot = '';
let acmeOperation = '';

/** Everything the beta tenant owns, as one digest (any change anywhere changes it). */
async function betaState(): Promise<string> {
  const tables = [
    'organizations o where o.id = $1',
    'memberships o where o.org_id = $1',
    'clients o where o.org_id = $1',
    'profiles o where o.org_id = $1',
    'invitations o where o.org_id = $1',
    'permission_grants o where o.org_id = $1',
    'profile_leases o where o.org_id = $1',
    'snapshot_manifests o where o.org_id = $1',
    'sync_operations o where o.org_id = $1',
    'organization_key_versions o where o.org_id = $1',
    'lease_history o where o.org_id = $1',
    'handoff_requests o where o.org_id = $1',
    'client_tasks o where o.org_id = $1',
    'client_bookmarks o where o.org_id = $1',
    'extension_policies o where o.org_id = $1',
    'extension_reports o where o.org_id = $1',
    'api_tokens o where o.org_id = $1',
    'automation_settings o where o.org_id = $1',
    'automation_agents o where o.org_id = $1',
    'automation_jobs o where o.org_id = $1',
    'job_steps o where o.org_id = $1',
    'job_artifacts o where o.org_id = $1',
    'webhook_endpoints o where o.org_id = $1',
    'webhook_deliveries o where o.org_id = $1',
    // R1 (ADR-0020)
    'folders o where o.org_id = $1',
    'profile_folders o where o.org_id = $1',
    'feature_settings o where o.org_id = $1',
    'profile_identity_map o where o.org_id = $1',
    'migration_runs o where o.org_id = $1',
  ];
  const parts: string[] = [];
  for (const t of tables) {
    const { rows } = await h.owner.query(
      `select coalesce(md5(string_agg(o::text, '|' order by o::text)), '-') as d from ${t}`,
      [beta.id],
    );
    parts.push(rows[0].d);
  }
  return parts.join(':');
}

const strip = (body: Record<string, unknown>) => ({ ...body, request_id: undefined });

beforeAll(async () => {
  h = await harness();
  attacker = await h.auth('acmeOwner');
  betaOwner = await h.auth('betaOwner');
  // Beta resources that only exist through the API: an invitation, a grant and a snapshot.
  FOREIGN.invitation = (
    await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${beta.id}/invitations`,
      headers: betaOwner,
      payload: { email: 'beta-invitee@people.test', role: 'viewer' },
    })
  ).json().invitation.id;
  FOREIGN.grant = (
    await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${beta.id}/grants`,
      headers: betaOwner,
      payload: { user_id: FIXTURES.users.betaOwner.id, client_id: FIXTURES.clients.betaInternal.id },
    })
  ).json().id;
  const foreign = await snapshotOf(beta.id, FOREIGN.profile, FIXTURES.devices.betaOwnerLaptop.id, betaOwner);
  FOREIGN.snapshot = foreign.snapshot;
  FOREIGN.operation = foreign.operation;
  const own = await snapshotOf(acme.id, ACME.profile, FIXTURES.devices.acmeOwnerLaptop.id, attacker);
  acmeSnapshot = own.snapshot;
  acmeOperation = own.operation;
  // Milestone 08: a beta session lease (released, so the beta profile stays usable) and an access request.
  const opened = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${beta.id}/profiles/${FOREIGN.profile}/leases`,
    headers: { ...betaOwner, 'idempotency-key': idemKey() },
    payload: {
      device_id: FIXTURES.devices.betaOwnerLaptop.id,
      platform: 'windows-x64',
      browser_version: '155.0.1.2',
    },
  });
  expect(opened.statusCode).toBe(201);
  FOREIGN.lease = opened.json().lease.id;
  const released = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${beta.id}/profiles/${FOREIGN.profile}/leases/${FOREIGN.lease}/release`,
    headers: betaOwner,
    payload: { fencing_token: opened.json().lease.fencing_token, outcome: 'closed' },
  });
  expect(released.statusCode).toBe(204);
  FOREIGN.request = fx('hrq', 'B1R1');
  await h.owner.query(
    `insert into handoff_requests (id, org_id, profile_id, requested_by, holder_user_id, note, status, expires_at)
     values ($1, $2, $3, $4, $4, '', 'open', now() + interval '1 hour') on conflict do nothing`,
    [FOREIGN.request, beta.id, FOREIGN.profile, FIXTURES.users.betaOwner.id],
  );
  // Milestone 09: a beta task, bookmark, extension rule and extension report.
  const task = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${beta.id}/clients/${FOREIGN.client}/tasks`,
    headers: betaOwner,
    payload: { title: 'Beta task', profile_id: FOREIGN.profile },
  });
  expect(task.statusCode, task.body).toBe(201);
  FOREIGN.task = task.json().id;
  const bookmark = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${beta.id}/clients/${FOREIGN.client}/bookmarks`,
    headers: betaOwner,
    payload: { title: 'Beta desk', url: 'https://desk.beta.example/' },
  });
  expect(bookmark.statusCode, bookmark.body).toBe(201);
  FOREIGN.bookmark = bookmark.json().id;
  const policy = await h.app.inject({
    method: 'GET',
    url: `/v1/orgs/${beta.id}/extension-policy`,
    headers: betaOwner,
  });
  const rule = { name: 'Beta tool', decision: 'allowed', source: 'web_store', approved_version_range: null };
  expect(
    (
      await h.app.inject({
        method: 'PUT',
        url: `/v1/orgs/${beta.id}/extension-policy`,
        headers: betaOwner,
        payload: {
          mode: 'warn',
          expected_version: policy.json().version,
          extensions: [{ ...rule, extension_id: 'b'.repeat(32), permissions: [] }],
        },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await h.app.inject({
        method: 'PUT',
        url: `/v1/orgs/${beta.id}/profiles/${FOREIGN.profile}/extension-report`,
        headers: betaOwner,
        payload: {
          device_id: FIXTURES.devices.betaOwnerLaptop.id,
          extensions: [
            {
              id: 'b'.repeat(32),
              name: 'Beta tool',
              version: '1',
              source: 'web_store',
              enabled: true,
              permissions: [],
            },
          ],
        },
      })
    ).statusCode,
  ).toBe(204);
  // Milestone 10: a beta API token, approved sites, computer, job (with a screenshot), webhook and delivery.
  const tok = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${beta.id}/api-tokens`,
    headers: betaOwner,
    payload: { name: 'Beta integration', scopes: ['profiles:read'], expires_in_days: 30 },
  });
  expect(tok.statusCode, tok.body).toBe(201);
  FOREIGN.token = tok.json().token.id;
  const agent = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${beta.id}/automation/agents`,
    headers: betaOwner,
    payload: { device_id: FIXTURES.devices.betaOwnerLaptop.id },
  });
  expect(agent.statusCode, agent.body).toBe(201);
  FOREIGN.agent = agent.json().id;
  const job = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${beta.id}/automation/jobs`,
    headers: { ...betaOwner, 'idempotency-key': idemKey() },
    payload: { profile_id: FOREIGN.profile, steps: [], keep_open_minutes: 5 },
  });
  expect(job.statusCode, job.body).toBe(201);
  FOREIGN.job = job.json().job.id;
  await h.owner.query(
    `insert into job_artifacts (id, org_id, job_id, sequence, content_type, bytes, sha256, width, height)
     values ($1, $2, $3, 1, 'image/jpeg', '\\xffd8ffe0'::bytea, $4, 1, 1)`,
    [FOREIGN.artifact, beta.id, FOREIGN.job, 'a'.repeat(64)],
  );
  const hook = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${beta.id}/webhook-endpoints`,
    headers: betaOwner,
    payload: { url: 'https://hooks.beta.example/pb', events: ['automation.job.failed'] },
  });
  expect(hook.statusCode, hook.body).toBe(201);
  FOREIGN.webhook = hook.json().endpoint.id;
  // Milestone 11: an invoice of the other organization (mirrored provider data).
  await h.owner.query(
    `insert into billing_invoices (id, org_id, status, currency, amount_due, amount_paid, provider_created_at)
     values ($1, $2, 'paid', 'usd', 1000, 1000, now()) on conflict do nothing`,
    [FOREIGN.invoice, beta.id],
  );
  await h.owner.query(
    `insert into webhook_deliveries (id, org_id, endpoint_id, event_id, event_type, event_created_at, payload, state,
                                     next_attempt_at)
     values ($1, $2, $3, $4, 'automation.job.failed', now(), '{}', 'dead', null)`,
    [FOREIGN.delivery, beta.id, FOREIGN.webhook, fx('evt', 'B1E1')],
  );
  // R1: a beta folder and migration run.
  const folder = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${beta.id}/folders`,
    headers: betaOwner,
    payload: { name: 'Beta folder' },
  });
  expect(folder.statusCode, folder.body).toBe(201);
  FOREIGN.folder = folder.json().id;
  const run = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${beta.id}/migration-runs`,
    headers: betaOwner,
    payload: {
      device_id: FIXTURES.devices.betaOwnerLaptop.id,
      manifest_digest: 'b'.repeat(64),
      state: 'planned',
    },
  });
  expect(run.statusCode, run.body).toBe(201);
  FOREIGN.run = run.json().id;
});
afterAll(async () => {
  await h.close();
});

/** A committed snapshot (the whole device flow, see sync-helpers.ts). */
async function snapshotOf(org: string, profile: string, device: string, headers: Record<string, string>) {
  const current = await h.app.inject({ method: 'GET', url: `/v1/orgs/${org}/profiles/${profile}`, headers });
  const done = await backup(h, { headers, org, profile, device, base: current.json().snapshot_version });
  expect(done.operation.state).toBe('committed');
  return { snapshot: done.init.key.snapshot_id, operation: done.init.operation.id };
}

interface Req {
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}

const commitBody = {
  fencing_token: '1',
  digest: 'd'.repeat(64),
  ciphertext_size: 10,
  plaintext_size: 10,
  parts: [{ part_number: 1, etag: 'x' }],
};

/** Every organization-scoped endpoint, addressed at organization `o` (resource ids from that organization). */
function orgEndpoints(o: string, ids: Ids): Req[] {
  const base = `/v1/orgs/${o}`;
  const p = `${base}/profiles/${ids.profile}`;
  return [
    { name: 'get organization', method: 'GET', url: base },
    { name: 'rename organization', method: 'PATCH', url: base, payload: { name: 'x', expected_version: 1 } },
    { name: 'list members', method: 'GET', url: `${base}/members` },
    {
      name: 'change member',
      method: 'PATCH',
      url: `${base}/members/${ids.user}`,
      payload: { role: 'viewer', expected_version: 1 },
    },
    { name: 'remove member', method: 'DELETE', url: `${base}/members/${ids.user}` },
    {
      name: 'transfer ownership',
      method: 'POST',
      url: `${base}/ownership-transfer`,
      payload: { user_id: ids.user, expected_version: 1 },
    },
    {
      name: 'invite',
      method: 'POST',
      url: `${base}/invitations`,
      payload: { email: 'x@people.test', role: 'viewer' },
    },
    { name: 'list invitations', method: 'GET', url: `${base}/invitations` },
    { name: 'revoke invitation', method: 'POST', url: `${base}/invitations/${ids.invitation}/revoke` },
    { name: 'list clients', method: 'GET', url: `${base}/clients` },
    { name: 'create client', method: 'POST', url: `${base}/clients`, payload: { name: 'Hijack' } },
    { name: 'get client', method: 'GET', url: `${base}/clients/${ids.client}` },
    {
      name: 'edit client',
      method: 'PATCH',
      url: `${base}/clients/${ids.client}`,
      payload: { name: 'x', expected_version: 1 },
    },
    { name: 'list grants', method: 'GET', url: `${base}/grants` },
    {
      name: 'grant client',
      method: 'POST',
      url: `${base}/grants`,
      payload: { user_id: ids.user, client_id: ids.client },
    },
    { name: 'remove grant', method: 'DELETE', url: `${base}/grants/${ids.grant}` },
    {
      name: 'change grant capabilities',
      method: 'PATCH',
      url: `${base}/grants/${ids.grant}`,
      payload: { capabilities: ['launch'] },
    },
    { name: 'list profiles', method: 'GET', url: `${base}/profiles` },
    { name: 'search profiles', method: 'GET', url: `${base}/profiles?q=Support&client_id=${ids.client}` },
    {
      name: 'create profile',
      method: 'POST',
      url: `${base}/profiles`,
      payload: { name: 'x', client_id: ids.client },
    },
    { name: 'export profiles', method: 'GET', url: `${base}/profiles/export` },
    {
      name: 'bulk delete',
      method: 'POST',
      url: `${base}/profiles/bulk`,
      payload: { action: 'delete', profile_ids: [ids.profile] },
    },
    { name: 'get profile', method: 'GET', url: p },
    { name: 'edit profile', method: 'PATCH', url: p, payload: { name: 'x', expected_version: 1 } },
    { name: 'delete profile', method: 'DELETE', url: p, headers: { 'if-match': '"1"' } },
    { name: 'get lease', method: 'GET', url: `${p}/lease` },
    {
      name: 'acquire lease',
      method: 'POST',
      url: `${p}/lease`,
      headers: { 'idempotency-key': idemKey() },
      payload: { device_id: FIXTURES.devices.acmeOwnerLaptop.id },
    },
    { name: 'renew lease', method: 'POST', url: `${p}/lease/renew`, payload: { fencing_token: '1' } },
    { name: 'release lease', method: 'POST', url: `${p}/lease/release`, payload: { fencing_token: '1' } },
    // Milestone 08: sessions and handoff.
    { name: 'current session', method: 'GET', url: `${p}/leases/current` },
    {
      name: 'open session',
      method: 'POST',
      url: `${p}/leases`,
      headers: { 'idempotency-key': idemKey() },
      payload: {
        device_id: FIXTURES.devices.acmeOwnerLaptop.id,
        platform: 'linux-x64',
        browser_version: '1.0',
      },
    },
    {
      name: 'heartbeat',
      method: 'POST',
      url: `${p}/leases/${ids.lease}/heartbeat`,
      payload: { fencing_token: '1', run_state: 'running' },
    },
    {
      name: 'release session',
      method: 'POST',
      url: `${p}/leases/${ids.lease}/release`,
      payload: { fencing_token: '1', outcome: 'closed' },
    },
    { name: 'ask for the profile', method: 'POST', url: `${p}/handoff-requests`, payload: { note: 'hi' } },
    { name: 'requests for the profile', method: 'GET', url: `${p}/handoff-requests` },
    { name: 'my requests', method: 'GET', url: `${base}/handoff-requests?mine=true` },
    { name: 'decline request', method: 'POST', url: `${p}/handoff-requests/${ids.request}/decline` },
    { name: 'cancel request', method: 'POST', url: `${p}/handoff-requests/${ids.request}/cancel` },
    {
      name: 'force takeover',
      method: 'POST',
      url: `${p}/force-takeover`,
      payload: { reason: 'swap test', confirm: true },
    },
    { name: 'recovery copies', method: 'GET', url: `${base}/recovery-copies` },
    { name: 'list snapshots', method: 'GET', url: `${p}/snapshots` },
    {
      name: 'start snapshot upload',
      method: 'POST',
      url: `${p}/snapshots/init`,
      headers: { 'idempotency-key': idemKey() },
      payload: { base_version: 0, fencing_token: '1', platform: 'linux-x64', browser_version: '1' },
    },
    {
      name: 'part upload urls',
      method: 'POST',
      url: `${p}/snapshots/${ids.snapshot}/parts`,
      payload: { part_numbers: [1] },
    },
    { name: 'uploaded parts', method: 'GET', url: `${p}/snapshots/${ids.snapshot}/parts` },
    {
      name: 'commit snapshot',
      method: 'POST',
      url: `${p}/snapshots/${ids.snapshot}/commit`,
      payload: commitBody,
    },
    { name: 'cancel upload', method: 'POST', url: `${p}/snapshots/${ids.snapshot}/cancel` },
    { name: 'sync operation', method: 'GET', url: `${base}/sync-operations/${ids.operation}` },
    {
      name: 'restore plan',
      method: 'POST',
      url: `${p}/restore-plans`,
      payload: { snapshot_id: ids.snapshot },
    },
    { name: 'undelete profile', method: 'POST', url: `${p}/undelete` },
    { name: 'backup policy', method: 'GET', url: `${base}/backup-policy` },
    {
      name: 'change backup policy',
      method: 'PATCH',
      url: `${base}/backup-policy`,
      payload: { retention_days: 7 },
    },
    { name: 'trash', method: 'GET', url: `${base}/trash` },
    { name: 'key versions', method: 'GET', url: `${base}/keys` },
    { name: 'rotate key', method: 'POST', url: `${base}/keys/rotate` },
    { name: 'audit log', method: 'GET', url: `${base}/audit-events` },
    // Milestone 09: client dashboard, tasks, bookmarks and the extension policy.
    { name: 'client dashboard', method: 'GET', url: `${base}/clients/${ids.client}/dashboard` },
    { name: 'list tasks', method: 'GET', url: `${base}/clients/${ids.client}/tasks` },
    {
      name: 'add task',
      method: 'POST',
      url: `${base}/clients/${ids.client}/tasks`,
      payload: { title: 'x', profile_id: ids.profile, assignee_id: ids.user },
    },
    {
      name: 'edit task',
      method: 'PATCH',
      url: `${base}/clients/${ids.client}/tasks/${ids.task}`,
      payload: { title: 'x', expected_version: 1 },
    },
    { name: 'delete task', method: 'DELETE', url: `${base}/clients/${ids.client}/tasks/${ids.task}` },
    { name: 'list bookmarks', method: 'GET', url: `${base}/clients/${ids.client}/bookmarks` },
    {
      name: 'add bookmark',
      method: 'POST',
      url: `${base}/clients/${ids.client}/bookmarks`,
      payload: { title: 'x', url: 'https://x.example/' },
    },
    {
      name: 'edit bookmark',
      method: 'PATCH',
      url: `${base}/clients/${ids.client}/bookmarks/${ids.bookmark}`,
      payload: { title: 'x', expected_version: 1 },
    },
    {
      name: 'delete bookmark',
      method: 'DELETE',
      url: `${base}/clients/${ids.client}/bookmarks/${ids.bookmark}`,
    },
    { name: 'extension policy', method: 'GET', url: `${base}/extension-policy` },
    {
      name: 'change extension policy',
      method: 'PUT',
      url: `${base}/extension-policy`,
      payload: { mode: 'enforce', extensions: [], expected_version: 1 },
    },
    {
      name: 'report extensions',
      method: 'PUT',
      url: `${p}/extension-report`,
      payload: { device_id: FIXTURES.devices.acmeOwnerLaptop.id, extensions: [] },
    },
    { name: 'extension inventory', method: 'GET', url: `${base}/extension-inventory` },
    // Milestone 10: automation, API tokens and webhooks.
    { name: 'automation settings', method: 'GET', url: `${base}/automation/settings` },
    {
      name: 'change automation settings',
      method: 'PUT',
      url: `${base}/automation/settings`,
      payload: { allowed_origins: [], expected_version: 1 },
    },
    { name: 'list jobs', method: 'GET', url: `${base}/automation/jobs?profile_id=${ids.profile}` },
    {
      name: 'ask for a job',
      method: 'POST',
      url: `${base}/automation/jobs`,
      headers: { 'idempotency-key': idemKey() },
      payload: { profile_id: ids.profile, steps: [], keep_open_minutes: 1, queue_timeout_seconds: 30 },
    },
    { name: 'get job', method: 'GET', url: `${base}/automation/jobs/${ids.job}` },
    { name: 'cancel job', method: 'POST', url: `${base}/automation/jobs/${ids.job}/cancel`, payload: {} },
    {
      name: 'job screenshot',
      method: 'GET',
      url: `${base}/automation/jobs/${ids.job}/artifacts/${ids.artifact}`,
    },
    {
      name: 'report on a job',
      method: 'POST',
      url: `${base}/automation/jobs/${ids.job}/report`,
      payload: { type: 'finished', attempt: 1, state: 'FAILED' },
    },
    {
      name: 'upload a screenshot',
      method: 'PUT',
      url: `${base}/automation/jobs/${ids.job}/steps/${ids.seq}/artifact?attempt=1&width=1&height=1`,
      headers: { 'content-type': 'image/jpeg' },
      payload: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
    },
    {
      name: 'enroll a computer',
      method: 'POST',
      url: `${base}/automation/agents`,
      payload: { device_id: FIXTURES.devices.acmeOwnerLaptop.id },
    },
    { name: 'list computers', method: 'GET', url: `${base}/automation/agents` },
    {
      name: 'change a computer',
      method: 'PATCH',
      url: `${base}/automation/agents/${ids.agent}`,
      payload: { enabled: false, expected_version: 1 },
    },
    { name: 'remove a computer', method: 'DELETE', url: `${base}/automation/agents/${ids.agent}` },
    {
      name: 'poll as a computer',
      method: 'POST',
      url: `${base}/automation/agents/${ids.agent}/poll`,
      payload: { running: [], capacity: 0, debug_allowed: false },
    },
    { name: 'list tokens', method: 'GET', url: `${base}/api-tokens` },
    {
      name: 'create a token',
      method: 'POST',
      url: `${base}/api-tokens`,
      payload: { name: 'x', scopes: ['profiles:read'], client_ids: [ids.client], expires_in_days: 1 },
    },
    { name: 'rotate a token', method: 'POST', url: `${base}/api-tokens/${ids.token}/rotate`, payload: {} },
    { name: 'revoke a token', method: 'DELETE', url: `${base}/api-tokens/${ids.token}` },
    { name: 'the calling token', method: 'GET', url: `${base}/api-tokens/current` },
    { name: 'list webhooks', method: 'GET', url: `${base}/webhook-endpoints` },
    {
      name: 'add a webhook',
      method: 'POST',
      url: `${base}/webhook-endpoints`,
      payload: { url: 'https://hooks.example.com/x', events: ['automation.job.failed'] },
    },
    { name: 'get a webhook', method: 'GET', url: `${base}/webhook-endpoints/${ids.webhook}` },
    {
      name: 'change a webhook',
      method: 'PATCH',
      url: `${base}/webhook-endpoints/${ids.webhook}`,
      payload: { state: 'disabled', expected_version: 1 },
    },
    { name: 'delete a webhook', method: 'DELETE', url: `${base}/webhook-endpoints/${ids.webhook}` },
    {
      name: 'rotate a webhook secret',
      method: 'POST',
      url: `${base}/webhook-endpoints/${ids.webhook}/rotate-secret`,
      payload: {},
    },
    { name: 'test a webhook', method: 'POST', url: `${base}/webhook-endpoints/${ids.webhook}/test` },
    { name: 'webhook deliveries', method: 'GET', url: `${base}/webhook-endpoints/${ids.webhook}/deliveries` },
    {
      name: 'redeliver',
      method: 'POST',
      url: `${base}/webhook-endpoints/${ids.webhook}/deliveries/${ids.delivery}/redeliver`,
    },
    {
      name: 'import local workspace',
      method: 'POST',
      url: `${base}/local-import`,
      payload: { dry_run: true, clients: [{ ref: 'a', name: 'A', map_to: ids.client }], profiles: [] },
    },
    // Milestone 11: billing.
    { name: 'subscription', method: 'GET', url: `${base}/billing/subscription` },
    { name: 'plans', method: 'GET', url: `${base}/billing/plans` },
    {
      name: 'checkout',
      method: 'POST',
      url: `${base}/billing/checkout-session`,
      payload: { plan_id: 'team' },
    },
    { name: 'billing portal', method: 'POST', url: `${base}/billing/portal-session` },
    { name: 'usage', method: 'GET', url: `${base}/billing/usage` },
    { name: 'invoices', method: 'GET', url: `${base}/billing/invoices` },
    { name: 'invoice links', method: 'GET', url: `${base}/billing/invoices/${ids.invoice}/links` },
    // R1 (ADR-0020): folders, feature settings, migration runs.
    { name: 'list folders', method: 'GET', url: `${base}/folders` },
    { name: 'create folder', method: 'POST', url: `${base}/folders`, payload: { name: 'Hijack' } },
    {
      name: 'rename folder',
      method: 'PATCH',
      url: `${base}/folders/${ids.folder}`,
      payload: { name: 'x', expected_version: 1 },
    },
    { name: 'file profile', method: 'PUT', url: `${p}/folder`, payload: { folder_id: ids.folder } },
    { name: 'feature settings', method: 'GET', url: `${base}/feature-settings` },
    {
      name: 'set feature settings',
      method: 'PUT',
      url: `${base}/feature-settings`,
      payload: { settings: [{ key: 'ui.unified_profiles', value: true }] },
    },
    {
      name: 'record migration run',
      method: 'POST',
      url: `${base}/migration-runs`,
      payload: {
        device_id: FIXTURES.devices.acmeOwnerLaptop.id,
        manifest_digest: 'a'.repeat(64),
        state: 'planned',
      },
    },
    { name: 'migration run', method: 'GET', url: `${base}/migration-runs/${ids.run}` },
    // R3 (ADR-0022): access in one step, folder move impact.
    {
      name: 'access preview',
      method: 'POST',
      url: `${base}/access/preview`,
      payload: { scope: { kind: 'all', include_future: true } },
    },
    {
      name: 'set member access',
      method: 'PUT',
      url: `${base}/members/${ids.user}/access`,
      payload: { scope: { kind: 'all', include_future: true } },
    },
    { name: 'folder move impact', method: 'GET', url: `${p}/folder-impact?folder_id=none` },
  ];
}

const send = (req: Req, headers = attacker) =>
  h.app.inject({
    method: req.method,
    url: req.url,
    headers: { ...headers, ...(req.headers ?? {}) },
    ...(req.payload ? { payload: req.payload } : {}),
  });

describe('coverage', () => {
  it('the swap lists include every organization-scoped route of the API', () => {
    const spec = h.app.swagger() as { paths: Record<string, Record<string, unknown>> };
    const routes = Object.entries(spec.paths)
      .filter(([path]) => path.startsWith('/v1/orgs/'))
      .flatMap(([path, ops]) => Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`));
    const placeholders: Ids = {
      org: '{orgId}',
      client: '{clientId}',
      profile: '{profileId}',
      user: '{userId}',
      invitation: '{invitationId}',
      grant: '{grantId}',
      snapshot: '{snapshotId}',
      operation: '{operationId}',
      lease: '{leaseId}',
      request: '{requestId}',
      task: '{taskId}',
      bookmark: '{bookmarkId}',
      token: '{tokenId}',
      agent: '{agentId}',
      job: '{jobId}',
      artifact: '{artifactId}',
      webhook: '{endpointId}',
      delivery: '{deliveryId}',
      seq: '{seq}',
      invoice: '{invoiceId}',
      folder: '{folderId}',
      run: '{id}',
    };
    const covered = new Set(
      orgEndpoints('{orgId}', placeholders).map((r) => `${r.method} ${r.url.split('?')[0]}`),
    );
    expect(routes.length).toBeGreaterThan(25);
    expect(routes.filter((r) => !covered.has(r))).toEqual([]);
  });
});

describe('another organization in the path', () => {
  const foreign = () => orgEndpoints(FOREIGN.org, FOREIGN);
  const missing = () => orgEndpoints(MISSING.org, MISSING);

  it('answers every endpoint exactly like an organization that does not exist, and changes nothing', async () => {
    const before = await betaState();
    const f = foreign();
    const m = missing();
    expect(f.length).toBeGreaterThanOrEqual(33);
    for (let i = 0; i < f.length; i++) {
      const a = await send(f[i] as Req);
      const b = await send(m[i] as Req);
      expect({ name: f[i]?.name, status: a.statusCode }).toEqual({ name: f[i]?.name, status: 404 });
      expect(strip(a.json())).toEqual(strip(b.json()));
    }
    expect(await betaState()).toBe(before);
  });
});

describe('another organization’s ids inside our own organization', () => {
  /** Endpoints of `acme` where exactly one id (of kind `kind`) is replaced. */
  const variants = (kind: keyof Ids, value: string) =>
    orgEndpoints(acme.id, {
      ...MISSING,
      ...ACME,
      invitation: MISSING.invitation,
      grant: MISSING.grant,
      snapshot: acmeSnapshot,
      operation: acmeOperation,
      lease: MISSING.lease,
      request: MISSING.request,
      task: MISSING.task,
      bookmark: MISSING.bookmark,
      token: MISSING.token,
      agent: MISSING.agent,
      job: MISSING.job,
      artifact: MISSING.artifact,
      webhook: MISSING.webhook,
      delivery: MISSING.delivery,
      folder: MISSING.folder,
      run: MISSING.run,
      [kind]: value,
    } as Ids);

  for (const kind of [
    'client',
    'profile',
    'user',
    'invitation',
    'grant',
    'snapshot',
    'operation',
    'lease',
    'request',
    'task',
    'bookmark',
    'token',
    'agent',
    'job',
    'artifact',
    'webhook',
    'delivery',
    'folder',
    'run',
  ] as const) {
    it(`${kind} ids answer like nonexistent ids on every endpoint that takes one`, async () => {
      const before = await betaState();
      const f = variants(kind, FOREIGN[kind]);
      const m = variants(kind, MISSING[kind]);
      let compared = 0;
      for (let i = 0; i < f.length; i++) {
        const fr = f[i] as Req;
        const mr = m[i] as Req;
        if (fr.url === mr.url && JSON.stringify(fr.payload) === JSON.stringify(mr.payload)) continue; // id not used
        const a = await send(fr);
        const b = await send(mr);
        compared++;
        expect({ name: fr.name, status: a.statusCode }).toEqual({ name: fr.name, status: b.statusCode });
        if (a.statusCode >= 400) {
          expect(strip(a.json())).toEqual(strip(b.json()));
        } else {
          // Lists, searches and bulk: the same answer as for an id that does not exist (bulk echoes the ids sent).
          const normalized = (body: unknown, id: string) =>
            JSON.stringify(body)
              .replaceAll(id, '<id>')
              .replace(/"exported_at":"[^"]+"/, '');
          expect(normalized(a.json(), FOREIGN[kind])).toBe(normalized(b.json(), MISSING[kind]));
        }
      }
      expect(compared).toBeGreaterThan(0);
      expect(await betaState()).toBe(before);
    });
  }

  it('bulk, search, export and filters never return or touch the other organization', async () => {
    const bulk = await send({
      name: 'bulk',
      method: 'POST',
      url: `/v1/orgs/${acme.id}/profiles/bulk`,
      payload: { action: 'set_client', client_id: null, profile_ids: [FOREIGN.profile, MISSING.profile] },
    });
    expect(bulk.json().results).toEqual([
      { id: FOREIGN.profile, outcome: 'not_found' },
      { id: MISSING.profile, outcome: 'not_found' },
    ]);
    const search = await send({
      name: 's',
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles?q=Support%20desk`,
    });
    expect(search.json().items).toEqual([]);
    // The export needs a recent sign-in (milestone 08): an acme admin who just signed in.
    const admin = await h.signIn();
    await h.owner.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'admin')", [
      acme.id,
      admin.session.user.id,
    ]);
    const exported = await send(
      { name: 'e', method: 'GET', url: `/v1/orgs/${acme.id}/profiles/export` },
      admin.headers,
    );
    expect(exported.json().profiles.length).toBeGreaterThan(0);
    expect(JSON.stringify(exported.json())).not.toContain(FOREIGN.profile);
    const filtered = await send(
      {
        name: 'f',
        method: 'GET',
        url: `/v1/orgs/${acme.id}/profiles/export?client_id=${FOREIGN.client}`,
      },
      admin.headers,
    );
    expect(filtered.json().profiles).toEqual([]);
    // Other test files count Acme's members: leave none behind.
    await h.owner.query('delete from memberships where org_id = $1 and user_id = $2', [
      acme.id,
      admin.session.user.id,
    ]);
    const grants = await send({
      name: 'g',
      method: 'GET',
      url: `/v1/orgs/${acme.id}/grants?user_id=${FOREIGN.user}`,
    });
    expect(grants.json().items).toEqual([]);
    // (The audit log is left out: it records the ids this caller sent, which disclose nothing.)
    const lists = await Promise.all(
      ['members', 'clients', 'invitations', 'grants', 'profiles'].map((r) =>
        send({ name: r, method: 'GET', url: `/v1/orgs/${acme.id}/${r}?limit=100` }),
      ),
    );
    const all = JSON.stringify(lists.map((l) => l.json()));
    for (const [kind, id] of Object.entries(FOREIGN)) if (kind !== 'seq') expect(all).not.toContain(id);
  });

  it('cannot move a profile between organizations by editing it', async () => {
    const current = await send({
      name: 'g',
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles/${ACME.profile}`,
    });
    const res = await send({
      name: 'move',
      method: 'PATCH',
      url: `/v1/orgs/${acme.id}/profiles/${ACME.profile}`,
      payload: { org_id: beta.id, expected_version: current.json().version },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('pooled database connections', () => {
  it('never carry one request’s tenant into the next (one shared connection)', async () => {
    const single = await harness({ poolMax: 1 });
    try {
      const acmeHeaders = await single.auth('acmeOwner');
      const betaHeaders = await single.auth('betaOwner');
      for (let i = 0; i < 20; i++) {
        const [org, headers] = i % 2 === 0 ? [acme.id, acmeHeaders] : [beta.id, betaHeaders];
        const res = await single.app.inject({
          method: 'GET',
          url: `/v1/orgs/${org}/profiles?limit=100`,
          headers,
        });
        expect(res.statusCode).toBe(200);
        expect(new Set(res.json().items.map((p: { org_id: string }) => p.org_id))).toEqual(new Set([org]));
        // A failing request (rolled back inside its transaction) in between.
        if (i % 5 === 0) {
          const failed = await single.app.inject({
            method: 'PATCH',
            url: `/v1/orgs/${org}/profiles/${org === acme.id ? ACME.profile : FOREIGN.profile}`,
            headers,
            payload: { name: 'x', expected_version: 999 },
          });
          expect(failed.statusCode).toBe(409);
        }
        const c = await single.pool.connect();
        try {
          const { rows } = await c.query(
            "select coalesce(current_setting('app.org_id', true), '') as org, coalesce(current_setting('app.user_id', true), '') as usr, (select count(*)::int from profiles) as visible",
          );
          expect(rows[0]).toEqual({ org: '', usr: '', visible: 0 });
        } finally {
          c.release();
        }
      }
    } finally {
      await single.close();
    }
  });
});

describe('same-organization references in the database', () => {
  const asApp = async (orgId: string, sql: string, params: unknown[]) => {
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.org_id', $1, true)", [orgId]);
      return await c.query(sql, params);
    } finally {
      await c.query('rollback');
      c.release();
    }
  };

  it('refuse pointing a profile at another organization’s client', async () => {
    await expect(
      asApp(acme.id, 'update profiles set client_id = $1 where id = $2', [FOREIGN.client, ACME.profile]),
    ).rejects.toThrow(/profiles_client_same_org/);
  });

  it('refuse a grant for another organization’s member, client or profile', async () => {
    const insert = `insert into permission_grants (id, org_id, user_id, client_id, profile_id, created_by)
                    values ($1, $2, $3, $4, $5, $6)`;
    const owner = FIXTURES.users.acmeOwner.id;
    await expect(
      asApp(acme.id, insert, [fx('grt', 'X1'), acme.id, FOREIGN.user, ACME.client, null, owner]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      asApp(acme.id, insert, [fx('grt', 'X2'), acme.id, ACME.user, FOREIGN.client, null, owner]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      asApp(acme.id, insert, [fx('grt', 'X3'), acme.id, ACME.user, null, FOREIGN.profile, owner]),
    ).rejects.toThrow(/foreign key/);
  });
});
