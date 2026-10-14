/**
 * The portal's only way to the server: same-origin requests with the HttpOnly session cookie (R2 backend-for-
 * frontend). The page never holds a token; changes carry the session's CSRF token. Demo builds replace `request`
 * with an in-memory stand-in (demo.ts).
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface PortalApi {
  request<T>(method: Method, path: string, body?: unknown, ifMatch?: number): Promise<T>;
  /** Leaves the page (sign-in, the payment provider's checkout and portal, downloads). */
  navigate(url: string): void;
}

/** Where a sign-in starts; the server checks `returnTo` stays inside the portal. */
export const signInUrl = (mode: 'signin' | 'signup', returnTo: string) =>
  `/v1/web/auth/login?mode=${mode}&return_to=${encodeURIComponent(returnTo)}`;

export function httpApi(): PortalApi {
  let csrf: string | null = null;
  const send = async <T>(method: Method, path: string, body?: unknown, ifMatch?: number): Promise<T> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      if (csrf) headers['x-csrf-token'] = csrf;
    }
    if (ifMatch !== undefined) headers['if-match'] = `"${ifMatch}"`;
    let res: Response;
    try {
      res = await fetch(`/v1${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError(0, 'NETWORK', 'The server cannot be reached. Check your connection and try again.');
    }
    const data = res.status === 204 || res.status === 304 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const d = (data ?? {}) as { code?: string; message?: string; safe_details?: Record<string, unknown> };
      throw new ApiError(
        res.status,
        d.code ?? 'UNAVAILABLE',
        d.message ?? `Request failed (${res.status})`,
        d.safe_details ?? {},
      );
    }
    // The session answer carries the CSRF token for later changes (a new one after a privilege change).
    if (path === '/web/auth/session') csrf = (data as { csrf_token?: string } | null)?.csrf_token ?? null;
    return data as T;
  };
  return { request: send, navigate: (url) => window.location.assign(url) };
}
