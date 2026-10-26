import { useMemo, useState, type DragEvent } from 'react';
import { slug } from '../lib/csv';
import {
  FIELD_LABEL, applyMapping, currencyDecimal, detectSeparator, errorRowsCsv, mappingFor, mappingProblem, readCsvTable, withImportMapping,
  type CsvMapping, type CsvTable, type DecimalSeparator, type MappingField, type RowError,
} from '../lib/csvMapping';
import { settingsOf } from '../lib/settings';
import { CsvImportProvider } from '../lib/sync';
import type { Account, AccountType } from '../lib/types';
import type { Ledger } from '../store';

const PREVIEW_ROWS = 10;
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

interface Loaded { name: string; text: string; table: CsvTable }
interface Summary { file: string; account: string; added: number; duplicates: number; errors: RowError[]; table: CsvTable }

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
  const { accounts, importMappings } = ledger.state;
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
  const [dragging, setDragging] = useState(false);
  const [problem, setProblem] = useState('');
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);

  /** Use the account's saved mapping if it fits this file, otherwise detect one from the headers. */
  function remap(table: CsvTable, accountId: string) {
    const saved = accountId === NEW ? undefined : importMappings?.[accountId];
    const m = mappingFor(table.headers, saved);
    setMapping(m);
    setFromSaved(m === saved);
    setDecimalChosen(false);
  }

  async function load(f?: File) {
    if (!f) return;
    setProblem('');
    if (f.size > MAX_BYTES) return setProblem(`${f.name} is larger than 20 MB.`);
    const text = await f.text();
    const table = readCsvTable(text);
    if (!table.rows.length) return setProblem(`${f.name} has no rows to import.`);
    // Offer the account this file's layout was imported into before; an unseen layout is
    // most likely a different account, so default to creating one.
    const known = visible.find((a) => importMappings?.[a.id] && !mappingProblem(importMappings[a.id], table.headers));
    const accountId = known?.id ?? NEW;
    setFile({ name: f.name, text, table });
    setTarget(accountId);
    setNewName(fileStem(f.name));
    setSummary(null);
    remap(table, accountId);
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
    if (file) remap(file.table, id);
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

  const mappingError = file && mapping ? mappingProblem(mapping, file.table.headers) : undefined;
  const nameError = target === NEW && !newName.trim() ? 'Name the new account.' : undefined;
  const savedDecimal = !decimalChosen;
  const check = useMemo(
    () => (file && mapping && !mappingError ? applyMapping(file.table, mapping, 'preview', { savedDecimal }) : null),
    [file, mapping, mappingError, savedDecimal],
  );
  const detected = useMemo(() => (file && mapping ? detectSeparator(file.table, mapping) : undefined), [file, mapping]);
  const usual = currencyDecimal(currency);
  const ambiguous = !!check?.errors.some((e) => e.kind === 'ambiguous');
  const saved = savedDecimal ? mapping?.decimal : undefined;
  const conflict = mapping?.decimal && detected && detected !== mapping.decimal ? detected : undefined;
  const setDecimal = (decimal?: DecimalSeparator) => {
    setMapping((m) => (m ? { ...m, decimal } : m));
    setDecimalChosen(true);
  };

  async function runImport() {
    if (!file || !mapping || mappingError || nameError) return;
    const newAccount: Account | undefined = target === NEW
      ? { id: newAccountId(newName, accounts), name: newName.trim(), type: newType }
      : undefined;
    const accountId = newAccount?.id ?? target;
    const accountName = newAccount?.name ?? accounts.find((a) => a.id === target)?.name ?? '';
    const p = new CsvImportProvider(file.text, { mapping, accountId, newAccount, savedDecimal });
    // Remember a separator the rows showed, so a later file whose rows don't show one is offered it.
    const next = { ...mapping, decimal: mapping.decimal ?? detected };
    setImporting(true);
    onBusy(true);
    try {
      const r = await ledger.runSync(p, (s) => withImportMapping(s, accountId, next));
      setSummary({
        file: file.name, account: accountName, added: r.added, duplicates: r.received - r.added,
        errors: p.errors, table: file.table,
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
        {file!.table.headers.map((h) => <option key={h} value={h}>{h}</option>)}
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

      {file && mapping && (
        <>
          <div className="row between">
            <p className="file-name"><b>{file.name}</b> <span className="muted">{file.table.rows.length} rows</span></p>
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
            {columnSelect('date', false)}
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

          <h3>Preview <span className="more muted">First {Math.min(PREVIEW_ROWS, file.table.rows.length)} of {file.table.rows.length} rows</span></h3>
          <div className="table-scroll">
            <table className="tx preview">
              <thead>
                <tr>
                  {file.table.headers.map((h) => (
                    <th key={h} className={used.has(h) ? 'mapped' : ''}>
                      {h}{used.has(h) && <span className="role">{FIELD_LABEL[used.get(h)!]}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {file.table.rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                  <tr key={i}>
                    {file.table.headers.map((h, j) => <td key={h} className={used.has(h) ? 'mapped' : ''}>{r[j] ?? ''}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(mappingError || nameError) && <p className="notice error" role="alert">{mappingError ?? nameError}</p>}
          {check && (
            <p className="muted">
              {check.transactions.length} rows ready to import
              {check.errors.length > 0 && <>, <span className="neg">{check.errors.length} with errors</span> (first: row {check.errors[0].row}, {check.errors[0].reason})</>}.
            </p>
          )}
          <button onClick={runImport} disabled={disabled || importing || !!mappingError || !!nameError || !check?.transactions.length}>
            {importing ? 'Importing…' : `Import ${check?.transactions.length ?? 0} rows`}
          </button>
        </>
      )}
    </div>
  );
}
