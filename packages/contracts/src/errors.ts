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
  RATE_LIMITED: { status: 429, retryable: true },
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
