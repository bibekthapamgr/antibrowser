/**
 * Client marker. Rule (milestone 01 design system): a client colour ALWAYS comes with a text label,
 * so meaning never depends on colour alone. The label prop is required and must be non-empty.
 */

// Palette chosen for >= 3:1 contrast of the dot against both light and dark surfaces.
const CLIENT_COLORS = [
  '#7C3AED',
  '#0E7490',
  '#B45309',
  '#BE185D',
  '#15803D',
  '#1D4ED8',
  '#9333EA',
  '#C2410C',
];

export function clientColor(label: string): string {
  let hash = 0;
  for (const ch of label) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return CLIENT_COLORS[hash % CLIENT_COLORS.length] ?? '#7C3AED';
}

/** `colour` (a chosen `#rrggbb`) overrides the colour derived from the label. */
export function ClientBadge({ label, colour }: { label: string; colour?: string | null }) {
  const text = label.trim();
  if (!text) return null;
  const dot = colour && /^#[0-9a-f]{6}$/i.test(colour) ? colour : clientColor(text);
  return (
    <span className="pb-badge">
      <span className="pb-badge__dot" style={{ background: dot }} aria-hidden="true" />
      {text}
    </span>
  );
}
