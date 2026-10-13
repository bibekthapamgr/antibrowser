import Type, { type Static } from 'typebox';
import { ID_PATTERN } from './ids.ts';

/**
 * Domain event envelope (milestone 01 contract).
 * Persisted to the outbox in the same transaction as the state change. Consumers deduplicate on event_id.
 * redacted_payload must never contain secrets, credentials, cookies, proxy passwords or snapshot keys.
 */
export const EVENT_TYPES = [
  'profile.created',
  'profile.updated',
  'lease.acquired',
  'lease.renewed',
  'lease.released',
  'snapshot.committed',
  'device.registered',
  // Milestone 06
  'organization.created',
  'organization.updated',
  'client.created',
  'client.updated',
  'profile.deleted',
  'membership.created',
  'membership.updated',
  'membership.removed',
  'grant.created',
  'grant.removed',
  // Milestone 07
  'profile.restored',
  'profile.purged',
  'snapshot.commit_failed',
  'snapshot.expired',
  'org_key.rotated',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EventEnvelope = Type.Object(
  {
    event_id: Type.String({ pattern: ID_PATTERN('evt') }),
    org_id: Type.String({ pattern: ID_PATTERN('org') }),
    actor_id: Type.String({ pattern: ID_PATTERN('usr') }),
    aggregate_id: Type.String(),
    aggregate_version: Type.Integer({ minimum: 1 }),
    event_type: Type.Enum(EVENT_TYPES),
    created_at: Type.String({ format: 'date-time' }),
    redacted_payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type EventEnvelope = Static<typeof EventEnvelope>;

/** Keys that must never appear in an event payload, at any depth. */
export const FORBIDDEN_PAYLOAD_KEYS = [
  'password',
  'secret',
  'token',
  'cookie',
  'cookies',
  'authorization',
  'key_material',
  'private_key',
  'proxy_password',
  'data_key',
  'wrapped_key',
  'wrapped_dek',
] as const;

/** Recursively drops forbidden keys. Applied by the outbox writer before persistence. */
export function redactPayload(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if ((FORBIDDEN_PAYLOAD_KEYS as readonly string[]).includes(key.toLowerCase())) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactPayload(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}
