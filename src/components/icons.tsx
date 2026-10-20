import type { RouteId } from '../lib/routes';

/** 24×24 stroke paths, one per nav destination. */
const PATHS: Record<RouteId, string> = {
  overview: 'M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-5h4v5',
  accounts: 'M3 9l9-5 9 5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18',
  transactions: 'M7 4v16M4 17l3 3 3-3M17 20V4M14 7l3-3 3 3',
  budgets: 'M12 3a9 9 0 1 0 9 9h-9z M15 3.5A9 9 0 0 1 20.5 9H15z',
  insights: 'M4 20h16M7 16v-4M12 16V7M17 16v-6',
  connections: 'M9 15l6-6M10.5 6.5l1.8-1.8a4 4 0 0 1 5.7 5.7l-1.8 1.8M13.5 17.5l-1.8 1.8a4 4 0 0 1-5.7-5.7l1.8-1.8',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 4.5v5M10 14.5v5',
};

export function NavIcon({ id }: { id: RouteId }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[id]} />
    </svg>
  );
}
