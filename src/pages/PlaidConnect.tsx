import { useCallback, useEffect, useState } from 'react';
import { PLAID_PROVIDER, PlaidProvider, type PlaidStatus } from '../lib/sync';
import { openPlaidLink } from '../plaidLink';

interface Props {
  busy: string | null;
  setBusy(id: string | null): void;
  /** Sync `p` into the ledger and report the outcome; never throws. */
  run(p: PlaidProvider): Promise<void>;
  onError(text: string): void;
  /** Builds the provider; tests pass one with a fake fetch. */
  createProvider?: () => PlaidProvider;
}

const newProvider = () => new PlaidProvider();

/** The Plaid card's controls: server status, connected banks, "Connect a bank" (Plaid Link) and "Sync now". */
export default function PlaidConnect({ busy, setBusy, run, onError, createProvider = newProvider }: Props) {
  const [status, setStatus] = useState<PlaidStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await createProvider().status());
      setProblem(null);
    } catch (e) {
      setStatus(null);
      setProblem(e instanceof Error ? e.message : String(e));
    }
  }, [createProvider]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function sync() {
    await run(createProvider());
    await refresh();
  }

  async function connect() {
    setBusy(PLAID_PROVIDER.id);
    try {
      const p = createProvider();
      const linked = await openPlaidLink(await p.linkToken());
      if (!linked) return;
      await p.exchange(linked.publicToken, linked.institution);
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      return;
    } finally {
      setBusy(null);
    }
    await sync();
  }

  const items = status?.items ?? [];
  const ready = !!status?.configured;
  return (
    <>
      {problem && <p className="muted">{problem}</p>}
      {status && !ready && (
        <p className="muted">The Plaid server is running without keys. Add PLAID_CLIENT_ID and PLAID_SECRET to .env and restart it.</p>
      )}
      {items.length > 0 && (
        <ul className="plaid-items">
          {items.map((i) => (
            <li key={i.item_id}>
              <strong>{i.institution?.name ?? 'Connected bank'}</strong>{' '}
              <span className="muted">{i.last_sync ? `synced ${new Date(i.last_sync).toLocaleString()}` : 'not synced yet'}</span>
              {i.last_error && <span className="neg"> · {i.last_error.message}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <button disabled={busy !== null || !ready} onClick={connect}>Connect a bank</button>
        <button className="btn ghost" disabled={busy !== null || !items.length} onClick={sync}>
          {busy === PLAID_PROVIDER.id ? 'Syncing…' : 'Sync now'}
        </button>
        {problem && <button className="btn ghost" disabled={busy !== null} onClick={refresh}>Retry</button>}
      </div>
    </>
  );
}
