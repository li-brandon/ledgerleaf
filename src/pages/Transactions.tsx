import { useMemo, useState } from 'react';
import { fmtDate, fmtMoney } from '../format';
import { CATEGORIES } from '../lib/types';
import type { Ledger } from '../store';
import EmptyState from './EmptyState';

export default function Transactions({ ledger }: { ledger: Ledger }) {
  const { accounts, transactions } = ledger.state;
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [acct, setAcct] = useState('');
  const categories = useMemo(
    () => [...new Set([...CATEGORIES, ...transactions.map((t) => t.category)])].sort(),
    [transactions],
  );
  const accountName = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const needle = q.trim().toLowerCase();
  const rows = transactions.filter((t) =>
    (!cat || t.category === cat) && (!acct || t.accountId === acct) &&
    (!needle || t.description.toLowerCase().includes(needle) || t.category.toLowerCase().includes(needle)));
  const net = rows.reduce((s, t) => s + t.amount, 0);

  return (
    <>
      <h1>Ledger</h1>
      {!transactions.length ? <EmptyState ledger={ledger} /> : (
        <section className="card">
          <div className="filters">
            <input type="search" placeholder="Search description or category…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
              <option value="">All categories</option>
              {categories.map((c) => <option key={c}>{c}</option>)}
            </select>
            <select value={acct} onChange={(e) => setAcct(e.target.value)} aria-label="Account">
              <option value="">All accounts</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <p className="muted">{rows.length} entries · net {fmtMoney(net)}</p>
          <table className="tx">
            <thead><tr><th>Date</th><th>Description</th><th>Account</th><th>Category</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>{fmtDate(t.date)}</td>
                  <td>{t.description}</td>
                  <td className="muted">{accountName[t.accountId] ?? '—'}</td>
                  <td>
                    <select className="inline" value={t.category} onChange={(e) => ledger.setCategory(t.id, e.target.value)} aria-label={`Category for ${t.description}`}>
                      {categories.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </td>
                  <td className={`num ${t.amount > 0 ? 'pos' : ''}`}>{fmtMoney(t.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
