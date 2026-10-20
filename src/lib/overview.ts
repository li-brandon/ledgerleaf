/**
 * Figures for the Overview page: daily spend pace, cash flow, net worth trend, upcoming
 * recurring charges and transactions to review. Pure, so they can be unit tested.
 */
import { addMonths, DEFAULT_EXCLUSIONS, isExcluded, monthKey, round, spendByMonth, type SpendExclusions } from './budget';
import { slug } from './csv';
import { monthRange } from './insights';
import type { Account, BalanceSnapshot, Category, Transaction } from './types';

/** Number of days in a YYYY-MM month. */
export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** Local YYYY-MM-DD for a date. */
export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Running total of spending by day of `month`: entry i is what was spent on days 1..i+1.
 * Refunds within a spend category reduce it (never below zero); excluded categories are
 * left out. For the month containing `today` the series stops at today, for a later month
 * it is empty.
 */
export function cumulativeDailySpend(
  txns: readonly Transaction[], month: string, excluded: SpendExclusions = DEFAULT_EXCLUSIONS, today = new Date(),
): number[] {
  const now = isoDate(today);
  const days = month < now.slice(0, 7) ? daysInMonth(month) : month === now.slice(0, 7) ? today.getDate() : 0;
  const daily = new Array<number>(days).fill(0);
  for (const t of txns) {
    if (monthKey(t.date) !== month || isExcluded(t, excluded)) continue;
    const day = Number(t.date.slice(8, 10));
    if (day <= days) daily[day - 1] -= t.amount;
  }
  let acc = 0;
  return daily.map((v) => Math.max(0, (acc = round(acc + v))));
}

export interface SpendPace {
  month: string;
  /** Cumulative spend this month, through today. */
  current: number[];
  /** Cumulative spend last month, every day. */
  previous: number[];
  /** Spent so far this month. */
  spent: number;
  /** What last month had spent by the same day of the month (its last day if shorter). */
  previousToDate: number;
}

/** This month's cumulative daily spend next to last month's. */
export function spendPace(
  txns: readonly Transaction[], month: string, excluded: SpendExclusions = DEFAULT_EXCLUSIONS, today = new Date(),
): SpendPace {
  const current = cumulativeDailySpend(txns, month, excluded, today);
  const previous = cumulativeDailySpend(txns, addMonths(month, -1), excluded, today);
  const day = Math.min(current.length, previous.length);
  return {
    month, current, previous,
    spent: current.at(-1) ?? 0,
    previousToDate: day ? previous[day - 1] : 0,
  };
}

/** Ids of categories that hold income: the Income group, plus the built-in Income category. */
export const incomeCategories = (categories: readonly Category[]): ReadonlySet<string> =>
  new Set(['income', ...categories.filter((c) => c.group === 'Income').map((c) => c.id)]);

export interface CashFlow {
  /** Net money in to income categories. */
  income: number;
  /** Net spend in categories that count as spending (as on the Budgets page). */
  spending: number;
  /** income − spending */
  net: number;
}

/**
 * Income, spending and net for `month`. Transfers and other categories excluded from
 * spending count as neither, unless they are income categories.
 */
export function cashFlow(
  txns: readonly Transaction[], month: string,
  excluded: SpendExclusions = DEFAULT_EXCLUSIONS, income: ReadonlySet<string> = incomeCategories([]),
): CashFlow {
  let inc = 0;
  for (const t of txns) {
    if (monthKey(t.date) === month && income.has(t.categoryId ?? slug(t.category))) inc += t.amount;
  }
  const byCategory = spendByMonth(txns.filter((t) => monthKey(t.date) === month), excluded).get(month);
  const spending = round([...(byCategory?.values() ?? [])].reduce((s, v) => s + v, 0));
  const r = round(inc);
  return { income: r, spending, net: round(r - spending) };
}

export const NET_WORTH_RANGES = [3, 6, 12] as const;
export type NetWorthRange = (typeof NET_WORTH_RANGES)[number];

export interface NetWorthTrendPoint {
  month: string;
  total: number;
}

/**
 * Net worth at the end of each of the last `n` months up to `month`, from balance
 * snapshots of visible accounts. Each account keeps its latest snapshot until a newer one;
 * months before the first snapshot are left out.
 */
export function netWorthTrend(
  accounts: readonly Account[], snapshots: readonly BalanceSnapshot[], month: string, n: number,
): NetWorthTrendPoint[] {
  const visible = new Set(accounts.filter((a) => !a.hidden).map((a) => a.id));
  const sorted = snapshots.filter((s) => visible.has(s.accountId)).sort((a, b) => a.date.localeCompare(b.date));
  const latest = new Map<string, number>();
  const out: NetWorthTrendPoint[] = [];
  let i = 0;
  for (const m of monthRange(month, n)) {
    while (i < sorted.length && monthKey(sorted[i].date) <= m) latest.set(sorted[i].accountId, sorted[i++].balance);
    if (latest.size) out.push({ month: m, total: round([...latest.values()].reduce((a, b) => a + b, 0)) });
  }
  return out;
}

/** Change from the first to the last point of a trend, or 0 with fewer than two points. */
export const trendChange = (points: readonly { total: number }[]) =>
  points.length > 1 ? round(points[points.length - 1].total - points[0].total) : 0;

/** A charge expected to repeat, as recurring detection will report it. */
export interface RecurringCharge {
  name: string;
  /** Signed, same convention as Transaction.amount. */
  amount: number;
  /** YYYY-MM-DD */
  nextDate: string;
}

export const UPCOMING_DAYS = 14;

/** Charges due from today through the next `days` days, soonest first. */
export function upcomingRecurring(
  charges: readonly RecurringCharge[], today = new Date(), days = UPCOMING_DAYS,
): RecurringCharge[] {
  const from = isoDate(today);
  const to = isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days));
  return charges
    .filter((c) => c.nextDate >= from && c.nextDate <= to)
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate) || a.name.localeCompare(b.name));
}

export interface ReviewQueue {
  count: number;
  /** The newest unreviewed transactions. */
  latest: Transaction[];
}

/** How many transactions need review, and the `limit` newest of them. */
export function reviewQueue(txns: readonly Transaction[], limit = 5): ReviewQueue {
  const open = txns.filter((t) => !t.reviewed);
  // Array.prototype.sort is stable, so same-day rows keep their input order.
  const latest = open.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, limit);
  return { count: open.length, latest };
}
