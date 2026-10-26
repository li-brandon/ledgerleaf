import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain ESM module without type declarations
import { HOST, createApp, loadEnvFile, resolveConfig, startServer } from '../plaid-server.mjs';

const ACCESS_TOKEN = 'access-sandbox-SECRET-123';
const config = resolveConfig({ PLAID_CLIENT_ID: 'client-id', PLAID_SECRET: 'shh-secret', PLAID_SERVER_PORT: '0' });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake handlers read arbitrary fields of the parsed JSON request body
type Handler = (body: Record<string, any>) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>;

/** A fake Plaid REST API: answers by path and records every request body. */
function fakePlaid(routes: Record<string, Handler>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions read arbitrary fields of the recorded JSON bodies
  const calls: { url: string; body: Record<string, any> }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) return new Response(JSON.stringify({ error_code: 'NOT_FOUND', error_message: path }), { status: 404 });
    const { status = 200, json } = await route(body);
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  });
  return { fetch, calls, of: (path: string) => calls.filter((c) => c.url.endsWith(path)).map((c) => c.body) };
}

const plaidError = (code: string, message: string, status = 400) => ({
  status, json: { error_type: 'TRANSACTIONS_ERROR', error_code: code, error_message: message, display_message: null, request_id: 'req-1' },
});

const tx = (id: string, amount = 12.5) => ({
  transaction_id: id, account_id: 'acc-1', amount, date: '2026-10-01', name: `Shop ${id}`, merchant_name: null, pending: false,
});
const ACCOUNTS = [{ account_id: 'acc-1', name: 'Plaid Checking', mask: '0000', type: 'depository', subtype: 'checking', balances: { current: 110 } }];

const exchangeRoute: Handler = () => ({ json: { access_token: ACCESS_TOKEN, item_id: 'item-1', request_id: 'r' } });

let dir: string;
let storePath: string;
let server: Server | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plaid-test-'));
  storePath = join(dir, 'data', 'items.json');
});

afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** Start the real HTTP server on an ephemeral port with a fake Plaid behind it. */
async function start(routes: Record<string, Handler>, over: Record<string, unknown> = {}) {
  const plaid = fakePlaid(routes);
  server = await startServer({ config, fetch: plaid.fetch, storePath, port: 0, ...over });
  const { port } = server!.address() as AddressInfo;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  };
  return { plaid, call, port };
}

const readStore = async () => JSON.parse(await readFile(storePath, 'utf8'));

describe('config', () => {
  it('defaults to the sandbox and reads credentials', () => {
    expect(resolveConfig({ PLAID_CLIENT_ID: ' id ', PLAID_SECRET: 's' })).toMatchObject({
      env: 'sandbox', baseUrl: 'https://sandbox.plaid.com', clientId: 'id', secret: 's', port: 8787, dataDir: '.plaid-data',
    });
  });

  it('refuses production unless explicitly allowed, and unknown environments always', () => {
    expect(() => resolveConfig({ PLAID_ENV: 'production' })).toThrow(/PLAID_ALLOW_NON_SANDBOX/);
    expect(resolveConfig({ PLAID_ENV: 'production', PLAID_ALLOW_NON_SANDBOX: 'true' }).baseUrl).toBe('https://production.plaid.com');
    expect(() => resolveConfig({ PLAID_ENV: 'development', PLAID_ALLOW_NON_SANDBOX: 'true' })).toThrow(/must be one of/);
    expect(() => resolveConfig({ PLAID_SERVER_PORT: 'abc' })).toThrow(/not a valid port/);
  });

  it('loads a dotenv file without overriding variables already set', async () => {
    const file = join(dir, '.env');
    await writeFile(file, '# keys\nPLAID_CLIENT_ID=abc\nexport PLAID_SECRET="q s"\nPLAID_ENV=sandbox # comment\nNOT A LINE\n');
    const env = loadEnvFile(file, { PLAID_CLIENT_ID: 'kept' });
    expect(env).toEqual({ PLAID_CLIENT_ID: 'kept', PLAID_SECRET: 'q s', PLAID_ENV: 'sandbox' });
    expect(loadEnvFile(join(dir, 'missing'), {})).toEqual({});
  });
});

describe('plaid server', () => {
  it('binds to 127.0.0.1 only', async () => {
    await start({});
    expect(HOST).toBe('127.0.0.1');
    expect((server!.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('creates a link token for the transactions product with the server-side credentials', async () => {
    const { call, plaid } = await start({
      '/link/token/create': () => ({ json: { link_token: 'link-sandbox-1', expiration: '2026-10-22T00:00:00Z', request_id: 'r' } }),
    });
    const r = await call('POST', '/api/plaid/link-token', {});
    expect(r).toMatchObject({ status: 200, json: { link_token: 'link-sandbox-1', expiration: '2026-10-22T00:00:00Z' } });
    expect(plaid.calls[0].url).toBe('https://sandbox.plaid.com/link/token/create');
    expect(plaid.calls[0].body).toMatchObject({ client_id: 'client-id', secret: 'shh-secret', products: ['transactions'], country_codes: ['US'] });
    expect(r.text).not.toContain('shh-secret');
  });

  it('exchanges the public token, stores the access token privately and never returns it', async () => {
    const { call, plaid } = await start({ '/item/public_token/exchange': exchangeRoute });
    const r = await call('POST', '/api/plaid/exchange', {
      public_token: 'public-sandbox-1', institution: { institution_id: 'ins_109508', name: 'First Platypus Bank' },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ item_id: 'item-1', institution: { id: 'ins_109508', name: 'First Platypus Bank' } });
    expect(r.text).not.toContain(ACCESS_TOKEN);
    expect(plaid.of('/item/public_token/exchange')[0]).toMatchObject({ public_token: 'public-sandbox-1' });

    const stored = await readStore();
    expect(stored.items['item-1']).toMatchObject({ access_token: ACCESS_TOKEN, cursor: null, institution: { name: 'First Platypus Bank' } });
    expect((await stat(storePath)).mode & 0o077).toBe(0);

    const status = await call('GET', '/api/plaid/status');
    expect(status.json).toEqual({
      configured: true, env: 'sandbox',
      items: [{ item_id: 'item-1', institution: { id: 'ins_109508', name: 'First Platypus Bank' }, last_sync: null, last_error: null }],
    });
    expect(status.text).not.toContain(ACCESS_TOKEN);
  });

  it('rejects an exchange without a public token', async () => {
    const { call, plaid } = await start({});
    const r = await call('POST', '/api/plaid/exchange', {});
    expect(r).toMatchObject({ status: 400, json: { error: { code: 'MISSING_PUBLIC_TOKEN' } } });
    expect(plaid.calls).toHaveLength(0);
  });

  it('paginates /transactions/sync, persists the cursor and resumes from it', async () => {
    const pages: Record<string, unknown> = {
      '': { added: [tx('t1'), tx('t2')], modified: [], removed: [], accounts: ACCOUNTS, next_cursor: 'c1', has_more: true },
      c1: { added: [tx('t3')], modified: [tx('t0', 9)], removed: [], accounts: ACCOUNTS, next_cursor: 'c2', has_more: true },
      c2: { added: [], modified: [], removed: [{ transaction_id: 't-old', account_id: 'acc-1' }], accounts: ACCOUNTS, next_cursor: 'c3', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' },
      c3: { added: [tx('t4')], modified: [], removed: [], accounts: ACCOUNTS, next_cursor: 'c4', has_more: false },
    };
    const { call, plaid } = await start({
      '/item/public_token/exchange': exchangeRoute,
      '/transactions/sync': (b) => ({ json: pages[b.cursor ?? ''] }),
    });
    await call('POST', '/api/plaid/exchange', { public_token: 'p' });

    const first = await call('POST', '/api/plaid/sync', {});
    expect(first.status).toBe(200);
    expect(first.json.added.map((t: { transaction_id: string }) => t.transaction_id)).toEqual(['t1', 't2', 't3']);
    expect(first.json.modified.map((t: { transaction_id: string }) => t.transaction_id)).toEqual(['t0']);
    expect(first.json.removed).toEqual([{ transaction_id: 't-old', account_id: 'acc-1' }]);
    expect(first.json.accounts).toEqual([{ ...ACCOUNTS[0], item_id: 'item-1' }]);
    expect(first.json.items).toEqual([expect.objectContaining({ item_id: 'item-1', transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' })]);
    expect(first.json.errors).toEqual([]);
    expect(first.text).not.toContain(ACCESS_TOKEN);
    expect(plaid.of('/transactions/sync').map((b) => b.cursor)).toEqual([undefined, 'c1', 'c2']);
    expect(plaid.of('/transactions/sync').every((b) => b.access_token === ACCESS_TOKEN)).toBe(true);
    expect((await readStore()).items['item-1']).toMatchObject({ cursor: 'c3', last_error: null, last_sync: expect.any(String) });

    const second = await call('POST', '/api/plaid/sync', {});
    expect(second.json.added.map((t: { transaction_id: string }) => t.transaction_id)).toEqual(['t4']);
    expect(plaid.of('/transactions/sync').map((b) => b.cursor).slice(3)).toEqual(['c3']);
    expect((await readStore()).items['item-1'].cursor).toBe('c4');

    // A reset re-reads from the beginning.
    await call('POST', '/api/plaid/sync', { reset: true });
    expect(plaid.of('/transactions/sync')[4].cursor).toBeUndefined();
  });

  it('restarts from the saved cursor when Plaid reports a mutation during pagination', async () => {
    let failed = false;
    const { call, plaid } = await start({
      '/item/public_token/exchange': exchangeRoute,
      '/transactions/sync': (b) => {
        if (!b.cursor) return { json: { added: [tx('t1')], modified: [], removed: [], accounts: ACCOUNTS, next_cursor: 'c1', has_more: true } };
        if (!failed) {
          failed = true;
          return plaidError('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'Underlying transaction data changed');
        }
        return { json: { added: [tx('t2')], modified: [], removed: [], accounts: ACCOUNTS, next_cursor: 'c2', has_more: false } };
      },
    });
    await call('POST', '/api/plaid/exchange', { public_token: 'p' });
    const r = await call('POST', '/api/plaid/sync', {});
    expect(r.status).toBe(200);
    // The first page is fetched again rather than kept twice.
    expect(r.json.added.map((t: { transaction_id: string }) => t.transaction_id)).toEqual(['t1', 't2']);
    expect(plaid.of('/transactions/sync').map((b) => b.cursor)).toEqual([undefined, 'c1', undefined, 'c1']);
    expect((await readStore()).items['item-1'].cursor).toBe('c2');
  });

  it('gives up after repeated mutations without moving the cursor', async () => {
    const { call, plaid } = await start({
      '/item/public_token/exchange': exchangeRoute,
      '/transactions/sync': () => plaidError('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'changed'),
    });
    await call('POST', '/api/plaid/exchange', { public_token: 'p' });
    const r = await call('POST', '/api/plaid/sync', {});
    expect(r).toMatchObject({ status: 400, json: { error: { code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' } } });
    expect(plaid.of('/transactions/sync')).toHaveLength(4);
    expect((await readStore()).items['item-1']).toMatchObject({ cursor: null, last_error: { code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' } });
  });

  it('reports Plaid errors with their code and message and records them per item', async () => {
    const { call } = await start({
      '/item/public_token/exchange': exchangeRoute,
      '/transactions/sync': () => ({
        status: 400,
        json: { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login details changed', display_message: 'Please reconnect your bank.', request_id: 'req-9' },
      }),
    });
    await call('POST', '/api/plaid/exchange', { public_token: 'p' });
    const r = await call('POST', '/api/plaid/sync', {});
    expect(r).toMatchObject({
      status: 400,
      json: { error: { code: 'ITEM_LOGIN_REQUIRED', message: 'Please reconnect your bank.', type: 'ITEM_ERROR', request_id: 'req-9' } },
    });
    const status = await call('GET', '/api/plaid/status');
    expect(status.json.items[0].last_error).toMatchObject({ code: 'ITEM_LOGIN_REQUIRED', message: 'Please reconnect your bank.' });
  });

  it('returns the items that synced and lists the ones that failed', async () => {
    const tokens = ['access-a', 'access-b'];
    const { call } = await start({
      '/item/public_token/exchange': () => ({ json: { access_token: tokens[0], item_id: tokens.shift()!.replace('access', 'item') } }),
      '/transactions/sync': (b) => (b.access_token === 'access-a'
        ? { json: { added: [tx('t1')], modified: [], removed: [], accounts: ACCOUNTS, next_cursor: 'c1', has_more: false } }
        : { status: 500, json: { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR', error_message: 'oops' } }),
    });
    await call('POST', '/api/plaid/exchange', { public_token: 'a', institution: { name: 'Bank A' } });
    await call('POST', '/api/plaid/exchange', { public_token: 'b', institution: { name: 'Bank B' } });
    const r = await call('POST', '/api/plaid/sync', {});
    expect(r.status).toBe(200);
    expect(r.json.added).toHaveLength(1);
    expect(r.json.errors).toEqual([{ item_id: 'item-b', institution: { name: 'Bank B' }, code: 'INTERNAL_SERVER_ERROR', message: 'oops' }]);
    const stored = await readStore();
    expect(stored.items['item-a'].cursor).toBe('c1');
    expect(stored.items['item-b'].cursor).toBeNull();
  });

  it('maps an unreachable Plaid to 502 and a missing configuration to 503', async () => {
    const down = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const { call } = await start({}, { fetch: down });
    expect(await call('POST', '/api/plaid/link-token', {})).toMatchObject({ status: 502, json: { error: { code: 'PLAID_UNREACHABLE' } } });
    await new Promise((r) => server!.close(r));

    const unconfigured = await start({}, { config: resolveConfig({ PLAID_SERVER_PORT: '0' }) });
    expect(await unconfigured.call('POST', '/api/plaid/link-token', {})).toMatchObject({ status: 503, json: { error: { code: 'NOT_CONFIGURED' } } });
    expect((await unconfigured.call('GET', '/api/plaid/status')).json).toEqual({ configured: false, env: 'sandbox', items: [] });
    expect(unconfigured.plaid.calls).toHaveLength(0);
  });

  it('rejects syncing with nothing connected, bad JSON, unknown routes and non-local origins', async () => {
    const { call, port } = await start({});
    expect(await call('POST', '/api/plaid/sync', {})).toMatchObject({ status: 409, json: { error: { code: 'NO_ITEMS' } } });
    expect(await call('POST', '/api/plaid/sync', { item_id: 'nope' })).toMatchObject({ status: 404, json: { error: { code: 'UNKNOWN_ITEM' } } });
    expect(await call('GET', '/api/plaid/nope')).toMatchObject({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
    expect(await call('POST', '/api/plaid/link-token', [1])).toMatchObject({ status: 400, json: { error: { code: 'INVALID_JSON' } } });
    expect(await call('GET', '/api/plaid/status', undefined, { Origin: 'https://evil.example' })).toMatchObject({ status: 403 });
    expect(await call('GET', '/api/plaid/status', undefined, { Origin: 'http://localhost:5173' })).toMatchObject({ status: 200 });
    // A page on another host that resolves to 127.0.0.1 (DNS rebinding) sends its own Host header.
    const rebound = await new Promise<number | undefined>((done, fail) => {
      request({ host: '127.0.0.1', port, path: '/api/plaid/status', headers: { Host: 'rebind.example' } }, (res) => {
        res.resume();
        done(res.statusCode);
      }).on('error', fail).end();
    });
    expect(rebound).toBe(403);
  });

  it('runs one sync at a time', async () => {
    let active = 0;
    let peak = 0;
    const { call } = await start({
      '/item/public_token/exchange': exchangeRoute,
      '/transactions/sync': async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { json: { added: [], modified: [], removed: [], accounts: ACCOUNTS, next_cursor: 'c', has_more: false } };
      },
    });
    await call('POST', '/api/plaid/exchange', { public_token: 'p' });
    await Promise.all([call('POST', '/api/plaid/sync', {}), call('POST', '/api/plaid/sync', {})]);
    expect(peak).toBe(1);
  });
});

describe('createApp without HTTP', () => {
  it('uses an injected Plaid base URL', async () => {
    const plaid = fakePlaid({ '/link/token/create': () => ({ json: { link_token: 'l' } }) });
    const app = createApp({ config, fetch: plaid.fetch, baseUrl: 'http://plaid.test', storePath });
    expect(await app.linkToken()).toEqual({ link_token: 'l', expiration: undefined });
    expect(plaid.calls[0].url).toBe('http://plaid.test/link/token/create');
  });
});
