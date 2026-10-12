/**
 * Typed wrapper over the three IPC commands the manager window is allowed to call
 * (apps/desktop/src-tauri/capabilities/default.json). Outside Tauri (plain `vite` in a browser) a small
 * in-memory demo backend is used so the UI can be developed without the native shell.
 */
import { invoke } from '@tauri-apps/api/core';

export interface LocalProfile {
  id: string;
  name: string;
  client_label: string | null;
  folder_label: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  running_pid: number | null;
}

export interface IpcError {
  code: string;
  message: string;
}

const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function isIpcError(e: unknown): e is IpcError {
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e;
}

export const api = {
  listProfiles: (query?: string): Promise<LocalProfile[]> =>
    inTauri ? invoke('list_profiles', { query: query ?? null, limit: 100 }) : demo.list(query),
  createLocalProfile: (name: string, clientLabel?: string): Promise<LocalProfile> =>
    inTauri
      ? invoke('create_local_profile', { name, clientLabel: clientLabel || null })
      : demo.create(name, clientLabel),
  launchProfile: (profileId: string): Promise<{ pid: number }> =>
    inTauri ? invoke('launch_profile', { profileId }) : demo.launch(profileId),
};

// ------------------------------------------------------------------ browser-only demo backend
const now = new Date().toISOString();
const demoSeed: [string, string, string | null][] = [
  ['prf_01J9ZSEED0DEM0000000000001', 'Shop admin', 'Client North'],
  ['prf_01J9ZSEED0DEM0000000000002', 'Ads QA', 'Client South'],
  ['prf_01J9ZSEED0DEM0000000000003', 'Support desk', null],
];
const demoRows: LocalProfile[] = demoSeed.map(([id, name, client]) => ({
  id,
  name,
  client_label: client,
  folder_label: null,
  version: 1,
  created_at: now,
  updated_at: now,
  running_pid: null,
}));

const demo = {
  async list(query?: string) {
    const q = query?.trim().toLowerCase();
    return demoRows.filter((p) => !q || `${p.name} ${p.client_label ?? ''}`.toLowerCase().includes(q));
  },
  async create(name: string, client?: string) {
    const row: LocalProfile = {
      ...(demoRows[0] as LocalProfile),
      id: `prf_01J9ZSEED0DEM${String(demoRows.length + 1).padStart(13, '0')}`,
      name,
      client_label: client || null,
    };
    demoRows.push(row);
    return row;
  },
  async launch(_id: string): Promise<{ pid: number }> {
    throw {
      code: 'BROWSER_NOT_CONFIGURED',
      message: 'Demo mode: launching needs the desktop app.',
    } satisfies IpcError;
  },
};
