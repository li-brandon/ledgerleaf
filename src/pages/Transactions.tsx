import { useMemo, useState } from 'react';
import type { PageProps } from '../App';
import { fmtDate, fmtMoney } from '../format';
import { transactionsHref } from '../lib/routes';
import EmptyState from './EmptyState';

/** The account filter lives in the URL (`#/transactions?account=…`) so it survives a reload. */
const setAcct = (id: string) => location.replace(transactionsHref(id));

export default function Transactions({ ledger, params }: PageProps) {
  const { accounts, categories: known, transactions } = ledger.state;
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const acct = params.account ?? '';
  const account = accounts.find((a) => a.id === acct);
  // Hidden accounts stay out of the list unless they are the one being viewed.
  const listed = accounts.filter((a) => !a.hidden || a.id === acct);
  const categories = useMemo(
    () => [...new Set([...known.map((c) => c.name), ...transactions.map((t) => t.category)])].sort(),
    [known, transactions],
  );
  const accountName = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const needle = q.trim().toLowerCase();
  const rows = transactions.filter((t) =>
    (!cat || t.category === cat) && (!acct || t.accountId === acct) &&
    (!needle || t.description.toLowerCase().includes(needle) || t.category.toLowerCase().includes(needle)));
  const net = rows.reduce((s, t) => s + t.amount, 0);

  return (
    <>
      <h1>Transactions {account && <small>{account.name}</small>}</h1>
      {acct && !account && (
        <p className="notice error" role="status">
          That account no longer exists. <a href={transactionsHref()}>Show all transactions</a>
        </p>
      )}
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
              {listed.map((a) => <option key={a.id} value={a.id}>{a.name}{a.hidden ? ' (hidden)' : ''}</option>)}
            </select>
          </div>
          <p className="muted">{rows.length} entries · net {fmtMoney(net)}</p>
          <div className="table-scroll">
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
          </div>
        </section>
      )}
    </>
  );
}
