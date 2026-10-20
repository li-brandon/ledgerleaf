import { Meter } from '../components/charts';
import { fmtMoney, fmtMonth } from '../format';
import { budgetProgress, budgetTotals, currentMonth } from '../lib/budget';
import { CATEGORIES, NON_SPEND } from '../lib/types';
import type { Ledger } from '../store';

const STATUS_LABEL = { ok: 'On track', near: 'Close to limit', over: 'Over' };

export default function Budgets({ ledger }: { ledger: Ledger }) {
  const { budgets, transactions } = ledger.state;
  const month = currentMonth();
  const lines = budgetProgress(budgets, transactions, month);
  const listed = new Set(lines.map((l) => l.category));
  const unused = CATEGORIES.filter((c) => !NON_SPEND.has(c) && !listed.has(c));
  const totals = budgetTotals(lines);

  return (
    <>
      <h1>Budgets <small>{fmtMonth(month, 'long')}</small></h1>
      <section className="card">
        <p className="hero">{fmtMoney(totals.spent)} <small>spent of {fmtMoney(totals.budgeted)} planned</small></p>
        <div className="budgets">
          {lines.map((l) => (
            <div key={l.category} className="budget">
              <div className="row between">
                <strong>{l.category}</strong>
                <span className={`tag ${l.status}`}>{l.budget ? STATUS_LABEL[l.status] : 'No budget'}</span>
              </div>
              <Meter ratio={l.ratio} status={l.status} />
              <div className="row between muted">
                <span>{fmtMoney(l.spent)} spent · {l.remaining >= 0 ? `${fmtMoney(l.remaining)} left` : `${fmtMoney(-l.remaining)} over`}</span>
                <label className="limit">Limit $<input type="number" min={0} step={10} value={l.budget || ''} placeholder="0"
                  onChange={(e) => ledger.setBudget(l.category, Number(e.target.value))} /></label>
              </div>
            </div>
          ))}
        </div>
        {unused.length > 0 && (
          <p className="muted add">
            Add a budget:{' '}
            {unused.map((c) => <button key={c} className="chip" onClick={() => ledger.setBudget(c, 100)}>+ {c}</button>)}
          </p>
        )}
      </section>
    </>
  );
}
