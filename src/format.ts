const currencyFormat = (currency: string, digits?: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: digits });

let currency = 'USD';
let money = currencyFormat(currency);
let whole = currencyFormat(currency, 0);

/** Show every amount in `code` (ISO 4217) from now on. Set from Settings before the app renders. */
export function setCurrency(code: string) {
  if (code === currency) return;
  money = currencyFormat(code);
  whole = currencyFormat(code, 0);
  currency = code;
}

export const displayCurrency = () => currency;

export const fmtMoney = (n: number) => money.format(n);
export const fmtWhole = (n: number) => whole.format(n);
export const fmtMonth = (key: string, style: 'short' | 'long' = 'short') =>
  new Date(`${key}-01T00:00:00`).toLocaleString('en-US', { month: style, year: style === 'long' ? 'numeric' : undefined });
export const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
export const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
