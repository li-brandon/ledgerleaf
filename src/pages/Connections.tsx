import { useState } from 'react';
import { CSV_PROVIDER, providers, type ProviderEntry, type ProviderKind, type SyncProvider } from '../lib/sync';
import CsvImport from './CsvImport';
import type { Ledger } from '../store';

const KIND_LABEL: Record<ProviderKind, string> = { demo: 'Sample data', file: 'File import', remote: 'Online' };

type Status = { ok: boolean; text: string };

export default function Connections({ ledger }: { ledger: Ledger }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [wide, setWide] = useState(false);
  const { lastSync, syncs, accounts, transactions } = ledger.state;

  async function run(p: SyncProvider, extra = () => '') {
    setBusy(p.id);
    try {
      const r = await ledger.runSync(p);
      const updated = r.updated ? `, ${r.updated} updated` : '';
      setStatus({ ok: true, text: `${p.name}: ${r.added} new of ${r.received} received${updated}${extra()}.` });
      setErrors(({ [p.id]: _, ...rest }) => rest);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setStatus({ ok: false, text });
      setErrors((errs) => ({ ...errs, [p.id]: text }));
    } finally {
      setBusy(null);
    }
  }

  function reportImport(error: string | null) {
    setStatus(error ? { ok: false, text: error } : null);
    setErrors(({ [CSV_PROVIDER.id]: _, ...rest }) => (error ? { ...rest, [CSV_PROVIDER.id]: error } : rest));
  }

  async function onFile(entry: ProviderEntry, file?: File) {
    if (!file || entry.kind !== 'file') return;
    const p = entry.create(await file.text());
    await run(p, () => (p.skipped ? `, ${p.skipped} unreadable rows skipped` : ''));
  }

  return (
    <>
      <h1>Connections</h1>
      {status && <p className={status.ok ? 'notice' : 'notice error'} role={status.ok ? 'status' : 'alert'}>{status.text}</p>}
      <div className="grid two">
        {providers.list().map((entry) => {
          const synced = syncs?.[entry.id]?.lastSync;
          return (
            <section className={entry.id === CSV_PROVIDER.id && wide ? 'card span-all' : 'card'} key={entry.id}>
              <h3>{entry.name}<span>{KIND_LABEL[entry.kind]}</span></h3>
              {entry.description && <p className="muted">{entry.description}</p>}
              <p className="muted">{synced ? `Last synced ${new Date(synced).toLocaleString()}` : 'Never synced'}</p>
              {errors[entry.id] && <p className="notice error" role="alert">{errors[entry.id]}</p>}
              {entry.id === CSV_PROVIDER.id ? (
                <CsvImport ledger={ledger} disabled={busy !== null} onResult={reportImport} onOpen={setWide}
                  onBusy={(b) => setBusy(b ? entry.id : null)} />
              ) : entry.kind === 'file' ? (
                <>
                  <label className="btn" aria-disabled={busy !== null}>
                    Choose file
                    <input type="file" accept={entry.accept} hidden disabled={busy !== null}
                      onChange={(e) => { onFile(entry, e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                  {entry.sample && <pre className="sample">{entry.sample}</pre>}
                </>
              ) : (
                <button disabled={busy !== null || entry.requiresAuth} onClick={() => run(entry.create())}>
                  {entry.requiresAuth ? 'Sign-in not available' : busy === entry.id ? 'Syncing…' : 'Sync now'}
                </button>
              )}
            </section>
          );
        })}
      </div>
      <section className="card">
        <h3>Local data</h3>
        <p className="muted">
          {accounts.length} accounts, {transactions.length} transactions
          {lastSync && ` · last sync ${new Date(lastSync).toLocaleString()}`}. Everything lives in this browser's IndexedDB.
        </p>
        <a className="btn ghost" href="#/settings">Manage in Settings</a>
      </section>
    </>
  );
}
