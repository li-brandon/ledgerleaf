# Ledgerleaf

A personal finance app (accounts, transactions, budgets, recurring charges, insights) that runs entirely in your browser.

> **Local only.** Ledgerleaf is a single-user app that runs on your own machine. There are no deploys, no hosted server and no user accounts. Data comes from built-in demo data, CSV files you import or, if you opt in, the Plaid sandbox through a small server on `127.0.0.1` (see [Connect a bank (Plaid sandbox)](#connect-a-bank-plaid-sandbox)). It is stored in your browser's IndexedDB. Unless you start that server and connect a bank, the app makes no network calls with your data.

## Prerequisites

- Node.js 20 or newer (`"engines": { "node": ">=20" }` in `package.json`). `.nvmrc` pins Node 24, so with nvm you can run `nvm use`.
- npm, which comes with Node.
- A modern browser with IndexedDB.

## Running locally

```sh
npm install        # install dependencies
npm run dev        # start the Vite dev server (http://localhost:5173 by default)
npm run plaid-server  # optional: local Plaid sandbox bridge (see "Connect a bank" below)
npm test           # run the Vitest suite once
npm run build      # type-check (tsc --noEmit) and build to dist/
npm run preview    # serve the built dist/ locally (http://localhost:4173 by default)
```

`npm run test:coverage` runs the tests with V8 coverage for `src/lib` (80% line threshold, set in `vite.config.ts`).

## Trying it out

### Load demo data

When the ledger is empty, the Overview page (and Accounts, Transactions, Recurring and Insights) shows **Your ledger is blank** with a **Load demo data** button. It syncs the built-in demo provider, which adds four sample accounts (checking, savings, credit card, investment) with 12 months of activity, monthly balances and recurring subscriptions.

You can also load it from **Connections** (`#/connections`): on the **Demo Bank (sample data)** card, click **Sync now**. Syncing again does not create duplicates.

### Import a CSV

A sample bank export is in [`fixtures/sample-transactions.csv`](fixtures/sample-transactions.csv) (15 rows with `Date,Description,Amount,Category` columns):

1. Open **Connections** (`#/connections`). The empty state's **Import CSV** button and the **Import bank CSV** link in Settings go there too.
2. On the **CSV import** card, drop the file onto **Drop a CSV export here** or click **Choose file** and pick `fixtures/sample-transactions.csv`.
3. Under **Import into**, keep **New account…** (named after the file) or pick an existing account.
4. Under **Columns**, check the mapping detected from the header row: Date, Description, Amount (one signed column; negative is money out) and Category. Use **Separate debit and credit columns** for files with withdrawal/deposit columns, and **Spending is shown as positive (flip signs)** for card exports that show charges as positive.
5. Look over the preview and click **Import 15 rows**.

The column mapping is saved per account and offered again next time. Re-importing the same file skips rows that are already there. Rows that cannot be read are listed after the import, and you can download them as CSV with an extra error column.

Header detection and column matching are in `src/lib/csvMapping.ts` (`readCsvTable`, `detectMapping`, `applyMapping`). Date and amount parsing is in `src/lib/csv.ts` (`normalizeDate`, `parseAmount`). `src/lib/__tests__/sampleFixture.test.ts` checks that the sample file parses with no errors.

### Connect a bank (Plaid sandbox)

Ledgerleaf can sync transactions from [Plaid](https://plaid.com)'s sandbox, which serves test banks and fake data. The browser never sees your Plaid keys or access tokens. It only talks to `server/plaid-server.mjs`, a small Node server that listens on `127.0.0.1` and calls the Plaid API.

1. **Get sandbox keys.** Sign up at [dashboard.plaid.com](https://dashboard.plaid.com/signup), then copy your `client_id` and **Sandbox** secret from **Developers → Keys**.
2. **Create `.env`.** Copy the template and fill in the two keys:

   ```sh
   cp .env.example .env
   # PLAID_CLIENT_ID=...
   # PLAID_SECRET=...      (the sandbox secret)
   ```

   `.env` is gitignored; only `.env.example` is committed. `PLAID_ENV` defaults to `sandbox`, and the server refuses any other environment unless you also set `PLAID_ALLOW_NON_SANDBOX=true`. Vite only exposes `VITE_`-prefixed variables to the browser, so these keys stay on the server.
3. **Run both servers** in two terminals:

   ```sh
   npm run plaid-server   # http://127.0.0.1:8787 (PLAID_SERVER_PORT), localhost only
   npm run dev            # Vite proxies /api/plaid to the Plaid server
   ```

4. **Connect.** Open **Connections** (`#/connections`). On the **Bank via Plaid (sandbox)** card, click **Connect a bank**. This loads Plaid Link from Plaid's CDN. Pick any test institution (for example *First Platypus Bank*) and sign in with **`user_good`** / **`pass_good`** (use `1234` if asked for a code). Ledgerleaf syncs as soon as the bank is connected.
5. **Sync again** with **Sync now**. Only changes since the last sync are fetched. Plaid sometimes needs a minute to prepare a new sandbox item's history; if a sync says so, wait a minute and sync again.

How it works:

- **Server endpoints** (`server/plaid-server.mjs`): `POST /api/plaid/link-token`, `POST /api/plaid/exchange` (swaps Link's public token for an access token and returns only the item id and institution), `POST /api/plaid/sync` (pages through Plaid's `/transactions/sync` until `has_more` is false, then saves the cursor) and `GET /api/plaid/status`. If Plaid returns `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, the server restarts from the saved cursor. It only accepts requests whose `Host` and `Origin` are local.
- **Token store:** access tokens, cursors and the last error for each item are kept in `.plaid-data/items.json` (`PLAID_DATA_DIR`), which is gitignored and written with owner-only permissions. Delete the folder to disconnect every bank. To re-read everything from the beginning, `POST /api/plaid/sync` with `{"reset": true}`. This is safe because merging is idempotent.
- **Mapping** (`src/lib/sync/plaidProvider.ts`): Plaid reports money out as positive, so amounts are negated. Credit and loan balances become negative. `transaction_id` is the externalId, `name` is the description, `merchant_name` is the initial merchant, and `pending`, `date` and `account_id` (as `plaid-<account_id>`) are kept. Plaid's personal finance category picks the starting category.
- **Merging:** added and modified transactions dedupe on source + `transaction_id`. A modified transaction refreshes only bank-owned fields (date, description, amount, account, pending). Your category, merchant, notes and reviewed state are kept, and so is anything a rule set when the transaction arrived. Removed transactions are deleted.

The tests (`server/__tests__/plaid-server.test.ts`, `src/lib/__tests__/plaid.test.ts`, `src/pages/__tests__/PlaidConnect.test.tsx`) mock every Plaid response and never touch the network.

## Where your data lives

Everything is stored in the browser profile you use to open the app. Nothing leaves it.

- **IndexedDB database `ledgerleaf`** (version 1, defined in `src/db/indexeddb.ts`) with these object stores:
  - `accounts` (key `id`)
  - `transactions` (key `id`; indexes `date` and `accountId`)
  - `categories` (key `id`)
  - `rules` (key `id`)
  - `budgets` (key `id`)
  - `balanceSnapshots` (key `[accountId, date]`)
  - `meta`: key/value entries for the schema `version`, `lastSync`, `syncs`, `importMappings`, `recurring`, `settings` and the record `order`
- **Legacy localStorage migration.** Earlier versions saved the whole ledger to localStorage under `ledgerleaf:v2` or `ledgerleaf:v1`. The first time the app opens an empty database, `loadLedger` in `src/db/ledger.ts` migrates that save (`migrate` in `src/lib/migrate.ts`), writes it to IndexedDB and then removes the old keys. A save that cannot be parsed is left untouched.
- **Other small keys.** `ledgerleaf:theme` in localStorage lets the first paint use the right theme (`src/theme.ts`), and `ledgerleaf:txFilters` in sessionStorage remembers the Transactions filters for the current tab (`src/browser.ts`).
- **No IndexedDB?** If IndexedDB is unavailable (for example in some private-browsing modes), `openRepository` in `src/db/index.ts` uses an in-memory repository instead, and changes are lost on reload.

To inspect the data, open your browser's devtools and go to Application → IndexedDB → `ledgerleaf`.

### Backup, restore, reset

All of these are on the **Settings** page (`#/settings`):

- **Back up:** under **Backup & restore (JSON)**, click **Download backup**. This saves a JSON file (`format: "ledgerleaf-backup"`, see `src/db/backup.ts`) with every store plus the meta values.
- **Restore:** click **Restore from backup…** and pick a backup file. It is validated before anything changes. Then choose **Merge** (keeps your current data and adds backup records whose ids are not already present) or **Replace** (erases everything, settings included, and loads the backup).
- **Export CSV:** **Export transactions (CSV)** exports all transactions or only the ones matching your current Transactions filters. This is a spreadsheet export, not a backup.
- **Clear demo data:** when demo data is loaded, the **Demo data** section has a **Clear demo data** button. It removes the demo accounts, transactions and balance history and keeps anything you imported (`src/db/demo.ts`).
- **Reset:** type `RESET` in **Type RESET to confirm** and click **Reset all data**. This erases every account, transaction, budget, rule and setting in this browser and cannot be undone, so download a backup first. Clearing the site's data in your browser does the same thing.

## Architecture

The app is React 19 + TypeScript, built with Vite and tested with Vitest (jsdom, Testing Library, `fake-indexeddb`). It uses hash routing (`#/overview`, `#/transactions`, …; see `src/lib/routes.ts`). The only backend is the optional localhost Plaid server.

### Data sources: the sync interface (`src/lib/sync/`)

All data enters the ledger through a pluggable provider interface:

- `src/lib/sync/types.ts`: `SyncProvider` (`listAccounts()`, `fetchTransactions(since?)`, optional `fetchBalances()`), its static `ProviderMeta` (`id`, `name`, `kind: 'file' | 'demo' | 'remote'`, `requiresAuth`), and `SyncResult` / `AccountBalance`. `RemoteSyncProvider` describes a bank-aggregator provider; `fetchRemovals()` lets incremental providers report deleted transactions.
- `src/lib/sync/mockProvider.ts`: `MockProvider`, the deterministic demo data generator (source `demo`).
- `src/lib/sync/csvProvider.ts`: `CsvImportProvider`, which reads CSV text with an explicit column mapping (`CsvImportOptions`) or, without one, in the fixed `date,description,amount,category,account` layout.
- `src/lib/sync/plaidProvider.ts`: `PlaidProvider` (source `plaid`), which calls the local Plaid server and maps Plaid accounts and transactions. `src/plaidLink.ts` loads Plaid Link in the browser.
- `src/lib/sync/registry.ts`: `ProviderRegistry` and the `providers` list shown on the Connections page.
- `src/lib/sync/run.ts`: `fetchSync` reads and validates everything from a provider (`findInvalid`; a failure throws `SyncError` and leaves the ledger unchanged), and `applySync` merges the result.
- `src/lib/sync/merge.ts`: `mergeSync`, which dedupes by `dedupeKey` (provider plus external id), applies categorization rules to new transactions and deletes removed ones.
- `src/lib/sync/hash.ts`: `hashId`, the content hash used for stable CSV row ids.

To add a source, implement `SyncProvider` and register it in `src/lib/sync/registry.ts`.

### Persistence (`src/db/`)

- `src/db/repository.ts`: the `Repository` interface, with one `EntityStore` per model (`MODEL_NAMES`), a `meta` record, `readAll()` and an atomic `apply(LedgerChanges)`.
- `src/db/indexeddb.ts`: the IndexedDB implementation (via `idb`), `DB_NAME = 'ledgerleaf'`.
- `src/db/memory.ts`: an in-memory `Repository` used by tests and as the fallback.
- `src/db/ledger.ts`: `loadLedger`/`readLedger`/`saveLedger`; `diffLedger` turns two ledger states into the minimal `LedgerChanges`; legacy localStorage migration.
- `src/db/persister.ts`: `createPersister`, a debounced, serialized writer that saves only what changed since the last write.
- `src/db/backup.ts`: JSON backup format, validation (`parseBackup`) and merge/replace restore.
- `src/db/demo.ts`: finding and removing demo data.
- `src/db/index.ts`: `openRepository()`, which uses IndexedDB or falls back to memory.

`src/store.ts` (`useLedger`) holds the in-memory `LedgerState` for the UI. It loads it from the repository at startup, applies every user action through pure functions in `src/lib/`, and has the persister write changes in the background.

### Folder layout

```
fixtures/                    sample CSV for trying the importer
server/                      optional localhost Plaid server (npm run plaid-server)
src/
  main.tsx                   entry point
  App.tsx                    shell, navigation, hash routing
  store.ts                   useLedger: app state + persistence wiring
  browser.ts                 downloads, per-tab sessionStorage helpers
  format.ts                  money/date formatting
  theme.ts                   light/dark theme
  styles.css
  components/                shared UI (charts, icons, transaction detail)
  pages/                     one component per screen (Dashboard, Accounts, Transactions,
                             Budgets, Recurring, Insights, Connections, CsvImport,
                             Settings, Categories, EmptyState)
  lib/                       pure domain logic: types, budgets, categories, rules,
                             recurring detection, insights, CSV parse/map/export,
                             settings, routes, ledger migrations
    sync/                    data-source providers and the sync pipeline
  db/                        persistence: repository interface, IndexedDB, memory,
                             backup/restore, demo data removal
  test/                      shared test helpers
  **/__tests__/              Vitest tests next to the code they cover
```
