import { useState } from 'react';
import { BarChart, LineChart, Meter, PaceChart } from '../components/charts';
import { fmtDate, fmtMoney, fmtMonth } from '../format';
import { currentMonth, monthBudget, monthTotals, spendExclusions } from '../lib/budget';
import { netWorth } from '../lib/accounts';
import { monthRange, monthlySpend } from '../lib/insights';
import {
  NET_WORTH_RANGES, UPCOMING_DAYS, cashFlow, daysInMonth, incomeCategories, netWorthTrend, reviewQueue, spendPace,
  trendChange, upcomingRecurring, type NetWorthRange,
} from '../lib/overview';
import { routeHref } from '../lib/routes';
import { EMPTY_FILTERS, filtersHref } from '../lib/txFilters';
import type { Ledger } from '../store';
import EmptyState from './EmptyState';

const signed = (n: number) => `${n > 0 ? '+' : ''}${fmtMoney(n)}`;

export default function Dashboard({ ledger }: { ledger: Ledger }) {
  const [range, setRange] = useState<NetWorthRange>(6);
  const { accounts, transactions, budgets, categories, balanceSnapshots } = ledger.state;
  if (!transactions.length && !accounts.length) return <><h1>Overview</h1><EmptyState ledger={ledger} /></>;

  const today = new Date();
  const month = currentMonth(today);
  const excluded = spendExclusions(categories);
  const totals = monthTotals(monthBudget({ budgets, categories, transactions }, month, today));
  const ratio = totals.available > 0 ? totals.spent / totals.available : totals.spent > 0 ? Infinity : 0;
  const pace = spendPace(transactions, month, excluded, today);
  const vsLast = pace.spent - pace.previousToDate;
  const flow = cashFlow(transactions, month, excluded, incomeCategories(categories));
  const flowMax = Math.max(1, flow.income, flow.spending);
  const trend = netWorthTrend(accounts, balanceSnapshots, month, range);
  const change = trendChange(trend);
  const worth = netWorth(accounts, transactions).netWorth;
  const upcoming = upcomingRecurring([], today);
  const review = reviewQueue(transactions);
  const months = monthlySpend(transactions, monthRange(month, 4), excluded);
  const accountName = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const monthHref = filtersHref({ ...EMPTY_FILTERS, from: `${month}-01`, to: `${month}-${daysInMonth(month)}` });
  const reviewHref = filtersHref({ ...EMPTY_FILTERS, reviewed: 'unreviewed' });

  return (
    <>
      <h1>Overview <small>{fmtMonth(month, 'long')}</small></h1>
      <div className="grid two">
        <section className="card" aria-label="Spent this month">
          <h3>Spent this month <a href={routeHref('budgets')} className="more">Budgets →</a></h3>
          <p className="hero">
            {fmtMoney(totals.spent)} {totals.available > 0 && <small>of {fmtMoney(totals.available)}</small>}
          </p>
          {totals.available > 0 && (
            <Meter ratio={ratio} status={ratio > 1 ? 'over' : ratio >= 0.85 ? 'near' : 'ok'}
              mark={totals.expected / totals.available} label="Spent of this month's budget" />
          )}
          <p className="muted">
            {totals.available <= 0
              ? 'No budget set for this month. '
              : totals.remaining < 0
                ? `${fmtMoney(-totals.remaining)} over budget. `
                : `${fmtMoney(totals.remaining)} left to spend. `}
            {pace.previousToDate > 0 || pace.spent > 0
              ? vsLast === 0
                ? 'Same as last month by today.'
                : `${fmtMoney(Math.abs(vsLast))} ${vsLast > 0 ? 'more' : 'less'} than last month by today.`
              : ''}
          </p>
          <ul className="legend">
            <li><i style={{ background: 'var(--leaf)' }} />{fmtMonth(month)}</li>
            <li><i style={{ background: 'var(--moss)' }} />{fmtMonth(monthRange(month, 2)[0])}</li>
          </ul>
          <PaceChart label="Cumulative spending by day, this month and last month" current={pace.current}
            previous={pace.previous} budget={totals.available > 0 ? totals.available : undefined} />
        </section>
        <section className="card" aria-label="Cash flow">
          <h3>Cash flow <a href={monthHref} className="more">Transactions →</a></h3>
          <p className={`hero ${flow.net < 0 ? 'neg' : ''}`}>{signed(flow.net)} <small>net this month</small></p>
          <dl className="stats">
            <div><dt>Income</dt><dd>{fmtMoney(flow.income)}</dd></div>
            <div><dt>Spending</dt><dd>{fmtMoney(flow.spending)}</dd></div>
          </dl>
          <ul className="merchants" aria-hidden>
            <li>
              <div className="row between muted"><span>Income</span></div>
              <div className="hbar"><span style={{ width: `${(flow.income / flowMax) * 100}%`, background: 'var(--leaf)' }} /></div>
            </li>
            <li>
              <div className="row between muted"><span>Spending</span></div>
              <div className="hbar"><span style={{ width: `${(flow.spending / flowMax) * 100}%` }} /></div>
            </li>
          </ul>
          <p className="muted">Transfers and other categories excluded from spending are left out.</p>
        </section>
      </div>
      <div className="grid two">
        <section className="card" aria-label="Net worth">
          <h3>Net worth <a href={routeHref('accounts')} className="more">Accounts →</a></h3>
          <p className={`hero ${worth < 0 ? 'neg' : ''}`}>
            {fmtMoney(worth)}
            {trend.length > 1 && <small> {signed(change)} over {range} months</small>}
          </p>
          <div className="row" role="group" aria-label="Net worth range">
            {NET_WORTH_RANGES.map((r) => (
              <button key={r} className={`chip ${r === range ? 'on' : ''}`} aria-pressed={r === range} onClick={() => setRange(r)}>
                {r} months
              </button>
            ))}
          </div>
          {trend.length > 1
            ? <LineChart label={`Net worth at the end of each of the last ${range} months`}
                points={trend.map((p) => ({ label: fmtMonth(p.month), value: p.total }))} />
            : <p className="muted">Net worth history appears once balances have been recorded over more than one month.</p>}
        </section>
        <section className="card" aria-label="To review">
          <h3>
            <span>To review {review.count > 0 && <>· {review.count.toLocaleString('en-US')}</>}</span>
            <a href={reviewHref} className="more">Review all →</a>
          </h3>
          {review.latest.length ? (
            <ul className="ruled">
              {review.latest.map((t) => (
                <li key={t.id}>
                  <span><a href={reviewHref}>{t.merchant ?? t.description}</a><em>{fmtDate(t.date)} · {accountName[t.accountId] ?? 'Unknown account'} · {t.category}</em></span>
                  <b className={t.amount > 0 ? 'pos' : ''}>{fmtMoney(t.amount)}</b>
                </li>
              ))}
            </ul>
          ) : <p className="muted">You're all caught up — nothing left to review.</p>}
        </section>
      </div>
      <div className="grid two">
        <section className="card" aria-label="Upcoming recurring">
          <h3>Upcoming · next {UPCOMING_DAYS} days <a href={routeHref('transactions')} className="more">Transactions →</a></h3>
          {upcoming.length ? (
            <ul className="ruled">
              {upcoming.map((c) => (
                <li key={`${c.name}:${c.nextDate}`}>
                  <span>{c.name}<em>{fmtDate(c.nextDate)}</em></span>
                  <b className={c.amount > 0 ? 'pos' : ''}>{fmtMoney(c.amount)}</b>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              Recurring bills and subscriptions will show here once they are detected from your transactions.
            </p>
          )}
        </section>
        <section className="card" aria-label="Monthly spending">
          <h3>Monthly spending <a href={routeHref('insights')} className="more">Insights →</a></h3>
          <BarChart label="Spending per month" highlightLast bars={months.map((m) => ({ label: fmtMonth(m.month), value: m.total }))} />
        </section>
      </div>
    </>
  );
}
