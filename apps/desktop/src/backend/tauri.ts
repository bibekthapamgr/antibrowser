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
    workspaces: {
      appState: () => call('get_app_state', {}),
      createWorkspace: (name) => call('create_workspace', { name }),
      setActiveWorkspace: async (workspaceId) => {
        await call('set_active_workspace', { workspaceId });
      },
    },
    profiles: {
      list: (query) => call('list_profiles', query ? { query, limit: 10000 } : { limit: 10000 }),
      create: (name, clientLabel) => call('create_profile', clientLabel ? { name, clientLabel } : { name }),
      update: (profileId, c) => call('update_profile', { profileId, ...c }),
      launch: (profileId) => call('launch_profile', { profileId }),
      stop: (profileId) => call('stop_profile', { profileId }),
      closeAll: () => call('close_all_profiles', {}),
    },
    system: {
      runtimeStatus: () => call('get_runtime_status', {}),
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
