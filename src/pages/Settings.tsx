import { useState } from 'react';
import { budgetsForMonth, currentMonth } from '../lib/budget';
import type { Ledger } from '../store';

export default function Settings({ ledger }: { ledger: Ledger }) {
  const [msg, setMsg] = useState('');
  const { accounts, transactions, budgets, categories, lastSync } = ledger.state;

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
        <p className="muted">Everything lives in this browser's localStorage. Nothing is sent to a server.</p>
        <div className="row">
          <button className="btn ghost" onClick={exportJson} disabled={!transactions.length}>Export JSON backup</button>
          <a className="btn ghost" href="#/connections">Import data</a>
        </div>
      </section>
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
