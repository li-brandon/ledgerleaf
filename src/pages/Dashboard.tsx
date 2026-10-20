import { BarChart, Meter } from '../components/charts';
import { fmtDate, fmtMoney, fmtMonth } from '../format';
import { budgetProgress, budgetTotals, currentMonth } from '../lib/budget';
import { accountBalance, monthRange, monthlySpend, netBalance } from '../lib/insights';
import type { Ledger } from '../store';
import EmptyState from './EmptyState';

export default function Dashboard({ ledger }: { ledger: Ledger }) {
  const { accounts, transactions, budgets } = ledger.state;
  if (!transactions.length) return <><h1>Overview</h1><EmptyState ledger={ledger} /></>;
  const month = currentMonth();
  const totals = budgetTotals(budgetProgress(budgets, transactions, month));
  const ratio = totals.budgeted ? totals.spent / totals.budgeted : 0;
  const months = monthlySpend(transactions, monthRange(month, 4));
  const accountName = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  return (
    <>
      <h1>Overview <small>{fmtMonth(month, 'long')}</small></h1>
      <div className="grid two">
        <section className="card">
          <h3>Net balance</h3>
          <p className="hero">{fmtMoney(netBalance(accounts, transactions))}</p>
          <ul className="ruled">
            {accounts.map((a) => (
              <li key={a.id}><span>{a.name} <em>{a.type}</em></span><b className={accountBalance(a, transactions) < 0 ? 'neg' : ''}>{fmtMoney(accountBalance(a, transactions))}</b></li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h3>Spent this month</h3>
          <p className="hero">{fmtMoney(totals.spent)} <small>of {fmtMoney(totals.budgeted)}</small></p>
          <Meter ratio={ratio} status={ratio > 1 ? 'over' : ratio >= 0.85 ? 'near' : 'ok'} />
          <p className="muted">
            {totals.spent > totals.budgeted
              ? `${fmtMoney(totals.spent - totals.budgeted)} over budget`
              : `${fmtMoney(totals.budgeted - totals.spent)} left to spend`}
          </p>
        </section>
      </div>
      <div className="grid two">
        <section className="card">
          <h3>Monthly spending</h3>
          <BarChart label="Spending per month" highlightLast bars={months.map((m) => ({ label: fmtMonth(m.month), value: m.total }))} />
        </section>
        <section className="card">
          <h3>Recent activity <a href="#/ledger" className="more">All →</a></h3>
          <ul className="ruled">
            {transactions.slice(0, 7).map((t) => (
              <li key={t.id}>
                <span>{t.description}<em>{fmtDate(t.date)} · {accountName[t.accountId]}</em></span>
                <b className={t.amount > 0 ? 'pos' : ''}>{fmtMoney(t.amount)}</b>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
