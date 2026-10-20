import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE, ROUTES, canonicalHash, isRouteId, parseHash, routeHref, routeLabel } from '../routes';

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

describe('canonicalHash', () => {
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
