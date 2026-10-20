/**
 * Recurring charge and subscription detection. Pure, so it can be unit tested.
 *
 * A series is three or more charges from the same merchant whose amounts are within
 * {@link AMOUNT_TOLERANCE} of their median and whose gaps fit a weekly, monthly or yearly
 * cadence. Only money out counts, and categories excluded from spending (transfers, card
 * payments, income) are ignored. Detected series are recomputed from transactions on every
 * render; only the user's decisions (confirm / dismiss) and manual series are stored.
 */
import { DEFAULT_EXCLUSIONS, isExcluded, round, type SpendExclusions } from './budget';
import { hashId } from './sync/hash';
import { isoDate, type RecurringCharge } from './overview';
import type {
  Cadence, LedgerState, ManualRecurring, RecurringDecision, RecurringSettings, Transaction,
} from './types';

export const CADENCES: readonly Cadence[] = ['weekly', 'monthly', 'yearly'];

/** Fewest charges that make a series. */
export const MIN_OCCURRENCES = 3;

/** Charges belong to one series when each is within ±10% of the series' median amount. */
export const AMOUNT_TOLERANCE = 0.1;

/**
 * The latest charge is flagged as a price increase when it is more than 5% above the median
 * of the earlier charges and higher than every one of them. 5% rather than 10% because common
 * subscription hikes are small ($10.99 → $11.99 is +9%); requiring a new high keeps bills that
 * merely vary from month to month from being flagged, and limits the flag to the first charge
 * at the new price.
 */
export const PRICE_INCREASE_THRESHOLD = 0.05;

/**
 * After a price change the charge may fall outside the ±10% band; a charge from the same
 * merchant that lands on the next expected date is still added to the series when it is
 * within this factor of the typical amount.
 */
const ON_SCHEDULE_FACTOR = 1.5;

interface CadenceSpec {
  /** Accepted gap in days between consecutive charges. */
  min: number;
  max: number;
  /** Charges per month, for the monthly-equivalent cost. */
  perMonth: number;
  /** Days after the expected date before a charge counts as missed. */
  grace: number;
}

export const CADENCE_SPECS: Record<Cadence, CadenceSpec> = {
  weekly: { min: 6, max: 8, perMonth: 52 / 12, grace: 3 },
  monthly: { min: 26, max: 35, perMonth: 1, grace: 5 },
  yearly: { min: 350, max: 380, perMonth: 1 / 12, grace: 14 },
};

export const CADENCE_LABELS: Record<Cadence, string> = { weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };

// ---------- Dates ----------

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};
const daysBetween = (a: string, b: string) => dayNumber(b) - dayNumber(a);
const fromUtc = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => fromUtc(dayNumber(iso) + n);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * `iso` moved `n` cadence steps. Monthly and yearly steps land on `anchorDay` (default: the
 * day of `iso`), clamped to the end of shorter months.
 */
export function stepDate(iso: string, cadence: Cadence, n: number, anchorDay?: number): string {
  if (cadence === 'weekly') return addDays(iso, 7 * n);
  const [y, m, d] = iso.split('-').map(Number);
  const months = (m - 1) + (cadence === 'monthly' ? n : 12 * n);
  const year = y + Math.floor(months / 12);
  const month = (((months % 12) + 12) % 12) + 1;
  const day = Math.min(anchorDay ?? d, lastDay(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** How many cadence steps a gap of `days` spans: 1, 2 (one charge skipped) or 0 if it fits neither. */
function stepsIn(days: number, cadence: Cadence): number {
  const { min, max } = CADENCE_SPECS[cadence];
  if (days >= min && days <= max) return 1;
  if (days >= 2 * min && days <= 2 * max) return 2;
  return 0;
}

// ---------- Detection ----------

/**
 * A merchant name reduced to what stays the same between charges: lower case, words only,
 * dropping tokens with digits (store numbers, reference codes).
 */
export function merchantKey(name: string): string {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !/\d/.test(w)).join(' ') || name.trim().toLowerCase();
}

const merchantOf = (t: Transaction) => t.merchant || t.description;

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const byDate = (a: Transaction, b: Transaction) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id));

/** A series found in transactions, before user decisions are applied. */
export interface DetectedSeries {
  /** Stable id for decisions: merchant key and cadence (plus a counter if a merchant has several). */
  key: string;
  /** Merchant name as it appears on the latest charge. */
  name: string;
  merchantKey: string;
  cadence: Cadence;
  /** The charges, oldest first. */
  charges: Transaction[];
}

/** Charges whose amounts are within ±{@link AMOUNT_TOLERANCE} of their median, by size. */
function amountClusters(charges: readonly Transaction[]): Transaction[][] {
  const sorted = [...charges].sort((a, b) => b.amount - a.amount); // smallest charge first
  const out: Transaction[][] = [];
  const span = (1 + AMOUNT_TOLERANCE) / (1 - AMOUNT_TOLERANCE);
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && -sorted[j].amount <= -sorted[i].amount * span) j++;
    let group = sorted.slice(i, j);
    // The span check allows ±10% of some midpoint; keep only what is within ±10% of the median.
    const m = median(group.map((t) => -t.amount));
    group = group.filter((t) => Math.abs(-t.amount - m) <= m * AMOUNT_TOLERANCE + 0.005);
    if (group.length) out.push(group);
    i = j;
  }
  return out;
}

/** The cadence `charges` (oldest first) repeat at, or undefined if they are not regular. */
export function inferCadence(charges: readonly Transaction[]): Cadence | undefined {
  if (charges.length < MIN_OCCURRENCES) return undefined;
  const gaps = charges.slice(1).map((t, i) => daysBetween(charges[i].date, t.date));
  for (const cadence of CADENCES) {
    const steps = gaps.map((g) => stepsIn(g, cadence));
    if (steps.includes(0)) continue;
    // Allow the odd skipped charge, but most gaps must be a single step.
    const skipped = steps.filter((s) => s === 2).length;
    if (steps.length - skipped >= MIN_OCCURRENCES - 1 && skipped <= Math.floor(steps.length / 4)) return cadence;
  }
  return undefined;
}

/** The day of the month charges usually fall on (the latest one's on a tie). */
function anchorDay(charges: readonly Transaction[]): number {
  const counts = new Map<number, number>();
  let best = 0;
  let bestN = 0;
  for (const t of charges) {
    const d = Number(t.date.slice(8, 10));
    const n = (counts.get(d) ?? 0) + 1;
    counts.set(d, n);
    if (n >= bestN) { best = d; bestN = n; }
  }
  return best;
}

/**
 * Add later charges from `pool` that land on schedule even though their amount moved beyond
 * the ±10% band (a price change). Returns the extended series, oldest first.
 */
function extendOnSchedule(series: Transaction[], cadence: Cadence, pool: readonly Transaction[]): Transaction[] {
  const typical = median(series.map((t) => -t.amount));
  const out = [...series];
  for (const t of [...pool].sort(byDate)) {
    const last = out[out.length - 1];
    if (t.date <= last.date || out.includes(t)) continue;
    const amount = -t.amount;
    if (amount < typical / ON_SCHEDULE_FACTOR || amount > typical * ON_SCHEDULE_FACTOR) continue;
    if (stepsIn(daysBetween(last.date, t.date), cadence) === 1) out.push(t);
  }
  return out;
}

export interface DetectOptions {
  /** Category ids that never count as recurring spend (default: Income and Transfer). */
  excluded?: SpendExclusions;
}

/**
 * Find recurring series in `txns`. Each charge belongs to at most one series; when a
 * merchant has several, the one with the most charges is taken first.
 */
export function detectRecurring(txns: readonly Transaction[], opts: DetectOptions = {}): DetectedSeries[] {
  const excluded = opts.excluded ?? DEFAULT_EXCLUSIONS;
  const byMerchant = new Map<string, Transaction[]>();
  for (const t of txns) {
    if (t.amount >= 0 || isExcluded(t, excluded)) continue;
    const key = merchantKey(merchantOf(t));
    const list = byMerchant.get(key);
    if (list) list.push(t); else byMerchant.set(key, [t]);
  }

  const out: DetectedSeries[] = [];
  for (const [mKey, all] of byMerchant) {
    if (all.length < MIN_OCCURRENCES) continue;
    let pool = all;
    const taken = new Map<string, number>();
    for (;;) {
      let best: { charges: Transaction[]; cadence: Cadence } | undefined;
      for (const cluster of amountClusters(pool)) {
        const charges = cluster.sort(byDate);
        const cadence = inferCadence(charges);
        if (cadence && (!best || charges.length > best.charges.length)) best = { charges, cadence };
      }
      if (!best) break;
      const charges = extendOnSchedule(best.charges, best.cadence, pool);
      const used = new Set(charges);
      pool = pool.filter((t) => !used.has(t));
      const n = (taken.get(best.cadence) ?? 0) + 1;
      taken.set(best.cadence, n);
      out.push({
        key: `${mKey}|${best.cadence}${n > 1 ? `|${n}` : ''}`,
        name: merchantOf(charges[charges.length - 1]),
        merchantKey: mKey,
        cadence: best.cadence,
        charges,
      });
      if (pool.length < MIN_OCCURRENCES) break;
    }
  }
  return out;
}

// ---------- Series with user decisions ----------

export type SeriesStatus = 'suggested' | 'confirmed' | 'dismissed' | 'manual';

/**
 * `active`: on schedule. `missed`: the expected charge is more than the grace window late.
 * `inactive`: two or more charges in a row did not arrive; probably cancelled.
 */
export type SeriesState = 'active' | 'missed' | 'inactive';

export interface PriceIncrease {
  /** Median of the earlier charges, positive. */
  from: number;
  /** The latest charge, positive. */
  to: number;
  /** Fractional increase, e.g. 0.09 for +9%. */
  change: number;
}

export interface RecurringSeries {
  /** Detected series' key, or the manual series' id. */
  key: string;
  name: string;
  cadence: Cadence;
  status: SeriesStatus;
  state: SeriesState;
  /** Signed median charge. */
  typical: number;
  /** Signed amount the next charge is expected to be: the latest after a price increase, else typical. */
  expected: number;
  /** Signed monthly equivalent of `expected`. */
  monthly: number;
  /** Matching charges, oldest first. */
  charges: Transaction[];
  /** YYYY-MM-DD of the next expected charge after the latest one; in the past when missed. */
  nextDate: string;
  /** YYYY-MM-DD of the first expected charge on or after today. */
  upcomingDate: string;
  priceIncrease?: PriceIncrease;
}

export const emptyRecurringSettings = (): RecurringSettings => ({ decisions: {}, manual: [] });

function priceIncrease(charges: readonly Transaction[]): PriceIncrease | undefined {
  if (charges.length < MIN_OCCURRENCES) return undefined;
  const earlier = charges.slice(0, -1).map((t) => -t.amount);
  const to = -charges[charges.length - 1].amount;
  const from = median(earlier);
  if (to <= from * (1 + PRICE_INCREASE_THRESHOLD) || to <= Math.max(...earlier)) return undefined;
  return { from: round(from), to: round(to), change: Math.round(((to - from) / from) * 1000) / 1000 };
}

function stateAt(nextDate: string, cadence: Cadence, today: string): SeriesState {
  const { grace } = CADENCE_SPECS[cadence];
  const late = daysBetween(nextDate, today);
  if (late <= grace) return 'active';
  return daysBetween(stepDate(nextDate, cadence, 1), today) > grace ? 'inactive' : 'missed';
}

/** The first date of `date`'s cadence sequence that is on or after `today`. */
function onOrAfter(date: string, cadence: Cadence, today: string, anchor?: number): string {
  let d = date;
  for (let i = 1; d < today; i++) d = stepDate(date, cadence, i, anchor);
  return d;
}

const monthlyOf = (amount: number, cadence: Cadence) => round(amount * CADENCE_SPECS[cadence].perMonth);

function fromDetected(s: DetectedSeries, status: SeriesStatus, today: string): RecurringSeries {
  const { charges, cadence } = s;
  const last = charges[charges.length - 1];
  const anchor = cadence === 'weekly' ? undefined : anchorDay(charges);
  const nextDate = stepDate(last.date, cadence, 1, anchor);
  const typical = -round(median(charges.map((t) => -t.amount)));
  const increase = priceIncrease(charges);
  const expected = increase ? last.amount : typical;
  return {
    key: s.key, name: s.name, cadence, status, state: stateAt(nextDate, cadence, today),
    typical, expected, monthly: monthlyOf(expected, cadence), charges, nextDate,
    upcomingDate: onOrAfter(nextDate, cadence, today, anchor), priceIncrease: increase,
  };
}

/**
 * A manual series. Charges from the same merchant within ±10% of its amount are matched to it,
 * so it is tracked like a detected one; with no matching charges it simply repeats from its
 * due date and is never flagged.
 */
function fromManual(m: ManualRecurring, txns: readonly Transaction[], excluded: SpendExclusions, today: string): RecurringSeries {
  const key = merchantKey(m.name);
  const size = Math.abs(m.amount);
  const charges = txns
    .filter((t) => t.amount < 0 && !isExcluded(t, excluded) && merchantKey(merchantOf(t)) === key
      && Math.abs(-t.amount - size) <= size * AMOUNT_TOLERANCE + 0.005)
    .sort(byDate);
  const anchor = m.cadence === 'weekly' ? undefined : Number(m.nextDate.slice(8, 10));
  const { grace } = CADENCE_SPECS[m.cadence];
  const last = charges[charges.length - 1];
  let nextDate = m.nextDate;
  if (last) {
    // The first due date in the manual schedule that the latest charge does not already cover.
    let i = 0;
    while (daysBetween(last.date, stepDate(m.nextDate, m.cadence, i, anchor)) > grace) i--;
    while (daysBetween(last.date, stepDate(m.nextDate, m.cadence, i, anchor)) <= grace) i++;
    nextDate = stepDate(m.nextDate, m.cadence, i, anchor);
  }
  const increase = priceIncrease(charges);
  const expected = increase ? last.amount : -size;
  return {
    key: m.id, name: m.name, cadence: m.cadence, status: 'manual',
    state: last ? stateAt(nextDate, m.cadence, today) : 'active',
    typical: -size, expected, monthly: monthlyOf(expected, m.cadence), charges, nextDate,
    upcomingDate: onOrAfter(nextDate, m.cadence, today, anchor), priceIncrease: increase,
  };
}

const STATUS_ORDER: Record<SeriesStatus, number> = { manual: 0, confirmed: 0, suggested: 1, dismissed: 2 };
const STATE_ORDER: Record<SeriesState, number> = { missed: 0, active: 0, inactive: 1 };

/**
 * Every recurring series: detected ones with the user's decisions applied, plus manual ones.
 * A detected series for the same merchant and cadence as a manual one is left out (the manual
 * one tracks those charges). Sorted: kept series by next date, then suggestions, then dismissed.
 */
export function recurringSeries(
  state: Pick<LedgerState, 'transactions' | 'recurring'>, today = new Date(), excluded: SpendExclusions = DEFAULT_EXCLUSIONS,
): RecurringSeries[] {
  const now = isoDate(today);
  const { decisions, manual } = state.recurring ?? emptyRecurringSettings();
  const manualKeys = new Set(manual.map((m) => `${merchantKey(m.name)}|${m.cadence}`));
  const out = [
    ...detectRecurring(state.transactions, { excluded })
      .filter((s) => !manualKeys.has(`${s.merchantKey}|${s.cadence}`))
      .map((s) => fromDetected(s, decisions[s.key] ?? 'suggested', now)),
    ...manual.map((m) => fromManual(m, state.transactions, excluded, now)),
  ];
  return out.sort((a, b) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || a.upcomingDate.localeCompare(b.upcomingDate) || a.name.localeCompare(b.name));
}

/** Series that count: not dismissed and not inactive. */
export const isCounted = (s: RecurringSeries) => s.status !== 'dismissed' && s.state !== 'inactive';

/** Monthly-equivalent cost of every counted series, as a positive amount. */
export const monthlyTotal = (series: readonly RecurringSeries[]) =>
  round(-series.filter(isCounted).reduce((sum, s) => sum + s.monthly, 0));

/** Counted series as charges for the Overview's upcoming card, due on their next date on or after today. */
export const recurringCharges = (series: readonly RecurringSeries[]): RecurringCharge[] =>
  series.filter(isCounted).map((s) => ({ name: s.name, amount: s.expected, nextDate: s.upcomingDate }));

// ---------- Settings (stored) ----------

/** Record a decision on a detected series; `undefined` makes it a suggestion again. */
export function setRecurringDecision(state: LedgerState, key: string, decision: RecurringDecision | undefined): LedgerState {
  const prev = state.recurring ?? emptyRecurringSettings();
  if (prev.decisions[key] === decision) return state;
  const decisions = { ...prev.decisions };
  if (decision) decisions[key] = decision; else delete decisions[key];
  return { ...state, recurring: { ...prev, decisions } };
}

export interface ManualDraft {
  name: string;
  /** Positive: how much is charged. */
  amount: number;
  cadence: Cadence;
  nextDate: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Why a manual series cannot be saved, or undefined if it can. */
export function manualProblem(d: ManualDraft): string | undefined {
  if (!d.name.trim()) return 'Enter a name.';
  if (!Number.isFinite(d.amount) || d.amount <= 0) return 'Enter an amount above zero.';
  if (!CADENCES.includes(d.cadence)) return 'Choose how often it repeats.';
  if (!ISO_DATE.test(d.nextDate) || Number.isNaN(dayNumber(d.nextDate))) return 'Enter the next due date.';
  return undefined;
}

/** Add a manual series; throws if the draft is invalid. */
export function addManualRecurring(state: LedgerState, d: ManualDraft, seed = `${Date.now()}-${Math.random()}`): LedgerState {
  const problem = manualProblem(d);
  if (problem) throw new Error(problem);
  const prev = state.recurring ?? emptyRecurringSettings();
  const taken = new Set(prev.manual.map((m) => m.id));
  let id = `manual-${hashId(seed)}`;
  for (let n = 1; taken.has(id); n++) id = `manual-${hashId(`${seed}#${n}`)}`;
  const m: ManualRecurring = { id, name: d.name.trim(), amount: -round(d.amount), cadence: d.cadence, nextDate: d.nextDate };
  return { ...state, recurring: { ...prev, manual: [...prev.manual, m] } };
}

export function removeManualRecurring(state: LedgerState, id: string): LedgerState {
  const prev = state.recurring;
  if (!prev?.manual.some((m) => m.id === id)) return state;
  return { ...state, recurring: { ...prev, manual: prev.manual.filter((m) => m.id !== id) } };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Stored recurring settings with malformed entries dropped; undefined when nothing is left. */
export function normalizeRecurring(v: unknown): RecurringSettings | undefined {
  if (!isObject(v)) return undefined;
  const decisions = isObject(v.decisions)
    ? Object.fromEntries(Object.entries(v.decisions).filter(([, d]) => d === 'confirmed' || d === 'dismissed')) as Record<string, RecurringDecision>
    : {};
  const seen = new Set<string>();
  const manual = (Array.isArray(v.manual) ? v.manual : []).flatMap((m): ManualRecurring[] => {
    if (!isObject(m) || typeof m.id !== 'string' || !m.id || seen.has(m.id)) return [];
    const draft = {
      name: typeof m.name === 'string' ? m.name : '',
      amount: typeof m.amount === 'number' ? Math.abs(m.amount) : NaN,
      cadence: m.cadence as Cadence,
      nextDate: typeof m.nextDate === 'string' ? m.nextDate : '',
    };
    if (manualProblem(draft)) return [];
    seen.add(m.id);
    return [{ id: m.id, name: draft.name.trim(), amount: -round(draft.amount), cadence: draft.cadence, nextDate: draft.nextDate }];
  });
  if (!Object.keys(decisions).length && !manual.length) return undefined;
  return { decisions, manual };
}
