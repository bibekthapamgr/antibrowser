/**
 * Organization API helpers for the manager UI. Requests go through the shell (`backend.account.request`), which adds
 * the session token; the UI only sees API bodies (types from packages/contracts) and whether they came from the
 * offline cache.
 */
import type { Permission, Role } from '@pb/contracts/resources';
import { ROLE_PERMISSIONS } from '@pb/contracts/resources';
import type { Backend, CloudRequest } from './backend/types.ts';

export interface ApiResult<T> {
  data: T;
  status: number;
  /** Served from the offline cache: show it, but do not act on it. */
  stale: boolean;
  fetchedAt: string | null;
}

/** An API error answer, shaped like an IPC error so `errorMessage` shows its message. */
export class ApiFailure extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api<T>(backend: Backend, req: CloudRequest): Promise<ApiResult<T>> {
  const res = await backend.account.request(req);
  if (res.status >= 400) {
    const body = (res.body ?? {}) as {
      code?: string;
      message?: string;
      safe_details?: Record<string, unknown>;
    };
    throw new ApiFailure(
      res.status,
      body.code ?? 'ERROR',
      body.message ?? 'The server refused this request.',
      body.safe_details ?? {},
    );
  }
  return { data: res.body as T, status: res.status, stale: res.stale, fetchedAt: res.fetched_at };
}

export const get = <T>(backend: Backend, path: string, query?: [string, string][]) =>
  api<T>(backend, { method: 'GET', path, ...(query ? { query } : {}) });

export const send = <T>(
  backend: Backend,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
  version?: number,
) =>
  api<T>(backend, {
    method,
    path,
    ...(body ? { body } : {}),
    ...(version !== undefined ? { ifMatch: `"${version}"` } : {}),
  });

export function can(role: Role | null | undefined, permission: Permission): boolean {
  return !!role && ROLE_PERMISSIONS[role].includes(permission);
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  operator: 'Member',
  viewer: 'Viewer',
  billing: 'Billing manager',
};

export const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including ownership and billing.',
  admin: 'Members, invitations, clients, access and profiles. No billing.',
  operator:
    'Opens and uses the profiles they are given. No editing, exporting, deleting, sharing or billing unless given.',
  viewer: 'Sees the profiles they are given. Cannot open or export them.',
  billing: 'Subscription and invoices only. No profiles.',
};

/** Every page of a list (100 at a time, at most `pages` pages); stale when any page came from the offline cache. */
export async function getAll<T>(
  backend: Backend,
  path: string,
  query: [string, string][] = [],
  pages = 20,
): Promise<{ items: T[]; stale: boolean; fetchedAt: string | null; complete: boolean }> {
  const items: T[] = [];
  let cursor: string | null = null;
  let stale = false;
  let fetchedAt: string | null = null;
  for (let i = 0; i < pages; i++) {
    const res: ApiResult<{ items: T[]; next_cursor: string | null }> = await get(backend, path, [
      ...query,
      ['limit', '100'],
      ...(cursor ? ([['cursor', cursor]] as [string, string][]) : []),
    ]);
    items.push(...res.data.items);
    stale ||= res.stale;
    fetchedAt ??= res.fetchedAt;
    cursor = res.data.next_cursor;
    if (!cursor) return { items, stale, fetchedAt, complete: true };
  }
  return { items, stale, fetchedAt, complete: false };
}

/** The machine code of an IPC or API error, if any. */
export const codeOf = (e: unknown): string | null =>
  e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string'
    ? (e as { code: string }).code
    : null;
