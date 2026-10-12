/**
 * Repository interfaces the UI depends on (milestone 02: "implement repository interfaces so the eventual cloud
 * adapter does not replace UI logic"). Screens never call Tauri directly.
 *
 * - `TauriBackend`  local manager via IPC (this milestone)
 * - `DemoBackend`   in-memory; used when the UI runs in a plain browser (development, UI tests)
 * - a cloud adapter (milestones 06-08) implements the same interfaces
 */
import type {
  AppView,
  EventName,
  EventPayload,
  IpcError,
  ProfileView,
  RuntimeStatus,
  SettingValue,
  Started,
  Workspace,
} from '@pb/contracts/ipc';

export type {
  AppView,
  IpcError,
  Operation,
  ProfileView,
  RuntimeStatus,
  SettingValue,
  Workspace,
} from '@pb/contracts/ipc';

export interface ProfileUpdate {
  expectedVersion: number;
  name?: string;
  clientLabel?: string;
  clearClientLabel?: boolean;
  notes?: string;
}

export interface WorkspaceRepository {
  appState(): Promise<AppView>;
  createWorkspace(name: string): Promise<Workspace>;
  setActiveWorkspace(id: string): Promise<void>;
}

export interface ProfileRepository {
  list(query?: string): Promise<ProfileView[]>;
  create(name: string, clientLabel?: string): Promise<ProfileView>;
  update(id: string, changes: ProfileUpdate): Promise<ProfileView>;
  launch(id: string): Promise<Started>;
  stop(id: string): Promise<Started>;
  closeAll(): Promise<Started>;
}

export interface SystemRepository {
  runtimeStatus(): Promise<RuntimeStatus>;
  updateSetting(key: string, value: unknown, expectedVersion?: number): Promise<SettingValue>;
  selectDownloadDirectory(): Promise<{ path: string | null }>;
  diagnostics(): Promise<Record<string, unknown>>;
  exportDiagnostics(): Promise<{ path: string | null }>;
  reportUiReady(): Promise<number | null>;
  recovery(
    action: 'dismiss_crash' | 'retry_open' | 'restore_backup' | 'discard_interrupted',
    target?: string,
  ): Promise<void>;
  resolveQuit(choice: 'cancel' | 'leave_running' | 'close_all'): Promise<void>;
  openExternal(url: string): Promise<void>;
  removeLocalData(confirm: string): Promise<void>;
}

export interface Backend {
  kind: 'tauri' | 'demo';
  workspaces: WorkspaceRepository;
  profiles: ProfileRepository;
  system: SystemRepository;
  on<E extends EventName>(event: E, handler: (payload: EventPayload<E>) => void): () => void;
}

export function isIpcError(e: unknown): e is IpcError {
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e;
}

export function errorMessage(e: unknown, fallback = 'Something went wrong.'): string {
  return isIpcError(e) ? e.message : fallback;
}
