/**
 * The platform audit's hash chain (milestone 12, migration 0010). Each entry's hash is
 *   sha256(previous hash || UTF-8 of the fields joined by U+001F)
 * with the fields: seq, id, time in microseconds since the epoch, actor, action, organization, target, details as
 * PostgreSQL's canonical jsonb text, request id (missing values as empty text). The database computes it on insert
 * and refuses updates and deletes; an export carries everything needed to recompute it elsewhere.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';

export interface AuditExportRow {
  seq: string;
  id: string;
  at: string;
  at_us: string;
  actor_user_id: string | null;
  action: string;
  org_id: string | null;
  target: string | null;
  /** The exact text the hash covers (PostgreSQL's jsonb text); parse it for the values. */
  details_text: string;
  request_id: string | null;
  prev_hash: string;
  hash: string;
}

export interface AuditHead {
  seq: string;
  hash: string;
}

export async function auditHead(c: pg.Pool | pg.ClientBase): Promise<AuditHead> {
  const { rows } = await c.query<AuditHead>(
    "select seq::text, encode(hash, 'hex') as hash from app.platform_audit_head where singleton",
  );
  const h = rows[0];
  if (!h) throw new Error('the platform audit has no chain head');
  return h;
}

/** Entries after `afterSeq`, in chain order (at most `limit`). */
export async function exportAudit(
  c: pg.Pool | pg.ClientBase,
  afterSeq = 0n,
  limit = 1000,
): Promise<AuditExportRow[]> {
  const { rows } = await c.query<AuditExportRow>(
    `select seq::text, id, at::text, ((extract(epoch from at) * 1000000)::bigint)::text as at_us, actor_user_id,
            action, org_id, target, details::text as details_text, request_id,
            encode(prev_hash, 'hex') as prev_hash, encode(hash, 'hex') as hash
       from app.platform_audit where seq > $1 order by seq limit $2`,
    [afterSeq.toString(), limit],
  );
  return rows;
}

export function entryHash(prevHex: string, r: Omit<AuditExportRow, 'prev_hash' | 'hash' | 'at'>): string {
  const text = [
    r.seq,
    r.id,
    r.at_us,
    r.actor_user_id ?? '',
    r.action,
    r.org_id ?? '',
    r.target ?? '',
    r.details_text,
    r.request_id ?? '',
  ].join('\u001f');
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(prevHex, 'hex'), Buffer.from(text, 'utf8')]))
    .digest('hex');
}

export interface ChainCheck {
  ok: boolean;
  checked: number;
  /** The first entry that does not follow from the one before it. */
  broken_at: string | null;
  last_seq: string | null;
  last_hash: string;
}

/**
 * Recomputes a run of exported entries. `prevHash` is the hash before the first entry (empty for the start of the
 * chain, or the last hash of an earlier export): a removed, reordered or changed entry breaks the chain there.
 */
export function verifyChain(rows: AuditExportRow[], prevHash = '', expectSeq?: bigint): ChainCheck {
  let prev = prevHash;
  let seq = expectSeq;
  for (const r of rows) {
    if (seq !== undefined && BigInt(r.seq) !== seq) return broken(r, rows, prev);
    if (r.prev_hash !== prev || entryHash(prev, r) !== r.hash) return broken(r, rows, prev);
    prev = r.hash;
    seq = BigInt(r.seq) + 1n;
  }
  return {
    ok: true,
    checked: rows.length,
    broken_at: null,
    last_seq: rows.at(-1)?.seq ?? null,
    last_hash: prev,
  };
}

function broken(r: AuditExportRow, rows: AuditExportRow[], prev: string): ChainCheck {
  return { ok: false, checked: rows.indexOf(r), broken_at: r.seq, last_seq: r.seq, last_hash: prev };
}

/** Walks the whole chain from the start and compares its end with the head. */
export async function verifyWholeChain(
  c: pg.Pool | pg.ClientBase,
  batch = 5000,
): Promise<ChainCheck & { head: AuditHead }> {
  const head = await auditHead(c);
  let after = 0n;
  let prev = '';
  let checked = 0;
  for (;;) {
    const rows = await exportAudit(c, after, batch);
    if (rows.length === 0) break;
    const r = verifyChain(rows, prev, after + 1n);
    if (!r.ok) return { ...r, checked: checked + r.checked, head };
    checked += r.checked;
    prev = r.last_hash;
    after = BigInt(r.last_seq ?? '0');
  }
  const ok = after.toString() === head.seq && prev === head.hash;
  return {
    ok,
    checked,
    broken_at: ok ? null : head.seq,
    last_seq: after.toString(),
    last_hash: prev,
    head,
  };
}
