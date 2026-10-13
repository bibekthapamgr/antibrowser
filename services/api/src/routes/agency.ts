/**
 * Agency workspace (milestone 09, ADR-0016): client dashboards, app-owned tasks, shared bookmarks and the browser
 * extension policy.
 *
 * Everything inherits the caller's scope (milestone 06): a dashboard counts only profiles the caller can see, and
 * hidden profiles are never counted or named. Tasks linked to a profile are visible only with that profile; a task
 * about the whole client is visible to members with a grant on the whole client, to its assignee and to its creator.
 * Bookmarks belong to the client (anyone who sees the client sees them); they are http(s) links only.
 */
import {
  ApiError,
  BOOKMARKS_PER_CLIENT,
  Bookmark,
  BookmarkCreate,
  BookmarkUpdate,
  bookmarkUrlProblem,
  ClientDashboard,
  ClientTask,
  cleanLabel,
  ExtensionInventoryItem,
  ExtensionPolicy,
  ExtensionPolicyUpdate,
  ExtensionReport,
  isSensitivePermission,
  newId,
  Page,
  roleAllows,
  sanitizeNotes,
  secretHint,
  TaskCreate,
  TaskQuery,
  TaskUpdate,
  validVersionRange,
} from '@pb/contracts';
import type pg from 'pg';
import Type, { type Static } from 'typebox';
import type { App, Deps } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { ts, withTx } from '../db.ts';
import { appendEvent } from '../outbox.ts';
import { inUseJson } from '../sessions.ts';
import {
  clientFor,
  profileFor,
  profileVisible,
  requirePermission,
  resolveTenant,
  type TenantAccess,
} from '../tenancy.ts';
import {
  CLIENT_COLUMNS,
  ClientParams,
  type ClientRow,
  errors,
  expectedVersion,
  OrgParams,
  ProfileParams,
  pageOf,
  pageWindow,
  versionConflict,
} from './common.ts';

const param = (pattern: string) => Type.String({ pattern });
const TaskParams = Type.Object(
  {
    orgId: param('^org_[0-9A-HJKMNP-TV-Z]{26}$'),
    clientId: param('^cli_[0-9A-HJKMNP-TV-Z]{26}$'),
    taskId: param('^tsk_[0-9A-HJKMNP-TV-Z]{26}$'),
  },
  { additionalProperties: false },
);
const BookmarkParams = Type.Object(
  {
    orgId: param('^org_[0-9A-HJKMNP-TV-Z]{26}$'),
    clientId: param('^cli_[0-9A-HJKMNP-TV-Z]{26}$'),
    bookmarkId: param('^bkm_[0-9A-HJKMNP-TV-Z]{26}$'),
  },
  { additionalProperties: false },
);

type TaskRow = Static<typeof ClientTask> & { sort_k: string };
type BookmarkRow = Static<typeof Bookmark>;

/** Task columns; the query aliases client_tasks `t`, its profile `tp` and the assignee `au`. */
const TASK_COLUMNS = `t.id, t.org_id, t.client_id, t.profile_id, tp.name as profile_name, t.assignee_id,
  au.display_name as assignee_name, t.title, t.notes, t.status, ${ts('t.due_at')} as due_at,
  (t.status <> 'done' and t.due_at is not null and t.due_at < now()) as overdue, t.created_by, t.completed_by,
  ${ts('t.completed_at')} as completed_at, t.version, ${ts('t.created_at')} as created_at,
  ${ts('t.updated_at')} as updated_at, coalesce(t.due_at, 'infinity'::timestamptz)::text as sort_k`;
const TASK_FROM = `client_tasks t left join profiles tp on tp.org_id = t.org_id and tp.id = t.profile_id
  left join users au on au.id = t.assignee_id`;

/**
 * SQL condition: the task `t` is visible to the caller (`userParam`). Organization scope sees every task; members
 * who reach profiles through grants see tasks of profiles they can see, and whole-client tasks only with a grant on
 * the whole client, or when they are its assignee or creator.
 */
function taskVisible(access: TenantAccess, userParam: string): string {
  if (access.scope === 'organization') return `(${userParam}::text is not null)`;
  if (access.scope === 'none') return `(${userParam}::text is null)`;
  return `((t.profile_id is not null and tp.deleted_at is null and ${profileVisible(access, 'tp', userParam)})
        or (t.profile_id is null and (t.assignee_id = ${userParam} or t.created_by = ${userParam}
             or exists (select 1 from permission_grants g
                         where g.org_id = t.org_id and g.user_id = ${userParam} and g.client_id = t.client_id))))`;
}

const bookmarkColumns = `b.id, b.org_id, b.client_id, b.title, b.url, b.position, b.version,
  ${ts('b.created_at')} as created_at, ${ts('b.updated_at')} as updated_at`;

function cleanTitle(text: string, field: string, max: number): string {
  const t = cleanLabel(text);
  if (!t) throw new ApiError('VALIDATION_FAILED', `${field} is empty`);
  if ([...t].length > max) throw new ApiError('VALIDATION_FAILED', `${field} is too long`);
  const hint = secretHint(t);
  if (hint) throw new ApiError('NOTE_LOOKS_SECRET', hint, { field });
  return t;
}

function cleanNotes(text: string | undefined): string {
  const n = sanitizeNotes(text ?? '');
  const hint = secretHint(n);
  if (hint) throw new ApiError('NOTE_LOOKS_SECRET', hint, { field: 'notes' });
  return n;
}

function checkUrl(url: string): string {
  const problem = bookmarkUrlProblem(url);
  if (problem) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'Bookmarks must be http or https links without a user name or password',
      {
        field: 'url',
        problem,
      },
    );
  }
  return url;
}

/** Whether `userId` (a member) can see client `clientId`: organization scope, or a grant on it or on one of its
 *  profiles; with `profileId`, that profile specifically. */
async function memberSees(
  c: pg.PoolClient,
  orgId: string,
  userId: string,
  clientId: string,
  profileId: string | null,
): Promise<boolean> {
  const { rows } = await c.query<{ ok: boolean }>(
    `select case when m.role in ('owner', 'admin') then true
                 when m.role in ('operator', 'viewer') then exists (
                   select 1 from permission_grants g
                    where g.org_id = $1 and g.user_id = $2
                      and (g.client_id = $3
                           or ($4::text is null and g.profile_id in (select id from profiles
                                                                       where org_id = $1 and client_id = $3
                                                                         and deleted_at is null))
                           or ($4::text is not null and g.profile_id = $4)))
                 else false end as ok
       from memberships m where m.org_id = $1 and m.user_id = $2`,
    [orgId, userId, clientId, profileId],
  );
  return rows[0]?.ok === true;
}

async function holdsClientGrant(c: pg.PoolClient, access: TenantAccess, clientId: string): Promise<boolean> {
  if (access.scope === 'organization') return true;
  const { rowCount } = await c.query(
    'select 1 from permission_grants where org_id = $1 and user_id = $2 and client_id = $3',
    [access.orgId, access.userId, clientId],
  );
  return (rowCount ?? 0) > 0;
}

async function loadTask(
  c: pg.PoolClient,
  access: TenantAccess,
  clientId: string,
  taskId: string,
  lock = false,
): Promise<TaskRow> {
  const { rows } = await c.query<TaskRow>(
    `select ${TASK_COLUMNS} from ${TASK_FROM}
      where t.org_id = $1 and t.client_id = $2 and t.id = $3 and ${taskVisible(access, '$4')}
      ${lock ? 'for update of t' : ''}`,
    [access.orgId, clientId, taskId, access.userId],
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'Task not found');
  return row;
}

const strip = ({ sort_k: _k, ...task }: TaskRow) => task;

/** Who may assign whom: owners and admins any member who can see the client (and the task's profile); others
 *  themselves or nobody, and never take a task away from someone else. */
async function checkAssignee(
  c: pg.PoolClient,
  access: TenantAccess,
  clientId: string,
  profileId: string | null,
  assignee: string | null,
  current: string | null,
): Promise<void> {
  const admin = access.scope === 'organization';
  if (!admin) {
    if (assignee !== null && assignee !== access.userId)
      throw new ApiError('FORBIDDEN', 'You can assign tasks to yourself only', { field: 'assignee_id' });
    if (current !== null && current !== access.userId && assignee !== current)
      throw new ApiError('FORBIDDEN', 'This task is assigned to someone else', { field: 'assignee_id' });
  }
  if (assignee !== null && !(await memberSees(c, access.orgId, assignee, clientId, profileId))) {
    throw new ApiError('VALIDATION_FAILED', 'The assignee cannot see this client or profile', {
      field: 'assignee_id',
    });
  }
}

export function agencyRoutes(app: App, deps: Deps): void {
  // ---------------------------------------------------------------- dashboard
  app.get(
    '/orgs/:orgId/clients/:clientId/dashboard',
    {
      schema: {
        tags: ['agency'],
        description:
          'One client at a glance: the profiles the caller can see (counts never include hidden ones), who has them ' +
          'open, open tasks, shared bookmarks, and — for owners and admins — who works on it and recent app activity.',
        params: ClientParams,
        response: { 200: ClientDashboard, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const clientId = req.params.clientId;
      return withTx(deps.pool, access, async (c) => {
        const client = await clientFor<ClientRow>(c, access, clientId, 'clients.read', CLIENT_COLUMNS);
        const visible = `p.org_id = $1 and p.client_id = $2 and p.deleted_at is null and ${profileVisible(access, 'p', '$3')}`;
        const live = `exists (select 1 from profile_leases l where l.org_id = p.org_id and l.profile_id = p.id
                        and l.state = 'active' and (l.expires_at > now() or l.purpose = 'session'))`;
        const counts = await c.query<{ total: number; in_use: number; never: number; stale: number }>(
          `select count(*)::int as total, count(*) filter (where ${live})::int as in_use,
                  count(*) filter (where p.snapshot_version = 0)::int as never,
                  count(*) filter (where p.snapshot_version > 0
                                     and p.last_snapshot_at < now() - interval '7 days')::int as stale
             from profiles p where ${visible}`,
          [access.orgId, clientId, access.userId],
        );
        const items = await c.query(
          `select p.id, p.name, ${inUseJson('p', '$3')} as in_use, p.snapshot_version,
                  ${ts('p.last_snapshot_at')} as last_snapshot_at, ${ts('h.last_opened')} as last_opened_at
             from profiles p
             left join lateral (select max(acquired_at) as last_opened from lease_history lh
                                 where lh.org_id = p.org_id and lh.profile_id = p.id and lh.purpose = 'session') h
               on true
            where ${visible}
            order by (${live}) desc, h.last_opened desc nulls last, lower(p.name), p.id
            limit 51`,
          [access.orgId, clientId, access.userId],
        );
        const people = roleAllows(access.role, 'grants.manage')
          ? (
              await c.query<{
                user_id: string;
                display_name: string;
                role: string;
                whole: boolean;
                granted: number;
                capabilities: string[];
              }>(
                `select g.user_id, coalesce(u.display_name, '') as display_name, m.role,
                        bool_or(g.client_id is not null) as whole,
                        count(distinct gp.id)::int as granted,
                        coalesce((select array_agg(distinct cap order by cap)
                                    from permission_grants g2
                                    left join profiles p2 on p2.org_id = g2.org_id and p2.id = g2.profile_id,
                                    unnest(g2.capabilities) cap
                                   where g2.org_id = $1 and g2.user_id = g.user_id
                                     and (g2.client_id = $2 or (p2.client_id = $2 and p2.deleted_at is null))),
                                 '{}') as capabilities
                   from permission_grants g
                   join memberships m on m.org_id = g.org_id and m.user_id = g.user_id
                   left join users u on u.id = g.user_id
                   left join profiles gp on gp.org_id = g.org_id and gp.id = g.profile_id and gp.deleted_at is null
                  where g.org_id = $1 and (g.client_id = $2 or gp.client_id = $2)
                  group by g.user_id, u.display_name, m.role
                  order by lower(coalesce(u.display_name, '')), g.user_id
                  limit 200`,
                [access.orgId, clientId],
              )
            ).rows.map((r) => ({
              user_id: r.user_id,
              display_name: r.display_name,
              role: r.role as 'operator',
              access: r.whole ? ('client' as const) : ('profiles' as const),
              profiles: r.whole ? (counts.rows[0]?.total ?? 0) : r.granted,
              capabilities: r.capabilities as ('launch' | 'edit' | 'backup_download')[],
            }))
          : null;
        const taskCounts = await c.query<{ open: number; overdue: number; mine: number }>(
          `select count(*) filter (where t.status <> 'done')::int as open,
                  count(*) filter (where t.status <> 'done' and t.due_at < now())::int as overdue,
                  count(*) filter (where t.status <> 'done' and t.assignee_id = $3)::int as mine
             from ${TASK_FROM} where t.org_id = $1 and t.client_id = $2 and ${taskVisible(access, '$3')}`,
          [access.orgId, clientId, access.userId],
        );
        const tasks = await c.query<TaskRow>(
          `select ${TASK_COLUMNS} from ${TASK_FROM}
            where t.org_id = $1 and t.client_id = $2 and t.status <> 'done' and ${taskVisible(access, '$3')}
            order by coalesce(t.due_at, 'infinity'::timestamptz), t.id limit 20`,
          [access.orgId, clientId, access.userId],
        );
        const bookmarks = await c.query<BookmarkRow>(
          `select ${bookmarkColumns} from client_bookmarks b where b.org_id = $1 and b.client_id = $2
            order by b.position, b.id limit ${BOOKMARKS_PER_CLIENT}`,
          [access.orgId, clientId],
        );
        const activity = roleAllows(access.role, 'audit.read')
          ? (
              await c.query(
                `select a.id, a.action, coalesce(u.display_name, '') as actor_name, a.target_type, a.target_id,
                        coalesce(tp.name, case when a.target_type = 'client' then $3 end) as target_name,
                        ${ts('a.created_at')} as created_at
                   from audit_events a
                   left join users u on u.id = a.actor_user_id
                   left join profiles tp on tp.org_id = a.org_id and tp.id = a.target_id
                  where a.org_id = $1 and a.outcome = 'success'
                    and (a.target_id = $2
                         or a.target_id in (select id from profiles where org_id = $1 and client_id = $2))
                  order by a.created_at desc, a.id desc limit 20`,
                [access.orgId, clientId, client.name],
              )
            ).rows
          : null;
        return {
          client,
          profiles: {
            total: counts.rows[0]?.total ?? 0,
            in_use: counts.rows[0]?.in_use ?? 0,
            never_backed_up: counts.rows[0]?.never ?? 0,
            stale_backups: counts.rows[0]?.stale ?? 0,
            items: items.rows.slice(0, 50),
            more: items.rows.length > 50,
          },
          people,
          tasks: {
            open: taskCounts.rows[0]?.open ?? 0,
            overdue: taskCounts.rows[0]?.overdue ?? 0,
            mine: taskCounts.rows[0]?.mine ?? 0,
            items: tasks.rows.map(strip),
          },
          bookmarks: bookmarks.rows,
          activity,
        };
      });
    },
  );

  // ---------------------------------------------------------------- tasks
  app.get(
    '/orgs/:orgId/clients/:clientId/tasks',
    {
      schema: {
        tags: ['agency'],
        description:
          'Tasks of a client the caller can see, soonest due first (status: open (default), done, all).',
        params: ClientParams,
        querystring: TaskQuery,
        response: { 200: Page(ClientTask), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const window = pageWindow(req.query);
      const status = req.query.status ?? 'open';
      const rows = await withTx(deps.pool, access, async (c) => {
        await clientFor(c, access, req.params.clientId, 'clients.read', 'c.id');
        const { rows } = await c.query<TaskRow>(
          `select ${TASK_COLUMNS} from ${TASK_FROM}
            where t.org_id = $1 and t.client_id = $2 and ${taskVisible(access, '$3')}
              and ($4 = 'all' or ($4 = 'open' and t.status <> 'done') or ($4 = 'done' and t.status = 'done'))
              and ($5::timestamptz is null
                   or (coalesce(t.due_at, 'infinity'::timestamptz), t.id) > ($5::timestamptz, $6::text))
            order by coalesce(t.due_at, 'infinity'::timestamptz), t.id limit $7`,
          [
            access.orgId,
            req.params.clientId,
            access.userId,
            status,
            window.after?.k ?? null,
            window.after?.id ?? '',
            window.limit + 1,
          ],
        );
        return rows;
      });
      const page = pageOf(rows, window, (r) => ({ k: r.sort_k, id: r.id }));
      return { items: page.items.map(strip), next_cursor: page.next_cursor };
    },
  );

  app.post(
    '/orgs/:orgId/clients/:clientId/tasks',
    {
      schema: {
        tags: ['agency'],
        description:
          'Adds a task. Members with grants add tasks to profiles they can see (or to the whole client with a client ' +
          'grant) and assign them to themselves only. Completing a task never means anything happened on a website.',
        params: ClientParams,
        body: TaskCreate,
        response: { 201: ClientTask, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const body = req.body;
      const clientId = req.params.clientId;
      const title = cleanTitle(body.title, 'title', 200);
      const notes = cleanNotes(body.notes);
      const id = newId('task');
      const task = await withTx(deps.pool, access, async (c) => {
        const client = await clientFor<{ archived: boolean }>(
          c,
          access,
          clientId,
          'clients.read',
          'c.archived_at is not null as archived',
        );
        requirePermission(access, 'tasks.write');
        if (client.archived) throw new ApiError('VALIDATION_FAILED', 'The client is archived');
        const profileId = body.profile_id ?? null;
        if (profileId) {
          const p = await profileFor<{ client_id: string | null }>(
            c,
            access,
            profileId,
            'profile.read',
            'p.client_id',
          );
          if (p.client_id !== clientId)
            throw new ApiError('VALIDATION_FAILED', 'The profile belongs to another client', {
              field: 'profile_id',
            });
        } else if (!(await holdsClientGrant(c, access, clientId))) {
          throw new ApiError('FORBIDDEN', 'Add tasks to the profiles you were given', {
            field: 'profile_id',
          });
        }
        const assignee = body.assignee_id ?? null;
        await checkAssignee(c, access, clientId, profileId, assignee, null);
        const status = body.status ?? 'open';
        await c.query(
          `insert into client_tasks (id, org_id, client_id, profile_id, assignee_id, title, notes, status, due_at,
                                     created_by, completed_by, completed_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   case when $8 = 'done' then $10 end, case when $8 = 'done' then now() end)`,
          [
            id,
            access.orgId,
            clientId,
            profileId,
            assignee,
            title,
            notes,
            status,
            body.due_at ?? null,
            access.userId,
          ],
        );
        await audit(
          c,
          changeEntry(access, 'task.created', 'client', clientId, { task_id: id, profile_id: profileId }),
        );
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: id,
          aggregateVersion: 1,
          eventType: 'task.created',
          payload: { client_id: clientId },
        });
        return loadTask(c, access, clientId, id);
      });
      return reply.status(201).header('etag', `"${task.version}"`).send(strip(task));
    },
  );

  app.patch(
    '/orgs/:orgId/clients/:clientId/tasks/:taskId',
    {
      schema: {
        tags: ['agency'],
        description: 'Edits or ticks off a task (If-Match: "<version>").',
        params: TaskParams,
        body: TaskUpdate,
        response: { 200: ClientTask, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const { expected_version: bodyVersion, ...changes } = req.body;
      const expected = expectedVersion(req.headers['if-match'], bodyVersion);
      const { clientId, taskId } = req.params;
      const title = changes.title === undefined ? null : cleanTitle(changes.title, 'title', 200);
      const notes = changes.notes === undefined ? null : cleanNotes(changes.notes);
      const task = await withTx(deps.pool, access, async (c) => {
        const current = await loadTask(c, access, clientId, taskId, true);
        requirePermission(access, 'tasks.write');
        if (current.version !== expected) throw versionConflict(current.version);
        const profileId = 'profile_id' in changes ? (changes.profile_id ?? null) : current.profile_id;
        if ('profile_id' in changes) {
          if (profileId) {
            const p = await profileFor<{ client_id: string | null }>(
              c,
              access,
              profileId,
              'profile.read',
              'p.client_id',
            );
            if (p.client_id !== clientId)
              throw new ApiError('VALIDATION_FAILED', 'The profile belongs to another client', {
                field: 'profile_id',
              });
          } else if (!(await holdsClientGrant(c, access, clientId))) {
            throw new ApiError('FORBIDDEN', 'Add tasks to the profiles you were given', {
              field: 'profile_id',
            });
          }
        }
        const assignee = 'assignee_id' in changes ? (changes.assignee_id ?? null) : current.assignee_id;
        if ('assignee_id' in changes || 'profile_id' in changes) {
          await checkAssignee(c, access, clientId, profileId, assignee, current.assignee_id);
        }
        const status = changes.status ?? current.status;
        await c.query(
          `update client_tasks set
              title = coalesce($3, title), notes = coalesce($4, notes), profile_id = $5, assignee_id = $6,
              due_at = case when $7::boolean then $8::timestamptz else due_at end,
              status = $9,
              completed_by = case when $9 = 'done' then coalesce(completed_by, $10) end,
              completed_at = case when $9 = 'done' then coalesce(completed_at, now()) end,
              version = version + 1, updated_at = now()
            where org_id = $1 and id = $2`,
          [
            access.orgId,
            taskId,
            title,
            notes,
            profileId,
            assignee,
            'due_at' in changes,
            changes.due_at ?? null,
            status,
            access.userId,
          ],
        );
        const changed = Object.keys(changes).sort();
        await audit(
          c,
          changeEntry(
            access,
            status === 'done' && current.status !== 'done' ? 'task.completed' : 'task.updated',
            'client',
            clientId,
            {
              task_id: taskId,
              changed_fields: changed,
            },
          ),
        );
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: taskId,
          aggregateVersion: current.version + 1,
          eventType: 'task.updated',
          payload: { client_id: clientId, changed_fields: changed },
        });
        return loadTask(c, access, clientId, taskId);
      });
      return reply.header('etag', `"${task.version}"`).send(strip(task));
    },
  );

  app.delete(
    '/orgs/:orgId/clients/:clientId/tasks/:taskId',
    {
      schema: {
        tags: ['agency'],
        description: 'Deletes a task (owners, admins, or whoever created it).',
        params: TaskParams,
        response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const { clientId, taskId } = req.params;
      await withTx(deps.pool, access, async (c) => {
        const current = await loadTask(c, access, clientId, taskId, true);
        requirePermission(access, 'tasks.write');
        if (access.scope !== 'organization' && current.created_by !== access.userId)
          throw new ApiError('FORBIDDEN', 'Only its creator or an admin can delete this task');
        await c.query('delete from client_tasks where org_id = $1 and id = $2', [access.orgId, taskId]);
        await audit(c, changeEntry(access, 'task.deleted', 'client', clientId, { task_id: taskId }));
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: taskId,
          aggregateVersion: current.version + 1,
          eventType: 'task.deleted',
          payload: { client_id: clientId },
        });
      });
      return reply.status(204).send(null);
    },
  );

  // ---------------------------------------------------------------- bookmarks
  app.get(
    '/orgs/:orgId/clients/:clientId/bookmarks',
    {
      schema: {
        tags: ['agency'],
        description: 'Shared bookmarks of a client (start-page templates), in their order.',
        params: ClientParams,
        response: { 200: Type.Object({ items: Type.Array(Bookmark) }), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      return withTx(deps.pool, access, async (c) => {
        await clientFor(c, access, req.params.clientId, 'clients.read', 'c.id');
        const { rows } = await c.query<BookmarkRow>(
          `select ${bookmarkColumns} from client_bookmarks b where b.org_id = $1 and b.client_id = $2
            order by b.position, b.id limit ${BOOKMARKS_PER_CLIENT}`,
          [access.orgId, req.params.clientId],
        );
        return { items: rows };
      });
    },
  );

  app.post(
    '/orgs/:orgId/clients/:clientId/bookmarks',
    {
      schema: {
        tags: ['agency'],
        description: `Adds a shared bookmark (owners and admins): http or https only, at most ${BOOKMARKS_PER_CLIENT} per client.`,
        params: ClientParams,
        body: BookmarkCreate,
        response: { 201: Bookmark, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const clientId = req.params.clientId;
      const title = cleanTitle(req.body.title, 'title', 120);
      const url = checkUrl(req.body.url);
      const id = newId('bookmark');
      const row = await withTx(deps.pool, access, async (c) => {
        await clientFor(c, access, clientId, 'clients.manage', 'c.id', true);
        const { rows: n } = await c.query<{ n: number }>(
          'select count(*)::int as n from client_bookmarks where org_id = $1 and client_id = $2',
          [access.orgId, clientId],
        );
        if ((n[0]?.n ?? 0) >= BOOKMARKS_PER_CLIENT)
          throw new ApiError('VALIDATION_FAILED', `A client has at most ${BOOKMARKS_PER_CLIENT} bookmarks`);
        const { rows } = await c.query<BookmarkRow>(
          `insert into client_bookmarks as b (id, org_id, client_id, title, url, position, created_by)
           values ($1, $2, $3, $4, $5, $6, $7) returning ${bookmarkColumns}`,
          [id, access.orgId, clientId, title, url, req.body.position ?? n[0]?.n ?? 0, access.userId],
        );
        await audit(c, changeEntry(access, 'bookmark.created', 'client', clientId, { bookmark_id: id }));
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: id,
          aggregateVersion: 1,
          eventType: 'bookmark.created',
          payload: { client_id: clientId },
        });
        return rows[0];
      });
      if (!row) throw new ApiError('INTERNAL', 'Bookmark was not created');
      return reply.status(201).header('etag', `"${row.version}"`).send(row);
    },
  );

  app.patch(
    '/orgs/:orgId/clients/:clientId/bookmarks/:bookmarkId',
    {
      schema: {
        tags: ['agency'],
        description: 'Renames, re-links or reorders a bookmark (owners and admins; If-Match: "<version>").',
        params: BookmarkParams,
        body: BookmarkUpdate,
        response: { 200: Bookmark, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const { expected_version: bodyVersion, ...changes } = req.body;
      const expected = expectedVersion(req.headers['if-match'], bodyVersion);
      const { clientId, bookmarkId } = req.params;
      const title = changes.title === undefined ? null : cleanTitle(changes.title, 'title', 120);
      const url = changes.url === undefined ? null : checkUrl(changes.url);
      const row = await withTx(deps.pool, access, async (c) => {
        await clientFor(c, access, clientId, 'clients.manage', 'c.id');
        const { rows } = await c.query<BookmarkRow>(
          `update client_bookmarks b set title = coalesce($4, b.title), url = coalesce($5, b.url),
                  position = coalesce($6, b.position), version = b.version + 1, updated_at = now()
            where b.org_id = $1 and b.client_id = $2 and b.id = $3 and b.version = $7
            returning ${bookmarkColumns}`,
          [access.orgId, clientId, bookmarkId, title, url, changes.position ?? null, expected],
        );
        if (!rows[0]) {
          const { rows: cur } = await c.query<{ version: number }>(
            'select version from client_bookmarks where org_id = $1 and client_id = $2 and id = $3',
            [access.orgId, clientId, bookmarkId],
          );
          if (!cur[0]) throw new ApiError('NOT_FOUND', 'Bookmark not found');
          throw versionConflict(cur[0].version);
        }
        const changed = Object.keys(changes).sort();
        await audit(
          c,
          changeEntry(access, 'bookmark.updated', 'client', clientId, {
            bookmark_id: bookmarkId,
            changed_fields: changed,
          }),
        );
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: bookmarkId,
          aggregateVersion: rows[0].version,
          eventType: 'bookmark.updated',
          payload: { client_id: clientId, changed_fields: changed },
        });
        return rows[0];
      });
      return reply.header('etag', `"${row.version}"`).send(row);
    },
  );

  app.delete(
    '/orgs/:orgId/clients/:clientId/bookmarks/:bookmarkId',
    {
      schema: {
        tags: ['agency'],
        description: 'Removes a bookmark (owners and admins).',
        params: BookmarkParams,
        response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const { clientId, bookmarkId } = req.params;
      await withTx(deps.pool, access, async (c) => {
        await clientFor(c, access, clientId, 'clients.manage', 'c.id');
        const { rows } = await c.query<{ version: number }>(
          'delete from client_bookmarks where org_id = $1 and client_id = $2 and id = $3 returning version',
          [access.orgId, clientId, bookmarkId],
        );
        if (!rows[0]) throw new ApiError('NOT_FOUND', 'Bookmark not found');
        await audit(
          c,
          changeEntry(access, 'bookmark.deleted', 'client', clientId, { bookmark_id: bookmarkId }),
        );
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: bookmarkId,
          aggregateVersion: rows[0].version + 1,
          eventType: 'bookmark.deleted',
          payload: { client_id: clientId },
        });
      });
      return reply.status(204).send(null);
    },
  );

  // ---------------------------------------------------------------- extension policy
  const policyOf = async (c: pg.PoolClient, orgId: string) => {
    const org = await c.query<{
      mode: 'off' | 'warn' | 'enforce';
      version: number;
      updated_at: string | null;
    }>(
      `select extension_mode as mode, extension_policy_version as version,
              ${ts('extension_policy_updated_at')} as updated_at
         from organizations where id = $1`,
      [orgId],
    );
    const rules = await c.query(
      `select extension_id, name, decision, source, approved_version_range, permissions
         from extension_policies where org_id = $1 order by lower(name), extension_id`,
      [orgId],
    );
    const o = org.rows[0];
    if (!o) throw new ApiError('NOT_FOUND', 'Organization not found');
    return {
      org_id: orgId,
      mode: o.mode,
      version: o.version,
      updated_at: o.updated_at,
      extensions: rules.rows,
    };
  };

  app.get(
    '/orgs/:orgId/extension-policy',
    {
      schema: {
        tags: ['extensions'],
        description:
          "The organization's browser extension policy. Every member's app reads it to judge the extensions installed " +
          'in organization profiles (off: inventory only; warn; enforce: such profiles open with extensions turned off).',
        params: OrgParams,
        response: { 200: ExtensionPolicy, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'org.read');
      const policy = await withTx(deps.pool, access, (c) => policyOf(c, access.orgId));
      return reply.header('etag', `"${policy.version}"`).send(policy);
    },
  );

  app.put(
    '/orgs/:orgId/extension-policy',
    {
      schema: {
        tags: ['extensions'],
        description: 'Replaces the extension policy (owners and admins; If-Match: "<version>").',
        params: OrgParams,
        body: ExtensionPolicyUpdate,
        response: { 200: ExtensionPolicy, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'extensions.manage');
      const expected = expectedVersion(req.headers['if-match'], req.body.expected_version);
      const seen = new Set<string>();
      const rules = req.body.extensions.map((r) => {
        if (seen.has(r.extension_id))
          throw new ApiError('VALIDATION_FAILED', 'An extension is listed twice', {
            extension_id: r.extension_id,
          });
        seen.add(r.extension_id);
        if (r.approved_version_range !== null && !validVersionRange(r.approved_version_range))
          throw new ApiError('VALIDATION_FAILED', 'Version ranges look like 1.2.3, 1.2.* or >=1.2 <2', {
            extension_id: r.extension_id,
          });
        const permissions = [...new Set(r.permissions.map((p) => p.trim()).filter(Boolean))];
        // biome-ignore lint/suspicious/noControlCharactersInRegex: hidden characters are refused
        if (permissions.some((p) => /[\u0000-\u001F\u007F]/.test(p)))
          throw new ApiError('VALIDATION_FAILED', 'Permissions contain hidden characters');
        return { ...r, name: cleanLabel(r.name).slice(0, 120), permissions };
      });
      const policy = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<{ version: number }>(
          'select extension_policy_version as version from organizations where id = $1 for update',
          [access.orgId],
        );
        const current = rows[0]?.version;
        if (current === undefined) throw new ApiError('NOT_FOUND', 'Organization not found');
        if (current !== expected) throw versionConflict(current);
        await c.query('delete from extension_policies where org_id = $1', [access.orgId]);
        for (const r of rules) {
          await c.query(
            `insert into extension_policies (org_id, extension_id, name, decision, source, approved_version_range,
                                             permissions, updated_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              access.orgId,
              r.extension_id,
              r.name,
              r.decision,
              r.source,
              r.approved_version_range,
              r.permissions,
              access.userId,
            ],
          );
        }
        await c.query(
          `update organizations set extension_mode = $2, extension_policy_version = extension_policy_version + 1,
                  extension_policy_updated_at = now() where id = $1`,
          [access.orgId, req.body.mode],
        );
        await audit(
          c,
          changeEntry(access, 'extension_policy.updated', 'organization', access.orgId, {
            mode: req.body.mode,
            allowed: rules.filter((r) => r.decision === 'allowed').length,
            blocked: rules.filter((r) => r.decision === 'blocked').length,
          }),
        );
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: access.orgId,
          aggregateVersion: current + 1,
          eventType: 'extension_policy.updated',
          payload: { mode: req.body.mode },
        });
        return policyOf(c, access.orgId);
      });
      return reply.header('etag', `"${policy.version}"`).send(policy);
    },
  );

  app.put(
    '/orgs/:orgId/profiles/:profileId/extension-report',
    {
      schema: {
        tags: ['extensions'],
        description:
          'A device reports the extensions installed in its copy of a profile (names, versions, sources and the ' +
          'permissions they declare; never browsing data). Latest report per profile and device.',
        params: ProfileParams,
        body: ExtensionReport,
        response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const body = req.body;
      if (access.deviceId && access.deviceId !== body.device_id)
        throw new ApiError('FORBIDDEN', 'device_id must be the device making the request');
      const extensions = body.extensions.map((e) => ({
        ...e,
        name: cleanLabel(e.name).slice(0, 120),
        // Permissions with hidden characters are dropped.
        permissions: [...new Set(e.permissions)].filter((p) => cleanLabel(p) === p).slice(0, 100),
      }));
      await withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, req.params.profileId, 'profile.read', 'p.id');
        const own = await c.query(
          'select 1 from devices where id = $1 and user_id = $2 and revoked_at is null',
          [body.device_id, access.userId],
        );
        if (!own.rowCount) throw new ApiError('FORBIDDEN', 'device_id is not an active device of the caller');
        await c.query(
          `insert into extension_reports (org_id, profile_id, device_id, user_id, extensions)
           values ($1, $2, $3, $4, $5::jsonb)
           on conflict (org_id, profile_id, device_id)
           do update set user_id = excluded.user_id, extensions = excluded.extensions, reported_at = now()`,
          [access.orgId, req.params.profileId, body.device_id, access.userId, JSON.stringify(extensions)],
        );
      });
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/orgs/:orgId/extension-inventory',
    {
      schema: {
        tags: ['extensions'],
        description:
          'Every extension devices reported in organization profiles: versions, sources, declared permissions ' +
          '(sensitive ones marked), and in how many profiles and devices (owners and admins).',
        params: OrgParams,
        response: { 200: Type.Object({ items: Type.Array(ExtensionInventoryItem) }), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'extensions.manage');
      const rows = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<{
          id: string;
          name: string;
          versions: string[];
          sources: string[];
          permissions: string[];
          profiles: number;
          devices: number;
          last_reported_at: string;
        }>(
          `with reported as (
             select e->>'id' as id, e->>'name' as name, e->>'version' as version, e->>'source' as source,
                    e->'permissions' as permissions, r.profile_id, r.device_id, r.reported_at
               from extension_reports r
               join profiles p on p.org_id = r.org_id and p.id = r.profile_id and p.deleted_at is null,
                    jsonb_array_elements(r.extensions) e
              where r.org_id = $1)
           select x.id, max(x.name) as name,
                  array_agg(distinct x.version order by x.version) as versions,
                  array_agg(distinct x.source order by x.source) as sources,
                  coalesce((select array_agg(distinct perm order by perm)
                              from reported x2, jsonb_array_elements_text(x2.permissions) perm
                             where x2.id = x.id), '{}') as permissions,
                  count(distinct x.profile_id)::int as profiles, count(distinct x.device_id)::int as devices,
                  ${ts('max(x.reported_at)')} as last_reported_at
             from reported x
            group by x.id
            order by lower(max(x.name)), x.id
            limit 500`,
          [access.orgId],
        );
        return rows;
      });
      return {
        items: rows.map((r) => ({
          ...r,
          sources: r.sources as ('web_store' | 'policy' | 'external' | 'unpacked' | 'other')[],
          sensitive: r.permissions.filter(isSensitivePermission),
        })),
      };
    },
  );
}
