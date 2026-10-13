/** Folded name used for per-organization uniqueness: trim, NFKD, no combining marks, lower case (same as 04). */
export function nameKey(name: string): string {
  return name.trim().normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Escapes LIKE wildcards so search text is matched literally. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
