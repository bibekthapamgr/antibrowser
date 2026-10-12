import { type EventType, newId, redactPayload } from '@pb/contracts';
import type pg from 'pg';

export interface NewEvent {
  orgId: string;
  actorId: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: EventType;
  payload: Record<string, unknown>;
}

/**
 * Appends an event to the outbox. MUST be called with the same client/transaction that performs the
 * state change, so the change and its event commit or roll back together.
 */
export async function appendEvent(client: pg.PoolClient, event: NewEvent): Promise<string> {
  const eventId = newId('event');
  await client.query(
    `insert into outbox_events (event_id, org_id, actor_id, aggregate_id, aggregate_version, event_type, redacted_payload)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      eventId,
      event.orgId,
      event.actorId,
      event.aggregateId,
      event.aggregateVersion,
      event.eventType,
      JSON.stringify(redactPayload(event.payload)),
    ],
  );
  return eventId;
}
