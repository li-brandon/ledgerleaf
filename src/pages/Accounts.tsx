import { fmtMoney } from '../format';
import { accountBalance, netBalance } from '../lib/insights';
import type { AccountType } from '../lib/types';
import type { Ledger } from '../store';
import EmptyState from './EmptyState';

const GROUPS: { type: AccountType; label: string }[] = [
  { type: 'checking', label: 'Cash' },
  { type: 'savings', label: 'Savings' },
  { type: 'credit', label: 'Credit cards' },
];

export default function Accounts({ ledger }: { ledger: Ledger }) {
  const { accounts, transactions } = ledger.state;
  if (!accounts.length) return <><h1>Accounts</h1><EmptyState ledger={ledger} /></>;

  const count: Record<string, number> = {};
  for (const t of transactions) count[t.accountId] = (count[t.accountId] ?? 0) + 1;

  return (
    <>
      <h1>Accounts <small>{accounts.length} linked</small></h1>
      <section className="card">
        <h3>Net balance</h3>
        <p className="hero">{fmtMoney(netBalance(accounts, transactions))}</p>
      </section>
      <div className="grid two">
        {GROUPS.map(({ type, label }) => {
          const list = accounts.filter((a) => a.type === type);
          if (!list.length) return null;
          const total = list.reduce((s, a) => s + accountBalance(a, transactions), 0);
          return (
            <section key={type} className="card">
              <h3>{label} <span className={total < 0 ? 'neg' : ''}>{fmtMoney(total)}</span></h3>
              <ul className="ruled">
                {list.map((a) => {
                  const bal = accountBalance(a, transactions);
                  return (
                    <li key={a.id}>
                      <span>{a.name}<em>{count[a.id] ?? 0} transactions</em></span>
                      <b className={bal < 0 ? 'neg' : ''}>{fmtMoney(bal)}</b>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
