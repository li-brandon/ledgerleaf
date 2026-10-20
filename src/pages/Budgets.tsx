import type { PageProps } from '../App';
import { Meter } from '../components/charts';
import { fmtMoney, fmtMonth } from '../format';
import {
  addMonths, currentMonth, isMonthKey, monthBudget, monthElapsed, monthTotals, type BudgetRow,
} from '../lib/budget';
import { routeHref } from '../lib/routes';

const STATUS_LABEL = { ok: 'On track', near: 'Close to limit', over: 'Over' };

/** Within this share of what is available, spending counts as on pace. */
const PACE_SLACK = 0.02;

const monthHref = (month: string) => routeHref('budgets', month === currentMonth() ? {} : { month });

const signed = (n: number) => `${n < 0 ? '−' : '+'}${fmtMoney(Math.abs(n))}`;

/** How spending compares with an even pace through the month, or null when there is no pace to keep. */
function pace(row: { spent: number; expected: number; available: number }, elapsed: number) {
  if (elapsed <= 0 || elapsed >= 1 || row.available <= 0) return null;
  const delta = row.spent - row.expected;
  const title = `${fmtMoney(row.expected)} expected by today`;
  if (Math.abs(delta) <= row.available * PACE_SLACK) return { text: 'On pace', cls: 'ok', title };
  return delta > 0
    ? { text: `${fmtMoney(delta)} over pace`, cls: 'near', title }
    : { text: `${fmtMoney(-delta)} under pace`, cls: 'ok', title };
}

function statusText(r: BudgetRow) {
  if (r.status === 'over') return r.available > 0 || r.budgeted ? `Over by ${fmtMoney(-r.remaining)}` : 'No budget';
  return STATUS_LABEL[r.status];
}

export default function Budgets({ ledger, params }: PageProps) {
  const { budgets, categories, transactions } = ledger.state;
  const now = currentMonth();
  const month = isMonthKey(params.month) ? params.month : now;
  const prev = addMonths(month, -1);
  const today = new Date();
  const elapsed = monthElapsed(month, today);
  const rows = monthBudget({ budgets, categories, transactions }, month, today);
  const listed = new Set(rows.map((r) => r.categoryId));
  const unused = categories.filter((c) => !c.excludeFromSpend && !listed.has(c.id)).map((c) => c.name);
  const totals = monthTotals(rows);
  const totalPace = pace(totals, elapsed);
  const totalRatio = totals.available > 0 ? totals.spent / totals.available : totals.spent > 0 ? Infinity : 0;

  return (
    <>
      <h1>Budgets</h1>
      <nav className="month-switch" aria-label="Month">
        <a className="btn ghost" href={monthHref(prev)} aria-label={`Previous month, ${fmtMonth(prev, 'long')}`}>‹</a>
        <strong aria-live="polite">{fmtMonth(month, 'long')}</strong>
        <a className="btn ghost" href={monthHref(addMonths(month, 1))} aria-label={`Next month, ${fmtMonth(addMonths(month, 1), 'long')}`}>›</a>
        {month !== now && <a className="month-now" href={monthHref(now)}>This month</a>}
      </nav>

      <section className="card">
        <p className="hero">{fmtMoney(totals.spent)} <small>spent of {fmtMoney(totals.available)} available</small></p>
        <Meter ratio={totalRatio} status={totalRatio > 1 ? 'over' : totalRatio >= 0.85 ? 'near' : 'ok'}
          mark={totals.available > 0 ? elapsed : undefined} label="Spent of all budgets" />
        <p className="muted budget-note">
          {totals.remaining >= 0 ? `${fmtMoney(totals.remaining)} left` : <span className="neg">{fmtMoney(-totals.remaining)} over</span>}
          {totalPace && <> · <span className={`tag ${totalPace.cls}`} title={totalPace.title}>{totalPace.text}</span></>}
          {elapsed > 0 && elapsed < 1 && <> · the tick marks where spending should be by today</>}
          {elapsed === 0 && <> · this month hasn’t started</>}
        </p>

        {rows.length === 0 && <p className="muted">No budgets for {fmtMonth(month, 'long')} yet. Add one below.</p>}
        <div className="budgets">
          {rows.map((r) => {
            const p = pace(r, elapsed);
            return (
              <div key={r.categoryId} className={`budget${r.status === 'over' ? ' is-over' : ''}`}>
                <div className="row between">
                  <strong className="budget-name">{r.category}</strong>
                  <span className={`tag ${r.status}`}>{statusText(r)}</span>
                </div>
                <Meter ratio={r.ratio} status={r.status} mark={r.available > 0 ? elapsed : undefined} label={`${r.category} spent`} />
                <dl className="budget-figs">
                  <div><dt>Spent</dt><dd>{fmtMoney(r.spent)}</dd></div>
                  <div>
                    <dt>Available</dt>
                    <dd className={r.available < 0 ? 'neg' : ''}>{fmtMoney(r.available)}</dd>
                  </div>
                  <div>
                    <dt>{r.remaining < 0 ? 'Over' : 'Left'}</dt>
                    <dd className={r.remaining < 0 ? 'neg' : ''}>{fmtMoney(Math.abs(r.remaining))}</dd>
                  </div>
                </dl>
                <p className="muted budget-note">
                  {r.carry !== 0 && <span className={r.carry < 0 ? 'neg' : ''}>{signed(r.carry)} rolled over from {fmtMonth(prev)}</span>}
                  {r.carry !== 0 && p && ' · '}
                  {p && <span className={`tag ${p.cls}`} title={p.title}>{p.text}</span>}
                </p>
                <div className="row between budget-edit">
                  <label className="limit">Budget $<input type="number" min={0} step={10} value={r.budgeted || ''} placeholder="0"
                    onChange={(e) => ledger.setBudget(r.category, Number(e.target.value), month)} /></label>
                  <label className="check" title="Carry what is left (or overspent) into next month">
                    <input type="checkbox" checked={r.rollover} onChange={(e) => ledger.setRollover(r.category, e.target.checked, month)} />
                    Roll over
                  </label>
                </div>
              </div>
            );
          })}
        </div>

        {rows.length > 0 && (
          <dl className="budget-total" aria-label="Totals">
            <div><dt>Budgeted</dt><dd>{fmtMoney(totals.budgeted)}</dd></div>
            <div><dt>Rolled over</dt><dd className={totals.carry < 0 ? 'neg' : ''}>{signed(totals.carry)}</dd></div>
            <div><dt>Available</dt><dd>{fmtMoney(totals.available)}</dd></div>
            <div><dt>Spent</dt><dd>{fmtMoney(totals.spent)}</dd></div>
            <div>
              <dt>{totals.remaining < 0 ? 'Over' : 'Left'}</dt>
              <dd className={totals.remaining < 0 ? 'neg' : ''}>{fmtMoney(Math.abs(totals.remaining))}</dd>
            </div>
          </dl>
        )}

        {unused.length > 0 && (
          <p className="muted add">
            Add a budget:{' '}
            {unused.map((c) => <button key={c} className="chip" onClick={() => ledger.setBudget(c, 100, month)}>+ {c}</button>)}
          </p>
        )}
      </section>
    </>
  );
}
