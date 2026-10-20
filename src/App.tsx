import { useEffect, useState } from 'react';
import { useLedger } from './store';
import Dashboard from './pages/Dashboard';
import Transactions from './pages/Transactions';
import Budgets from './pages/Budgets';
import Insights from './pages/Insights';
import Connections from './pages/Connections';

const PAGES = {
  overview: { label: 'Overview', C: Dashboard },
  ledger: { label: 'Ledger', C: Transactions },
  budgets: { label: 'Budgets', C: Budgets },
  insights: { label: 'Insights', C: Insights },
  connections: { label: 'Connections', C: Connections },
} as const;
type PageId = keyof typeof PAGES;

const fromHash = (): PageId => {
  const h = location.hash.slice(2);
  return h in PAGES ? (h as PageId) : 'overview';
};

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden>
      <path d="M6 26C6 12 16 5 27 5c0 11-7 21-21 21z" fill="var(--leaf)" />
      <path d="M6 26L20 12M11 21h6M14 18v-5" stroke="var(--paper)" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export default function App() {
  const ledger = useLedger();
  const [page, setPage] = useState<PageId>(fromHash);
  useEffect(() => {
    const on = () => setPage(fromHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const { C } = PAGES[page];
  return (
    <div className="shell">
      <aside className="rail">
        <a className="brand" href="#/overview"><Logo /><span>Ledgerleaf</span></a>
        <nav>
          {(Object.keys(PAGES) as PageId[]).map((id) => (
            <a key={id} href={`#/${id}`} className={id === page ? 'active' : ''}>{PAGES[id].label}</a>
          ))}
        </nav>
        <p className="rail-foot">Stored only in this browser.</p>
      </aside>
      <main>
        <C ledger={ledger} />
      </main>
    </div>
  );
}
