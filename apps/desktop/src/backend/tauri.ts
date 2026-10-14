import type { CommandArgs, CommandName, CommandResult, EventName, EventPayload } from '@pb/contracts/ipc';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Backend } from './types.ts';

/** Typed wrapper: command names, argument keys and result types come from the shared IPC contract. */
function call<C extends CommandName>(cmd: C, args: CommandArgs<C>): Promise<CommandResult<C>> {
  return invoke<CommandResult<C>>(cmd, args as Record<string, unknown>);
}

export function tauriBackend(): Backend {
  return {
    kind: 'tauri',
    agency: {
      health: () => call('get_health', {}),
      runCheck: (check) => call('run_health_check', { check }),
      resources: () => call('get_resources', {}),
      checkLaunch: (profileIds) => call('check_launch', { profileIds }),
      selectionSummary: (selection) => call('selection_summary', { selection }),
      clientOverview: (clientId) => call('get_client_overview', { clientId }),
      selectClientDownloadDirectory: (clientId, clear) =>
        call('select_client_download_directory', clear ? { clientId, clear } : { clientId }),
      extensions: (profileId) => call('get_extensions', profileId ? { profileId } : {}),
      rescanExtensions: (profileId) => call('rescan_extensions', profileId ? { profileId } : {}),
      reviewExtension: (profileId, extensionId) => call('review_extension', { profileId, extensionId }),
      previewDiagnostics: () => call('preview_diagnostics', {}),
      exportDiagnostics: (previewId) => call('export_diagnostics', { previewId }),
    },
    automation: {
      status: () => call('get_automation_status', {}),
      enroll: (orgId, accepts, maxJobs) => call('automation_enroll', { orgId, accepts, maxJobs }),
      unenroll: (orgId) => call('automation_unenroll', { orgId }),
      stopJob: (jobId) => call('automation_stop_job', { jobId }),
      setDebugging: (allow) => call('automation_set_debugging', { allow }),
      screenshot: (orgId, jobId, artifactId) => call('automation_screenshot', { orgId, jobId, artifactId }),
    },
    billing: {
      openCheckout: (orgId, planId) => call('billing_open_checkout', { orgId, planId }),
      openPortal: (orgId) => call('billing_open_portal', { orgId }),
      openInvoice: (orgId, invoiceId, pdf) => call('billing_open_invoice', { orgId, invoiceId, pdf }),
    },
    updates: {
      get: () => call('get_update_status', {}),
      check: () => call('check_for_updates', {}),
      download: () => call('download_update', {}),
      cancel: () => call('cancel_update_download', {}),
      install: () => call('install_update', {}),
    },
    account: {
      get: () => call('get_account', {}),
      setServer: (url) => call('set_cloud_server', { url }),
      signIn: async (reauth) => {
        await call('begin_sign_in', reauth ? { reauth } : {});
      },
      cancelSignIn: () => call('cancel_sign_in', {}),
      signOut: () => call('sign_out', {}),
      request: (r) =>
        call('cloud_request', {
          method: r.method,
          path: r.path,
          ...(r.query ? { query: r.query } : {}),
          ...(r.body ? { body: r.body } : {}),
          ...(r.ifMatch ? { ifMatch: r.ifMatch } : {}),
        }),
      orgImport: (workspaceId, orgId, dryRun, mapping) =>
        call('org_import', { workspaceId, orgId, dryRun, ...(mapping ? { mapping } : {}) }),
      links: (orgId) => call('list_org_links', orgId ? { orgId } : {}),
    },
    sync: {
      status: (profileId) => call('get_sync_status', { profileId }),
      backupNow: (profileId) => call('sync_backup_now', { profileId }),
      cancel: (profileId) => call('sync_cancel', { profileId }),
      setAutoBackup: (profileId, enabled) => call('sync_set_auto_backup', { profileId, enabled }),
      resolveConflict: (profileId, choice) => call('sync_resolve_conflict', { profileId, choice }),
      restore: (profileId, snapshotId, asCopy) =>
        call('sync_restore', snapshotId ? { profileId, snapshotId, asCopy } : { profileId, asCopy }),
      restoreHere: (orgId, orgProfileId, name) => call('sync_restore_here', { orgId, orgProfileId, name }),
    },
    team: {
      status: (profileId) => call('get_team_status', { profileId }),
      close: (profileId, note) => call('team_close', { profileId, note }),
      abort: (profileId) => call('team_abort', { profileId }),
      retry: (profileId) => call('team_retry', { profileId }),
      dismiss: (profileId) => call('team_dismiss', { profileId }),
      restoreRecoveryCopy: (orgId, orgProfileId, snapshotId, name) =>
        call('team_restore_recovery_copy', { orgId, orgProfileId, snapshotId, name }),
    },
    workspaces: {
      appState: () => call('get_app_state', {}),
      createWorkspace: (name) => call('create_workspace', { name }),
      setActiveWorkspace: async (workspaceId) => {
        await call('set_active_workspace', { workspaceId });
      },
    },
    profiles: {
      query: (q) => call('query_profiles', q),
      create: (name, client, templateId) =>
        call('create_profile', {
          name,
          ...(client ? { client } : {}),
          ...(templateId ? { templateId } : {}),
        }),
      update: (profileId, c) => call('update_profile', { profileId, ...c }),
      duplicate: (profileId, name) => call('duplicate_profile', { profileId, name }),
      bulk: (action, selection) => call('bulk_profiles', { action, selection }),
      undo: (token) => call('undo_action', { token }),
      deletePermanently: (selection, expectedCount) =>
        call('delete_profiles', { selection, confirm: 'DELETE', expectedCount }),
      launch: (profileId) => call('launch_profile', { profileId }),
      stop: (profileId, force) => call('stop_profile', force ? { profileId, force } : { profileId }),
      closeAll: (force) => call('close_all_profiles', force ? { force } : {}),
      status: (profileId) => call('get_profile_status', { profileId }),
      recover: (profileId, action) => call('recover_profile', { profileId, action }),
      selectDownloadDirectory: (profileId) => call('select_profile_download_directory', { profileId }),
    },
    library: {
      library: () => call('get_library', {}),
      createClient: (name, colour) => call('create_client', colour ? { name, colour } : { name }),
      updateClient: (clientId, expectedVersion, c) =>
        call('update_client', { clientId, expectedVersion, ...c }),
      createTag: (name) => call('create_tag', { name }),
      renameTag: async (tagId, name) => {
        await call('rename_tag', { tagId, name });
      },
      deleteTag: async (tagId) => {
        await call('delete_tag', { tagId });
      },
      saveFilter: (name, filter, sort) => call('save_filter', { name, filter, sort }),
      deleteFilter: async (filterId) => {
        await call('delete_filter', { filterId });
      },
      saveTemplate: (profileId, name) => call('save_template', { profileId, name }),
      deleteTemplate: async (templateId) => {
        await call('delete_template', { templateId });
      },
    },
    transfer: {
      chooseFile: () => call('choose_import_file', {}),
      preview: (fileRef, settings) => call('preview_import', { fileRef, settings }),
      commit: (previewId) => call('commit_import', { previewId }),
      cancel: async (jobId) => {
        await call('cancel_import', { jobId });
      },
      jobs: () => call('list_imports', {}),
      export: (selection, format, includeNotes) =>
        call('export_profiles', { selection, format, includeNotes }),
    },
    network: {
      proxies: () => call('list_proxies', {}),
      createProxy: (proxy) => call('create_proxy', { proxy }),
      updateProxy: (proxyId, expectedVersion, changes) =>
        call('update_proxy', { proxyId, expectedVersion, changes }),
      deleteProxy: async (proxyId) => {
        await call('delete_proxy', { proxyId });
      },
      testProxy: (proxyId) => call('test_proxy', { proxyId }),
      checks: (proxyId) => call('list_proxy_checks', { proxyId }),
      assign: (profileId, proxyId, failClosed, expectedVersion) =>
        call('assign_proxy', { profileId, proxyId, failClosed, expectedVersion }),
      validatePrivacy: (config, failClosedProxy) => call('validate_privacy', { config, failClosedProxy }),
      privacyOptions: () => call('get_privacy_options', {}),
    },
    system: {
      runtimeStatus: () => call('get_runtime_status', {}),
      installRuntime: (version) => call('install_runtime', { version }),
      updateSetting: (key, value, expectedVersion) =>
        call(
          'update_setting',
          expectedVersion === undefined ? { key, value } : { key, value, expectedVersion },
        ),
      selectDownloadDirectory: () => call('select_download_directory', {}),
      diagnostics: () => call('get_diagnostics', {}) as Promise<Record<string, unknown>>,
      reportUiReady: () => call('report_ui_ready', {}),
      recovery: async (action, target) => {
        await call('recovery_action', target ? { action, target } : { action });
      },
      resolveQuit: async (choice) => {
        await call('resolve_quit', { choice });
      },
      openExternal: async (url) => {
        await call('open_external', { url });
      },
      removeLocalData: async (confirm) => {
        await call('remove_local_data', { confirm: confirm as 'DELETE' });
      },
    },
    on<E extends EventName>(event: E, handler: (payload: EventPayload<E>) => void) {
      let unlisten: (() => void) | null = null;
      let cancelled = false;
      void listen<EventPayload<E>>(event, (e) => handler(e.payload)).then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
      return () => {
        cancelled = true;
        unlisten?.();
      };
    },
  };
}
