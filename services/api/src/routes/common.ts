import {
  ApiError,
  type Client,
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  ErrorBody,
  encodeCursor,
  ID_PATTERN,
  INVITATION_TOKEN_PATTERN,
  type Profile,
} from '@pb/contracts';
import Type from 'typebox';
import { ts } from '../db.ts';

/** Every route declares error responses so the serializer can never emit unexpected fields. */
export const errors = { '4xx': ErrorBody, '5xx': ErrorBody } as const;

const param = (prefix: Parameters<typeof ID_PATTERN>[0]) => Type.String({ pattern: ID_PATTERN(prefix) });

export const OrgParams = Type.Object({ orgId: param('org') }, { additionalProperties: false });
export const ProfileParams = Type.Object(
  { orgId: param('org'), profileId: param('prf') },
  { additionalProperties: false },
);
export const SnapshotParams = Type.Object(
  { orgId: param('org'), profileId: param('prf'), snapshotId: param('snp') },
  { additionalProperties: false },
);
export const ClientParams = Type.Object(
  { orgId: param('org'), clientId: param('cli') },
  { additionalProperties: false },
);
export const MemberParams = Type.Object(
  { orgId: param('org'), userId: param('usr') },
  { additionalProperties: false },
);
export const InvitationParams = Type.Object(
  { orgId: param('org'), invitationId: param('inv') },
  { additionalProperties: false },
);
export const GrantParams = Type.Object(
  { orgId: param('org'), grantId: param('grt') },
  { additionalProperties: false },
);
export const DeviceParams = Type.Object({ deviceId: param('dev') }, { additionalProperties: false });
export const TokenParams = Type.Object(
  { token: Type.String({ pattern: INVITATION_TOKEN_PATTERN }) },
  { additionalProperties: false },
);

/** Profile columns; every query aliases the table as `p`. */
export const PROFILE_COLUMNS = `p.id, p.org_id, p.name, p.client_id, p.notes, p.version, p.snapshot_version,
  ${ts('p.last_snapshot_at')} as last_snapshot_at, ${ts('p.created_at')} as created_at,
  ${ts('p.updated_at')} as updated_at`;
export type ProfileRow = Profile;

/** Client columns; every query aliases the table as `c`. */
export const CLIENT_COLUMNS = `c.id, c.org_id, c.name, c.colour, ${ts('c.archived_at')} as archived_at, c.version,
  ${ts('c.created_at')} as created_at, ${ts('c.updated_at')} as updated_at`;
export type ClientRow = Client;

export const LEASE_COLUMNS = `profile_id, holder_device_id, holder_user_id, fencing_token::text as fencing_token,
  ${ts('acquired_at')} as acquired_at, ${ts('expires_at')} as expires_at`;

/** Accepts If-Match: "3" (or 3) and/or body.expected_version. Exactly one source of truth is required. */
export function expectedVersion(ifMatch: string | undefined, bodyVersion: number | undefined): number {
  let headerVersion: number | undefined;
  if (ifMatch !== undefined) {
    const m = /^(?:W\/)?"?([1-9][0-9]{0,9})"?$/.exec(ifMatch.trim());
    if (!m?.[1]) throw new ApiError('VALIDATION_FAILED', 'If-Match must be a version ETag such as "3"');
    headerVersion = Number(m[1]);
  }
  if (headerVersion !== undefined && bodyVersion !== undefined && headerVersion !== bodyVersion) {
    throw new ApiError('VALIDATION_FAILED', 'If-Match and expected_version disagree');
  }
  const version = headerVersion ?? bodyVersion;
  if (version === undefined) {
    throw new ApiError('PRECONDITION_REQUIRED', 'Send If-Match or expected_version to change this resource');
  }
  return version;
}

export function versionConflict(current: number): ApiError {
  return new ApiError('VERSION_CONFLICT', 'This was changed by someone else; reload and retry', {
    current_version: current,
  });
}

/** Keyset pagination over (sort key, id). */
export interface PageWindow {
  limit: number;
  after: { k: string; id: string } | null;
}

export function pageWindow(query: { cursor?: string; limit?: number }): PageWindow {
  const after = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !after) throw new ApiError('VALIDATION_FAILED', 'cursor is invalid');
  return { limit: query.limit ?? DEFAULT_PAGE_SIZE, after };
}

/** Rows were fetched with `limit + 1`; returns the page and the cursor of its last row. */
export function pageOf<T>(rows: T[], window: PageWindow, key: (row: T) => { k: string; id: string }) {
  const items = rows.slice(0, window.limit);
  const last = items.at(-1);
  return {
    items,
    next_cursor: rows.length > window.limit && last ? encodeCursor(key(last)) : null,
  };
}

/** PostgreSQL unique violation, optionally of one named constraint or index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
