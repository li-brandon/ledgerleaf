import { useState } from 'react';
import { MockProvider } from '../lib/sync';
import type { Ledger } from '../store';

export default function EmptyState({ ledger }: { ledger: Ledger }) {
  const [error, setError] = useState('');
  const loadDemo = () => ledger.runSync(new MockProvider()).catch((e: Error) => setError(e.message));
  return (
    <div className="card empty">
      <svg className="empty-art" viewBox="0 0 64 64" width="56" height="56" aria-hidden>
        <path d="M12 52C12 26 30 12 54 12c0 22-14 40-42 40z" fill="var(--color-accent-soft)" />
        <path d="M12 52l26-26" stroke="var(--color-accent)" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <h2>Your ledger is blank</h2>
      <p className="muted">Load the demo bank to explore, or import a CSV export from your bank. Nothing leaves this browser.</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="row">
        <button onClick={loadDemo}>Load demo data</button>
        <a className="btn ghost" href="#/connections">Import CSV</a>
      </div>
    </div>
  );
}
