import { useEffect, useState } from 'react';
import type { PageProps } from '../App';
import { DonutChart, LineChart, OTHER, categoryColor, chartCategory } from '../components/charts';
import { fmtMoney, fmtMonth } from '../format';
import { addMonths, currentMonth, isMonthKey, spendExclusions } from '../lib/budget';
import {
  AVERAGE_MONTHS, categoryShares, categoryTrend, monthOverMonth, monthRange, monthlySpend, spendHref, topMerchants,
  type MonthCompare,
} from '../lib/insights';
import { routeHref, type RouteParams } from '../lib/routes';
import EmptyState from './EmptyState';

/** How many months the category breakdown covers, ending at the chosen month. */
const RANGES = [1, 3, 6, 12];
const TRENDS = [6, 12];

interface View {
  month: string;
  range: number;
  trend: number;
  /** Category the trend follows; empty for all spending. */
  cat: string;
}

function parseView(params: RouteParams): View {
  const range = Number(params.range);
  const trend = Number(params.trend);
  return {
    month: isMonthKey(params.month) ? params.month : currentMonth(),
    range: RANGES.includes(range) ? range : 1,
    trend: TRENDS.includes(trend) ? trend : 6,
    cat: params.cat ?? '',
  };
}

/** The Insights hash for a view; defaults are left out. */
function viewHref(v: View): string {
  return routeHref('insights', {
    month: v.month === currentMonth() ? '' : v.month,
    range: v.range === 1 ? '' : String(v.range),
    trend: v.trend === 6 ? '' : String(v.trend),
    cat: v.cat,
  });
}

const periodLabel = (months: string[]) =>
  months.length === 1 ? fmtMonth(months[0], 'long') : `${fmtMonth(months[0])} – ${fmtMonth(months[months.length - 1], 'long')}`;

/** A % change; more spending reads as a warning, less as good. Text carries the direction, not just color. */
function Change({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="muted">new</span>;
  const n = Math.round(pct * 100);
  if (n === 0) return <span className="muted">±0%</span>;
  return <span className={n > 0 ? 'neg' : 'pos'}>{n > 0 ? '▲' : '▼'} {Math.abs(n)}%</span>;
}

const NARROW = '(max-width: 760px)';

/** Whether the viewport is phone-sized, so wide charts can use a narrower drawing with legible text. */
function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

export default function Insights({ ledger, params }: PageProps) {
  const { transactions, categories } = ledger.state;
  const narrow = useNarrow();
  if (!transactions.length) return <><h1>Insights</h1><EmptyState ledger={ledger} /></>;

  const view = parseView(params);
  const { month } = view;
  const now = currentMonth();
  const go = (patch: Partial<View>) => viewHref({ ...view, ...patch });
  const excluded = spendExclusions(categories);

  const months = monthRange(month, view.range);
  const rows = monthlySpend(transactions, months, excluded);
  const shares = categoryShares(rows);
  const spent = rows.reduce((s, r) => s + r.total, 0);
  const folded = new Map<string, number>();
  for (const s of shares) folded.set(chartCategory(s.category), (folded.get(chartCategory(s.category)) ?? 0) + s.total);
  // "Other" links to exactly the categories folded into it, so its transactions add up to the slice.
  const others = shares.map((s) => s.category).filter((c) => chartCategory(c) === OTHER);
  const slices = [...folded].map(([key, value]) => ({
    key, value, href: spendHref(months, { category: key === OTHER ? others : key }),
  })).sort((a, b) => (a.key === OTHER ? 1 : b.key === OTHER ? -1 : b.value - a.value));
  const maxShare = shares[0]?.total || 1;

  const trendRows = monthlySpend(transactions, monthRange(month, view.trend), excluded);
  const trendCats = categoryShares(trendRows).map((s) => s.category);
  const cat = trendCats.includes(view.cat) ? view.cat : '';
  const trend = categoryTrend(trendRows, cat || undefined).map((p) => ({
    label: fmtMonth(p.month), value: p.value, href: spendHref([p.month], { category: cat || undefined }),
  }));

  const mom = monthOverMonth(transactions, month, excluded);
  const prev = addMonths(month, -1);
  const merchants = topMerchants(transactions, 8, months, excluded);
  const maxM = merchants[0]?.total || 1;

  const momRow = (r: MonthCompare, total = false) => (
    <tr key={r.category} className={total ? 'mom-total' : undefined}>
      <td>
        {total ? <strong>Total</strong> : (
          <a className="ins-link" href={spendHref([month], { category: r.category })}>
            <i className="cat-swatch" style={{ background: categoryColor(chartCategory(r.category)) }} />{r.category}
          </a>
        )}
      </td>
      <td className="num" data-label={fmtMonth(month)}>{fmtMoney(r.current)}</td>
      <td className="num" data-label={fmtMonth(prev)}>{fmtMoney(r.previous)}</td>
      <td className="num" data-label={`${AVERAGE_MONTHS}-mo avg`}>{fmtMoney(r.average)}</td>
      <td className="num" data-label="vs last month"><Change pct={r.vsPrevious} /></td>
      <td className="num" data-label="vs average"><Change pct={r.vsAverage} /></td>
    </tr>
  );

  return (
    <>
      <h1>Insights</h1>
      <nav className="month-switch" aria-label="Month">
        <a className="btn ghost" href={go({ month: prev })} aria-label={`Previous month, ${fmtMonth(prev, 'long')}`}>‹</a>
        <strong aria-live="polite">{fmtMonth(month, 'long')}</strong>
        <a className="btn ghost" href={go({ month: addMonths(month, 1) })} aria-label={`Next month, ${fmtMonth(addMonths(month, 1), 'long')}`}>›</a>
        {month !== now && <a className="month-now" href={go({ month: now })}>This month</a>}
      </nav>

      <section className="card">
        <h3>Spending by category <span className="muted">{periodLabel(months)}</span></h3>
        <div className="filters" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <a key={r} className={`chip ${r === view.range ? 'on' : ''}`} aria-current={r === view.range ? 'true' : undefined}
              href={go({ range: r })}>{r === 1 ? 'Month' : `${r} months`}</a>
          ))}
        </div>
        <div className="ins-split">
          <DonutChart slices={slices} center={fmtMoney(spent)} label={`Spending by category, ${periodLabel(months)}`} />
          {shares.length === 0 ? <p className="muted">No spending in {periodLabel(months)}.</p> : (
            <ul className="ins-shares">
              {shares.map((s) => (
                <li key={s.category}>
                  <a className="ins-link" href={spendHref(months, { category: s.category })}>
                    <span className="row between">
                      <span className="ins-name"><i className="cat-swatch" style={{ background: categoryColor(chartCategory(s.category)) }} />{s.category}</span>
                      <span className="ins-fig"><em>{Math.round(s.share * 100)}%</em> <b>{fmtMoney(s.total)}</b></span>
                    </span>
                    <span className="hbar"><span style={{ width: `${(s.total / maxShare) * 100}%` }} /></span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="muted ins-note">Transfers, income and other categories marked not spending are left out. Select a category to see its transactions.</p>
      </section>

      <section className="card">
        <h3>Trend <span className="muted">{cat || 'All spending'}</span></h3>
        <div className="filters ins-trend-controls">
          <select aria-label="Category to follow" value={cat}
            onChange={(e) => { location.hash = go({ cat: e.target.value }); }}>
            <option value="">All spending</option>
            {trendCats.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <span role="group" aria-label="Trend length">
            {TRENDS.map((t) => (
              <a key={t} className={`chip ${t === view.trend ? 'on' : ''}`} aria-current={t === view.trend ? 'true' : undefined}
                href={go({ trend: t })}>{t} months</a>
            ))}
          </span>
        </div>
        <LineChart W={narrow ? 360 : 720} labelEvery={narrow && view.trend > 6 ? 2 : 1} points={trend} label={`${cat || 'Total'} spend per month, last ${view.trend} months`} />
        <details>
          <summary>Table view</summary>
          <div className="table-scroll">
            <table className="tx">
              <thead><tr><th>Month</th><th className="num">{cat || 'All spending'}</th></tr></thead>
              <tbody>{trend.map((p) => <tr key={p.label}><td><a href={p.href}>{p.label}</a></td><td className="num">{fmtMoney(p.value)}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      </section>

      <section className="card">
        <h3>Month over month <span className="muted">{fmtMonth(month, 'long')}</span></h3>
        {mom.rows.length === 0 ? <p className="muted">No spending in {fmtMonth(month, 'long')} or the {AVERAGE_MONTHS} months before.</p> : (
          <table className="tx mom-table">
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">{fmtMonth(month)}</th>
                <th className="num">{fmtMonth(prev)}</th>
                <th className="num" title={`Average of the ${AVERAGE_MONTHS} months before ${fmtMonth(month, 'long')}`}>{AVERAGE_MONTHS}-mo avg</th>
                <th className="num">vs last month</th>
                <th className="num">vs average</th>
              </tr>
            </thead>
            <tbody>{mom.rows.map((r) => momRow(r))}</tbody>
            <tfoot>{momRow(mom.total, true)}</tfoot>
          </table>
        )}
      </section>

      <section className="card">
        <h3>Top merchants <span className="muted">{periodLabel(months)}</span></h3>
        {merchants.length === 0 ? <p className="muted">No spending in {periodLabel(months)}.</p> : (
          <ul className="merchants">
            {merchants.map((m) => (
              <li key={m.name}>
                <a className="ins-link" href={spendHref(months, { merchant: m.name })}>
                  <span className="row between"><span className="ins-name">{m.name} <em>×{m.count}</em></span><b>{fmtMoney(m.total)}</b></span>
                  <span className="hbar"><span style={{ width: `${(m.total / maxM) * 100}%` }} /></span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
