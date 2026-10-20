import { afterEach, describe, expect, it } from 'vitest';
import { displayCurrency, fmtMoney, fmtWhole, setCurrency } from '../../format';
import { emptyLedger, normalizeLedger } from '../migrate';
import {
  DEFAULT_SETTINGS, currencySymbol, isCurrency, normalizeSettings, ordinal, resolveTheme, settingsOf, updateSettings,
} from '../settings';

describe('normalizeSettings', () => {
  it('fills defaults for missing or unusable input', () => {
    for (const raw of [undefined, null, 'x', 42, [], {}]) expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values and replaces invalid ones field by field', () => {
    expect(normalizeSettings({ currency: 'EUR', monthStartDay: 15, theme: 'dark' }))
      .toEqual({ currency: 'EUR', monthStartDay: 15, theme: 'dark' });
    expect(normalizeSettings({ currency: 'eur', monthStartDay: 31, theme: 'neon' })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ currency: 'XYZW', monthStartDay: 2.5 })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ monthStartDay: 28 }).monthStartDay).toBe(28);
    expect(normalizeSettings({ monthStartDay: 0 }).monthStartDay).toBe(1);
  });

  it('reads defaults from a ledger that never saved settings', () => {
    expect(settingsOf(emptyLedger('2026-10'))).toEqual(DEFAULT_SETTINGS);
  });

  it('is applied when a ledger is normalized, and left out when absent', () => {
    expect(normalizeLedger({}).settings).toBeUndefined();
    expect(normalizeLedger({ settings: { currency: 'GBP', monthStartDay: 99, theme: 'light' } as never }).settings)
      .toEqual({ currency: 'GBP', monthStartDay: 1, theme: 'light' });
  });
});

describe('updateSettings', () => {
  const current = { currency: 'CAD', monthStartDay: 10, theme: 'light' as const };

  it('applies valid changes', () => {
    expect(updateSettings(current, { theme: 'dark', monthStartDay: 1 })).toEqual({ currency: 'CAD', monthStartDay: 1, theme: 'dark' });
  });

  it('keeps the current value instead of an invalid one', () => {
    expect(updateSettings(current, { currency: 'nope', monthStartDay: 40, theme: 'blue' as never })).toEqual(current);
  });
});

describe('helpers', () => {
  it('validates currency codes', () => {
    expect(isCurrency('JPY')).toBe(true);
    expect(isCurrency('usd')).toBe(false);
    expect(isCurrency('')).toBe(false);
    expect(isCurrency(5)).toBe(false);
  });

  it('resolves the system theme from the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('names currency symbols and ordinals', () => {
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('EUR')).toBe('€');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 28].map(ordinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '28th']);
  });
});

describe('currency formatting', () => {
  afterEach(() => setCurrency('USD'));

  it('formats every amount in the chosen currency', () => {
    expect(fmtMoney(-1234.5)).toBe('-$1,234.50');
    setCurrency('EUR');
    expect(displayCurrency()).toBe('EUR');
    expect(fmtMoney(-1234.5)).toBe('-€1,234.50');
    expect(fmtWhole(1234.5)).toBe('€1,235');
    setCurrency('JPY');
    expect(fmtMoney(1234)).toBe('¥1,234');
  });
});
