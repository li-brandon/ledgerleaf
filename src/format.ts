const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const whole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const fmtMoney = (n: number) => money.format(n);
export const fmtWhole = (n: number) => whole.format(n);
export const fmtMonth = (key: string, style: 'short' | 'long' = 'short') =>
  new Date(`${key}-01T00:00:00`).toLocaleString('en-US', { month: style, year: style === 'long' ? 'numeric' : undefined });
export const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
