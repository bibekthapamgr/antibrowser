import Type, { type Static } from 'typebox';

/**
 * Error envelope (milestone 01 contract): code, message, request_id, retryable, safe_details.
 * Never include stack traces, SQL, secrets, tokens, file paths or other tenants' identifiers.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: { status: 400, retryable: false },
  UNAUTHENTICATED: { status: 401, retryable: false },
  FORBIDDEN: { status: 403, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  VERSION_CONFLICT: { status: 409, retryable: false },
  LEASE_HELD: { status: 409, retryable: true },
  LEASE_NOT_HELD: { status: 409, retryable: false },
  FENCING_TOKEN_STALE: { status: 409, retryable: false },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, retryable: true },
  IDEMPOTENCY_KEY_REUSED: { status: 422, retryable: false },
  PRECONDITION_REQUIRED: { status: 428, retryable: false },
  // Milestone 06
  REAUTHENTICATION_REQUIRED: { status: 401, retryable: false },
  EMAIL_NOT_VERIFIED: { status: 403, retryable: false },
  ALREADY_EXISTS: { status: 409, retryable: false },
  LAST_OWNER: { status: 409, retryable: false },
  ALREADY_MEMBER: { status: 409, retryable: false },
  INVITATION_EXPIRED: { status: 410, retryable: false },
  INVITATION_USED: { status: 410, retryable: false },
  INVITATION_WRONG_ACCOUNT: { status: 403, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  // Milestone 07
  QUOTA_EXCEEDED: { status: 409, retryable: false },
  SNAPSHOT_TOO_LARGE: { status: 413, retryable: false },
  UPLOAD_INCOMPLETE: { status: 409, retryable: false },
  SYNC_STATE_CONFLICT: { status: 409, retryable: false },
  SNAPSHOT_UNAVAILABLE: { status: 410, retryable: false },
  STORAGE_UNAVAILABLE: { status: 503, retryable: true },
  // Milestone 08
  /** The last session ended without closing (expired, not released): its browser may still be open. */
  LEASE_UNCERTAIN: { status: 409, retryable: false },
  /** The profile is not open anywhere (a handoff request has nobody to ask). */
  PROFILE_NOT_IN_USE: { status: 409, retryable: false },
  /** The device's browser is older than the profile's newest backup, or its platform is not supported. */
  RUNTIME_TOO_OLD: { status: 409, retryable: false },
  /** The organization's plan does not include this feature (milestone 11 sets plans). */
  ENTITLEMENT_REQUIRED: { status: 403, retryable: false },
  /** A note that looks like a password, key, token or card number. Notes are not a place for secrets. */
  NOTE_LOOKS_SECRET: { status: 422, retryable: false },
  // Milestone 10
  /** The API token may not call this route, or lacks the scope this operation needs (safe_details say which). */
  TOKEN_SCOPE_MISSING: { status: 403, retryable: false },
  /** A workflow address is not on the organization's approved sites. */
  URL_NOT_APPROVED: { status: 422, retryable: false },
  /** Too many queued jobs for the organization or the token; retry after some finish. */
  QUEUE_FULL: { status: 429, retryable: true },
  /** The job already finished (canceling or reporting on it changes nothing). */
  JOB_FINISHED: { status: 409, retryable: false },
  /** A report from a computer that no longer holds this job (it was given back, reassigned or ended). */
  JOB_CLAIM_STALE: { status: 409, retryable: false },
  /** The chosen computer cannot run this job (turned off, removed, or it does not allow debugging sessions). */
  AGENT_UNAVAILABLE: { status: 409, retryable: false },
  /** A webhook address that resolves to a private, local or reserved network, or is otherwise not allowed. */
  WEBHOOK_DESTINATION_BLOCKED: { status: 422, retryable: false },
  INTERNAL: { status: 500, retryable: true },
  UNAVAILABLE: { status: 503, retryable: true },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ErrorBody = Type.Object(
  {
    code: Type.Enum(Object.keys(ERROR_CODES) as (keyof typeof ERROR_CODES)[]),
    message: Type.String(),
    request_id: Type.String(),
    retryable: Type.Boolean(),
    safe_details: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type ErrorBody = Static<typeof ErrorBody>;

export class ApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly code: ErrorCode;
  readonly safeDetails: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, safeDetails: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.safeDetails = safeDetails;
    this.status = ERROR_CODES[code].status;
    this.retryable = ERROR_CODES[code].retryable;
  }
}
