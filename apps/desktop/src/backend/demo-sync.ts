/**
 * In-memory stand-in for the shell's encrypted backup and restore worker (milestone 07), for UI development and UI
 * tests. It follows the desktop rules: only closed, organization-linked profiles are backed up; a newer version made
 * elsewhere is a conflict, never an overwrite; a restore keeps the previous data and blocks opening until done;
 * another computer's backup restores with "sign-in may be required".
 *
 * Modes (`?demo=`, combined with the cloud modes): `linked` (the first local profile is linked to the first
 * organization profile, which has a backup made on another computer), `conflict` (with `linked`: this computer's copy
 * is based on no version, so its first backup conflicts), `syncoffline` (uploads wait for the connection).
 */
import type { EventPayload, Started } from '@pb/contracts/ipc';
import type { DemoCloudSync } from './demo-cloud.ts';
import type {
  ConflictChoice,
  OrgLink,
  ProfileView,
  SyncRepository,
  SyncStatus,
  WorkspaceCopy,
} from './types.ts';

interface LocalState {
  synced_version: number;
  synced_snapshot: string | null;
  synced_at: string | null;
  dirty: boolean;
  auto: boolean;
  conflict_head: number | null;
  job: SyncStatus['job'];
  progress: SyncStatus['progress'];
}

const IDLE: SyncStatus['progress'] = { phase: null, done: 0, total: 0, waiting_for: null };
const now = () => new Date().toISOString();
const err = (code: string, message: string) => ({ code, message });
const jid = () => `sj_${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)}`;

export function demoSync(deps: {
  mode: string;
  cloud: DemoCloudSync;
  links: (orgId?: string) => Promise<OrgLink[]>;
  /** The local profile or throws UNKNOWN_PROFILE. */
  profile: (id: string) => { id: string; name: string; state: string; workspace_id: string | null };
  /** A new local profile in `workspaceId` (or the active workspace). */
  create: (name: string, workspaceId: string | null) => ProfileView;
  emit: (p: EventPayload<'sync'>) => void;
  changed: () => void;
  /** The phase of this computer's shared session of a profile (milestone 08), if any. */
  teamPhase?: (id: string) => string | null;
  /** R3: the current view of a local profile; opening it (lease first); its proxy on this computer. */
  view?: (id: string) => ProfileView;
  launch?: (id: string) => Promise<Started>;
  assignProxy?: (id: string, proxyId: string) => Promise<ProfileView>;
}): SyncRepository & {
  afterCleanClose(id: string): void;
  /** A shared session's closing backup (milestone 08): how it ended, or `waiting` for the connection. */
  closingBackup(id: string): Promise<'committed' | 'conflict' | 'waiting' | 'canceled' | 'failed'>;
  restoring(id: string): boolean;
  seed(id: string, syncedVersion: number): void;
} {
  const local = new Map<string, LocalState>();
  /** First downloads ("restore here"): org profile → the local copy being restored (linked when done). */
  const here = new Map<string, string>();
  const stateOf = (id: string): LocalState => {
    let s = local.get(id);
    if (!s) {
      s = {
        synced_version: 0,
        synced_snapshot: null,
        synced_at: null,
        dirty: true,
        auto: true,
        conflict_head: null,
        job: null,
        progress: { ...IDLE },
      };
      local.set(id, s);
    }
    return s;
  };
  const linkOf = async (id: string) => (await deps.links()).find((l) => l.local_profile_id === id) ?? null;
  /** Read through a call so TypeScript does not narrow it between awaits (a cancel can arrive meanwhile). */
  const canceled = (s: LocalState) => s.job?.state === 'canceled';
  const running = (s: LocalState) =>
    !!s.job && !['committed', 'conflict', 'failed', 'canceled', 'done'].includes(s.job.state);

  const status = async (id: string): Promise<SyncStatus> => {
    const p = deps.profile(id);
    const link = await linkOf(id);
    const s = stateOf(id);
    return {
      profile_id: p.id,
      linked: !!link,
      org_id: link?.org_id ?? null,
      org_profile_id: link?.org_profile_id ?? null,
      synced_version: s.synced_version,
      synced_at: s.synced_at,
      dirty: !!link && s.dirty,
      auto_backup: !!link && s.auto,
      conflict_head: s.conflict_head,
      job: s.job ? { ...s.job } : null,
      progress: { ...s.progress },
      restoring: s.job?.kind === 'restore' && running(s),
      local_backup: null,
      local_backups_sealed: true,
    };
  };

  const step = (
    id: string,
    s: LocalState,
    state: string,
    patch: Partial<NonNullable<LocalState['job']>> = {},
  ) => {
    if (!s.job) return;
    s.job = {
      ...s.job,
      ...patch,
      state: state as NonNullable<LocalState['job']>['state'],
      updated_at: now(),
    };
    deps.emit({ profile_id: id, job_id: s.job.id, kind: s.job.kind, state });
  };

  const upload = async (id: string, link: OrgLink) => {
    const s = stateOf(id);
    const job = { id: jid(), kind: 'upload' as const, error_code: null, version: null, head_version: null };
    s.job = { ...job, state: 'local_dirty', updated_at: now(), portability: null };
    step(id, s, 'preparing');
    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await tick(250);
    s.progress = { phase: 'sealing', done: 40, total: 96, waiting_for: null };
    await tick(250);
    if (canceled(s)) return;
    step(id, s, 'uploading');
    for (const done of [12, 28, 41]) {
      s.progress = { phase: 'uploading', done: done * 1_000_000, total: 41_000_000, waiting_for: null };
      deps.emit({ profile_id: id, job_id: s.job?.id ?? '', kind: 'upload', state: 'uploading' });
      await tick(250);
      if (canceled(s)) return;
      if (deps.mode.includes('syncoffline') && done === 28) {
        s.progress = { ...s.progress, phase: null, waiting_for: 'STORAGE_OFFLINE' };
        deps.emit({ profile_id: id, job_id: s.job?.id ?? '', kind: 'upload', state: 'uploading' });
        return;
      }
    }
    step(id, s, 'verifying');
    s.progress = { ...IDLE };
    await tick(300);
    const result = deps.cloud.commit(link.org_id, link.org_profile_id, s.synced_version, deps.cloud.deviceId);
    if ('conflict' in result) {
      s.conflict_head = result.conflict;
      s.dirty = true;
      step(id, s, 'conflict', { error_code: 'VERSION_CONFLICT', head_version: result.conflict });
    } else {
      s.synced_version = result.version;
      s.synced_snapshot = result.snapshot.id;
      s.synced_at = now();
      s.dirty = false;
      step(id, s, 'committed', { version: result.version });
    }
    deps.changed();
  };

  const restore = async (
    target: string,
    org: string,
    orgProfile: string,
    snapshotId: string | null,
    linkAfter: boolean,
    replace: boolean,
  ) => {
    const s = stateOf(target);
    const head = deps.cloud.head(org, orgProfile);
    const snap = snapshotId ? deps.cloud.snapshot(org, snapshotId) : head.snapshot;
    s.job = {
      id: jid(),
      kind: 'restore',
      state: 'planning',
      error_code: null,
      updated_at: now(),
      version: snap?.version ?? null,
      head_version: head.version,
      portability: null,
    };
    deps.emit({ profile_id: target, job_id: s.job.id, kind: 'restore', state: 'planning' });
    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await tick(200);
    if (!snap) {
      step(target, s, 'failed', { error_code: 'NOT_FOUND' });
      return;
    }
    step(target, s, 'downloading');
    for (const done of [15, 30, snap.ciphertext_size / 1_000_000]) {
      s.progress = {
        phase: 'downloading',
        done: Math.round(done * 1_000_000),
        total: snap.ciphertext_size,
        waiting_for: null,
      };
      deps.emit({ profile_id: target, job_id: s.job?.id ?? '', kind: 'restore', state: 'downloading' });
      await tick(200);
      if (canceled(s)) return;
    }
    step(target, s, 'opening');
    s.progress = {
      phase: 'opening',
      done: snap.plaintext_size,
      total: snap.plaintext_size,
      waiting_for: null,
    };
    await tick(250);
    s.progress = { ...IDLE };
    const portability = snap.device_id === deps.cloud.deviceId ? 'supported' : 'sign_in_required';
    if (linkAfter) deps.cloud.link(target, org, orgProfile);
    if (linkAfter || replace) {
      s.synced_version = head.version;
      s.synced_snapshot = snap.id;
      s.synced_at = now();
      s.dirty = snap.version !== head.version;
      s.conflict_head = null;
    }
    step(target, s, 'done', { portability });
    deps.emit({
      profile_id: target,
      job_id: s.job?.id ?? '',
      kind: 'restore',
      state: 'restored',
      version: snap.version,
      portability,
    });
    deps.changed();
  };

  const copyOf = (id: string) => {
    const p = deps.profile(id);
    return deps.create(`${p.name} (restored copy)`.slice(0, 120), p.workspace_id);
  };

  const requireLink = async (id: string) => {
    const link = await linkOf(id);
    if (!link)
      throw err(
        'SYNC_NOT_LINKED',
        'This profile is not part of an organization. Copy it to an organization first to back it up there.',
      );
    return link;
  };
  const requireClosed = (id: string) => {
    if (deps.profile(id).state !== 'stopped')
      throw err(
        'SYNC_PROFILE_NOT_CLOSED',
        'Close the profile first. Only a profile that closed normally is backed up or replaced.',
      );
  };
  const requireIdle = (s: LocalState) => {
    if (running(s)) throw err('SYNC_BUSY', 'A backup or restore of this profile is still in progress.');
  };

  const viewOf = (id: string): ProfileView => {
    if (!deps.view) throw err('INTERNAL', 'Not available in this preview.');
    return deps.view(id);
  };
  const launch = (id: string): Promise<Started> => {
    if (!deps.launch) throw err('INTERNAL', 'Not available in this preview.');
    return deps.launch(id);
  };
  const localCopy = async (orgId: string, orgProfileId: string): Promise<string | null> => {
    const l = (await deps.links(orgId)).find((x) => x.org_profile_id === orgProfileId);
    if (l) {
      try {
        if (!viewOf(l.local_profile_id).trashed_at) return l.local_profile_id;
      } catch {
        /* removed */
      }
    }
    return here.get(`${orgId}/${orgProfileId}`) ?? null;
  };

  return {
    status,
    async backupNow(id) {
      const link = await requireLink(id);
      const s = stateOf(id);
      const phase = deps.teamPhase?.(id) ?? null;
      if (phase)
        throw ['taken_over', 'revoked'].includes(phase)
          ? err(
              'SESSION_ENDED',
              "This profile's session here ended (taken over, or access removed). Dismiss the notice first.",
            )
          : err(
              'TEAM_SESSION_ACTIVE',
              'The session is still active. Close and hand off the profile, or give the handoff up.',
            );
      if (s.conflict_head !== null)
        throw err(
          'SYNC_CONFLICT_OPEN',
          'A newer backup was made on another computer. Choose how to resolve that first.',
        );
      requireClosed(id);
      if (running(s) && s.job?.kind === 'upload' && s.progress.waiting_for) {
        s.progress.waiting_for = null; // retry a waiting upload
      } else requireIdle(s);
      void upload(id, link);
      return status(id);
    },
    async cancel(id) {
      const s = stateOf(id);
      if (running(s) && s.job) {
        step(id, s, 'canceled', { error_code: 'CANCELED' });
        s.progress = { ...IDLE };
        if (s.job.kind === 'upload') s.dirty = true;
      }
      return status(id);
    },
    async setAutoBackup(id, enabled) {
      await requireLink(id);
      stateOf(id).auto = enabled;
      return status(id);
    },
    async resolveConflict(id, choice: ConflictChoice) {
      const link = await requireLink(id);
      const s = stateOf(id);
      if (s.conflict_head === null)
        throw err('SYNC_NO_CONFLICT', 'There is nothing to resolve for this profile.');
      if (choice === 'upload_mine') {
        requireClosed(id);
        s.synced_version = s.conflict_head;
        s.conflict_head = null;
        void upload(id, link);
      } else if (choice === 'use_newer') {
        requireClosed(id);
        void restore(id, link.org_id, link.org_profile_id, null, false, true);
      } else {
        const copy = copyOf(id);
        void restore(copy.id, link.org_id, link.org_profile_id, null, false, false);
      }
      return status(id);
    },
    async restore(id, snapshotId, asCopy) {
      const link = await requireLink(id);
      if (asCopy) {
        const copy = copyOf(id);
        void restore(copy.id, link.org_id, link.org_profile_id, snapshotId, false, false);
      } else {
        requireClosed(id);
        requireIdle(stateOf(id));
        void restore(id, link.org_id, link.org_profile_id, snapshotId, false, true);
      }
      return status(id);
    },
    async restoreHere(orgId, orgProfileId, name) {
      if ((await deps.links(orgId)).some((l) => l.org_profile_id === orgProfileId))
        throw err('SYNC_ALREADY_HERE', 'This organization profile is already on this computer.');
      if (!deps.cloud.head(orgId, orgProfileId).snapshot)
        throw err(
          'SYNC_NO_BACKUP',
          'This organization profile has no backup yet. Back it up from the computer that has it first.',
        );
      const p = deps.create(name, null);
      here.set(`${orgId}/${orgProfileId}`, p.id);
      void restore(p.id, orgId, orgProfileId, null, true, false).finally(() =>
        here.delete(`${orgId}/${orgProfileId}`),
      );
      return p;
    },
    async copies(orgId) {
      const out: WorkspaceCopy[] = [];
      const seen = new Set<string>();
      const add = async (orgProfileId: string, localId: string) => {
        if (seen.has(orgProfileId)) return;
        let profile: ProfileView;
        try {
          profile = viewOf(localId);
        } catch {
          return; // removed meanwhile
        }
        if (profile.trashed_at) return;
        seen.add(orgProfileId);
        out.push({ org_profile_id: orgProfileId, profile, sync: await status(localId) });
      };
      for (const l of await deps.links(orgId)) await add(l.org_profile_id, l.local_profile_id);
      for (const [k, localId] of here) {
        const [o, prf] = k.split('/');
        if (o === orgId && prf) await add(prf, localId);
      }
      return out;
    },
    async prepare(orgId, orgProfileId, name, proxyId) {
      const existing = await localCopy(orgId, orgProfileId);
      if (existing) return viewOf(existing);
      let made: ProfileView;
      if (deps.cloud.head(orgId, orgProfileId).snapshot) {
        made = await this.restoreHere(orgId, orgProfileId, name);
      } else {
        if (deps.cloud.profileName(orgId, orgProfileId) === null)
          throw err('SYNC_FORBIDDEN', 'This profile is not shared with you, or it was removed.');
        made = deps.create(name, null);
        deps.cloud.link(made.id, orgId, orgProfileId);
        deps.changed();
      }
      if (proxyId && deps.assignProxy) return deps.assignProxy(made.id, proxyId);
      return viewOf(made.id);
    },
    async openWorkspaceProfile(orgId, orgProfileId, name) {
      const view = await this.prepare(orgId, orgProfileId, name);
      const isRestoring = () => {
        const s = local.get(view.id);
        return !!s && s.job?.kind === 'restore' && running(s);
      };
      if (!isRestoring()) {
        const started = await launch(view.id);
        return { local_profile_id: view.id, operation_id: started.operation_id, restoring: false };
      }
      void (async () => {
        while (isRestoring()) await new Promise((r) => setTimeout(r, 100));
        if (await linkOf(view.id)) await launch(view.id).catch(() => undefined);
      })();
      return { local_profile_id: view.id, operation_id: null, restoring: true };
    },
    async closingBackup(id) {
      const link = await requireLink(id);
      const s = stateOf(id);
      s.dirty = true;
      if (running(s) && s.job?.kind === 'upload' && s.progress.waiting_for) s.progress.waiting_for = null;
      await upload(id, link);
      if (s.job?.state === 'committed') return 'committed';
      if (s.job?.state === 'conflict') return 'conflict';
      if (s.job?.state === 'canceled') return 'canceled';
      return s.progress.waiting_for ? 'waiting' : 'failed';
    },
    afterCleanClose(id) {
      const s = stateOf(id);
      s.dirty = true;
      void linkOf(id).then((link) => {
        if (link && s.auto && s.conflict_head === null && !running(s)) void upload(id, link);
      });
    },
    seed(id, syncedVersion) {
      const s = stateOf(id);
      s.synced_version = syncedVersion;
      s.synced_at = syncedVersion > 0 ? new Date(Date.now() - 3_600_000).toISOString() : null;
      s.dirty = syncedVersion === 0;
    },
    restoring(id) {
      const s = local.get(id);
      return !!s && s.job?.kind === 'restore' && running(s);
    },
  };
}
