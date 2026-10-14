/**
 * R1 (ADR-0020) in the demo backend: a workspace's migration into the unified model, planned from the demo
 * profiles and the demo server's links. Mirrors the desktop shell's rules: linked profiles keep their workspace
 * id, local-only profiles are adopted only when chosen, open or unclean profiles are left out, and running the
 * same plan twice gives the same mapping.
 */
import type {
  LocalMigrationRun,
  MigrationPlan,
  MigrationPlanEntry,
  MigrationReport,
} from '@pb/contracts/ipc';
import type { MigrationRepository } from './types.ts';

type LocalProfile = { id: string; name: string; state: string; workspace_id: string | null; clean: boolean };

const rid = (prefix: string) =>
  `${prefix}_${Array.from({ length: 26 }, () => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Math.floor(Math.random() * 32)]).join('')}`;

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  if (globalThis.crypto?.subtle) {
    const d = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Non-cryptographic stand-in where SubtleCrypto is missing (insecure contexts): the demo only needs stability.
  let h = 0;
  for (const b of data) h = (h * 31 + b) >>> 0;
  return h.toString(16).padStart(64, '0');
}

export function demoMigration(deps: {
  deviceId: string;
  profiles: (workspaceId: string) => LocalProfile[];
  linkOf: (localId: string) => { org_id: string; org_profile_id: string } | null;
  adopt: (
    orgId: string,
    profiles: { id: string; name: string }[],
  ) => { local_id: string; profile_id: string }[];
  setUnified: (on: boolean) => void;
  changed: () => void;
}): MigrationRepository {
  const runs = new Map<string, LocalMigrationRun>();
  const now = () => new Date().toISOString();

  const build = async (workspaceId: string, orgId: string): Promise<MigrationPlan> => {
    const entries: MigrationPlanEntry[] = deps
      .profiles(workspaceId)
      .map((p) => {
        const link = deps.linkOf(p.id);
        const linked = link && link.org_id === orgId ? link.org_profile_id : null;
        const state: MigrationPlanEntry['state'] = linked
          ? 'linked'
          : p.state !== 'stopped'
            ? 'blocked_running'
            : p.clean
              ? 'local_only'
              : 'blocked_unclean';
        return {
          local_id: p.id,
          view_key: linked ?? `local:${p.id}`,
          name: p.name,
          state,
          cloud_profile_id: linked,
        };
      })
      .sort((a, b) => a.local_id.localeCompare(b.local_id));
    const manifest = JSON.stringify({
      schema: 1,
      org_id: orgId,
      device_id: deps.deviceId,
      workspace_id: workspaceId,
      profiles: entries.map((e) => [e.local_id, e.cloud_profile_id]),
    });
    const digest = await sha256Hex(manifest);
    const count = (s: MigrationPlanEntry['state']) => entries.filter((e) => e.state === s).length;
    const run = runs.get(digest) ?? null;
    return {
      org_id: orgId,
      workspace_id: workspaceId,
      device_id: deps.deviceId,
      manifest_digest: digest,
      entries,
      counts: {
        profiles: entries.length,
        linked: count('linked'),
        mapped_on_server: 0,
        local_only: count('local_only'),
        blocked: count('blocked_running') + count('blocked_unclean'),
        adopted: Number((run?.counts as { adopted?: number } | null)?.adopted ?? 0),
        skipped: Number((run?.counts as { skipped?: number } | null)?.skipped ?? 0),
      },
      quota: { profiles_used: count('linked'), profiles_allowed: 100 },
      run,
    };
  };
  const report = (orgId: string, run: LocalMigrationRun): MigrationReport => {
    const mappings: Record<string, string> = {};
    for (const ws of new Set(Array.from(runs.values()).map((r) => r.workspace_id))) {
      for (const p of deps.profiles(ws)) {
        const link = deps.linkOf(p.id);
        if (link && link.org_id === orgId) mappings[p.id] = link.org_profile_id;
      }
    }
    return { run, mappings };
  };
  const latest = (orgId: string) =>
    Array.from(runs.values())
      .filter((r) => r.org_id === orgId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];

  return {
    async plan(workspaceId, orgId) {
      const plan = await build(workspaceId, orgId);
      if (!plan.run) {
        const t = now();
        const run: LocalMigrationRun = {
          id: rid('mgr'),
          org_id: orgId,
          workspace_id: workspaceId,
          manifest_digest: plan.manifest_digest,
          state: 'planned',
          checkpoint: {},
          counts: plan.counts,
          error_code: null,
          server_run_id: null,
          created_at: t,
          updated_at: t,
        };
        runs.set(plan.manifest_digest, run);
        plan.run = run;
      }
      return plan;
    },
    async run(workspaceId, orgId, adopt, _sync, batchSize) {
      const plan = await this.plan(workspaceId, orgId);
      const run = plan.run as LocalMigrationRun;
      if (run.state === 'completed') return report(orgId, run);
      const byId = new Map(plan.entries.map((e) => [e.local_id, e]));
      const selected = [...new Set(adopt)]
        .map((id) => {
          const e = byId.get(id);
          if (!e) throw { code: 'UNKNOWN_PROFILE', message: 'No such profile.' };
          if (e.state === 'blocked_running')
            throw { code: 'PROFILE_RUNNING', message: 'Close the profile first.' };
          if (e.state === 'blocked_unclean')
            throw { code: 'MIGRATION_PROFILE_UNCLEAN', message: 'Open and close the profile once first.' };
          return e;
        })
        .filter((e) => e.state === 'local_only')
        .sort((a, b) => a.local_id.localeCompare(b.local_id));
      const batch = batchSize ?? 50;
      let adopted = 0;
      for (let i = 0; i < selected.length; i += batch) {
        const slice = selected.slice(i, i + batch).map((e) => ({ id: e.local_id, name: e.name }));
        adopted += deps.adopt(orgId, slice).length;
        run.checkpoint = { step: 'adopt', batch_size: batch, batches_done: Math.floor(i / batch) + 1 };
        run.state = 'running';
        run.updated_at = now();
      }
      run.counts = { ...plan.counts, adopted, skipped: plan.counts.local_only - selected.length };
      run.state = 'completed';
      run.updated_at = now();
      deps.setUnified(true);
      deps.changed();
      return report(orgId, run);
    },
    async rollback(orgId) {
      deps.setUnified(false);
      const run = latest(orgId);
      if (!run) throw { code: 'MIGRATION_NO_RUN', message: 'This workspace has not been migrated here.' };
      run.state = 'rolled_back';
      run.updated_at = now();
      deps.changed();
      return report(orgId, run);
    },
    async report(orgId) {
      const run = latest(orgId);
      if (!run) throw { code: 'MIGRATION_NO_RUN', message: 'This workspace has not been migrated here.' };
      return report(orgId, run);
    },
  };
}
