import { useState, type FormEvent } from 'react';
import type { PageProps } from '../App';
import { LineChart } from '../components/charts';
import { fmtMoney, fmtMonth } from '../format';
import { groupAccounts, netWorth, type AccountRow } from '../lib/accounts';
import { netWorthByMonth } from '../lib/insights';
import { transactionsHref } from '../lib/routes';
import type { Ledger } from '../store';
import EmptyState from './EmptyState';

export default function Accounts({ ledger }: PageProps) {
  const { accounts, transactions, balanceSnapshots } = ledger.state;
  const [showHidden, setShowHidden] = useState(false);
  if (!accounts.length) return <><h1>Accounts</h1><EmptyState ledger={ledger} /></>;

  const hiddenCount = accounts.filter((a) => a.hidden).length;
  const groups = groupAccounts(accounts, transactions, { showHidden });
  const worth = netWorth(accounts, transactions);
  const trend = netWorthByMonth(accounts, balanceSnapshots).slice(-12);
  const count: Record<string, number> = {};
  for (const t of transactions) count[t.accountId] = (count[t.accountId] ?? 0) + 1;

  return (
    <>
      <h1>Accounts <small>{accounts.length - hiddenCount} shown{hiddenCount ? ` · ${hiddenCount} hidden` : ''}</small></h1>
      <section className="card">
        <h3>Net worth</h3>
        <p className={`hero ${worth.netWorth < 0 ? 'neg' : ''}`}>{fmtMoney(worth.netWorth)}</p>
        <dl className="stats">
          <div><dt>Assets</dt><dd>{fmtMoney(worth.assets)}</dd></div>
          <div><dt>Liabilities</dt><dd>{fmtMoney(worth.liabilities)}</dd></div>
        </dl>
        {trend.length > 1 && (
          <LineChart label="Net worth at the end of each month" points={trend.map((p) => ({ label: fmtMonth(p.month), value: p.total }))} />
        )}
      </section>
      {hiddenCount > 0 && (
        <div className="row toolbar">
          <button className={`chip ${showHidden ? 'on' : ''}`} aria-pressed={showHidden} onClick={() => setShowHidden(!showHidden)}>
            Show hidden ({hiddenCount})
          </button>
        </div>
      )}
      {groups.length ? (
        <div className="grid two">
          {groups.map((g) => (
            <section key={g.id} className="card" aria-label={g.label}>
              <h3>
                {g.label}
                <span className={g.subtotal < 0 ? 'neg' : ''}>{fmtMoney(g.subtotal)}</span>
              </h3>
              <ul className="ruled accounts">
                {g.accounts.map((row) => <AccountItem key={row.account.id} row={row} count={count[row.account.id] ?? 0} ledger={ledger} />)}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <p className="muted">Every account is hidden. Use “Show hidden” to bring one back.</p>
      )}
    </>
  );
}

function AccountItem({ row: { account: a, balance }, count, ledger }: { row: AccountRow; count: number; ledger: Ledger }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(a.name);

  function save(e: FormEvent) {
    e.preventDefault();
    ledger.renameAccount(a.id, name);
    setEditing(false);
  }

  function startEditing() {
    setName(a.name);
    setEditing(true);
  }

  return (
    <li className={a.hidden ? 'is-hidden' : undefined}>
      {editing ? (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape from the inputs inside cancels the form; the form itself is not a control
        <form className="rename" onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the inline rename form opens on Rename; focus moves to the field the user asked to edit */}
          <input aria-label={`New name for ${a.name}`} value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          <button type="submit" disabled={!name.trim()}>Save</button>
          <button type="button" className="link" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : (
        <span>
          <a href={transactionsHref(a.id)} className="acct-name">{a.name}</a>
          {a.hidden && <span className="tag"> Hidden</span>}
          <em>
            {[a.institution, `${count} transaction${count === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
            {' · '}
            <button type="button" className="link" onClick={startEditing} aria-label={`Rename ${a.name}`}>Rename</button>
            {' · '}
            <button type="button" className="link" onClick={() => ledger.setAccountHidden(a.id, !a.hidden)}
              aria-label={`${a.hidden ? 'Unhide' : 'Hide'} ${a.name}`}>
              {a.hidden ? 'Unhide' : 'Hide'}
            </button>
          </em>
        </span>
      )}
      <b className={balance < 0 ? 'neg' : ''}>{fmtMoney(balance)}</b>
    </li>
  );
}
