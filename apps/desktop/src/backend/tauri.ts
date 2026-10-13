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
      exportDiagnostics: () => call('export_diagnostics', {}),
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
