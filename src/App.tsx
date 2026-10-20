import { useEffect, useRef, useState, type ComponentType } from 'react';
import { NavIcon } from './components/icons';
import {
  ROUTES, canonicalHash, parseRoute, routeHref, routeLabel, type Route, type RouteId, type RouteParams,
} from './lib/routes';
import { useLedger, type Ledger } from './store';
import Dashboard from './pages/Dashboard';
import Accounts from './pages/Accounts';
import Transactions from './pages/Transactions';
import Budgets from './pages/Budgets';
import Insights from './pages/Insights';
import Connections from './pages/Connections';
import Settings from './pages/Settings';

/** Every page gets the ledger and the route's query parameters. */
export interface PageProps {
  ledger: Ledger;
  params: RouteParams;
}

const PAGES: Record<RouteId, ComponentType<PageProps>> = {
  overview: Dashboard,
  accounts: Accounts,
  transactions: Transactions,
  budgets: Budgets,
  insights: Insights,
  connections: Connections,
  settings: Settings,
};

/** Read the current route, rewriting the address bar if the hash is unknown or non-canonical. */
function currentRoute(): Route {
  const fix = canonicalHash(location.hash);
  if (fix) history.replaceState(null, '', fix);
  return parseRoute(location.hash);
}

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
  const [{ id: route, params }, setRoute] = useState<Route>(currentRoute);
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);

  useEffect(() => {
    const on = () => setRoute(currentRoute());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    document.title = `${routeLabel(route)} · Ledgerleaf`;
    if (first.current) { first.current = false; return; }
    scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
  }, [route]);

  const Page = PAGES[route];
  return (
    <div className="shell">
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>Skip to content</a>
      <aside className="rail">
        <a className="brand" href={routeHref('overview')}><Logo /><span>Ledgerleaf</span></a>
        <nav className="nav" aria-label="Main">
          {ROUTES.map(({ id, label }) => (
            <a key={id} href={routeHref(id)} aria-current={id === route ? 'page' : undefined}>
              <NavIcon id={id} />
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <p className="rail-foot">Stored only in this browser.</p>
      </aside>
      <main id="main" ref={mainRef} tabIndex={-1}>
        {ledger.error && <p className="notice" role="alert">{ledger.error}</p>}
        {ledger.loading ? <p className="muted" role="status">Loading your ledger…</p> : <Page ledger={ledger} params={params} />}
      </main>
    </div>
  );
}
