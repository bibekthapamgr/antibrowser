/**
 * Notes helpers for the window. `sanitizeNotes` and `secretHint` live in the shared contracts so the API enforces the
 * same rule (milestone 08); Rust re-checks on export and withholds notes that look like secrets.
 */
export { sanitizeNotes, secretHint } from '@pb/contracts/notes';

/** Folded key used for name comparison and search (mirrors `pb_storage::migrations::name_key`). */
export function nameKey(s: string): string {
  return s.trim().normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}
