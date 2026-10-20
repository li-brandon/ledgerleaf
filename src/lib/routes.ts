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

/** Pages reached from another page rather than the nav; `parent` stays highlighted in the nav. */
export const SUBPAGES = [
  { id: 'categories', label: 'Categories & rules', parent: 'settings' },
] as const;

export type NavRouteId = (typeof ROUTES)[number]['id'];
export type RouteId = NavRouteId | (typeof SUBPAGES)[number]['id'];

/** The nav entry to highlight for a route: itself, or the page a subpage belongs to. */
export const navRoute = (id: RouteId): NavRouteId => SUBPAGES.find((p) => p.id === id)?.parent ?? (id as NavRouteId);

export const DEFAULT_ROUTE: RouteId = 'overview';

const IDS = new Set<string>([...ROUTES, ...SUBPAGES].map((r) => r.id));

/** Old or alternate slugs that should keep working as deep links. */
const ALIASES = new Map<string, RouteId>([
  ['ledger', 'transactions'],
  ['dashboard', 'overview'],
  ['home', 'overview'],
  ['rules', 'categories'],
]);

export const isRouteId = (s: string): s is RouteId => IDS.has(s);

/** Query parameters carried in the hash, e.g. `#/transactions?account=abc`. */
export type RouteParams = Record<string, string>;

export interface Route {
  id: RouteId;
  params: RouteParams;
}

/** The hash for a route; empty parameters are left out. */
export function routeHref(id: RouteId, params: RouteParams = {}): string {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '')).toString();
  return `#/${id}${qs ? `?${qs}` : ''}`;
}

/** Transactions, filtered to one account when `accountId` is given. */
export const transactionsHref = (accountId?: string) => routeHref('transactions', accountId ? { account: accountId } : {});

export const routeLabel = (id: RouteId) => [...ROUTES, ...SUBPAGES].find((r) => r.id === id)!.label;

/**
 * Resolve a `location.hash` value to a route. Accepts `#/budgets`, `#budgets`,
 * trailing slashes, sub-paths and query strings; anything unknown falls back to
 * the default route.
 */
export function parseHash(hash: string): RouteId {
  return parseRoute(hash).id;
}

/**
 * Resolve a `location.hash` value to a route and its query parameters. Parameters are
 * dropped when the hash falls back to the default route.
 */
export function parseRoute(hash: string): Route {
  const slug = hash.replace(/^#/, '').replace(/^\/+/, '').split(/[/?#]/)[0].trim().toLowerCase();
  const id = isRouteId(slug) ? slug : ALIASES.get(slug);
  if (!id) return { id: DEFAULT_ROUTE, params: {} };
  const q = hash.indexOf('?');
  const query = q < 0 ? [] : [...new URLSearchParams(hash.slice(q + 1).split('#')[0])];
  // fromEntries defines own properties, so keys like `__proto__` stay plain data.
  return { id, params: Object.fromEntries(query.filter(([, v]) => v !== '')) };
}

/** The hash the address bar should show for a given hash, or null if it is already canonical. */
export function canonicalHash(hash: string): string | null {
  const { id, params } = parseRoute(hash);
  const want = routeHref(id, params);
  return hash === want ? null : want;
}
