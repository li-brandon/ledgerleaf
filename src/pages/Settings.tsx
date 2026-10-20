import { useState } from 'react';
import { demoCounts } from '../db';
import { budgetsForMonth, currentMonth } from '../lib/budget';
import { routeHref } from '../lib/routes';
import type { Ledger } from '../store';

export default function Settings({ ledger }: { ledger: Ledger }) {
  const [msg, setMsg] = useState('');
  const [clearing, setClearing] = useState(false);
  const { accounts, transactions, budgets, categories, rules, lastSync } = ledger.state;
  const demo = demoCounts(ledger.state);
  const hasDemo = demo.accounts + demo.transactions + demo.balanceSnapshots > 0;

  async function clearDemo() {
    if (!confirm('Remove the demo accounts and transactions? Imported data is kept.')) return;
    setClearing(true);
    try {
      const removed = await ledger.clearDemo();
      setMsg(`Removed ${removed.transactions} demo transactions and ${removed.accounts} demo accounts.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(ledger.state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ledgerleaf-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <h1>Settings</h1>
      {msg && <p className="notice" role="status">{msg}</p>}
      <section className="card">
        <h3>Your data</h3>
        <ul className="ruled">
          <li><span>Accounts</span><b>{accounts.length}</b></li>
          <li><span>Transactions</span><b>{transactions.length}</b></li>
          <li><span>Budgeted categories</span><b>{Object.keys(budgetsForMonth(budgets, categories, currentMonth())).length}</b></li>
          <li><span>Last sync</span><b>{lastSync ? new Date(lastSync).toLocaleString() : 'Never'}</b></li>
        </ul>
        <p className="muted">Everything lives in this browser's IndexedDB. Nothing is sent to a server.</p>
        <div className="row">
          <button className="btn ghost" onClick={exportJson} disabled={!transactions.length}>Export JSON backup</button>
          <a className="btn ghost" href="#/connections">Import data</a>
        </div>
      </section>
      <section className="card">
        <h3>Categories &amp; rules</h3>
        <ul className="ruled">
          <li><span>Categories</span><b>{categories.length}</b></li>
          <li><span>Auto-categorize rules</span><b>{rules.length}</b></li>
        </ul>
        <p className="muted">
          Add, rename, recolor or delete categories, choose which ones count as spending, and set up rules that
          categorize and rename imported transactions.
        </p>
        <a className="btn ghost" href={routeHref('categories')}>Manage categories &amp; rules</a>
      </section>
      {hasDemo && (
        <section className="card">
          <h3>Demo data</h3>
          <p className="muted">
            {demo.accounts} sample accounts and {demo.transactions} sample transactions are loaded. Clearing them leaves
            anything you imported in place.
          </p>
          <button className="btn ghost" onClick={clearDemo} disabled={clearing}>
            {clearing ? 'Clearing…' : 'Clear demo data'}
          </button>
        </section>
      )}
      <section className="card">
        <h3>Danger zone</h3>
        <p className="muted">Erasing removes accounts, transactions and budgets from this browser. It cannot be undone.</p>
        <button className="danger" onClick={() => confirm('Erase all Ledgerleaf data in this browser?') && (ledger.reset(), setMsg('All local data erased.'))}>
          Erase local data
        </button>
      </section>
    </>
  );
}
