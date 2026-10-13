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
  method: 'POST' | 'PATCH' | 'DELETE',
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
  operator: 'Operator',
  viewer: 'Viewer',
  billing: 'Billing',
};

export const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including ownership and billing.',
  admin: 'Members, invitations, clients, access and profiles. No billing.',
  operator: 'Uses the clients and profiles they are given access to.',
  viewer: 'Sees the clients and profiles they are given access to. Cannot open or export them.',
  billing: 'Subscription and invoices only. No profiles.',
};
