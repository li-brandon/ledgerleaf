import { useMemo, useState, type DragEvent } from 'react';
import { fmtDay, fmtMoney } from '../format';
import { DELIMITERS, detectDelimiter, normalizeDate, slug } from '../lib/csv';
import {
  FIELD_LABEL, applyMapping, currencyDecimal, detectMapping, detectOrder, detectSeparator, errorRowsCsv, mappingProblem, matchExisting, readCsvTable,
  withImportMapping, type CsvDelimiter, type CsvMapping, type CsvTable, type DateOrder, type DecimalSeparator, type MappingField,
  type RowError,
} from '../lib/csvMapping';
import { batchTransactionCount, newBatchId, recordImport } from '../lib/importBatches';
import { settingsOf } from '../lib/settings';
import { CsvImportProvider } from '../lib/sync';
import type { Account, AccountType } from '../lib/types';
import type { Ledger } from '../store';

const PREVIEW_ROWS = 10;
const RECENT_BATCHES = 10;
const MAX_BYTES = 20 * 1024 * 1024;
const NEW = '__new__';

const ACCOUNT_TYPES: { type: AccountType; label: string }[] = [
  { type: 'checking', label: 'Checking' },
  { type: 'savings', label: 'Savings' },
  { type: 'credit', label: 'Credit card' },
  { type: 'investment', label: 'Investment' },
  { type: 'loan', label: 'Loan' },
];

const DECIMAL_LABEL: Record<DecimalSeparator, string> = { '.': 'Point: 1,234.56', ',': 'Comma: 1.234,56' };
const DATE_ORDER_LABEL: Record<DateOrder, string> = {
  MDY: 'Month first: 12/31/2026', DMY: 'Day first: 31/12/2026', YMD: 'Year first: 2026-12-31',
};
const DATE_ORDERS: DateOrder[] = ['MDY', 'DMY', 'YMD'];
const DELIMITER_LABEL: Record<CsvDelimiter, string> = { ',': 'Comma', ';': 'Semicolon', '\t': 'Tab' };

/** A dropped file, read as a table once per delimiter asked for. */
interface Loaded {
  name: string;
  text: string;
  /** The delimiter detected from the file's first lines. */
  detected: CsvDelimiter;
  /** The file read with `delimiter`, by default the detected one. */
  table(delimiter?: CsvDelimiter): CsvTable;
}

function loaded(name: string, text: string): Loaded {
  const detected = detectDelimiter(text);
  const tables = new Map<CsvDelimiter, CsvTable>();
  return {
    name, text, detected,
    table(delimiter = detected) {
      if (!tables.has(delimiter)) tables.set(delimiter, readCsvTable(text, delimiter));
      return tables.get(delimiter)!;
    },
  };
}

/** Whether `saved` fits the file read with its own delimiter, the one its columns were named under. */
const fits = (f: Loaded, saved: CsvMapping) => !mappingProblem(saved, f.table(saved.delimiter).headers);

interface Summary { file: string; account: string; added: number; duplicates: number; oppositeSign: number; errors: RowError[]; table: CsvTable }

/** An account id for a new account named `name` that no existing account uses. */
function newAccountId(name: string, accounts: Account[]) {
  const base = `csv-${slug(name)}`;
  let id = base;
  for (let n = 2; accounts.some((a) => a.id === id); n++) id = `${base}-${n}`;
  return id;
}

const fileStem = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Imported account';

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

interface Props {
  ledger: Ledger;
  /** Another sync is running. */
  disabled: boolean;
  onBusy(busy: boolean): void;
  /** Reports the outcome for the provider card: an error message, or null after a successful import. */
  onResult(error: string | null): void;
  /** Whether a file is loaded, so the card can widen to fit the mapping and preview. */
  onOpen(open: boolean): void;
}

/** Drop or pick a CSV, map its columns, choose the account and import through the CSV provider. */
export default function CsvImport({ ledger, disabled, onBusy, onResult, onOpen }: Props) {
  const { accounts, importMappings, transactions, importBatches = [] } = ledger.state;
  // The display currency's usual separator is offered for ambiguous amounts. Account.currency is
  // not used: CSV accounts default it to USD whatever the user's bank.
  const { currency } = settingsOf(ledger.state);
  const visible = accounts.filter((a) => !a.hidden);
  const [file, setFile] = useState<Loaded | null>(null);
  const [target, setTarget] = useState<string>(NEW);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<AccountType>('checking');
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [fromSaved, setFromSaved] = useState(false);
  // Whether the decimal separator was chosen during this import, rather than loaded from the saved mapping.
  const [decimalChosen, setDecimalChosen] = useState(false);
  // Likewise for the date order.
  const [dateOrderChosen, setDateOrderChosen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [problem, setProblem] = useState('');
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState<{ text: string; error?: boolean } | null>(null);

  /** Use the account's saved mapping if it fits this file, otherwise detect one from the headers (read with the detected delimiter). */
  function remap(f: Loaded, accountId: string) {
    const saved = accountId === NEW ? undefined : importMappings?.[accountId];
    const m = saved && fits(f, saved) ? saved : detectMapping(f.table().headers);
    setMapping(m);
    setFromSaved(m === saved);
    setDecimalChosen(false);
    setDateOrderChosen(false);
  }

  async function load(f?: File) {
    if (!f) return;
    setProblem('');
    if (f.size > MAX_BYTES) return setProblem(`${f.name} is larger than 20 MB.`);
    const next = loaded(f.name, await f.text());
    if (!next.table().rows.length) return setProblem(`${f.name} has no rows to import.`);
    // Offer the account this file's layout was imported into before; an unseen layout is
    // most likely a different account, so default to creating one.
    const known = visible.find((a) => importMappings?.[a.id] && fits(next, importMappings[a.id]));
    const accountId = known?.id ?? NEW;
    setFile(next);
    setTarget(accountId);
    setNewName(fileStem(f.name));
    setSummary(null);
    remap(next, accountId);
    onOpen(true);
  }

  function close() {
    setFile(null);
    setMapping(null);
    setProblem('');
    onOpen(false);
  }

  function chooseTarget(id: string) {
    setTarget(id);
    if (file) remap(file, id);
  }

  /** Read the file with `delimiter` (unset: the detected one). Its columns change, so they are detected again. */
  function setDelimiter(delimiter?: CsvDelimiter) {
    if (!file) return;
    setMapping((m) => (m ? { ...detectMapping(file.table(delimiter).headers), decimal: m.decimal, dateOrder: m.dateOrder, delimiter } : m));
    setFromSaved(false);
  }

  function setField(field: MappingField, col: string) {
    setMapping((m) => {
      if (!m) return m;
      const next = { ...m };
      if (col) next[field] = col;
      else if (field === 'date' || field === 'description') next[field] = '';
      else delete next[field];
      return next;
    });
  }

  function setSplit(split: boolean) {
    setMapping((m) => {
      if (!m || split === (m.amount === undefined)) return m;
      const { amount, debit, credit, ...rest } = m;
      return split ? rest : { ...rest, amount: debit ?? credit ?? '' };
    });
  }

  // The table as the import will read it (see CsvImportProvider): with the mapping's delimiter, else the detected one.
  const table = file && mapping ? file.table(mapping.delimiter) : null;
  const mappingError = table && mapping ? mappingProblem(mapping, table.headers) : undefined;
  const nameError = target === NEW && !newName.trim() ? 'Name the new account.' : undefined;
  const savedDecimal = !decimalChosen;
  const savedDateOrder = !dateOrderChosen;
  // Mapped into the target account, so rows are matched against its transactions as the import will (see CsvImportProvider).
  const previewAccount = target === NEW ? 'preview' : target;
  const check = useMemo(
    () => (table && mapping && !mappingError ? applyMapping(table, mapping, previewAccount, { savedDecimal, savedDateOrder }) : null),
    [table, mapping, mappingError, previewAccount, savedDecimal, savedDateOrder],
  );
  const matched = useMemo(() => (check ? matchExisting(check.transactions, transactions) : null), [check, transactions]);
  const ready = matched?.transactions.length ?? 0;
  const oppositeSign = matched?.oppositeSign.size ?? 0;
  const detected = useMemo(() => (table && mapping ? detectSeparator(table, mapping) : undefined), [table, mapping]);
  const usual = currencyDecimal(currency);
  const ambiguous = !!check?.errors.some((e) => e.kind === 'ambiguous');
  const saved = savedDecimal ? mapping?.decimal : undefined;
  const conflict = mapping?.decimal && detected && detected !== mapping.decimal ? detected : undefined;
  const setDecimal = (decimal?: DecimalSeparator) => {
    setMapping((m) => (m ? { ...m, decimal } : m));
    setDecimalChosen(true);
  };
  const detectedOrder = useMemo(() => (table && mapping ? detectOrder(table, mapping) : undefined), [table, mapping]);
  const dateCol = table && mapping ? table.headers.indexOf(mapping.date) : -1;
  const ambiguousDates = check?.errors.filter((e) => e.kind === 'ambiguous-date').map((e) => (e.cells[dateCol] ?? '').trim()) ?? [];
  const savedOrder = savedDateOrder ? mapping?.dateOrder : undefined;
  const orderConflict = mapping?.dateOrder && detectedOrder && detectedOrder !== mapping.dateOrder ? detectedOrder : undefined;
  // The orders some ambiguous date reads in, the saved order first.
  const orderChoices = (savedOrder ? [savedOrder, ...DATE_ORDERS.filter((o) => o !== savedOrder)] : DATE_ORDERS)
    .filter((o) => ambiguousDates.some((raw) => normalizeDate(raw, o)));
  const setDateOrder = (dateOrder?: DateOrder) => {
    setMapping((m) => (m ? { ...m, dateOrder } : m));
    setDateOrderChosen(true);
  };

  async function runImport() {
    if (!file || !table || !mapping || mappingError || nameError) return;
    const newAccount: Account | undefined = target === NEW
      ? { id: newAccountId(newName, accounts), name: newName.trim(), type: newType }
      : undefined;
    const accountId = newAccount?.id ?? target;
    const accountName = newAccount?.name ?? accounts.find((a) => a.id === target)?.name ?? '';
    const p = new CsvImportProvider(file.text, { mapping, accountId, newAccount, savedDecimal, savedDateOrder, existing: transactions });
    // Remember a separator and date order the rows showed, so a later file whose rows don't show one is offered it,
    // and the delimiter the file was read with, so its columns are found again.
    const next = {
      ...mapping, decimal: mapping.decimal ?? detected, dateOrder: mapping.dateOrder ?? detectedOrder, delimiter: mapping.delimiter ?? file.detected,
    };
    const draft = { id: newBatchId(), file: file.name, accountId, rows: table.rows.length, at: new Date().toISOString() };
    setImporting(true);
    setUndone(null);
    onBusy(true);
    try {
      const r = await ledger.runSync(p, (s, before) => recordImport(withImportMapping(s, accountId, next), before, draft));
      setSummary({
        file: file.name, account: accountName, added: r.added, duplicates: r.received - r.added,
        oppositeSign: p.oppositeSign, errors: p.errors, table,
      });
      onResult(null);
      close();
    } catch (e) {
      onResult(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
      onBusy(false);
    }
  }

  async function undo(id: string, name: string) {
    const count = batchTransactionCount(ledger.state, id);
    if (!confirm(`Undo the import of ${name}? This removes ${count} transaction${count === 1 ? '' : 's'}.`)) return;
    setUndoing(true);
    setSummary(null);
    try {
      const removed = await ledger.undoImport(id);
      setUndone({ text: `Undid the import of ${name}: removed ${removed} transaction${removed === 1 ? '' : 's'}.` });
    } catch (e) {
      setUndone({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setUndoing(false);
    }
  }

  const onDrag = (e: DragEvent, over: boolean) => {
    e.preventDefault();
    setDragging(over && !disabled);
  };

  const used = new Map<string, MappingField>();
  if (mapping) {
    for (const f of ['date', 'description', 'amount', 'debit', 'credit', 'category'] as const) {
      const col = mapping[f];
      if (col && !used.has(col)) used.set(col, f);
    }
  }

  const columnSelect = (field: MappingField, optional: boolean) => (
    <label className="field" key={field}>
      <span>{FIELD_LABEL[field]}{optional && <em> optional</em>}</span>
      <select value={mapping?.[field] ?? ''} onChange={(e) => setField(field, e.target.value)}>
        <option value="">{optional ? 'None' : 'Choose a column…'}</option>
        {table!.headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </label>
  );

  return (
    <div className="csv-import">
      {summary && (
        <div className="import-summary" role="status">
          <p><b>{summary.file}</b> imported into {summary.account}.</p>
          <dl className="stats">
            <div><dt>Added</dt><dd className="pos">{summary.added}</dd></div>
            <div><dt>Duplicates skipped</dt><dd>{summary.duplicates}</dd></div>
            {summary.oppositeSign > 0 && <div><dt>Opposite-sign duplicates skipped</dt><dd>{summary.oppositeSign}</dd></div>}
            <div><dt>Rows with errors</dt><dd className={summary.errors.length ? 'neg' : ''}>{summary.errors.length}</dd></div>
          </dl>
          {summary.errors.length > 0 && (
            <div className="row">
              <button className="btn ghost" onClick={() => download(`${fileStem(summary.file)} errors.csv`, errorRowsCsv(summary.table, summary.errors))}>
                Download error rows
              </button>
              <span className="muted">Fix them and import the file again; rows already imported are skipped.</span>
            </div>
          )}
        </div>
      )}

      {undone && <p className={`notice${undone.error ? ' error' : ''}`} role={undone.error ? 'alert' : 'status'}>{undone.text}</p>}

      {!file && (
        <div
          className={`dropzone${dragging ? ' over' : ''}`}
          onDragOver={(e) => onDrag(e, true)}
          onDragLeave={(e) => onDrag(e, false)}
          onDrop={(e) => { onDrag(e, false); if (!disabled) void load(e.dataTransfer.files[0]); }}
        >
          <p>Drop a CSV export here</p>
          <label className="btn" aria-disabled={disabled}>
            Choose file
            <input type="file" accept=".csv,text/csv" hidden disabled={disabled}
              onChange={(e) => { void load(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        </div>
      )}
      {problem && <p className="notice error" role="alert">{problem}</p>}

      {!file && importBatches.length > 0 && (
        <div className="settings-block">
          <h4>Recent imports</h4>
          <ul className="ruled">
            {importBatches.slice(0, RECENT_BATCHES).map((b) => (
              <li key={b.id}>
                <span>
                  {b.file}
                  <em>
                    {accounts.find((a) => a.id === b.accountId)?.name ?? 'Removed account'} · {b.rows} rows, {b.added} added
                    · {new Date(b.at).toLocaleString()}
                  </em>
                </span>
                <button className="btn ghost" onClick={() => void undo(b.id, b.file)} disabled={disabled || undoing}
                  aria-label={`Undo import of ${b.file}`}>
                  Undo import
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {file && table && mapping && (
        <>
          <div className="row between">
            <p className="file-name"><b>{file.name}</b> <span className="muted">{table.rows.length} rows</span></p>
            <button className="btn ghost" onClick={close} disabled={importing}>Cancel</button>
          </div>

          <fieldset className="mapping">
            <legend>Import into</legend>
            <label className="field">
              <span>Account</span>
              <select value={target} onChange={(e) => chooseTarget(e.target.value)}>
                {visible.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                <option value={NEW}>New account…</option>
              </select>
            </label>
            {target === NEW && (
              <>
                <label className="field">
                  <span>Name</span>
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} />
                </label>
                <label className="field">
                  <span>Type</span>
                  <select value={newType} onChange={(e) => setNewType(e.target.value as AccountType)}>
                    {ACCOUNT_TYPES.map(({ type, label }) => <option key={type} value={type}>{label}</option>)}
                  </select>
                </label>
              </>
            )}
          </fieldset>

          <fieldset className="mapping">
            <legend>
              Columns <span className="muted">{fromSaved ? 'Saved mapping for this account' : 'Detected from the header row'}</span>
            </legend>
            <label className="field">
              <span>Delimiter</span>
              <select value={mapping.delimiter ?? ''}
                onChange={(e) => setDelimiter((e.target.value || undefined) as CsvDelimiter | undefined)}>
                <option value="">Detect ({DELIMITER_LABEL[file.detected]})</option>
                {DELIMITERS.map((d) => <option key={d} value={d}>{DELIMITER_LABEL[d]}</option>)}
              </select>
            </label>
            {columnSelect('date', false)}
            <label className="field">
              <span>Date order</span>
              <select value={mapping.dateOrder ?? ''}
                onChange={(e) => setDateOrder((e.target.value || undefined) as DateOrder | undefined)}>
                <option value="">Detect ({detectedOrder ? DATE_ORDER_LABEL[detectedOrder] : 'unclear from the rows'})</option>
                {DATE_ORDERS.map((o) => <option key={o} value={o}>{DATE_ORDER_LABEL[o]}</option>)}
              </select>
            </label>
            {orderConflict && (
              <p className="notice">
                This file's dates look like {DATE_ORDER_LABEL[orderConflict]}, but {DATE_ORDER_LABEL[mapping.dateOrder!]} is selected.{' '}
                <button className="btn ghost" onClick={() => setDateOrder(orderConflict)}>Use {DATE_ORDER_LABEL[orderConflict]}</button>
              </p>
            )}
            {orderChoices.map((o) => (
              <button key={o} className="btn ghost" onClick={() => setDateOrder(o)}>
                Use {DATE_ORDER_LABEL[o]}{o === savedOrder && ' (saved for this account)'} for ambiguous dates
              </button>
            ))}
            {columnSelect('description', false)}
            <label className="field">
              <span>Amounts are in</span>
              <select value={mapping.amount === undefined ? 'split' : 'single'} onChange={(e) => setSplit(e.target.value === 'split')}>
                <option value="single">One signed column</option>
                <option value="split">Separate debit and credit columns</option>
              </select>
            </label>
            {mapping.amount !== undefined ? columnSelect('amount', false) : <>{columnSelect('debit', true)}{columnSelect('credit', true)}</>}
            <label className="field">
              <span>Decimal separator</span>
              <select value={mapping.decimal ?? ''}
                onChange={(e) => setDecimal((e.target.value || undefined) as DecimalSeparator | undefined)}>
                <option value="">Detect ({detected ? DECIMAL_LABEL[detected] : 'unclear from the rows'})</option>
                <option value=".">{DECIMAL_LABEL['.']}</option>
                <option value=",">{DECIMAL_LABEL[',']}</option>
              </select>
            </label>
            {conflict && (
              <p className="notice">
                This file's amounts look like {DECIMAL_LABEL[conflict]}, but {DECIMAL_LABEL[mapping.decimal!]} is selected.{' '}
                <button className="btn ghost" onClick={() => setDecimal(conflict)}>Use {DECIMAL_LABEL[conflict]}</button>
              </p>
            )}
            {ambiguous && saved && (
              <button className="btn ghost" onClick={() => setDecimal(saved)}>
                Use {DECIMAL_LABEL[saved]} (saved for this account) for ambiguous rows
              </button>
            )}
            {ambiguous && usual && usual !== saved && (
              <button className="btn ghost" onClick={() => setDecimal(usual)}>
                Use {DECIMAL_LABEL[usual]} (usual for {currency}) for ambiguous rows
              </button>
            )}
            {columnSelect('category', true)}
            <label className="check">
              <input type="checkbox" checked={!!mapping.negate}
                onChange={(e) => setMapping({ ...mapping, negate: e.target.checked || undefined })} />
              Spending is shown as positive (flip signs)
            </label>
          </fieldset>

          <h3>Preview <span className="more muted">First {Math.min(PREVIEW_ROWS, table.rows.length)} of {table.rows.length} rows</span></h3>
          <div className="table-scroll">
            {check ? (
              <table className="tx preview">
                <thead>
                  <tr><th>Date</th><th>Description</th><th>Amount</th><th>Category</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {check.rows.slice(0, PREVIEW_ROWS).map((r, i) => {
                    const cells = table.rows[i];
                    const raw = (col?: string) => (col === undefined ? '' : (cells[table.headers.indexOf(col)] ?? ''));
                    const rawAmount = mapping.amount !== undefined
                      ? raw(mapping.amount)
                      : (['debit', 'credit'] as const).filter((f) => mapping[f]).map((f) => `${mapping[f]}: ${raw(mapping[f])}`).join(', ');
                    if ('reason' in r) {
                      return (
                        <tr key={i} className="rejected">
                          <td>{raw(mapping.date)}</td>
                          <td>{raw(mapping.description)}</td>
                          <td className="num">{rawAmount}</td>
                          <td>{raw(mapping.category)}</td>
                          <td className="issue neg">{r.reason}</td>
                        </tr>
                      );
                    }
                    const flipped = matched?.oppositeSign.has(r);
                    return (
                      <tr key={i} className={flipped ? 'rejected' : undefined}>
                        <td title={raw(mapping.date)}>{fmtDay(r.date)}</td>
                        <td title={raw(mapping.description)}>{r.description}</td>
                        <td title={rawAmount} className={`num ${r.amount > 0 ? 'pos' : ''}`}>{fmtMoney(r.amount)}</td>
                        <td title={raw(mapping.category)}>{r.category}</td>
                        <td className={flipped ? 'issue neg' : 'issue'}>{flipped ? 'Opposite-sign duplicate' : 'Ready'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <table className="tx preview">
                <thead>
                  <tr>
                    {table.headers.map((h) => (
                      <th key={h} className={used.has(h) ? 'mapped' : ''}>
                        {h}{used.has(h) && <span className="role">{FIELD_LABEL[used.get(h)!]}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                    <tr key={i}>
                      {table.headers.map((h, j) => <td key={h} className={used.has(h) ? 'mapped' : ''}>{r[j] ?? ''}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {(mappingError || nameError) && <p className="notice error" role="alert">{mappingError ?? nameError}</p>}
          {oppositeSign > 0 && (
            <p className="notice">
              {oppositeSign} opposite-sign duplicates of existing transactions will be skipped: they match transactions
              already in this account except for sign. Check that flip signs is set as it was for the earlier import.
            </p>
          )}
          {check && (
            <p className="muted">
              {ready} rows ready to import
              {check.errors.length > 0 && <>, <span className="neg">{check.errors.length} with errors</span> (first: row {check.errors[0].row}, {check.errors[0].reason})</>}.
            </p>
          )}
          <button onClick={runImport} disabled={disabled || importing || !!mappingError || !!nameError || !ready}>
            {importing ? 'Importing…' : `Import ${ready} rows`}
          </button>
        </>
      )}
    </div>
  );
}
