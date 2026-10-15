/**
 * Small presentational building blocks shared by the settings, subscription, team and profile screens: settings
 * groups with a title and description on the left and the control on the right, a switch, selectable option cards,
 * usage meters, status pills and initials avatars. They carry no behaviour of their own; callers pass the existing
 * handlers through unchanged.
 */
import { type ReactNode, useId } from 'react';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase() ||
    '?'
  );
}

/** A stable tint (one of six) from a name, so the same person keeps the same avatar colour. */
function tint(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h % 6;
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span className={`avatar avatar--${size} avatar--t${tint(name)}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export type Tone = 'ok' | 'warn' | 'error' | 'accent' | 'neutral';

/** A status pill: a coloured dot plus words (never colour alone). */
export function Pill({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string | undefined;
}) {
  return (
    <span className={`pill pill--${tone}`} title={title}>
      <span className="pill__dot" aria-hidden="true" />
      {children}
    </span>
  );
}

/** A card of related settings: a heading, an optional line under it, then rows. */
export function SettingsGroup(props: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  tone?: 'danger';
  className?: string;
}) {
  const id = useId();
  return (
    <section
      className={`set-group${props.tone ? ` set-group--${props.tone}` : ''}${props.className ? ` ${props.className}` : ''}`}
      aria-labelledby={id}
    >
      <header className="set-group__head">
        <h2 id={id} className="set-group__title">
          {props.title}
        </h2>
        {props.description && <p className="set-group__desc">{props.description}</p>}
      </header>
      <div className="set-group__body">{props.children}</div>
    </section>
  );
}

/**
 * One setting: title and help on the left, the control on the right. `stacked` puts the control under the text (for
 * option cards and anything wide). With `labelFor`, the title is the <label> of the control (which takes `controlId`);
 * otherwise it is a plain line the control can point at with `titleId`.
 */
export function SettingRow(props: {
  title: string;
  description?: ReactNode;
  stacked?: boolean;
  labelFor?: boolean;
  children: (ids: { titleId: string; controlId: string; descId: string | undefined }) => ReactNode;
}) {
  const titleId = useId();
  const controlId = useId();
  const descId = useId();
  return (
    <div className={`set-row${props.stacked ? ' set-row--stacked' : ''}`}>
      <div className="set-row__text">
        {props.labelFor ? (
          <label id={titleId} htmlFor={controlId} className="set-row__title">
            {props.title}
          </label>
        ) : (
          <p id={titleId} className="set-row__title">
            {props.title}
          </p>
        )}
        {props.description && (
          <div id={descId} className="set-row__desc">
            {props.description}
          </div>
        )}
      </div>
      <div className="set-row__control">
        {props.children({ titleId, controlId, descId: props.description ? descId : undefined })}
      </div>
    </div>
  );
}

/** An on/off switch: a real checkbox with the switch role, so keyboard and screen readers work as usual. */
export function Toggle(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The id its <label> points at (SettingRow `labelFor`). */
  id: string;
  describedBy?: string | undefined;
  disabled?: boolean;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="switch"
      checked={props.checked}
      aria-checked={props.checked}
      disabled={props.disabled}
      id={props.id}
      aria-describedby={props.describedBy}
      onChange={(e) => props.onChange(e.target.checked)}
    />
  );
}

/** Radio buttons drawn as selectable cards (one row of tiles, or a list with `layout="list"`). */
export function OptionCards<T extends string>(props: {
  name: string;
  value: T;
  options: { value: T; label: string; hint?: string; preview?: ReactNode }[];
  onChange: (v: T) => void;
  labelledBy: string;
  layout?: 'tiles' | 'list';
}) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={props.labelledBy}
      className={`options options--${props.layout ?? 'tiles'}`}
    >
      {props.options.map((o) => (
        <label key={o.value} className="option">
          <input
            type="radio"
            name={props.name}
            checked={props.value === o.value}
            onChange={() => props.onChange(o.value)}
          />
          {o.preview}
          <span className="option__text">
            <span className="option__label">{o.label}</span>
            {o.hint && <span className="option__hint">{o.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * A usage meter: label, "used of allowed", and a bar whose fill shows how close the limit is (accent, then warning
 * from 80%, then danger when over). Without a limit it says so and draws no bar.
 */
export function Meter(props: {
  label: string;
  used: number;
  limit: number | null;
  format?: (n: number) => string;
  over?: boolean;
}) {
  const fmt = props.format ?? ((n: number) => n.toLocaleString());
  const { used, limit } = props;
  const ratio = limit === null ? 0 : limit <= 0 ? (used > 0 ? 1 : 0) : used / limit;
  const level = props.over || ratio > 1 ? 'over' : ratio >= 0.8 ? 'high' : 'ok';
  return (
    <div className={`meter meter--${level}`}>
      <div className="meter__top">
        <span className="meter__label" title={props.label}>
          {props.label}
        </span>
        <span className="meter__value">
          <strong>{fmt(used)}</strong>
          <span className="muted"> {limit === null ? '· no limit' : `of ${fmt(limit)}`}</span>
        </span>
      </div>
      {limit !== null && (
        <progress
          className="meter__bar"
          aria-label={`${props.label} used`}
          value={Math.min(used, Math.max(limit, 1))}
          max={Math.max(limit, 1)}
        />
      )}
      {level === 'over' && <span className="meter__note">Over the limit</span>}
    </div>
  );
}
