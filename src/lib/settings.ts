/** User preferences: display currency, the day budget months start on, and color theme. Pure. */

export type Theme = 'light' | 'dark' | 'system';

export interface Settings {
  /** ISO 4217 code every amount is shown in. */
  currency: string;
  /** Day of the month (1–28) a budget month starts on; e.g. 15 makes "October" run Oct 15 – Nov 14. */
  monthStartDay: number;
  theme: Theme;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = { currency: 'USD', monthStartDay: 1, theme: 'system' };

/** Currencies offered in the picker; any other valid ISO code is kept if it arrives in a backup. */
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF', 'SEK', 'INR', 'MXN', 'SGD'] as const;

export const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

/** Latest start day allowed, so every month has it. */
export const MAX_START_DAY = 28;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Whether `code` is a three-letter currency code the browser can format. */
export function isCurrency(code: unknown): code is string {
  if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
    return true;
  } catch {
    return false;
  }
}

export const isStartDay = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_START_DAY;

export const isTheme = (v: unknown): v is Theme => THEMES.includes(v as Theme);

/** Stored or imported settings with anything missing or invalid replaced by the default. */
export function normalizeSettings(v: unknown): Settings {
  const s = isObject(v) ? v : {};
  return {
    currency: isCurrency(s.currency) ? s.currency : DEFAULT_SETTINGS.currency,
    monthStartDay: isStartDay(s.monthStartDay) ? s.monthStartDay : DEFAULT_SETTINGS.monthStartDay,
    theme: isTheme(s.theme) ? s.theme : DEFAULT_SETTINGS.theme,
  };
}

/** The ledger's settings, defaults filled in. */
export const settingsOf = (state: { settings?: Partial<Settings> }) => normalizeSettings(state.settings);

/** Apply a change, ignoring invalid values. */
export function updateSettings(current: Settings, patch: Partial<Settings>): Settings {
  return normalizeSettings({ ...current, ...Object.fromEntries(Object.entries(patch).filter(([k, v]) =>
    (k === 'currency' && isCurrency(v)) || (k === 'monthStartDay' && isStartDay(v)) || (k === 'theme' && isTheme(v)))) });
}

/** The theme to draw with: "system" follows the OS preference. */
export const resolveTheme = (theme: Theme, prefersDark: boolean): 'light' | 'dark' =>
  theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;

/** The symbol a currency is written with in en-US, e.g. "$", "€", "CA$". */
export function currencySymbol(currency: string): string {
  const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency }).formatToParts(0);
  return parts.find((p) => p.type === 'currency')?.value ?? currency;
}

/** "1st", "2nd", "15th"… for the start-day picker. */
export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${s}`;
}
