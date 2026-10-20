/** Hash routing: pure helpers, no DOM access, so they can be unit tested. */

export const ROUTES = [
  { id: 'overview', label: 'Overview' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'insights', label: 'Insights' },
  { id: 'connections', label: 'Connections' },
  { id: 'settings', label: 'Settings' },
] as const;

export type RouteId = (typeof ROUTES)[number]['id'];

export const DEFAULT_ROUTE: RouteId = 'overview';

const IDS = new Set<string>(ROUTES.map((r) => r.id));

/** Old or alternate slugs that should keep working as deep links. */
const ALIASES = new Map<string, RouteId>([
  ['ledger', 'transactions'],
  ['dashboard', 'overview'],
  ['home', 'overview'],
]);

export const isRouteId = (s: string): s is RouteId => IDS.has(s);

export const routeHref = (id: RouteId) => `#/${id}`;

export const routeLabel = (id: RouteId) => ROUTES.find((r) => r.id === id)!.label;

/**
 * Resolve a `location.hash` value to a route. Accepts `#/budgets`, `#budgets`,
 * trailing slashes, sub-paths and query strings; anything unknown falls back to
 * the default route.
 */
export function parseHash(hash: string): RouteId {
  const slug = hash.replace(/^#/, '').replace(/^\/+/, '').split(/[/?#]/)[0].trim().toLowerCase();
  if (isRouteId(slug)) return slug;
  return ALIASES.get(slug) ?? DEFAULT_ROUTE;
}

/** The hash the address bar should show for a given hash, or null if it is already canonical. */
export function canonicalHash(hash: string): string | null {
  const want = routeHref(parseHash(hash));
  return hash === want ? null : want;
}
