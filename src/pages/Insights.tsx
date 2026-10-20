import { useState } from 'react';
import { BarChart, Legend, LineChart, OTHER, chartCategory } from '../components/charts';
import { fmtMoney, fmtMonth } from '../format';
import { currentMonth } from '../lib/budget';
import { monthRange, monthlySpend, rankCategories, topMerchants } from '../lib/insights';
import type { Ledger } from '../store';
import EmptyState from './EmptyState';

const RANGES = [3, 4, 6, 12];

export default function Insights({ ledger }: { ledger: Ledger }) {
  const { transactions } = ledger.state;
  const [n, setN] = useState(4);
  if (!transactions.length) return <><h1>Insights</h1><EmptyState ledger={ledger} /></>;

  const months = monthRange(currentMonth(), n);
  const rows = monthlySpend(transactions, months);
  const folded = rows.map((r) => {
    const by: Record<string, number> = {};
    for (const [c, v] of Object.entries(r.byCategory)) by[chartCategory(c)] = (by[chartCategory(c)] ?? 0) + v;
    return { ...r, byCategory: by };
  });
  const keys = rankCategories(folded).sort((a, b) => (a === OTHER ? 1 : b === OTHER ? -1 : 0));
  const merchants = topMerchants(transactions, 8, months);
  const maxM = merchants[0]?.total ?? 1;

  return (
    <>
      <h1>Insights</h1>
      <div className="filters">
        {RANGES.map((r) => (
          <button key={r} className={`chip ${r === n ? 'on' : ''}`} onClick={() => setN(r)}>{r} months</button>
        ))}
      </div>
      <section className="card">
        <h3>Spending by category</h3>
        <Legend keys={keys} />
        <BarChart W={940} label="Monthly spend by category" bars={folded.map((r) => ({
          label: fmtMonth(r.month), value: r.total,
          segments: keys.map((k) => ({ key: k, value: r.byCategory[k] ?? 0 })),
        }))} />
        <details>
          <summary>Table view</summary>
          <table className="tx">
            <thead><tr><th>Category</th>{rows.map((r) => <th key={r.month} className="num">{fmtMonth(r.month)}</th>)}</tr></thead>
            <tbody>
              {rankCategories(rows).map((c) => (
                <tr key={c}><td>{c}</td>{rows.map((r) => <td key={r.month} className="num">{fmtMoney(r.byCategory[c] ?? 0)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>
      <div className="grid two">
        <section className="card">
          <h3>Total spend trend</h3>
          <LineChart label="Total spend per month" points={rows.map((r) => ({ label: fmtMonth(r.month), value: r.total }))} />
        </section>
        <section className="card">
          <h3>Top merchants</h3>
          <ul className="merchants">
            {merchants.map((m) => (
              <li key={m.name}>
                <div className="row between"><span>{m.name} <em>×{m.count}</em></span><b>{fmtMoney(m.total)}</b></div>
                <div className="hbar"><span style={{ width: `${(m.total / maxM) * 100}%` }} /></div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
