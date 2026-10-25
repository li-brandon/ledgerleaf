import { useState } from 'react';
import { IMPORT_CSV_HREF } from '../lib/commands';
import { MockProvider } from '../lib/sync';
import type { Ledger } from '../store';

export default function EmptyState({ ledger }: { ledger: Ledger }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const loadDemo = () => {
    setBusy(true);
    setError('');
    ledger.runSync(new MockProvider(new Date())).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <div className="card empty">
      <svg className="empty-art" viewBox="0 0 64 64" width="56" height="56" aria-hidden>
        <path d="M12 52C12 26 30 12 54 12c0 22-14 40-42 40z" fill="var(--color-accent-soft)" />
        <path d="M12 52l26-26" stroke="var(--color-accent)" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <h2>Your ledger is blank</h2>
      <p className="muted">Load a year of sample accounts to explore (you can clear them in Settings), or import a CSV export from your bank. Nothing leaves this browser.</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="row">
        <button onClick={loadDemo} disabled={busy}>{busy ? 'Loading demo data…' : 'Load demo data'}</button>
        <a className="btn ghost" href={IMPORT_CSV_HREF}>Import CSV</a>
      </div>
    </div>
  );
}
