// @ts-check
/**
 * Localhost-only bridge between Ledgerleaf and Plaid. The browser never sees Plaid
 * credentials or access tokens: it asks this server for a Link token, hands back the
 * public token Link returns, and asks it to sync. Access tokens and sync cursors live in a
 * gitignored JSON file (`.plaid-data/items.json` by default).
 *
 * Run with `npm run plaid-server`. Configuration comes from `.env` (see `.env.example`):
 * PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox unless PLAID_ALLOW_NON_SANDBOX=true),
 * PLAID_SERVER_PORT (8787) and PLAID_DATA_DIR (.plaid-data).
 *
 * Plain fetch is used for the Plaid REST API so tests can pass a fake `fetch`.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Plaid API hosts by environment. */
export const PLAID_HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

export const DEFAULT_PORT = 8787;
/** Only ever bound to the loopback interface. */
export const HOST = '127.0.0.1';
const MAX_BODY = 64 * 1024;
/** How many times a sync restarts after Plaid reports the data changed mid-pagination. */
const MAX_SYNC_RESTARTS = 3;
const SYNC_PAGE_SIZE = 500;
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Read KEY=VALUE lines from a dotenv file into `env`, without overriding values already
 * set. Missing files are ignored. Returns `env`.
 * @param {string} path
 * @param {Record<string, string | undefined>} [env]
 */
export function loadEnvFile(path, env = process.env) {
  if (!existsSync(path)) return env;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    const quoted = /^(['"])(.*)\1$/.exec(value);
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
    if (env[m[1]] === undefined) env[m[1]] = value;
  }
  return env;
}

/**
 * @typedef {object} PlaidConfig
 * @property {string} env
 * @property {string} baseUrl
 * @property {string} [clientId]
 * @property {string} [secret]
 * @property {number} port
 * @property {string} dataDir
 */

/**
 * Server configuration from environment variables. Throws for an unknown PLAID_ENV, or a
 * non-sandbox one without PLAID_ALLOW_NON_SANDBOX=true. Missing credentials are allowed:
 * the server starts and reports itself as not configured.
 * @param {Record<string, string | undefined>} env
 * @returns {PlaidConfig}
 */
export function resolveConfig(env) {
  const name = (env.PLAID_ENV || 'sandbox').trim().toLowerCase();
  if (!Object.hasOwn(PLAID_HOSTS, name)) {
    throw new Error(`PLAID_ENV must be one of ${Object.keys(PLAID_HOSTS).join(', ')}; got "${name}".`);
  }
  if (name !== 'sandbox' && env.PLAID_ALLOW_NON_SANDBOX !== 'true') {
    throw new Error(`PLAID_ENV=${name} refused: Ledgerleaf only talks to the Plaid sandbox unless PLAID_ALLOW_NON_SANDBOX=true is set.`);
  }
  const port = env.PLAID_SERVER_PORT ? Number(env.PLAID_SERVER_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PLAID_SERVER_PORT is not a valid port: "${env.PLAID_SERVER_PORT}".`);
  return {
    env: name,
    baseUrl: PLAID_HOSTS[/** @type {keyof typeof PLAID_HOSTS} */ (name)],
    clientId: env.PLAID_CLIENT_ID?.trim() || undefined,
    secret: env.PLAID_SECRET?.trim() || undefined,
    port,
    dataDir: env.PLAID_DATA_DIR?.trim() || '.plaid-data',
  };
}

/** An error to report to the browser: HTTP status, a stable code and a readable message. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {{ type?: string, requestId?: string }} [extra]
   */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.type = extra.type;
    this.requestId = extra.requestId;
  }
}

/**
 * @typedef {object} PlaidClientOptions
 * @property {string} baseUrl
 * @property {string} clientId
 * @property {string} secret
 * @property {typeof fetch} [fetch]
 */

/**
 * Minimal Plaid REST client: POSTs JSON with the credentials in the body and turns Plaid
 * error payloads (and network failures) into {@link ApiError}s.
 * @param {PlaidClientOptions} o
 */
export function createPlaidClient({ baseUrl, clientId, secret, fetch: fetchFn = fetch }) {
  /**
   * @param {string} path
   * @param {Record<string, unknown>} body
   * @returns {Promise<any>}
   */
  return async function call(path, body) {
    let res;
    try {
      res = await fetchFn(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, secret, ...body }),
      });
    } catch (e) {
      throw new ApiError(502, 'PLAID_UNREACHABLE', `Could not reach Plaid: ${e instanceof Error ? e.message : String(e)}`);
    }
    /** @type {any} */
    let json;
    try {
      json = await res.json();
    } catch {
      throw new ApiError(502, 'PLAID_BAD_RESPONSE', `Plaid returned an unreadable response (HTTP ${res.status}).`);
    }
    if (!res.ok || json?.error_code) {
      const status = res.status >= 400 && res.status < 500 ? 400 : 502;
      throw new ApiError(
        status, json?.error_code || 'PLAID_ERROR',
        json?.display_message || json?.error_message || `Plaid request failed (HTTP ${res.status}).`,
        { type: json?.error_type, requestId: json?.request_id },
      );
    }
    return json;
  };
}

/**
 * @typedef {object} StoredItem
 * @property {string} access_token
 * @property {{ id?: string, name?: string } | null} institution
 * @property {string | null} cursor
 * @property {string} created_at
 * @property {string | null} last_sync
 * @property {{ code: string, message: string, at: string } | null} last_error
 */

/**
 * The local token store: one JSON file, written atomically with owner-only permissions.
 * Writes are serialized.
 * @param {string} file
 */
export function createTokenStore(file) {
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /** @returns {Promise<{ version: 1, items: Record<string, StoredItem> }>} */
  async function read() {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      return { version: 1, items: data?.items && typeof data.items === 'object' ? data.items : {} };
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return { version: 1, items: {} };
      throw e;
    }
  }

  /**
   * Read, change and write the store as one step.
   * @template T
   * @param {(data: { version: 1, items: Record<string, StoredItem> }) => T} fn
   * @returns {Promise<T>}
   */
  function update(fn) {
    const run = queue.then(async () => {
      const data = await read();
      const out = fn(data);
      const dir = resolve(file, '..');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(tmp, file);
      await chmod(file, 0o600).catch(() => {});
      return out;
    });
    queue = run.catch(() => {});
    return run;
  }

  return { file, read: () => queue.then(read), update };
}

/**
 * What the browser may know about an item: never the access token.
 * @param {string} id
 * @param {StoredItem} item
 */
const publicItem = (id, item) => ({
  item_id: id,
  institution: item.institution ?? null,
  last_sync: item.last_sync ?? null,
  last_error: item.last_error ?? null,
});

/** @param {import('node:http').IncomingMessage} req */
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body is too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
  }
}

/**
 * Whether a request looks like it comes from this machine's browser: the Host header names
 * the loopback interface (guards against DNS rebinding) and any Origin is local too.
 * @param {import('node:http').IncomingMessage} req
 */
function isLocalRequest(req) {
  const hostname = (value) => {
    try {
      return new URL(value.includes('://') ? value : `http://${value}`).hostname;
    } catch {
      return '';
    }
  };
  if (!LOCAL_HOSTNAMES.has(hostname(req.headers.host ?? ''))) return false;
  const origin = req.headers.origin;
  return origin === undefined || LOCAL_HOSTNAMES.has(hostname(origin));
}

/**
 * @typedef {object} AppOptions
 * @property {PlaidConfig} config
 * @property {typeof fetch} [fetch] Used for every Plaid call; tests pass a fake.
 * @property {string} [baseUrl] Overrides the Plaid host from the config.
 * @property {string} [storePath] Overrides `<dataDir>/items.json`.
 * @property {() => Date} [now]
 */

/**
 * The request handler and the operations behind it.
 * @param {AppOptions} o
 */
export function createApp({ config, fetch: fetchFn, baseUrl, storePath, now = () => new Date() }) {
  const store = createTokenStore(storePath ?? join(config.dataDir, 'items.json'));
  const configured = Boolean(config.clientId && config.secret);
  const plaid = createPlaidClient({
    baseUrl: baseUrl ?? config.baseUrl, clientId: config.clientId ?? '', secret: config.secret ?? '', fetch: fetchFn,
  });
  /** @type {Promise<unknown>} */
  let syncing = Promise.resolve();

  function requireConfig() {
    if (!configured) {
      throw new ApiError(503, 'NOT_CONFIGURED', 'The Plaid server has no credentials. Set PLAID_CLIENT_ID and PLAID_SECRET in .env and restart it.');
    }
  }

  async function status() {
    const { items } = await store.read();
    return {
      configured,
      env: config.env,
      items: Object.entries(items).map(([id, item]) => publicItem(id, item)),
    };
  }

  async function linkToken() {
    requireConfig();
    const r = await plaid('/link/token/create', {
      client_name: 'Ledgerleaf',
      user: { client_user_id: 'ledgerleaf-local-user' },
      products: ['transactions'],
      transactions: { days_requested: 730 },
      country_codes: ['US'],
      language: 'en',
    });
    return { link_token: r.link_token, expiration: r.expiration };
  }

  /** @param {any} body */
  async function exchange(body) {
    requireConfig();
    if (typeof body.public_token !== 'string' || !body.public_token) {
      throw new ApiError(400, 'MISSING_PUBLIC_TOKEN', 'public_token is required.');
    }
    const r = await plaid('/item/public_token/exchange', { public_token: body.public_token });
    if (typeof r.access_token !== 'string' || typeof r.item_id !== 'string') {
      throw new ApiError(502, 'PLAID_BAD_RESPONSE', 'Plaid did not return an item.');
    }
    const inst = body.institution && typeof body.institution === 'object' ? body.institution : null;
    const institution = inst
      ? { id: typeof inst.institution_id === 'string' ? inst.institution_id : inst.id, name: typeof inst.name === 'string' ? inst.name : undefined }
      : null;
    await store.update((data) => {
      data.items[r.item_id] = {
        access_token: r.access_token, institution, cursor: null, created_at: now().toISOString(), last_sync: null, last_error: null,
      };
    });
    return { item_id: r.item_id, institution };
  }

  /**
   * Page through /transactions/sync from the saved cursor until has_more is false. If Plaid
   * reports the data changed mid-pagination, everything fetched is discarded and the sync
   * restarts from the saved cursor.
   * @param {StoredItem} item
   * @param {string | null} from
   */
  async function pull(item, from) {
    for (let attempt = 0; ; attempt++) {
      let cursor = from;
      /** @type {any[]} */ const added = [];
      /** @type {any[]} */ const modified = [];
      /** @type {any[]} */ const removed = [];
      /** @type {any[]} */ let accounts = [];
      let updateStatus;
      try {
        for (let more = true; more;) {
          const page = await plaid('/transactions/sync', {
            access_token: item.access_token, count: SYNC_PAGE_SIZE, ...(cursor ? { cursor } : {}),
          });
          added.push(...(page.added ?? []));
          modified.push(...(page.modified ?? []));
          removed.push(...(page.removed ?? []));
          if (Array.isArray(page.accounts)) accounts = page.accounts;
          updateStatus = page.transactions_update_status;
          cursor = page.next_cursor ?? cursor;
          more = page.has_more === true;
        }
        return { added, modified, removed, accounts, cursor, transactions_update_status: updateStatus };
      } catch (e) {
        if (e instanceof ApiError && e.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < MAX_SYNC_RESTARTS) continue;
        throw e;
      }
    }
  }

  /**
   * Sync every item (or just `body.item_id`). `body.reset` starts over from the beginning,
   * which is safe because the app merges idempotently. Each item's cursor is saved as soon
   * as it has been read completely; an item that fails keeps its cursor and is reported in
   * `errors`. Fails outright only if every requested item failed.
   * @param {any} body
   */
  async function sync(body) {
    requireConfig();
    const { items } = await store.read();
    const ids = typeof body.item_id === 'string' ? [body.item_id] : Object.keys(items);
    if (typeof body.item_id === 'string' && !items[body.item_id]) throw new ApiError(404, 'UNKNOWN_ITEM', 'No such connected item.');
    if (!ids.length) throw new ApiError(409, 'NO_ITEMS', 'No bank is connected yet. Connect one with Plaid Link first.');

    const out = {
      /** @type {any[]} */ items: [], /** @type {any[]} */ accounts: [], /** @type {any[]} */ added: [],
      /** @type {any[]} */ modified: [], /** @type {any[]} */ removed: [], /** @type {any[]} */ errors: [],
    };
    /** @type {ApiError | undefined} */
    let firstError;
    for (const id of ids) {
      const item = items[id];
      const at = now().toISOString();
      try {
        const r = await pull(item, body.reset === true ? null : item.cursor);
        await store.update((data) => {
          const saved = data.items[id];
          if (saved) Object.assign(saved, { cursor: r.cursor, last_sync: at, last_error: null });
        });
        const tag = (/** @type {any} */ x) => ({ ...x, item_id: id });
        out.items.push({ ...publicItem(id, { ...item, last_sync: at, last_error: null }), transactions_update_status: r.transactions_update_status ?? null });
        out.accounts.push(...r.accounts.map(tag));
        out.added.push(...r.added);
        out.modified.push(...r.modified);
        out.removed.push(...r.removed);
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(500, 'SYNC_FAILED', e instanceof Error ? e.message : String(e));
        firstError ??= err;
        await store.update((data) => {
          const saved = data.items[id];
          if (saved) saved.last_error = { code: err.code, message: err.message, at };
        });
        out.errors.push({ item_id: id, institution: item.institution ?? null, code: err.code, message: err.message });
      }
    }
    if (firstError && !out.items.length) throw firstError;
    return out;
  }

  /** @type {Record<string, (body: any) => Promise<unknown>>} */
  const routes = {
    'GET /api/plaid/status': status,
    'POST /api/plaid/link-token': linkToken,
    'POST /api/plaid/exchange': exchange,
    'POST /api/plaid/sync': (body) => {
      // One sync at a time, so two requests never page from the same cursor.
      const run = syncing.then(() => sync(body));
      syncing = run.catch(() => {});
      return run;
    },
  };

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    /** @param {number} code @param {unknown} payload */
    const send = (code, payload) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    try {
      if (!isLocalRequest(req)) throw new ApiError(403, 'FORBIDDEN', 'Only local requests are accepted.');
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const route = routes[`${req.method} ${path}`];
      if (!route) throw new ApiError(404, 'NOT_FOUND', `No route for ${req.method} ${path}.`);
      const body = req.method === 'POST' ? await readJson(req) : {};
      send(200, await route(body));
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, 'INTERNAL', 'Unexpected server error.');
      if (!(e instanceof ApiError)) console.error(e);
      send(err.status, { error: { code: err.code, message: err.message, type: err.type, request_id: err.requestId } });
    }
  }

  return { handle, status, linkToken, exchange, sync, store };
}

/**
 * Start listening on 127.0.0.1 (never any other interface). Resolves once listening.
 * @param {AppOptions & { port?: number }} o
 * @returns {Promise<import('node:http').Server>}
 */
export function startServer(o) {
  const app = createApp(o);
  const server = createServer((req, res) => void app.handle(req, res));
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(o.port ?? o.config.port, HOST, () => {
      server.off('error', fail);
      done(server);
    });
  });
}

async function main() {
  loadEnvFile(resolve('.env'));
  let config;
  try {
    config = resolveConfig(process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
  const server = await startServer({ config });
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  console.log(`Plaid server (${config.env}) listening on http://${HOST}:${addr.port}`);
  console.log(`Token store: ${resolve(config.dataDir, 'items.json')}`);
  if (!config.clientId || !config.secret) console.warn('PLAID_CLIENT_ID / PLAID_SECRET are not set; copy .env.example to .env and fill them in.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
