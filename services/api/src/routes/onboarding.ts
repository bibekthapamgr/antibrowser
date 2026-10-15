/**
 * R2 self-service onboarding (ADR-0021). One idempotent call decides where a signed-in person lands:
 *
 *   1. an invitation (token given) is accepted first and its workspace becomes the default — no personal workspace,
 *      no payment;
 *   2. an explicit choice (`choose_org_id`) among the person's own workspaces;
 *   3. a default that is still reachable is kept (`existing`);
 *   4. a returning person with workspaces gets one selected: their only owned one, else (several owned) a choice asked
 *      once, else the workspace they were invited to — never a fresh trial;
 *   5. otherwise (a direct signup) one personal workspace with an owner membership and a trial is created in the
 *      same transaction as the onboarding record, unless invitations for their verified address are waiting.
 *
 * The person's onboarding row is locked (`select … for update`) for the whole decision and `bootstrap_org_id` is
 * unique, so a desktop and a browser completing onboarding at the same moment produce one workspace and one trial.
 * Identity comes only from the verified sign-in; the body never names a user, an e-mail address or a role.
 */
import {
  ApiError,
  newId,
  OnboardingComplete,
  type OnboardingOutcome,
  OnboardingResult,
  type OnboardingStatus,
  type Role,
} from '@pb/contracts';
import type pg from 'pg';
import { type App, type Deps, principalOf } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { catalogOf, newestPlan } from '../billing/catalog.ts';
import { ts, withTx } from '../db.ts';
import { enqueueEmail } from '../email.ts';
import { appendEvent } from '../outbox.ts';
import { hit, LIMITS } from '../ratelimit.ts';
import { sha256Hex } from '../session.ts';
import { errors } from './common.ts';
import { acceptFailure } from './invitations.ts';
import { rotateWebSession } from './web.ts';

interface StateRow {
  state: OnboardingStatus['state'];
  default_org_id: string | null;
  bootstrap_org_id: string | null;
  plan_intent: string | null;
  choice_made_at: string | null;
  attempts: number;
  last_error: string | null;
  completed_at: string | null;
}

interface WorkspaceRow {
  org_id: string;
  name: string;
  role: Role;
  suspended: boolean;
}

interface Caller {
  userId: string;
  deviceId: string | null;
  requestId: string;
}

export function onboardingRoutes(app: App, deps: Deps): void {
  app.get(
    '/onboarding/status',
    {
      config: { web: true },
      schema: {
        tags: ['identity'],
        description:
          'Where the signed-in person is in onboarding: their workspaces, the default one, terms, waiting ' +
          'invitations, whether a new workspace would start a trial, and queued e-mails.',
        response: { 200: OnboardingResult.properties.status, ...errors },
      },
    },
    async (req) => {
      const { userId } = principalOf(req);
      return withTx(deps.pool, { orgId: null, userId }, (c) => readStatus(c, deps, userId));
    },
  );

  app.post(
    '/onboarding/complete',
    {
      config: { web: true },
      schema: {
        tags: ['identity'],
        description:
          'Completes onboarding (idempotent; safe to retry). Invitations take priority; a direct signup gets one ' +
          'personal workspace with an owner membership and a trial; returning people get their workspace ' +
          'selected (or a choice once when they own several). Never creates a second personal workspace.',
        body: OnboardingComplete,
        response: { 200: OnboardingResult, ...errors },
      },
    },
    async (req, reply) => {
      const principal = principalOf(req);
      await hit(deps.pool, LIMITS.onboardingPerUser, principal.userId);
      await hit(deps.pool, LIMITS.onboardingPerIp, req.ip);
      const caller: Caller = { userId: principal.userId, deviceId: principal.deviceId, requestId: req.id };
      try {
        const result = await withTx(deps.pool, { orgId: null, userId: caller.userId }, (c) =>
          complete(c, deps, caller, req.body),
        );
        // A privilege change (a new workspace, a joined team) gives a portal session a new id.
        if (result.outcome === 'created' || result.outcome === 'joined')
          await rotateWebSession(req, reply, deps);
        return result;
      } catch (err) {
        // Kept for the status page ("try again"), in its own transaction: the attempt itself rolled back.
        const code = err instanceof ApiError ? err.code : 'INTERNAL';
        await withTx(deps.pool, { orgId: null, userId: caller.userId }, (c) =>
          c.query(
            `insert into onboarding_state (user_id, state, attempts, last_error) values ($1, 'new', 1, $2)
             on conflict (user_id) do update set attempts = onboarding_state.attempts + 1, last_error = $2,
               updated_at = now()`,
            [caller.userId, code],
          ),
        ).catch(() => undefined);
        throw err;
      }
    },
  );
}

async function complete(
  c: pg.PoolClient,
  deps: Deps,
  caller: Caller,
  body: OnboardingComplete,
): Promise<{ outcome: OnboardingOutcome; status: OnboardingStatus }> {
  const { userId } = caller;
  await c.query(`insert into onboarding_state (user_id, state) values ($1, 'new') on conflict do nothing`, [
    userId,
  ]);
  const locked = await c.query<StateRow>(
    `select state, default_org_id, bootstrap_org_id, plan_intent, ${ts('choice_made_at')} as choice_made_at,
            attempts, last_error, ${ts('completed_at')} as completed_at
       from onboarding_state where user_id = $1 for update`,
    [userId],
  );
  const st = locked.rows[0];
  if (!st) throw new ApiError('INTERNAL', 'Onboarding state is missing');
  await c.query(
    'update onboarding_state set attempts = attempts + 1, updated_at = now() where user_id = $1',
    [userId],
  );
  const me = await currentUser(c, userId);

  // Consents and the plan intent are recorded whatever else happens.
  const termsVersion = deps.config.onboarding.termsVersion;
  if (body.accept_terms_version !== undefined) {
    if (body.accept_terms_version !== termsVersion) {
      throw new ApiError('TERMS_REQUIRED', 'These terms are not the current ones; reload and accept again', {
        current_version: termsVersion,
      });
    }
    if ((await acceptedTerms(c, userId)) !== termsVersion) {
      await c.query(
        `insert into user_consents (user_id, kind, version, granted) values ($1, 'terms', $2, true)`,
        [userId, termsVersion],
      );
    }
  }
  if (body.marketing_consent !== undefined && body.marketing_consent !== (await marketingRecord(c, userId))) {
    await c.query(
      `insert into user_consents (user_id, kind, version, granted) values ($1, 'marketing', $2, $3)`,
      [userId, termsVersion, body.marketing_consent],
    );
  }
  if (body.plan_intent !== undefined) {
    // R5: the database catalog decides what is sold (the newest version of the plan must be purchasable).
    const plan = body.plan_intent === null ? null : newestPlan(await catalogOf(deps), body.plan_intent);
    if (body.plan_intent !== null && !plan?.purchasable) {
      throw new ApiError('PLAN_NOT_AVAILABLE', 'This plan is not offered', { plan_id: body.plan_intent });
    }
    await c.query('update onboarding_state set plan_intent = $2 where user_id = $1', [
      userId,
      plan?.id ?? null,
    ]);
  }

  const finish = async (outcome: OnboardingOutcome, defaultOrg: string | null, state: StateRow['state']) => {
    await c.query(
      `update onboarding_state set state = $2, default_org_id = $3, last_error = null, updated_at = now(),
              completed_at = case when $3::text is null then completed_at else coalesce(completed_at, now()) end,
              version = version + 1
        where user_id = $1`,
      [userId, state, defaultOrg],
    );
    return { outcome, status: await readStatus(c, deps, userId) };
  };

  // 1. An invitation first.
  if (body.invitation_token) {
    if (!me.email_verified) {
      throw new ApiError(
        'EMAIL_NOT_VERIFIED',
        'Verify your e-mail address first, then open the invitation again',
      );
    }
    const { rows } = await c.query<{
      outcome: string;
      org_id: string | null;
      role: Role | null;
      invitation_id: string | null;
    }>('select * from app.accept_invitation($1, $2)', [sha256Hex(body.invitation_token), userId]);
    const r = rows[0];
    let orgId: string | null = null;
    if (r?.outcome === 'accepted' && r.org_id && r.role && r.invitation_id) {
      orgId = r.org_id;
      await c.query("select set_config('app.org_id', $1, true)", [r.org_id]);
      const access = { orgId: r.org_id, ...caller };
      await audit(
        c,
        changeEntry(access, 'invitation.accepted', 'invitation', r.invitation_id, {
          role: r.role,
          via: 'onboarding',
        }),
      );
      await appendEvent(c, {
        orgId: r.org_id,
        actorId: userId,
        aggregateId: userId,
        aggregateVersion: 1,
        eventType: 'membership.created',
        payload: { user_id: userId, role: r.role, via: 'invitation' },
      });
      await c.query("select set_config('app.org_id', '', true)");
    } else if ((r?.outcome === 'already_member' || r?.outcome === 'used') && r.org_id) {
      orgId = r.org_id; // a retry after the acceptance committed: the same answer
    } else {
      throw acceptFailure(r?.outcome ?? 'invalid');
    }
    const ws = await workspaces(c, userId);
    const role = ws.find((w) => w.org_id === orgId)?.role;
    return finish('joined', orgId, role === 'owner' ? 'ready' : 'invited');
  }

  const all = await workspaces(c, userId);
  const active = all.filter((w) => !w.suspended);

  // 2. An explicit choice.
  if (body.choose_org_id) {
    const chosen = all.find((w) => w.org_id === body.choose_org_id);
    if (!chosen) throw new ApiError('NOT_FOUND', 'Workspace not found');
    if (chosen.suspended) throw new ApiError('WORKSPACE_SUSPENDED', 'This workspace is suspended');
    await c.query('update onboarding_state set choice_made_at = now() where user_id = $1', [userId]);
    return finish('chosen', chosen.org_id, chosen.role === 'owner' ? 'ready' : 'invited');
  }

  if (!body.create_own && active.length > 0) {
    // 3. The default is still reachable.
    const current = active.find((w) => w.org_id === st.default_org_id);
    if (current) return finish('existing', current.org_id, current.role === 'owner' ? 'ready' : 'invited');
    // 4. A returning person: select, or ask once among several owned workspaces. No new workspace, no trial.
    const owned = active.filter((w) => w.role === 'owner');
    if (owned.length > 1 && !st.choice_made_at) return finish('choice_required', null, 'choose');
    const pick = owned[0] ?? active[0];
    if (pick) return finish('selected', pick.org_id, pick.role === 'owner' ? 'ready' : 'invited');
  }

  // 5. A new personal workspace (direct signup, or the explicit "create my own workspace").
  const reachableDefault = active.find((w) => w.org_id === st.default_org_id)?.org_id ?? null;
  const stateOf = (orgId: string | null): StateRow['state'] =>
    orgId === null ? 'new' : active.find((w) => w.org_id === orgId)?.role === 'owner' ? 'ready' : 'invited';
  if (!me.email_verified) {
    throw new ApiError('EMAIL_NOT_VERIFIED', 'Verify your e-mail address first; the link is in your inbox');
  }
  const suspended = await c.query<{ s: boolean }>('select app.email_suspended($1) as s', [userId]);
  if (suspended.rows[0]?.s) {
    throw new ApiError(
      'ACCOUNT_SUSPENDED',
      'A workspace cannot be created for this address; contact support',
    );
  }
  if (!body.create_own) {
    const waiting = await c.query('select 1 from app.invitations_for_user($1) limit 1', [userId]);
    if ((waiting.rowCount ?? 0) > 0)
      return finish('invitations_pending', reachableDefault, stateOf(reachableDefault));
  }
  // Nothing is created without the current terms; whatever the person already has stays as it is.
  if ((await acceptedTerms(c, userId)) !== termsVersion) {
    return finish('terms_required', reachableDefault, stateOf(reachableDefault));
  }
  await hit(deps.pool, LIMITS.orgCreatePerUser, userId);

  const orgId = newId('organization');
  const name = (body.workspace_name?.trim() || `${me.display_name}’s workspace`).slice(0, 120);
  await c.query("select set_config('app.org_id', $1, true)", [orgId]);
  await c.query('insert into organizations (id, name) values ($1, $2)', [orgId, name]);
  await c.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgId, userId]);
  const trial = await c.query<{ fresh: boolean }>('select app.claim_trial($1, $2) as fresh', [orgId, userId]);
  const access = { orgId, ...caller };
  await audit(
    c,
    changeEntry(access, 'organization.created', 'organization', orgId, {
      name_length: name.length,
      via: body.create_own ? 'create_own' : 'onboarding',
      trial: trial.rows[0]?.fresh ? 'started' : 'shared',
    }),
  );
  await appendEvent(c, {
    orgId,
    actorId: userId,
    aggregateId: orgId,
    aggregateVersion: 1,
    eventType: 'organization.created',
    payload: { via: body.create_own ? 'create_own' : 'onboarding' },
  });
  await appendEvent(c, {
    orgId,
    actorId: userId,
    aggregateId: userId,
    aggregateVersion: 1,
    eventType: 'membership.created',
    payload: { user_id: userId, role: 'owner' },
  });
  if (me.email && !st.bootstrap_org_id) {
    await enqueueEmail(c, deps.config.email.taskKey, {
      kind: 'welcome',
      orgId,
      to: me.email,
      dedupeKey: `welcome:${userId}`,
      vars: {
        display_name: me.display_name,
        workspace_name: name,
        app_url: deps.config.web.origin ? `${deps.config.web.origin}/app/` : '',
      },
    });
  }
  await c.query("select set_config('app.org_id', '', true)");
  // The first personal workspace is the bootstrap mapping (unique); an explicit extra one does not replace it.
  await c.query(
    'update onboarding_state set bootstrap_org_id = coalesce(bootstrap_org_id, $2) where user_id = $1',
    [userId, orgId],
  );
  const keepDefault = body.create_own && active.some((w) => w.org_id === st.default_org_id);
  return finish('created', keepDefault ? st.default_org_id : orgId, 'ready');
}

// ---------------------------------------------------------------- reading
export async function readStatus(c: pg.PoolClient, deps: Deps, userId: string): Promise<OnboardingStatus> {
  const { rows } = await c.query<StateRow>(
    `select state, default_org_id, bootstrap_org_id, plan_intent, attempts, last_error,
            ${ts('completed_at')} as completed_at
       from onboarding_state where user_id = $1`,
    [userId],
  );
  const st = rows[0];
  const me = await currentUser(c, userId);
  const ws = await workspaces(c, userId);
  const invitations = await c.query<{ org_name: string; role: Role; expires_at: string }>(
    `select org_name, role, ${ts('expires_at')} as expires_at from app.invitations_for_user($1)`,
    [userId],
  );
  const trial = await c.query<{ ok: boolean }>('select app.trial_available($1) as ok', [userId]);
  const welcome = await c.query<{ state: 'pending' | 'sent' | 'failed' | 'skipped' }>(
    'select state from app.email_task_state($1)',
    [`welcome:${userId}`],
  );
  const reachable = ws.find((w) => w.org_id === st?.default_org_id && !w.suspended);
  return {
    state: st?.state ?? 'new',
    default_org_id: reachable ? reachable.org_id : null,
    bootstrap_org_id: st?.bootstrap_org_id ?? null,
    workspaces: ws,
    email_verified: me.email_verified,
    terms: {
      current_version: deps.config.onboarding.termsVersion,
      accepted_version: await acceptedTerms(c, userId),
    },
    marketing_consent: await marketing(c, userId),
    plan_intent: st?.plan_intent ?? null,
    pending_invitations: invitations.rows,
    trial_available: trial.rows[0]?.ok ?? false,
    pending_tasks: welcome.rows.map((r) => ({ kind: 'welcome' as const, state: r.state })),
    attempts: st?.attempts ?? 0,
    last_error: st?.last_error ?? null,
    completed_at: st?.completed_at ?? null,
  };
}

async function currentUser(c: pg.PoolClient, userId: string) {
  const { rows } = await c.query<{ email: string | null; email_verified: boolean; display_name: string }>(
    'select email, email_verified, display_name from users where id = $1',
    [userId],
  );
  return rows[0] ?? { email: null, email_verified: false, display_name: 'User' };
}

async function workspaces(c: pg.PoolClient, userId: string): Promise<WorkspaceRow[]> {
  const { rows } = await c.query<WorkspaceRow>(
    `select m.org_id, o.name, m.role, o.suspended_at is not null as suspended
       from memberships m join organizations o on o.id = m.org_id
      where m.user_id = $1 order by m.created_at, m.org_id limit 200`,
    [userId],
  );
  return rows;
}

async function acceptedTerms(c: pg.PoolClient, userId: string): Promise<string | null> {
  const { rows } = await c.query<{ version: string }>(
    `select version from user_consents where user_id = $1 and kind = 'terms' order by at desc, id desc limit 1`,
    [userId],
  );
  return rows[0]?.version ?? null;
}

/** The latest marketing answer (null: never asked or never answered). */
async function marketingRecord(c: pg.PoolClient, userId: string): Promise<boolean | null> {
  const { rows } = await c.query<{ granted: boolean }>(
    `select granted from user_consents where user_id = $1 and kind = 'marketing' order by at desc, id desc limit 1`,
    [userId],
  );
  return rows[0]?.granted ?? null;
}

async function marketing(c: pg.PoolClient, userId: string): Promise<boolean> {
  return (await marketingRecord(c, userId)) ?? false;
}
