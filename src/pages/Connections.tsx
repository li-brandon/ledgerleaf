import { useState } from 'react';
import { CsvImportProvider, MockProvider, type SyncProvider } from '../lib/sync';
import type { Ledger } from '../store';

const SAMPLE = 'date,description,amount,category,account\n2026-10-03,Corner Bakery,-6.25,Dining,Everyday Card';

export default function Connections({ ledger }: { ledger: Ledger }) {
  const [msg, setMsg] = useState('');
  const { lastSync, accounts, transactions } = ledger.state;

  async function run(p: SyncProvider, extra = () => '') {
    try {
      const r = await ledger.runSync(p);
      setMsg(`${p.name}: ${r.added} new of ${r.received} received${extra()}.`);
    } catch (e) {
      setMsg(`${p.name} failed: ${(e as Error).message}`);
    }
  }

  async function onFile(file?: File) {
    if (!file) return;
    const p = new CsvImportProvider(await file.text());
    await run(p, () => (p.skipped ? `, ${p.skipped} unreadable rows skipped` : ''));
  }

  return (
    <>
      <h1>Connections</h1>
      {msg && <p className="notice" role="status">{msg}</p>}
      <div className="grid two">
        <section className="card">
          <h3>Demo Bank</h3>
          <p className="muted">Three sample accounts with about four months of activity. Safe to re-sync; nothing is duplicated.</p>
          <button onClick={() => run(new MockProvider())}>Sync demo bank</button>
        </section>
        <section className="card">
          <h3>CSV import</h3>
          <p className="muted">Columns: <code>date,description,amount,category,account</code>. Negative amounts are spending. Re-importing a file skips rows already present.</p>
          <label className="btn">Choose CSV file<input type="file" accept=".csv,text/csv" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
          <pre className="sample">{SAMPLE}</pre>
        </section>
      </div>
      <section className="card">
        <h3>Local data</h3>
        <p className="muted">
          {accounts.length} accounts, {transactions.length} transactions
          {lastSync && ` · last sync ${new Date(lastSync).toLocaleString()}`}. Everything lives in this browser's localStorage.
        </p>
        <button className="danger" onClick={() => confirm('Erase all Ledgerleaf data in this browser?') && (ledger.reset(), setMsg('All local data erased.'))}>
          Erase local data
        </button>
      </section>
    </>
  );
}
