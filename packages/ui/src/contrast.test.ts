import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast.ts';

// Pairs actually used by tokens.css. WCAG AA: 4.5:1 for body text, 3:1 for UI components/focus.
const LIGHT = {
  bg: '#F8FAFC',
  surface: '#FFFFFF',
  text: '#111827',
  muted: '#475569',
  accent: '#7C3AED',
  focus: '#7C3AED',
  warn: '#B45309',
  danger: '#B91C1C',
  border: '#64748B',
};
const DARK = {
  bg: '#0B1120',
  surface: '#111827',
  text: '#F1F5F9',
  muted: '#94A3B8',
  accent: '#A78BFA',
  focus: '#C4B5FD',
  warn: '#FBBF24',
  danger: '#F87171',
  border: '#7C8AA0',
};

describe('design token contrast', () => {
  for (const [name, t] of Object.entries({ light: LIGHT, dark: DARK })) {
    it(`${name}: text and muted text meet AA on background and surface`, () => {
      for (const surface of [t.bg, t.surface]) {
        expect(contrastRatio(t.text, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(t.muted, surface)).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name}: status text (warning, error) meets AA and input borders meet 3:1`, () => {
      for (const surface of [t.bg, t.surface]) {
        expect(contrastRatio(t.warn, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(t.danger, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(t.border, surface)).toBeGreaterThanOrEqual(3);
      }
    });
    it(`${name}: focus ring and accent meet 3:1 against surfaces`, () => {
      for (const surface of [t.bg, t.surface]) {
        expect(contrastRatio(t.focus, surface)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(t.accent, surface)).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it('primary button text is readable on the accent', () => {
    expect(contrastRatio('#FFFFFF', LIGHT.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#111827', DARK.accent)).toBeGreaterThanOrEqual(4.5);
  });
});
