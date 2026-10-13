import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';

/** Returns `value` after it has stopped changing for `ms` (search debounce). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Modal dialog: traps focus, closes on Escape, restores focus to the opener, labelled for screen readers.
 * `initialFocus` selects the element focused on open (defaults to the first focusable element).
 */
export function Dialog(props: {
  title: string;
  description?: string | undefined;
  onClose: () => void;
  children: ReactNode;
  role?: 'dialog' | 'alertdialog';
  initialFocus?: string;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const { onClose, initialFocus } = props;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const target =
      (initialFocus ? root?.querySelector<HTMLElement>(initialFocus) : null) ?? focusables(root)[0] ?? root;
    target?.focus();
    return () => opener?.focus?.();
  }, [initialFocus]);

  // Escape closes; Tab is trapped inside the dialog (listener attached natively, not via a JSX handler).
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(root);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="scrim">
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: both possible roles (dialog, alertdialog) support aria-modal */}
      <div
        ref={ref}
        className={props.wide ? 'dialog dialog--wide' : 'dialog'}
        role={props.role === 'alertdialog' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.description ? descId : undefined}
        tabIndex={-1}
      >
        <h2 id={titleId}>{props.title}</h2>
        {props.description && (
          <p id={descId} className="muted">
            {props.description}
          </p>
        )}
        {props.children}
      </div>
    </div>
  );
}

function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
}

/**
 * Windowed grid: renders only the rows in view (plus overscan), so 10,000 rows stay fast. Rows may be loaded lazily:
 * `getItem` returns `undefined` for a row whose page has not arrived yet, and `onRangeChange` reports which rows are
 * on screen so the owner can load them. Rows have a fixed height.
 *
 * Keyboard: the grid is a single tab stop; Up/Down/PageUp/PageDown/Home/End move the active row, Enter activates it,
 * Space toggles its selection (Shift+Space selects the range from the last toggled row).
 */
export function VirtualList<T>(props: {
  count: number;
  getItem: (index: number) => T | undefined;
  rowHeight: number;
  height: number;
  label: string;
  getKey: (item: T | undefined, index: number) => string;
  renderRow: (item: T | undefined, index: number, active: boolean) => ReactNode;
  activeIndex: number;
  onActiveIndexChange: (i: number) => void;
  onActivate?: (item: T, index: number) => void;
  onToggle?: (item: T, index: number, range: boolean) => void;
  isSelected?: (item: T | undefined, index: number) => boolean;
  onRangeChange?: (start: number, end: number) => void;
}) {
  const { count, rowHeight, height, activeIndex, onActiveIndexChange, onRangeChange } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const overscan = 6;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + overscan);

  useEffect(() => {
    onRangeChange?.(start, end);
  }, [start, end, onRangeChange]);

  const scrollIntoView = useCallback(
    (i: number) => {
      const el = ref.current;
      if (!el) return;
      const top = i * rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowHeight > el.scrollTop + height) el.scrollTop = top + rowHeight - height;
      setScrollTop(el.scrollTop);
    },
    [rowHeight, height],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!count) return;
    const pageSize = Math.max(1, Math.floor(height / rowHeight));
    const moves: Record<string, number> = {
      ArrowDown: activeIndex + 1,
      ArrowUp: activeIndex - 1,
      Home: 0,
      End: count - 1,
      PageDown: activeIndex + pageSize,
      PageUp: activeIndex - pageSize,
    };
    if (e.key in moves) {
      e.preventDefault();
      const next = Math.min(count - 1, Math.max(0, moves[e.key] as number));
      onActiveIndexChange(next);
      scrollIntoView(next);
      return;
    }
    const item = props.getItem(activeIndex);
    if (e.key === 'Enter' && props.onActivate && item !== undefined) {
      e.preventDefault();
      props.onActivate(item, activeIndex);
    } else if (e.key === ' ' && props.onToggle && item !== undefined) {
      e.preventDefault();
      props.onToggle(item, activeIndex, e.shiftKey);
    }
  };

  const active = props.getItem(activeIndex);
  const activeKey = count > 0 ? props.getKey(active, activeIndex) : undefined;
  const rows: ReactNode[] = [];
  for (let index = start; index < end; index++) {
    const item = props.getItem(index);
    const key = props.getKey(item, index);
    rows.push(
      // biome-ignore lint/a11y/useFocusableInteractive: rows are reached via aria-activedescendant on the grid (single tab stop)
      // biome-ignore lint/a11y/useSemanticElements: a windowed grid cannot use <tr> (rows are absolutely positioned)
      <div
        key={key}
        id={`row-${key}`}
        role="row"
        aria-rowindex={index + 1}
        aria-selected={props.isSelected ? props.isSelected(item, index) : index === activeIndex}
        aria-busy={item === undefined ? true : undefined}
        className="vlist__row"
        style={{ position: 'absolute', top: index * rowHeight, height: rowHeight, left: 0, right: 0 }}
      >
        {props.renderRow(item, index, index === activeIndex)}
      </div>,
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a windowed grid needs explicit ARIA (a <table> would render every row)
    <div
      ref={ref}
      className="vlist"
      role="grid"
      aria-label={props.label}
      aria-rowcount={count}
      aria-multiselectable={props.onToggle ? true : undefined}
      aria-activedescendant={activeKey ? `row-${activeKey}` : undefined}
      tabIndex={0}
      style={{ height }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      <div style={{ height: count * rowHeight, position: 'relative' }}>{rows}</div>
    </div>
  );
}

/** A grid cell inside a VirtualList row (cells are not separately focusable; the grid is one tab stop). */
export function Cell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid (aria-activedescendant pattern)
    // biome-ignore lint/a11y/useSemanticElements: see VirtualList; native table cells cannot be windowed
    <span role="gridcell" className={className}>
      {children}
    </span>
  );
}

/** Polite live region: screen readers announce operation results without moving focus. */
export function LiveRegion({
  messages,
}: {
  messages: { id: number; text: string; tone: 'info' | 'error' }[];
}) {
  return (
    <div className="toasts">
      <div className="pb-sr-only" role="status" aria-live="polite">
        {messages.filter((m) => m.tone === 'info').at(-1)?.text}
      </div>
      <div className="pb-sr-only" role="alert">
        {messages.filter((m) => m.tone === 'error').at(-1)?.text}
      </div>
      {messages.map((m) => (
        <div key={m.id} className={`toast toast--${m.tone}`} aria-hidden="true">
          {m.text}
        </div>
      ))}
    </div>
  );
}

export function useElementHeight<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [h, setH] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(
      ([entry]) => entry && setH(Math.max(120, Math.floor(entry.contentRect.height))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, h] as const;
}

export function formatBytes(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 100 || u === 0 ? 0 : 1)} ${units[u]}`;
}
