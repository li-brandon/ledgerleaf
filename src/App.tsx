import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import CommandPalette from './components/CommandPalette';
import { NavIcon } from './components/icons';
import { setCurrency } from './format';
import { IS_MAC } from './lib/commands';
import {
  ROUTES, canonicalHash, navRoute, parseRoute, routeHref, routeLabel, type Route, type RouteId, type RouteParams,
} from './lib/routes';
import { settingsOf } from './lib/settings';
import { reviewCount } from './lib/txEdits';
import { useTheme } from './theme';
import { useLedger, type Ledger } from './store';
import Dashboard from './pages/Dashboard';
import Accounts from './pages/Accounts';
import Transactions from './pages/Transactions';
import Budgets from './pages/Budgets';
import Insights from './pages/Insights';
import Recurring from './pages/Recurring';
import Connections from './pages/Connections';
import Settings from './pages/Settings';
import Categories from './pages/Categories';

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
  recurring: Recurring,
  insights: Insights,
  connections: Connections,
  settings: Settings,
  categories: Categories,
};

/** The palette shortcut's modifier as the keyboard labels it. */
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl+';

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
  const toReview = useMemo(() => reviewCount(ledger.state.transactions), [ledger.state.transactions]);
  const settings = settingsOf(ledger.state);
  // Before anything renders an amount: every page formats through the shared formatter.
  setCurrency(settings.currency);
  useTheme(ledger.loading ? undefined : settings.theme);

  useEffect(() => {
    const on = () => setRoute(currentRoute());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    document.title = `${routeLabel(route)} · Ledgerleaf`;
    if (first.current) { first.current = false; return; }
    scrollTo(0, 0);
    // A page may have focused something of its own, e.g. the CSV import card.
    if (!mainRef.current?.contains(document.activeElement)) mainRef.current?.focus({ preventScroll: true });
  }, [route]);

  const Page = PAGES[route];
  return (
    <div className="shell">
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>Skip to content</a>
      <aside className="rail">
        <a className="brand" href={routeHref('overview')}><Logo /><span>Ledgerleaf</span></a>
        <nav className="nav" aria-label="Main">
          {ROUTES.map(({ id, label }) => (
            <a key={id} href={routeHref(id)} aria-current={id === route ? 'page' : id === navRoute(route) ? 'location' : undefined}>
              <NavIcon id={id} />
              <span>{label}</span>
              {id === 'transactions' && toReview > 0 && (
                <span className="nav-badge" title={`${toReview.toLocaleString('en-US')} to review`}>
                  <span aria-hidden>{toReview > 99 ? '99+' : toReview}</span>
                  <span className="sr-only">, {toReview.toLocaleString('en-US')} to review</span>
                </span>
              )}
            </a>
          ))}
        </nav>
        <p className="rail-foot"><kbd>{MOD_KEY}K</kbd> for commands<br />Stored only in this browser.</p>
      </aside>
      <main id="main" ref={mainRef} tabIndex={-1}>
        {ledger.error && <p className="notice" role="alert">{ledger.error}</p>}
        {ledger.loading ? <p className="muted" role="status">Loading your ledger…</p> : <Page ledger={ledger} params={params} />}
      </main>
      <CommandPalette onTheme={(theme) => ledger.setSettings({ theme })} />
    </div>
  );
}
