import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTE, ROUTES, SUBPAGES, canonicalHash, navRoute, isRouteId, parseHash, parseRoute, routeHref, routeLabel, transactionsHref,
} from '../routes';

describe('parseHash', () => {
  it('resolves every route from its own href', () => {
    for (const r of ROUTES) expect(parseHash(routeHref(r.id))).toBe(r.id);
  });

  it('falls back to overview for empty and unknown hashes', () => {
    expect(DEFAULT_ROUTE).toBe('overview');
    for (const h of ['', '#', '#/', '#/nope', '#/../etc', '#/constructor', '#/__proto__', '#/toString']) {
      expect(parseHash(h)).toBe('overview');
    }
  });

  it('tolerates missing slash, trailing slash, case, sub-paths and queries', () => {
    expect(parseHash('#budgets')).toBe('budgets');
    expect(parseHash('#/budgets/')).toBe('budgets');
    expect(parseHash('#//Budgets')).toBe('budgets');
    expect(parseHash('#/transactions/abc123')).toBe('transactions');
    expect(parseHash('#/insights?range=6')).toBe('insights');
    expect(parseHash('budgets')).toBe('budgets');
  });

  it('maps legacy aliases', () => {
    expect(parseHash('#/ledger')).toBe('transactions');
    expect(parseHash('#/dashboard')).toBe('overview');
  });
});

describe('parseRoute', () => {
  it('reads query parameters for known routes and aliases', () => {
    expect(parseRoute('#/transactions?account=demo-card')).toEqual({ id: 'transactions', params: { account: 'demo-card' } });
    expect(parseRoute('#/ledger?account=a%20b&q=')).toEqual({ id: 'transactions', params: { account: 'a b' } });
    expect(parseRoute('#/accounts')).toEqual({ id: 'accounts', params: {} });
  });

  it('drops parameters when falling back to the default route', () => {
    expect(parseRoute('#/nope?account=x')).toEqual({ id: 'overview', params: {} });
  });

  it('keeps odd keys as plain data', () => {
    const { params } = parseRoute('#/transactions?__proto__=x');
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    expect(Object.keys(params)).toEqual(['__proto__']);
  });
});

describe('routeHref', () => {
  it('encodes parameters and skips empty ones', () => {
    expect(routeHref('transactions', { account: 'a b&c', q: '' })).toBe('#/transactions?account=a+b%26c');
    expect(transactionsHref()).toBe('#/transactions');
    expect(transactionsHref('demo-card')).toBe('#/transactions?account=demo-card');
  });

  it('round-trips through parseRoute', () => {
    const href = transactionsHref('acct/1?x=#y');
    expect(parseRoute(href)).toEqual({ id: 'transactions', params: { account: 'acct/1?x=#y' } });
  });
});

describe('canonicalHash', () => {
  it('keeps query parameters so filtered views survive a reload', () => {
    expect(canonicalHash('#/transactions?account=demo-card')).toBeNull();
    expect(canonicalHash('#transactions?account=demo-card')).toBe('#/transactions?account=demo-card');
    expect(canonicalHash('#/ledger?account=x&empty=')).toBe('#/transactions?account=x');
  });

  it('returns null when the hash is already canonical', () => {
    expect(canonicalHash('#/accounts')).toBeNull();
  });

  it('rewrites unknown or sloppy hashes', () => {
    expect(canonicalHash('')).toBe('#/overview');
    expect(canonicalHash('#/wat')).toBe('#/overview');
    expect(canonicalHash('#settings')).toBe('#/settings');
    expect(canonicalHash('#/ledger')).toBe('#/transactions');
  });
});

describe('route table', () => {
  it('has the nav items in order with unique ids', () => {
    expect(ROUTES.map((r) => r.label)).toEqual([
      'Overview', 'Accounts', 'Transactions', 'Budgets', 'Insights', 'Connections', 'Settings',
    ]);
    expect(new Set(ROUTES.map((r) => r.id)).size).toBe(ROUTES.length);
  });

  it('exposes labels and a type guard', () => {
    expect(routeLabel('settings')).toBe('Settings');
    expect(isRouteId('budgets')).toBe(true);
    expect(isRouteId('ledger')).toBe(false);
  });
});

describe('subpages', () => {
  it('routes to pages that are not in the nav, keeping their parent highlighted', () => {
    expect(SUBPAGES.map((p) => p.id)).toEqual(['categories']);
    expect(parseHash('#/categories')).toBe('categories');
    expect(parseHash('#/rules')).toBe('categories');
    expect(canonicalHash('#/rules')).toBe('#/categories');
    expect(routeLabel('categories')).toBe('Categories & rules');
    expect(navRoute('categories')).toBe('settings');
    expect(navRoute('budgets')).toBe('budgets');
    expect(ROUTES.some((r) => (r.id as string) === 'categories')).toBe(false);
  });
});
