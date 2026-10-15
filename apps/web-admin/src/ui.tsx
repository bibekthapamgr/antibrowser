/**
 * The console's visual building blocks: stroke icons, panels, stat tiles, status pills, empty and loading states,
 * callouts and toasts. Everything is markup and classes styled by console.css — no inline styles (the console's CSP
 * allows only its own stylesheet), and sizes that depend on data are SVG attributes.
 */
import type { ReactNode } from 'react';

// ---------------------------------------------------------------- icons
const PATHS = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  building: (
    <>
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <path d="M9 22v-4h6v4" />
      <path d="M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </>
  ),
  layers: (
    <>
      <path d="m12 2 10 5-10 5L2 7z" />
      <path d="m2 17 10 5 10-5" />
      <path d="m2 12 10 5 10-5" />
    </>
  ),
  activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  audit: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="m9 15 2 2 4-4" />
    </>
  ),
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  alert: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6M9 9l6 6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </>
  ),
  back: (
    <>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </>
  ),
  chevron: <path d="m9 18 6-6-6-6" />,
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  close: <path d="M18 6 6 18M6 6l12 12" />,
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  server: (
    <>
      <rect x="2" y="3" width="20" height="7" rx="2" />
      <rect x="2" y="14" width="20" height="7" rx="2" />
      <path d="M6 6.5h.01M6 17.5h.01" />
    </>
  ),
  mail: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 5L2 7" />
    </>
  ),
  package: (
    <>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12" />
    </>
  ),
  zap: <path d="M13 2 3 14h9l-1 8 10-12h-9z" />,
  lock: (
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  note: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  card: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
      <path d="M1 14h6M9 8h6M17 16h6" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The product mark: two offset browser windows (isolated profiles). */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="8" className="brand-mark__bg" />
      <rect x="7" y="7" width="13" height="11" rx="2.5" className="brand-mark__back" />
      <rect x="12" y="13" width="13" height="12" rx="2.5" className="brand-mark__front" />
      <path d="M12 16.5h13" className="brand-mark__bar" />
    </svg>
  );
}

// ---------------------------------------------------------------- layout
export function PageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="page-head__text">
        {title}
        {meta && <div className="page-head__meta">{meta}</div>}
        {description && <p className="page-head__desc">{description}</p>}
      </div>
      {actions && <div className="page-head__actions">{actions}</div>}
    </div>
  );
}

/** A titled surface. The heading id names the section for assistive technology. */
export function Panel({
  id,
  title,
  description,
  actions,
  icon,
  children,
  className,
  tone,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: IconName;
  children?: ReactNode;
  className?: string;
  tone?: 'danger';
}) {
  return (
    <section className={className ? `panel ${className}` : 'panel'} data-tone={tone} aria-labelledby={id}>
      <div className="panel__head">
        <div className="panel__title">
          {icon && <Icon name={icon} className="panel__icon" />}
          <h2 id={id}>{title}</h2>
        </div>
        {actions && <div className="panel__actions">{actions}</div>}
      </div>
      {description && <p className="panel__desc">{description}</p>}
      <div className="panel__body">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------- data display
export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral' | 'accent';

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="pill" data-tone={tone}>
      {children}
    </span>
  );
}

/** The tone of a free-text status from the server (invoice, event, publication, request, backup). */
export function toneOf(status: string): Tone {
  const s = status.toLowerCase();
  if (/(fail|error|uncollectible|denied|dispute|broken|failing)/.test(s)) return 'bad';
  if (/(pending|open|waiting|retry|requested|draft|publishing|queued|grace|past)/.test(s)) return 'warn';
  if (/(paid|processed|succeeded|sent|active|approved|ok|works|available|done|in force|healthy)/.test(s))
    return 'good';
  return 'neutral';
}

export function Stat({
  label,
  value,
  hint,
  tone,
  status,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  status?: string;
  icon?: IconName;
}) {
  return (
    <li className="stat" data-tone={tone}>
      <span className="stat__label">
        {icon && <Icon name={icon} size={15} />}
        {label}
      </span>
      <span className="stat__value">{value}</span>
      {(hint || status) && (
        <span className="stat__foot">
          {status && tone && <Pill tone={tone}>{status}</Pill>}
          {hint && <span className="stat__hint">{hint}</span>}
        </span>
      )}
    </li>
  );
}

export function EmptyState({
  icon = 'inbox',
  title,
  children,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty__icon">
        <Icon name={icon} size={20} />
      </span>
      <p className="empty__title">{title}</p>
      {children && <p className="empty__hint">{children}</p>}
    </div>
  );
}

/** Placeholder rows while a page loads. */
export function Skeleton({ variant = 'page' }: { variant?: 'page' | 'rows' }) {
  return (
    <div className="skeleton" data-variant={variant} aria-busy="true">
      <span className="pb-sr-only" role="status">
        Loading…
      </span>
      {variant === 'page' && (
        <div className="skeleton__stats" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
      )}
      <div className="skeleton__block" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

export function Callout({
  tone,
  children,
  role,
  title,
}: {
  tone: 'danger' | 'warn' | 'good' | 'info';
  children: ReactNode;
  role?: 'alert' | 'status' | 'note';
  title?: string;
}) {
  const icon: IconName =
    tone === 'danger' ? 'error' : tone === 'warn' ? 'alert' : tone === 'good' ? 'check' : 'info';
  return (
    <div className="callout" data-tone={tone} role={role}>
      <Icon name={icon} size={18} className="callout__icon" />
      <div className="callout__body">
        {title && <p className="callout__title">{title}</p>}
        <div>{children}</div>
      </div>
    </div>
  );
}

/** A confirmation that an action went through; stays until dismissed or replaced. */
export function Toast({ text, onDismiss }: { text: string | null; onDismiss: () => void }) {
  if (!text) return null;
  return (
    <div className="toast" role="status">
      <Icon name="check" size={18} className="toast__icon" />
      <p>{text}</p>
      <button type="button" className="toast__close" aria-label="Dismiss message" onClick={onDismiss}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

/** A horizontal meter (used / allowed) drawn with SVG attributes so it needs no inline style. */
export function Meter({ value, max, tone }: { value: number; max: number | null; tone?: Tone }) {
  if (max === null || max <= 0) return null;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <svg className="meter" data-tone={tone} viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
      <rect className="meter__track" x="0" y="0" width="100" height="6" rx="3" />
      {pct > 0 && <rect className="meter__fill" x="0" y="0" width={Math.max(pct, 3)} height="6" rx="3" />}
    </svg>
  );
}

/** Sign-in artwork: isolated profile windows stacked behind an audited one. Decorative only. */
export function ProfileStack() {
  const rows = [
    { y: 128, w: 132, tone: 'muted' },
    { y: 148, w: 104, tone: 'accent' },
    { y: 168, w: 150, tone: 'muted' },
    { y: 188, w: 88, tone: 'muted' },
  ];
  return (
    <svg className="stack-art" viewBox="0 0 360 230" aria-hidden="true" focusable="false">
      <g className="stack-art__win stack-art__win--back">
        <rect x="12" y="14" width="220" height="140" rx="12" />
        <path d="M12 38h220" />
      </g>
      <g className="stack-art__win stack-art__win--mid">
        <rect x="56" y="44" width="220" height="140" rx="12" />
        <path d="M56 68h220" />
      </g>
      <g className="stack-art__win stack-art__win--front">
        <rect x="104" y="76" width="244" height="146" rx="12" />
        <path d="M104 102h244" />
        <circle cx="122" cy="89" r="3.5" />
        <circle cx="134" cy="89" r="3.5" />
        <circle cx="146" cy="89" r="3.5" />
      </g>
      {rows.map((r) => (
        <g key={r.y} className={`stack-art__row stack-art__row--${r.tone}`}>
          <circle cx="126" cy={r.y} r="4" />
          <rect x="138" y={r.y - 3.5} width={r.w} height="7" rx="3.5" />
        </g>
      ))}
      <g className="stack-art__badge">
        <circle cx="322" cy="128" r="16" />
        <path d="M315.5 128.5l4.5 4.5 8-8.5" />
      </g>
    </svg>
  );
}
