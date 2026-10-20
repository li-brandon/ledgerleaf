import { describe, expect, it } from 'vitest';
import { createMemoryRepository, loadLedger, readLedger, saveLedger } from '../../db';
import { spendExclusions } from '../budget';
import { emptyLedger, migrate } from '../migrate';
import { upcomingRecurring } from '../overview';
import {
  addManualRecurring, detectRecurring, inferCadence, merchantKey, monthlyTotal, normalizeRecurring, recurringCharges,
  recurringSeries, removeManualRecurring, setRecurringDecision, stepDate,
} from '../recurring';
import { DEMO_SUBSCRIPTIONS, MockProvider } from '../sync';
import type { LedgerState, Transaction } from '../types';

let n = 0;
const tx = (date: string, amount: number, merchant: string, extra: Partial<Transaction> = {}): Transaction => ({
  id: `t${n++}`, date, description: merchant, merchant, amount, category: 'Entertainment', categoryId: 'entertainment',
  accountId: 'a', ...extra,
});

/** One charge on `day` of each month from `from` (YYYY-MM) for `count` months. */
const monthly = (merchant: string, amount: number | ((i: number) => number), from: string, count: number, day = 5) =>
  Array.from({ length: count }, (_, i) => tx(
    stepDate(`${from}-${String(day).padStart(2, '0')}`, 'monthly', i, day),
    typeof amount === 'number' ? amount : amount(i), merchant,
  ));

const ledger = (transactions: Transaction[], recurring?: LedgerState['recurring']): LedgerState =>
  ({ ...emptyLedger('2026-10'), transactions, recurring });

const today = new Date(2026, 9, 20); // 2026-10-20

describe('stepDate', () => {
  it('steps weeks, months and years, clamping to short months', () => {
    expect(stepDate('2026-10-28', 'weekly', 1)).toBe('2026-11-04');
    expect(stepDate('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
    expect(stepDate('2026-02-28', 'monthly', 1, 31)).toBe('2026-03-31');
    expect(stepDate('2026-12-15', 'monthly', 1)).toBe('2027-01-15');
    expect(stepDate('2026-01-15', 'monthly', -1)).toBe('2025-12-15');
    expect(stepDate('2028-02-29', 'yearly', 1)).toBe('2029-02-28');
  });
});

describe('merchantKey', () => {
  it('ignores case, punctuation and tokens with digits', () => {
    expect(merchantKey('STREAMLY*Subscription #4821')).toBe('streamly subscription');
    expect(merchantKey('Streamly  subscription')).toBe('streamly subscription');
    expect(merchantKey('7-Eleven')).toBe('eleven');
  });
});

describe('inferCadence', () => {
  it('recognises weekly, monthly and yearly gaps', () => {
    expect(inferCadence([tx('2026-09-01', -5, 'x'), tx('2026-09-08', -5, 'x'), tx('2026-09-15', -5, 'x')])).toBe('weekly');
    expect(inferCadence(monthly('x', -5, '2026-01', 4))).toBe('monthly');
    expect(inferCadence([tx('2023-03-01', -99, 'x'), tx('2024-03-01', -99, 'x'), tx('2025-03-02', -99, 'x')])).toBe('yearly');
  });

  it('needs three charges and regular gaps', () => {
    expect(inferCadence(monthly('x', -5, '2026-01', 2))).toBeUndefined();
    expect(inferCadence([tx('2026-01-01', -5, 'x'), tx('2026-01-15', -5, 'x'), tx('2026-02-01', -5, 'x')])).toBeUndefined();
    expect(inferCadence([tx('2026-01-01', -5, 'x'), tx('2026-02-01', -5, 'x'), tx('2026-02-20', -5, 'x')])).toBeUndefined();
  });

  it('tolerates the odd skipped charge', () => {
    const charges = monthly('x', -5, '2026-01', 9).filter((_, i) => i !== 4);
    expect(inferCadence(charges)).toBe('monthly');
  });
});

describe('detectRecurring', () => {
  it('groups by merchant and similar amount, and ignores income and transfers', () => {
    const found = detectRecurring([
      ...monthly('Streamly', -15.99, '2026-04', 6),
      ...monthly('Payroll', 2900, '2026-04', 6),
      ...monthly('Card payment', -500, '2026-04', 6).map((t) => ({ ...t, category: 'Transfer', categoryId: 'transfer' })),
    ]);
    expect(found.map((s) => [s.name, s.cadence, s.charges.length])).toEqual([['Streamly', 'monthly', 6]]);
    expect(found[0].key).toBe('streamly|monthly');
  });

  it('accepts amounts within ±10% and rejects ones further off', () => {
    const near = detectRecurring(monthly('Power Co', (i) => [-100, -108, -95, -104][i], '2026-06', 4));
    expect(near).toHaveLength(1);
    const far = detectRecurring(monthly('Corner Shop', (i) => [-100, -130, -70, -100][i], '2026-06', 4));
    expect(far).toEqual([]);
  });

  it('needs at least three occurrences', () => {
    expect(detectRecurring(monthly('Streamly', -15.99, '2026-08', 2))).toEqual([]);
  });

  it('splits one merchant into separate series by amount', () => {
    const found = detectRecurring([...monthly('App Store', -2.99, '2026-03', 5, 3), ...monthly('App Store', -9.99, '2026-03', 4, 20)]);
    expect(found.map((s) => [s.key, -s.charges[0].amount])).toEqual([['app store|monthly', 2.99], ['app store|monthly|2', 9.99]]);
  });

  it('does not treat irregular spending at one merchant as recurring', () => {
    const dates = ['2026-06-02', '2026-06-09', '2026-06-27', '2026-07-03', '2026-08-15', '2026-08-16'];
    expect(detectRecurring(dates.map((d) => tx(d, -42, 'Juniper Café')))).toEqual([]);
  });

  it('keeps an on-schedule charge after a price rise in the series', () => {
    const charges = monthly('Streamly', (i) => (i < 5 ? -15.99 : -19.99), '2026-05', 6);
    const [s] = detectRecurring(charges);
    expect(s.charges).toHaveLength(6);
  });
});

describe('recurringSeries', () => {
  it('reports cadence, typical amount, next date and monthly equivalent', () => {
    const weekly = Array.from({ length: 5 }, (_, i) => tx(stepDate('2026-09-15', 'weekly', i), -12, 'Veg Box'));
    const yearly = [tx('2024-03-01', -120, 'Domain Host'), tx('2025-03-01', -120, 'Domain Host'), tx('2026-03-02', -120, 'Domain Host')];
    const series = recurringSeries(ledger([...monthly('Streamly', -15.99, '2026-05', 6, 12), ...weekly, ...yearly]), today);
    const by = Object.fromEntries(series.map((s) => [s.name, s]));
    expect(by.Streamly).toMatchObject({ cadence: 'monthly', typical: -15.99, monthly: -15.99, nextDate: '2026-11-12', state: 'active' });
    expect(by['Veg Box']).toMatchObject({ cadence: 'weekly', typical: -12, monthly: -52, nextDate: '2026-10-20', upcomingDate: '2026-10-20' });
    expect(by['Domain Host']).toMatchObject({ cadence: 'yearly', monthly: -10, nextDate: '2027-03-01' });
    expect(monthlyTotal(series)).toBe(77.99);
  });

  it('flags a price increase above 5% on the latest charge', () => {
    const [s] = recurringSeries(ledger(monthly('Tunebox', (i) => (i < 5 ? -10.99 : -11.99), '2026-05', 6, 3)), today);
    expect(s.priceIncrease).toEqual({ from: 10.99, to: 11.99, change: 0.091 });
    expect(s.expected).toBe(-11.99);
    expect(s.typical).toBe(-10.99);
  });

  it('flags a rise beyond the ±10% band too', () => {
    const [s] = recurringSeries(ledger(monthly('Streamly', (i) => (i < 5 ? -15.99 : -19.99), '2026-05', 6, 12)), today);
    expect(s.priceIncrease?.to).toBe(19.99);
    expect(s.monthly).toBe(-19.99);
  });

  it('does not flag small rises or a bill that merely varies', () => {
    const small = recurringSeries(ledger(monthly('Gym', (i) => (i < 5 ? -39 : -40), '2026-05', 6)), today)[0];
    expect(small.priceIncrease).toBeUndefined();
    const varies = recurringSeries(ledger(monthly('Power', (i) => [-100, -108, -96, -104, -101, -106][i], '2026-05', 6)), today)[0];
    expect(varies.priceIncrease).toBeUndefined();
    const flat = recurringSeries(ledger(monthly('Streamly', -15.99, '2026-05', 6)), today)[0];
    expect(flat.priceIncrease).toBeUndefined();
  });

  it('marks a charge missed after the grace window, and inactive after two', () => {
    const state = (last: string) => recurringSeries(ledger(monthly('Streamly', -15.99, '2026-01', 12, 12).filter((t) => t.date <= last)), today)[0];
    expect(state('2026-10-12').state).toBe('active');
    // Due 2026-10-12; five days of grace end on the 17th.
    expect(state('2026-09-12')).toMatchObject({ state: 'missed', nextDate: '2026-10-12', upcomingDate: '2026-11-12' });
    expect(state('2026-08-12').state).toBe('inactive');
    // Within the grace window it is still on schedule.
    expect(recurringSeries(ledger(monthly('Gym', -39, '2026-04', 6, 16)), today)[0].state).toBe('active');
  });

  it('applies confirm and dismiss decisions', () => {
    let s = ledger([...monthly('Streamly', -15.99, '2026-05', 6, 12), ...monthly('Tunebox', -10.99, '2026-05', 6, 3)]);
    s = setRecurringDecision(s, 'streamly|monthly', 'confirmed');
    s = setRecurringDecision(s, 'tunebox|monthly', 'dismissed');
    const series = recurringSeries(s, today);
    expect(series.map((x) => [x.name, x.status])).toEqual([['Streamly', 'confirmed'], ['Tunebox', 'dismissed']]);
    expect(monthlyTotal(series)).toBe(15.99);
    expect(recurringSeries(setRecurringDecision(s, 'tunebox|monthly', undefined), today)[1].status).toBe('suggested');
  });

  it('includes manual series and lets them take over a detected one', () => {
    let s = ledger(monthly('Streamly', -15.99, '2026-05', 6, 12));
    s = addManualRecurring(s, { name: 'Window cleaner', amount: 40, cadence: 'monthly', nextDate: '2026-08-25' }, 'a');
    s = addManualRecurring(s, { name: 'streamly', amount: 16, cadence: 'monthly', nextDate: '2026-11-12' }, 'b');
    const series = recurringSeries(s, today);
    expect(series.map((x) => [x.name, x.status, x.charges.length, x.upcomingDate, x.state])).toEqual([
      ['Window cleaner', 'manual', 0, '2026-10-25', 'active'],
      ['streamly', 'manual', 6, '2026-11-12', 'active'],
    ]);
    expect(series[0].monthly).toBe(-40);
    const id = s.recurring!.manual[0].id;
    expect(recurringSeries(removeManualRecurring(s, id), today).map((x) => x.name)).toEqual(['streamly']);
  });

  it('flags a missed charge on a manual series that has matching charges', () => {
    const s = addManualRecurring(
      ledger(monthly('Gym', -39, '2026-04', 5, 7)), { name: 'Gym', amount: 39, cadence: 'monthly', nextDate: '2026-04-07' },
    );
    expect(recurringSeries(s, today)[0]).toMatchObject({ nextDate: '2026-09-07', state: 'inactive' });
    const recent = addManualRecurring(
      ledger(monthly('Gym', -39, '2026-04', 6, 7)), { name: 'Gym', amount: 39, cadence: 'monthly', nextDate: '2026-04-07' },
    );
    expect(recurringSeries(recent, today)[0]).toMatchObject({ nextDate: '2026-10-07', state: 'missed' });
  });

  it('rejects invalid manual series', () => {
    expect(() => addManualRecurring(ledger([]), { name: ' ', amount: 5, cadence: 'monthly', nextDate: '2026-11-01' })).toThrow('name');
    expect(() => addManualRecurring(ledger([]), { name: 'x', amount: 0, cadence: 'monthly', nextDate: '2026-11-01' })).toThrow('amount');
    expect(() => addManualRecurring(ledger([]), { name: 'x', amount: 5, cadence: 'monthly', nextDate: '' })).toThrow('date');
  });
});

describe('upcoming recurring for the Overview', () => {
  it('leaves out dismissed and inactive series and uses the expected amount', () => {
    let s = ledger([
      ...monthly('Streamly', (i) => (i < 5 ? -15.99 : -17.99), '2026-05', 6, 12),
      ...monthly('Cloudbox', -2.99, '2026-05', 5, 22),
      ...monthly('Gone', -9, '2026-01', 6, 25),
    ]);
    s = addManualRecurring(s, { name: 'Insurance', amount: 80, cadence: 'monthly', nextDate: '2026-10-28' });
    expect(upcomingRecurring(recurringCharges(recurringSeries(s, today)), today)).toEqual([
      { name: 'Cloudbox', amount: -2.99, nextDate: '2026-10-22' },
      { name: 'Insurance', amount: -80, nextDate: '2026-10-28' },
    ]);
    s = setRecurringDecision(s, 'cloudbox|monthly', 'dismissed');
    expect(upcomingRecurring(recurringCharges(recurringSeries(s, today)), today).map((c) => c.name)).toEqual(['Insurance']);
    expect(upcomingRecurring(recurringCharges(recurringSeries(s, today)), new Date(2026, 10, 1)).map((c) => c.name))
      .toEqual(['Streamly']);
  });
});

describe('demo data', () => {
  async function demoLedger(seed?: number) {
    const p = new MockProvider(today, seed);
    return migrate({ ...emptyLedger('2026-10'), transactions: await p.fetchTransactions() });
  }

  it('finds every demo subscription, monthly, at its amount and day', async () => {
    const s = await demoLedger();
    const series = recurringSeries(s, today, spendExclusions(s.categories));
    for (const [day, merchant, amount] of DEMO_SUBSCRIPTIONS) {
      const found = series.find((x) => x.name === merchant);
      expect(found, merchant).toMatchObject({ cadence: 'monthly', typical: -amount, state: 'active', status: 'suggested' });
      expect(Number(found!.nextDate.slice(8))).toBe(day);
      expect(found!.priceIncrease).toBeUndefined();
    }
  });

  it('adds rent but no paychecks, transfers, card payments or everyday spending', async () => {
    for (const seed of [42, 7, 1234]) {
      const s = await demoLedger(seed);
      const names = recurringSeries(s, today, spendExclusions(s.categories)).map((x) => x.name).sort();
      expect(names).toEqual([...DEMO_SUBSCRIPTIONS.map(([, m]) => m), 'Maple Street Lofts'].sort());
    }
  });

  it('totals the monthly equivalent and feeds the upcoming card', async () => {
    const s = await demoLedger();
    const series = recurringSeries(s, today, spendExclusions(s.categories));
    const subs = DEMO_SUBSCRIPTIONS.reduce((sum, [, , amount]) => sum + amount, 0);
    expect(monthlyTotal(series)).toBeCloseTo(subs + 1650, 2);
    expect(upcomingRecurring(recurringCharges(series), today).map((c) => [c.name, c.nextDate])).toEqual([
      ['Cloudvault Storage', '2026-10-22'],
      ['Hearthline Mobile', '2026-10-26'],
      ['Maple Street Lofts', '2026-11-01'],
      ['Tunebox Music', '2026-11-03'],
    ]);
  });
});

describe('stored settings', () => {
  it('normalizes stored settings and drops malformed entries', () => {
    expect(normalizeRecurring(undefined)).toBeUndefined();
    expect(normalizeRecurring({ decisions: {}, manual: [] })).toBeUndefined();
    expect(normalizeRecurring({
      decisions: { a: 'confirmed', b: 'dismissed', c: 'maybe' },
      manual: [
        { id: 'm1', name: ' Gym ', amount: -39, cadence: 'monthly', nextDate: '2026-11-07', junk: 1 },
        { id: 'm1', name: 'Dup', amount: -1, cadence: 'monthly', nextDate: '2026-11-07' },
        { id: 'm2', name: 'Bad', amount: -1, cadence: 'daily', nextDate: '2026-11-07' },
        { name: 'No id', amount: -1, cadence: 'weekly', nextDate: '2026-11-07' },
      ],
    })).toEqual({
      decisions: { a: 'confirmed', b: 'dismissed' },
      manual: [{ id: 'm1', name: 'Gym', amount: -39, cadence: 'monthly', nextDate: '2026-11-07' }],
    });
  });

  it('survives migration and an older ledger without settings loads unchanged', () => {
    const base = emptyLedger('2026-10');
    expect(migrate(base, '2026-10').recurring).toBeUndefined();
    const s = setRecurringDecision(base, 'x|monthly', 'dismissed');
    expect(migrate(JSON.parse(JSON.stringify(s)), '2026-10')).toEqual(s);
  });

  it('is saved to and read back from the repository', async () => {
    const repo = createMemoryRepository();
    const first = await loadLedger(repo, undefined);
    let next = setRecurringDecision(first, 'streamly|monthly', 'confirmed');
    next = addManualRecurring(next, { name: 'Gym', amount: 39, cadence: 'monthly', nextDate: '2026-11-07' }, 'seed');
    await saveLedger(repo, next, first);
    expect((await readLedger(repo))?.recurring).toEqual(next.recurring);
  });
});
