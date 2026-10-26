import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  downloadFile, persistenceStatus, rememberedTxFilters, requestPersistence, type StoragePersistence,
} from '../browser';
import { demoCounts } from '../db';
import {
  STORE_LABELS, backupFilename, csvFilename, makeBackup, parseBackup, type Backup, type RestoreMode, type StoreCounts,
} from '../db/backup';
import { MODEL_NAMES } from '../db/repository';
import { displayCurrency, fmtDate, fmtMoney } from '../format';
import { budgetPeriod, budgetsForMonth, currentBudgetMonth } from '../lib/budget';
import { transactionsToCsv } from '../lib/csvExport';
import { routeHref } from '../lib/routes';
import {
  CURRENCIES, MAX_START_DAY, THEMES, THEME_LABEL, currencySymbol, ordinal, settingsOf,
} from '../lib/settings';
import { EMPTY_FILTERS, activeFilterCount, applyFilters, filtersHref, hasFilters } from '../lib/txFilters';
import type { Ledger } from '../store';


const PERSISTENCE_TEXT: Record<StoragePersistence, string> = {
  persistent: "Persistent — the browser won't clear this data under storage pressure.",
  'best-effort': 'Best effort — the browser may clear this data when space runs low.',
  unsupported: 'Not supported by this browser.',
};

const START_DAYS = Array.from({ length: MAX_START_DAY }, (_, i) => i + 1);

const countsText = (c: StoreCounts) =>
  MODEL_NAMES.filter((n) => c[n]).map((n) => `${c[n].toLocaleString('en-US')} ${STORE_LABELS[n].toLowerCase()}`).join(', ') || 'nothing new';

/** A backup file that passed validation, waiting for the user to confirm how to restore it. */
interface Pending {
  name: string;
  backup: Backup;
  counts: StoreCounts;
}

export default function Settings({ ledger }: { ledger: Ledger }) {
  const [msg, setMsg] = useState<{ text: string; error?: boolean }>();
  const [busy, setBusy] = useState(false);
  const [csvScope, setCsvScope] = useState<'all' | 'filtered'>('all');
  const [pending, setPending] = useState<Pending>();
  const [mode, setMode] = useState<RestoreMode>('merge');
  const [resetText, setResetText] = useState('');
  const [storage, setStorage] = useState<StoragePersistence>();
  const [storageDenied, setStorageDenied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void persistenceStatus().then((s) => mounted.current && setStorage(s));
    return () => { mounted.current = false; };
  }, []);

  const { accounts, transactions, budgets, categories, rules, lastSync } = ledger.state;
  const settings = settingsOf(ledger.state);
  const demo = demoCounts(ledger.state);
  const hasDemo = demo.accounts + demo.transactions + demo.balanceSnapshots > 0;
  const budgetMonth = currentBudgetMonth(settings.monthStartDay);
  const period = budgetPeriod(budgetMonth, settings.monthStartDay);
  const txFilters = rememberedTxFilters();
  const filtered = hasFilters(txFilters) ? applyFilters(transactions, txFilters) : undefined;
  const scope = filtered ? csvScope : 'all';

  const say = (text: string, error = false) => setMsg({ text, error });
  const fail = (e: unknown) => say(e instanceof Error ? e.message : String(e), true);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const clearDemo = () => {
    if (!confirm('Remove the demo accounts and transactions? Imported data is kept.')) return;
    void run(async () => {
      const removed = await ledger.clearDemo();
      say(`Removed ${removed.transactions} demo transactions and ${removed.accounts} demo accounts.`);
    });
  };

  const exportCsv = () => {
    const rows = scope === 'filtered' && filtered ? filtered : applyFilters(transactions, EMPTY_FILTERS);
    downloadFile(csvFilename(), transactionsToCsv(rows, accounts, displayCurrency()), 'text/csv');
    say(`Exported ${rows.length.toLocaleString('en-US')} transactions to CSV.`);
  };

  const exportJson = () => {
    downloadFile(backupFilename(), `${JSON.stringify(makeBackup(ledger.state), null, 2)}\n`, 'application/json');
    say('Backup downloaded. Keep it somewhere safe; it holds everything in this browser.');
  };

  async function pickBackup(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPending(undefined);
    const parsed = parseBackup(await file.text());
    if (!parsed.ok) return say(`${file.name}: ${parsed.error} Nothing was changed.`, true);
    setMsg(undefined);
    setMode(transactions.length ? 'merge' : 'replace');
    setPending({ name: file.name, backup: parsed.backup, counts: parsed.counts });
  }

  const restore = () => pending && run(async () => {
    const added = await ledger.importBackup(pending.backup, mode);
    setPending(undefined);
    say(mode === 'replace' ? `Restored ${pending.name}: ${countsText(added)}.` : `Merged ${pending.name}: added ${countsText(added)}.`);
  });

  async function persistStorage() {
    const s = await requestPersistence();
    if (!mounted.current) return;
    setStorage(s);
    setStorageDenied(s !== 'persistent');
  }

  const reset = () => run(async () => {
    await ledger.reset();
    setResetText('');
    setPending(undefined);
    say('All local data erased. Settings are back to their defaults.');
  });

  return (
    <>
      <h1>Settings</h1>
      {msg && <p className={`notice${msg.error ? ' error' : ''}`} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}

      <section className="card">
        <h3>Preferences</h3>
        <div className="settings-form">
          <label className="field">Currency
            <select value={settings.currency} onChange={(e) => ledger.setSettings({ currency: e.target.value })}>
              {!(CURRENCIES as readonly string[]).includes(settings.currency) && <option value={settings.currency}>{settings.currency}</option>}
              {CURRENCIES.map((c) => <option key={c} value={c}>{c} ({currencySymbol(c)})</option>)}
            </select>
            <em>Every amount is shown as {fmtMoney(1234.5)}. Amounts are not converted.</em>
          </label>
          <label className="field">Budget month starts on the
            <select value={settings.monthStartDay} onChange={(e) => ledger.setSettings({ monthStartDay: Number(e.target.value) })}>
              {START_DAYS.map((d) => <option key={d} value={d}>{ordinal(d)}{d === 1 ? ' (calendar month)' : ''}</option>)}
            </select>
            <em>This budget month runs {fmtDate(period.from)} – {fmtDate(period.to)}.</em>
          </label>
          <div className="field" role="radiogroup" aria-label="Theme">
            <span>Theme</span>
            <div className="row settings-themes">
              {THEMES.map((t) => (
                <label key={t} className={`chip${settings.theme === t ? ' on' : ''}`}>
                  <input type="radio" name="theme" className="sr-only" value={t} checked={settings.theme === t}
                    onChange={() => ledger.setSettings({ theme: t })} />
                  {THEME_LABEL[t]}
                </label>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        <h3>Your data</h3>
        <ul className="ruled">
          <li><span>Accounts</span><b>{accounts.length}</b></li>
          <li><span>Transactions</span><b>{transactions.length}</b></li>
          <li><span>Budgeted categories</span><b>{Object.keys(budgetsForMonth(budgets, categories, budgetMonth)).length}</b></li>
          <li><span>Last sync</span><b>{lastSync ? new Date(lastSync).toLocaleString() : 'Never'}</b></li>
        </ul>
        <p className="muted">Everything lives in this browser's IndexedDB. Exports and restores happen on this device; nothing is sent to a server.</p>

        <div className="settings-block">
          <h4>Storage</h4>
          {storage && <p>{PERSISTENCE_TEXT[storage]}</p>}
          {storage === 'best-effort' && (
            <>
              <button className="btn ghost" onClick={() => void persistStorage()}>Request persistent storage</button>
              {storageDenied && <p className="muted" role="status">The browser declined; it may allow it later, e.g. once you use the app more.</p>}
            </>
          )}
        </div>

        <div className="settings-block">
          <h4>Export transactions (CSV)</h4>
          <div className="settings-choice" role="radiogroup" aria-label="Transactions to export">
            <label className="check">
              <input type="radio" name="csv-scope" checked={scope === 'all'} onChange={() => setCsvScope('all')} />
              All transactions ({transactions.length.toLocaleString('en-US')})
            </label>
            <label className="check">
              <input type="radio" name="csv-scope" checked={scope === 'filtered'} disabled={!filtered} onChange={() => setCsvScope('filtered')} />
              {filtered
                ? <span>Matching the current <a href={filtersHref(txFilters)}>Transactions filters</a> ({activeFilterCount(txFilters)} set, {filtered.length.toLocaleString('en-US')} rows)</span>
                : <span>Matching the current Transactions filters <em className="muted">(none set)</em></span>}
            </label>
          </div>
          <button className="btn ghost" onClick={exportCsv} disabled={!(scope === 'filtered' ? filtered?.length : transactions.length)}>Export CSV</button>
        </div>

        <div className="settings-block">
          <h4>Backup &amp; restore (JSON)</h4>
          <p className="muted">A backup holds every account, transaction, category, rule, budget, balance and setting.</p>
          <div className="row">
            <button className="btn ghost" onClick={exportJson}>Download backup</button>
            <button className="btn ghost" onClick={() => fileRef.current?.click()} disabled={busy}>Restore from backup…</button>
            <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void pickBackup(e)}
              aria-label="Backup file to restore" data-testid="backup-file" />
            <a className="btn ghost" href={routeHref('connections')}>Import bank CSV</a>
          </div>
          {pending && (
            <div className="settings-confirm" role="group" aria-label="Confirm restore">
              <p>
                <strong>{pending.name}</strong>
                {pending.backup.exportedAt && <> · made {new Date(pending.backup.exportedAt).toLocaleString()}</>}
                <br /><span className="muted">Contains {countsText(pending.counts)}.</span>
              </p>
              <div className="settings-choice" role="radiogroup" aria-label="How to restore">
                <label className="check">
                  <input type="radio" name="restore-mode" checked={mode === 'merge'} onChange={() => setMode('merge')} />
                  <span><b>Merge</b> — keep what is here and add records from the backup that are not (matched by id).</span>
                </label>
                <label className="check">
                  <input type="radio" name="restore-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
                  <span><b>Replace</b> — erase everything here, settings included, and use the backup instead.</span>
                </label>
              </div>
              <div className="row">
                <button className={mode === 'replace' ? 'danger' : undefined} onClick={() => void restore()} disabled={busy}>
                  {mode === 'replace' ? 'Replace my data' : 'Merge backup'}
                </button>
                <button className="btn ghost" onClick={() => setPending(undefined)} disabled={busy}>Cancel</button>
              </div>
            </div>
          )}
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
          <button className="btn ghost" onClick={clearDemo} disabled={busy}>
            {busy ? 'Working…' : 'Clear demo data'}
          </button>
        </section>
      )}
      <section className="card">
        <h3>Danger zone</h3>
        <p className="muted">
          Reset erases every account, transaction, budget, rule and setting in this browser. It cannot be undone;
          download a backup first if you might want it back.
        </p>
        <div className="row settings-reset">
          <label className="field">Type RESET to confirm
            <input value={resetText} onChange={(e) => setResetText(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <button className="danger" onClick={() => void reset()} disabled={busy || resetText !== 'RESET'}>Reset all data</button>
        </div>
      </section>
    </>
  );
}
