import Type, { type TSchema } from 'typebox';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

export const PageQuery = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE })),
  },
  { additionalProperties: false },
);

export const Page = <T extends TSchema>(item: T) =>
  Type.Object(
    {
      items: Type.Array(item, { maxItems: MAX_PAGE_SIZE }),
      next_cursor: Type.Union([Type.String(), Type.Null()]),
    },
    { additionalProperties: false },
  );

/** Opaque cursor: base64url JSON of the last row's sort key. Clients must not construct cursors. */
export interface CursorPosition {
  /** sort key: created_at as ISO string */
  k: string;
  /** tie-breaker id */
  id: string;
}

export function encodeCursor(pos: CursorPosition): string {
  return Buffer.from(JSON.stringify(pos), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPosition | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as CursorPosition).k === 'string' &&
      typeof (parsed as CursorPosition).id === 'string' &&
      !Number.isNaN(Date.parse((parsed as CursorPosition).k))
    ) {
      return { k: (parsed as CursorPosition).k, id: (parsed as CursorPosition).id };
    }
    return null;
  } catch {
    return null;
  }
}
