/**
 * Demo stand-in for the milestone 09 shell commands (UI development and UI tests only): health cards with check
 * times, resource use of open profiles (made-up but stable numbers), installed extensions judged by the demo
 * organization's policy, the pre-open check, selection summaries, client overviews and a redacted diagnostics
 * preview. Modes (`?demo=`): `extupdate` (an extension update added sensitive permissions), `lowmem` (little free
 * memory), `serverdown` (the server check fails).
 */
import { type ExtensionRule, isSensitivePermission, judgeExtension } from '@pb/contracts/agency';
import type {
  AgencyRepository,
  Client,
  ClientOverview,
  DiagnosticsPreview,
  ExtensionsView,
  HealthCard,
  HealthView,
  IpcError,
  LaunchCheck,
  NetworkCheck,
  ProfileView,
  ResourcesView,
  Selection,
  SelectionSummary,
} from './types.ts';

type Ext = ExtensionsView['profiles'][number]['extensions'][number];
const MB = 1024 * 1024;
const GB = 1024 * MB;
const err = (code: string, message: string): IpcError => ({ code, message });

export interface DemoAgencyContext {
  mode: string;
  profiles(): ProfileView[];
  clients(): Client[];
  setting(key: string): unknown;
  proxies(): { name: string; last_check: NetworkCheck | null }[];
  runtimeInstalled(): boolean;
  linkOf(profileId: string): { org_id: string; org_profile_id: string } | null;
  policy(orgId: string): { mode: 'off' | 'warn' | 'enforce'; version: number; rules: ExtensionRule[] } | null;
  signedIn(): boolean;
  resolve(selection: Selection): string[];
  emit(payload: {
    code: 'EXTENSION_PERMISSIONS_ADDED';
    profile_id: string;
    extension_id: string;
    permissions: string[];
  }): void;
}

export function demoAgency(ctx: DemoAgencyContext): AgencyRepository {
  const now = () => new Date().toISOString();
  const checkedServer: { at: string | null; ok: boolean } = { at: null, ok: true };
  const installed = new Map<string, Ext[]>();
  const scanned = new Map<string, string>();
  const previews = new Map<string, DiagnosticsPreview>();

  const ext = (
    id: string,
    name: string,
    version: string,
    permissions: string[],
    extra: Partial<Ext> = {},
  ): Ext => ({
    id: id.repeat(32),
    name,
    version,
    previous_version: null,
    source: 'web_store',
    enabled: true,
    permissions,
    sensitive: permissions.filter(isSensitivePermission),
    added_sensitive: [],
    changed_at: now(),
    verdict: null,
    ...extra,
  });
  /** The first two profiles have extensions (as Chromium would have recorded them). */
  const seed = () => {
    if (installed.size) return;
    const [first, second] = ctx.profiles();
    if (first)
      installed.set(first.id, [
        ext('a', 'Grammar helper', '4.2.0', ['activeTab', 'storage']),
        ext('b', 'Coupon finder', '2.1.0', ['<all_urls>', 'tabs']),
      ]);
    if (second)
      installed.set(second.id, [
        ctx.mode.includes('extupdate')
          ? ext('c', 'Tab saver', '3.1.0', ['<all_urls>', 'cookies', 'storage'], {
              previous_version: '3.0.4',
              added_sensitive: ['<all_urls>', 'cookies'],
            })
          : ext('c', 'Tab saver', '3.0.4', ['storage']),
      ]);
    for (const id of installed.keys()) scanned.set(id, now());
  };

  const view = (only?: string): ExtensionsView => {
    seed();
    const profiles = ctx.profiles().filter((p) => (only ? p.id === only : installed.has(p.id)));
    const orgs = new Set<string>();
    return {
      profiles: profiles.map((p) => {
        const link = ctx.linkOf(p.id);
        if (link) orgs.add(link.org_id);
        const policy = link ? ctx.policy(link.org_id) : null;
        const mode = !link ? 'local' : !policy ? 'unknown' : policy.mode;
        const list = (installed.get(p.id) ?? []).map((e) => ({
          ...e,
          verdict: policy ? judgeExtension(policy.rules, e) : null,
        }));
        const judging = !!policy && policy.mode !== 'off';
        const needs = list.filter(
          (e) =>
            (judging && e.verdict && e.verdict.status !== 'approved') ||
            (!link && e.added_sensitive.length > 0),
        ).length;
        return {
          profile_id: p.id,
          name: p.name,
          client_name: p.client_name,
          org_id: link?.org_id ?? null,
          mode,
          scan_status: scanned.has(p.id) ? 'ok' : null,
          scanned_at: scanned.get(p.id) ?? null,
          reported_at: link ? (scanned.get(p.id) ?? null) : null,
          will_disable: mode === 'enforce' && needs > 0,
          needs_attention: needs,
          extensions: list,
        };
      }),
      policies: [...orgs].flatMap((o) => {
        const p = ctx.policy(o);
        return p
          ? [{ org_id: o, mode: p.mode, version: p.version, rules: p.rules.length, fetched_at: now() }]
          : [];
      }),
    };
  };

  const memory = () => {
    const total = 16 * GB;
    const running = ctx.profiles().filter((p) => p.status === 'running' || p.status === 'starting');
    const available = ctx.mode.includes('lowmem') ? 1.2 * GB : 9.4 * GB - running.length * 480 * MB;
    return { total, available: Math.max(0, Math.round(available)), running };
  };
  const estimate = () => ({ per_profile_bytes: 480 * MB, source: 'measured' as const, samples: 24 });

  const health = (): HealthView => {
    seed();
    const t = now();
    const card = (
      c: Omit<HealthCard, 'checked_at' | 'valid_until' | 'items' | 'action'> & Partial<HealthCard>,
    ): HealthCard => ({
      checked_at: t,
      valid_until: null,
      items: [],
      action: null,
      ...c,
    });
    const cards: HealthCard[] = [];
    if (!ctx.signedIn())
      cards.push(
        card({
          id: 'connectivity',
          title: 'Server connection',
          status: 'off',
          summary: 'No organization server is set up; this computer works on its own.',
        }),
      );
    else if (!checkedServer.at)
      cards.push(
        card({
          id: 'connectivity',
          title: 'Server connection',
          status: 'unknown',
          summary: 'Not checked yet.',
          checked_at: null,
          action: 'retry_server',
        }),
      );
    else
      cards.push(
        card({
          id: 'connectivity',
          title: 'Server connection',
          status: checkedServer.ok ? 'ok' : 'problem',
          summary: checkedServer.ok
            ? 'The server answered and your sign-in works.'
            : 'The server could not be reached from this computer.',
          checked_at: checkedServer.at,
          valid_until: new Date(Date.parse(checkedServer.at) + 15 * 60_000).toISOString(),
          action: 'retry_server',
        }),
      );
    const proxies = ctx.proxies();
    const items = proxies.map((p) => {
      const c = p.last_check;
      const stale = !c || Date.now() - Date.parse(c.checked_at) > 86_400_000;
      return {
        label: p.name,
        status: !c
          ? ('unknown' as const)
          : stale
            ? ('unknown' as const)
            : c.result === 'ok'
              ? ('ok' as const)
              : ('problem' as const),
        detail: !c
          ? 'Never checked.'
          : stale
            ? 'The last check is more than a day old; it says nothing about now.'
            : c.result === 'ok'
              ? 'Reachable when checked.'
              : `Failed when checked (${c.error_code ?? 'error'}).`,
        checked_at: c?.checked_at ?? null,
      };
    });
    const worst = (s: HealthCard['status'][]) =>
      (['problem', 'warning', 'unknown', 'ok'] as const).find((x) => s.includes(x)) ?? 'ok';
    cards.push(
      proxies.length === 0
        ? card({ id: 'proxies', title: 'Proxies', status: 'off', summary: 'No proxies in this workspace.' })
        : card({
            id: 'proxies',
            title: 'Proxies',
            status: worst(items.map((i) => i.status)),
            summary: items.every((i) => i.status === 'ok')
              ? `${items.length} checked in the last 24 hours and reachable.`
              : `${items.filter((i) => i.status !== 'ok').length} not checked recently or failing.`,
            checked_at:
              items
                .map((i) => i.checked_at)
                .filter((x) => x !== null)
                .sort()
                .at(-1) ?? null,
            action: 'check_proxies',
            items,
          }),
    );
    cards.push(
      ctx.runtimeInstalled()
        ? card({
            id: 'browser',
            title: 'Browser',
            status: 'ok',
            summary: 'Browser 155.0.8059.39 is installed and verified (the version this app is built for).',
          })
        : card({
            id: 'browser',
            title: 'Browser',
            status: 'problem',
            summary: 'Browser 155.0.8059.39 needs to be installed before profiles can open.',
            action: 'open_runtime',
          }),
    );
    const linked = ctx.profiles().filter((p) => ctx.linkOf(p.id));
    cards.push(
      linked.length === 0
        ? card({
            id: 'backups',
            title: 'Backups',
            status: 'off',
            summary: 'No organization profiles on this computer.',
          })
        : card({
            id: 'backups',
            title: 'Backups',
            status: 'ok',
            summary: `${linked.length} organization profiles: backups are current.`,
            action: 'open_backups',
          }),
    );
    cards.push(
      card({
        id: 'conflicts',
        title: 'Sync conflicts',
        status: 'ok',
        summary: 'No conflicts or sessions waiting for a decision.',
      }),
    );
    cards.push(card({ id: 'disk', title: 'Disk space', status: 'ok', summary: '212 GB free.' }));
    const { total, available, running } = memory();
    cards.push(
      card({
        id: 'locks',
        title: 'Open profiles and sessions',
        status: 'ok',
        summary: `${running.length} open on this computer; ${linked.filter((p) => p.status === 'running').length} shared sessions held by this computer.`,
        action: running.length ? 'open_resources' : null,
      }),
    );
    const ev = view();
    const extItems = ev.profiles
      .filter((p) => p.needs_attention > 0)
      .map((p) => ({
        label: p.name,
        status: p.will_disable ? ('problem' as const) : ('warning' as const),
        detail: p.will_disable
          ? `${p.needs_attention} not approved: extensions will be off at the next open.`
          : p.mode === 'local'
            ? `${p.needs_attention} updated and asks for more access: review.`
            : `${p.needs_attention} not approved by your organization.`,
        checked_at: p.scanned_at,
      }));
    cards.push(
      card({
        id: 'extensions',
        title: 'Extensions',
        status: extItems.length ? worst(extItems.map((i) => i.status)) : 'ok',
        summary: extItems.length
          ? `${extItems.length} profiles need attention.`
          : `${ev.profiles.reduce((n, p) => n + p.extensions.length, 0)} extensions in ${ev.profiles.length} profiles; nothing waiting for review.`,
        action: 'open_extensions',
        items: extItems,
      }),
    );
    const fits = Math.max(0, Math.floor((available - GB) / estimate().per_profile_bytes));
    cards.push(
      card({
        id: 'memory',
        title: 'Memory',
        status: available < GB + estimate().per_profile_bytes ? 'warning' : 'ok',
        summary: `${(available / GB).toFixed(1)} of ${(total / GB).toFixed(1)} GB available: room for about ${fits} more profiles (measured estimate; real use depends on the sites).`,
        action: 'open_resources',
      }),
    );
    return { generated_at: t, cards };
  };

  return {
    async health() {
      return health();
    },
    async runCheck(check) {
      if (check === 'server') {
        checkedServer.at = now();
        checkedServer.ok = !ctx.mode.includes('serverdown');
      } else if (check === 'extensions') {
        seed();
        for (const id of installed.keys()) scanned.set(id, now());
      }
      return health();
    },
    async resources(): Promise<ResourcesView> {
      const { total, available, running } = memory();
      const profiles = running.map((p, i) => ({
        profile_id: p.id,
        name: p.name,
        client_name: p.client_name,
        processes: 6 + (i % 3),
        memory_bytes: (420 + 37 * i) * MB,
        open_seconds: 600 + 900 * i,
      }));
      return {
        measured_at: now(),
        manager: { processes: 3, memory_bytes: 142 * MB },
        profiles,
        browsers_memory_bytes: profiles.reduce((n, p) => n + p.memory_bytes, 0),
        total_memory_bytes: total,
        available_memory_bytes: available,
        estimate: estimate(),
      };
    },
    async checkLaunch(profileIds): Promise<LaunchCheck> {
      const all = ctx.profiles();
      const chosen = all.filter((p) => profileIds.includes(p.id));
      const toOpen = chosen.filter((p) => p.status !== 'running' && p.status !== 'starting');
      const { available } = memory();
      const per = estimate().per_profile_bytes;
      const needed = per * toOpen.length;
      const ev = view();
      return {
        to_open: toOpen.length,
        already_open: chosen.length - toOpen.length,
        memory: {
          warn:
            ctx.setting('resources.memory_warning') !== false && toOpen.length > 0 && available < needed + GB,
          available_bytes: available,
          needed_bytes: needed,
          reserve_bytes: GB,
          fits_about: Math.max(0, Math.floor((available - GB) / per)),
          estimate: estimate(),
        },
        extensions: ev.profiles
          .filter(
            (p) => toOpen.some((x) => x.id === p.profile_id) && (p.mode === 'warn' || p.mode === 'enforce'),
          )
          .map((p) => ({
            profile_id: p.profile_id,
            name: p.name,
            mode: p.mode as 'warn' | 'enforce',
            disable: p.mode === 'enforce',
            items: p.extensions
              .filter((e) => e.verdict && e.verdict.status !== 'approved')
              .map((e) => ({
                id: e.id,
                name: e.name,
                verdict: e.verdict ?? { status: 'not_listed' as const },
              })),
          }))
          .filter((p) => p.items.length > 0),
      };
    },
    async selectionSummary(selection): Promise<SelectionSummary> {
      const ids = ctx.resolve(selection);
      const rows = ctx.profiles().filter((p) => ids.includes(p.id));
      const groups = new Map<
        string,
        { client_id: string | null; client_name: string | null; names: string[] }
      >();
      for (const p of rows) {
        const key = p.client_id ?? '';
        const g = groups.get(key) ?? { client_id: p.client_id, client_name: p.client_name, names: [] };
        g.names.push(p.name);
        groups.set(key, g);
      }
      return {
        total: rows.length,
        running: rows.filter((p) => p.status === 'running').length,
        shared: rows.filter((p) => ctx.linkOf(p.id)).length,
        missing: ids.length - rows.length,
        clients: [...groups.values()]
          .sort((a, b) =>
            a.client_name === null
              ? 1
              : b.client_name === null
                ? -1
                : a.client_name.localeCompare(b.client_name),
          )
          .map((g) => ({
            client_id: g.client_id,
            client_name: g.client_name,
            count: g.names.length,
            names: g.names.sort((a, b) => a.localeCompare(b)).slice(0, 5),
          })),
      };
    },
    async clientOverview(clientId): Promise<ClientOverview> {
      const client = ctx.clients().find((c) => c.id === clientId);
      if (!client) throw err('UNKNOWN_CLIENT', 'That client does not exist in this workspace.');
      const ps = ctx.profiles().filter((p) => p.client_id === clientId && !p.trashed_at);
      const perClient = ctx.setting('downloads.per_client_folders') === true;
      const base = (ctx.setting('downloads.directory') as string | null) ?? '~/Downloads';
      const folder = client.name.replace(/[<>:"/\\|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '') || 'Client';
      return {
        client,
        profiles: {
          total: ps.length,
          running: ps.filter((p) => p.status === 'running').length,
          never_opened: ps.filter((p) => !p.last_started_at).length,
          crashed: ps.filter((p) => p.status === 'crashed').length,
          shared: ps.filter((p) => ctx.linkOf(p.id)).length,
          archived: ps.filter((p) => p.archived_at).length,
          items: ps.slice(0, 50).map((p) => ({
            id: p.id,
            name: p.name,
            state: p.state,
            last_started_at: p.last_started_at,
            last_backup_at: p.last_backup_at,
            shared: !!ctx.linkOf(p.id),
            running: p.status === 'running',
            archived: !!p.archived_at,
          })),
          more: ps.length > 50,
        },
        activity: ps
          .filter((p) => p.last_started_at)
          .map((p) => ({
            at: p.last_started_at ?? now(),
            profile_id: p.id,
            profile_name: p.name,
            action: 'start',
            outcome: 'ok',
          })),
        downloads: {
          client_folder: client.download_dir ?? null,
          per_client_folders: perClient,
          effective:
            client.download_dir ??
            (perClient ? `${base}/${folder}` : (ctx.setting('downloads.directory') as string | null)),
          folder_name: folder,
        },
      };
    },
    async selectClientDownloadDirectory(clientId, clear) {
      const client = ctx.clients().find((c) => c.id === clientId);
      if (!client) throw err('UNKNOWN_CLIENT', 'That client does not exist in this workspace.');
      client.download_dir = clear ? null : `/Users/demo/Clients/${client.name}`;
      return { path: client.download_dir };
    },
    async extensions(profileId) {
      return view(profileId);
    },
    async rescanExtensions(profileId) {
      seed();
      for (const id of profileId ? [profileId] : installed.keys()) scanned.set(id, now());
      return view(profileId);
    },
    async reviewExtension(profileId, extensionId) {
      const list = installed.get(profileId);
      const e = list?.find((x) => x.id === extensionId);
      if (!e) throw err('INVALID_ARGUMENT', 'That extension is not installed in this profile.');
      e.added_sensitive = [];
      return view(profileId);
    },
    async previewDiagnostics() {
      const report = {
        app: { version: '0.11.0-demo', platform: 'demo', arch: 'demo' },
        generated_at: now(),
        data_directory: '~/Library/Application Support/Project Browser',
        store: { status: 'ready', schema_version: 9, journal_mode: 'wal', integrity_ok: true },
        runtime: { manifest_status: { status: 'verified', version: '155.0.8059.39' } },
        operations: [
          {
            operation_id: 'op_12',
            kind: 'launch_profile',
            status: 'failed',
            error_code: 'PROXY_AUTH_FAILED',
          },
        ],
        error_summary: [{ code: 'PROXY_AUTH_FAILED', count: 2 }],
        recent_activity: [
          {
            at: now(),
            profile_id: ctx.profiles()[0]?.id ?? null,
            action: 'network',
            outcome: 'PROXY_AUTH_FAILED',
            detail: '<address> <email> token=[secret]',
          },
        ],
        health: health().cards.map((c) => ({ id: c.id, status: c.status, checked_at: c.checked_at })),
      };
      const text = JSON.stringify(report, null, 2);
      const p: DiagnosticsPreview = {
        preview_id: `diag_${Math.random().toString(16).slice(2, 18)}`,
        text,
        bytes: new TextEncoder().encode(text).length,
        limit_bytes: 1024 * 1024,
        truncated: false,
        redactions: {
          addresses: 1,
          emails: 1,
          ip_addresses: 0,
          paths: 1,
          user_names: 1,
          secrets: 1,
          tokens: 0,
        },
        expires_in_seconds: 600,
      };
      previews.set(p.preview_id, p);
      return p;
    },
    async exportDiagnostics(previewId) {
      if (!previews.has(previewId))
        throw err(
          'PREVIEW_EXPIRED',
          'The preview is no longer available. Preview the report again, then save it.',
        );
      previews.delete(previewId);
      return { path: '~/Downloads/project-browser-diagnostics.json' };
    },
  };
}

/** Demo: raises the "update added permissions" notice once, a moment after start (mode `extupdate`). */
export function announceDemoExtensionUpdate(ctx: DemoAgencyContext) {
  if (!ctx.mode.includes('extupdate')) return;
  const second = ctx.profiles()[1];
  if (second)
    setTimeout(
      () =>
        ctx.emit({
          code: 'EXTENSION_PERMISSIONS_ADDED',
          profile_id: second.id,
          extension_id: 'c'.repeat(32),
          permissions: ['<all_urls>', 'cookies'],
        }),
      300,
    );
}
