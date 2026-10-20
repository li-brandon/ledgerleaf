import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { PageProps } from '../App';
import { downloadFile, rememberTxFilters } from '../browser';
import TxDetail from '../components/TxDetail';
import { csvFilename } from '../db/backup';
import { displayCurrency, fmtDay, fmtMoney } from '../format';
import { transactionsToCsv } from '../lib/csvExport';
import type { RouteParams } from '../lib/routes';
import {
  PAGE_SIZE, activeFilterCount, applyFilters, filtersHref, groupByDate, hasFilters, parseFilters, totals,
} from '../lib/txFilters';
import { moveSelection, txKeyAction } from '../lib/txKeys';
import EmptyState from './EmptyState';

/** How long the URL waits for typing to settle before it is updated. */
const URL_DELAY = 250;

/**
 * The filters live in the URL (`#/transactions?q=…&account=…`) so views are linkable and
 * survive a reload. The form keeps the raw input text; the URL gets the parsed, canonical
 * filters a moment after the last change.
 */
export default function Transactions({ ledger, params }: PageProps) {
  const { accounts, categories: known, transactions } = ledger.state;
  const [form, setForm] = useState<RouteParams>(params);
  const filters = useMemo(() => parseFilters(form), [form]);
  const href = filtersHref(filters);
  const urlHref = filtersHref(parseFilters(params));
  const written = useRef(urlHref);
  const [open, setOpen] = useState(() => activeFilterCount({ ...filters, q: '' }) > 0);

  // Outside changes to the URL (a link, the address bar) replace the form.
  useEffect(() => {
    if (urlHref === written.current) return;
    written.current = urlHref;
    setForm(params);
    if (activeFilterCount({ ...parseFilters(params), q: '' }) > 0) setOpen(true);
  }, [urlHref]);

  useEffect(() => {
    if (href === written.current) return;
    const id = setTimeout(() => {
      written.current = href;
      location.replace(href);
    }, URL_DELAY);
    return () => clearTimeout(id);
  }, [href]);

  const set = (key: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const clear = () => setForm({});

  const shown = useDeferredValue(filters);
  useEffect(() => rememberTxFilters(shown), [shown]);
  const rows = useMemo(() => applyFilters(transactions, shown), [transactions, shown]);
  const exportCsv = () => downloadFile(csvFilename(), transactionsToCsv(rows, accounts, displayCurrency()), 'text/csv');
  const sum = useMemo(() => totals(rows), [rows]);
  const shownKey = filtersHref(shown);
  const [page, setPage] = useState({ key: shownKey, limit: PAGE_SIZE });
  const limit = page.key === shownKey ? page.limit : PAGE_SIZE;
  const groups = useMemo(() => groupByDate(rows.slice(0, limit)), [rows, limit]);
  const visible = Math.min(limit, rows.length);

  const acct = filters.account;
  const account = accounts.find((a) => a.id === acct);
  // Hidden accounts stay out of the list unless they are the one being viewed.
  const listed = accounts.filter((a) => !a.hidden || a.id === acct);
  const categories = useMemo(
    () => [...new Set([...known.map((c) => c.name), ...transactions.map((t) => t.category)])].sort(),
    [known, transactions],
  );
  const accountName = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const more = activeFilterCount({ ...filters, q: '' });
  const color = Object.fromEntries(known.map((c) => [c.id, c.color]));

  // The open transaction (shown in the detail panel) and the rows ticked for bulk actions.
  const [activeId, setActiveId] = useState<string>();
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const active = activeId === undefined ? undefined : transactions.find((t) => t.id === activeId);
  const shownRows = useMemo(() => rows.slice(0, limit), [rows, limit]);
  const shownIds = useMemo(() => shownRows.map((t) => t.id), [shownRows]);
  const picked = shownIds.filter((id) => checked.has(id));
  const allPicked = picked.length > 0 && picked.length === shownIds.length;

  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const categoryRef = useRef<HTMLSelectElement>(null);
  const bulkCategoryRef = useRef<HTMLSelectElement>(null);
  const bulkAllRef = useRef<HTMLInputElement>(null);
  const [focusCategory, setFocusCategory] = useState(false);

  useEffect(() => {
    if (bulkAllRef.current) bulkAllRef.current.indeterminate = picked.length > 0 && !allPicked;
  });

  const openRow = (id: string | undefined, focus = false) => {
    setActiveId(id);
    if (!id || !focus) return;
    const el = rowRefs.current.get(id);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => {
    const el = activeId === undefined ? undefined : rowRefs.current.get(activeId);
    setActiveId(undefined);
    el?.focus({ preventScroll: true });
  };
  const toggle = (id: string, on: boolean) =>
    setChecked((c) => {
      const next = new Set(c);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  const pickAll = (on: boolean) => setChecked(on ? new Set(shownIds) : new Set());
  const bulkCategory = (name: string) => name && ledger.setCategory(picked, name);
  const showPicker = (el: HTMLSelectElement | null) => {
    el?.focus();
    try { el?.showPicker?.(); } catch { /* not supported or not allowed: focus is enough */ }
  };

  // `c` with nothing open opens the first row, then focuses its category once rendered.
  useEffect(() => {
    if (!focusCategory || !active) return;
    setFocusCategory(false);
    categoryRef.current?.focus();
  }, [focusCategory, active]);

  const onKey = useRef<(e: KeyboardEvent) => void>(undefined);
  onKey.current = (e) => {
    const action = txKeyAction(e);
    if (!action || !shownIds.length) return;
    if (action === 'next' || action === 'prev') {
      openRow(moveSelection(shownIds, activeId, action === 'next' ? 1 : -1), true);
    } else if (action === 'review') {
      if (picked.length) ledger.setReviewed(picked, true);
      else if (active) {
        ledger.setReviewed(active.id, !active.reviewed);
        // Marking reviewed moves on to the next row, for quick triage.
        if (!active.reviewed) {
          const next = moveSelection(shownIds, active.id, 1);
          openRow(next === active.id ? moveSelection(shownIds, active.id, -1) : next, true);
        }
      } else return;
    } else if (action === 'category') {
      if (active) showPicker(categoryRef.current);
      else if (picked.length) showPicker(bulkCategoryRef.current);
      else {
        openRow(shownIds[0], true);
        setFocusCategory(true);
      }
    } else if (action === 'close') {
      if (!active) return;
      close();
    }
    e.preventDefault();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => onKey.current?.(e);
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, []);

  return (
    <>
      <h1>Transactions {account && <small>{account.name}</small>}</h1>
      {acct && !account && (
        <p className="notice error" role="status">
          That account no longer exists. <a href={filtersHref({ ...filters, account: '' })}>Show all accounts</a>
        </p>
      )}
      {!transactions.length ? <EmptyState ledger={ledger} /> : (
        <section className="card">
          <form className="tx-filters" role="search" onSubmit={(e) => e.preventDefault()}>
            <div className="tx-search">
              <input
                type="search" placeholder="Search description, merchant or notes…" aria-label="Search transactions"
                value={form.q ?? ''} onChange={set('q')}
              />
              <button
                type="button" className={`chip${open ? ' on' : ''}`} aria-expanded={open} aria-controls="tx-filter-panel"
                onClick={() => setOpen((o) => !o)}
              >
                Filters{more > 0 && <span className="count"> · {more}</span>}
              </button>
              {hasFilters(filters) && <button type="button" className="link" onClick={clear}>Clear</button>}
              <button type="button" className="chip" onClick={exportCsv} disabled={!rows.length}
                title={hasFilters(shown) ? 'Download the transactions matching these filters as CSV' : 'Download all transactions as CSV'}>
                Export CSV
              </button>
            </div>
            <div id="tx-filter-panel" className="tx-panel" hidden={!open}>
              <label className="field">Account
                <select value={acct} onChange={set('account')}>
                  <option value="">All accounts</option>
                  {acct && !account && <option value={acct}>Unknown account</option>}
                  {listed.map((a) => <option key={a.id} value={a.id}>{a.name}{a.hidden ? ' (hidden)' : ''}</option>)}
                </select>
              </label>
              <label className="field">Category
                <select value={categories.find((c) => c.toLowerCase() === filters.category.toLowerCase()) ?? filters.category} onChange={set('category')}>
                  <option value="">All categories</option>
                  {filters.category && !categories.some((c) => c.toLowerCase() === filters.category.toLowerCase()) && (
                    <option value={filters.category}>{filters.category}</option>
                  )}
                  {categories.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              <label className="field">From
                <input type="date" value={form.from ?? ''} max={form.to || undefined} onChange={set('from')} />
              </label>
              <label className="field">To
                <input type="date" value={form.to ?? ''} min={form.from || undefined} onChange={set('to')} />
              </label>
              <label className="field">Min amount
                <input type="text" inputMode="decimal" placeholder="0.00" value={form.min ?? ''} onChange={set('min')} />
              </label>
              <label className="field">Max amount
                <input type="text" inputMode="decimal" placeholder="Any" value={form.max ?? ''} onChange={set('max')} />
              </label>
              <label className="field">Money
                <select value={filters.kind} onChange={set('type')}>
                  <option value="">In and out</option>
                  <option value="income">Income (in)</option>
                  <option value="expense">Expenses (out)</option>
                </select>
              </label>
              <label className="field">Status
                <select value={filters.reviewed} onChange={set('reviewed')}>
                  <option value="">Any status</option>
                  <option value="unreviewed">Needs review</option>
                  <option value="reviewed">Reviewed</option>
                </select>
              </label>
            </div>
          </form>

          <dl className="tx-summary" aria-live="polite">
            <div><dt>Transactions</dt><dd>{sum.count.toLocaleString('en-US')}</dd></div>
            <div><dt>Total</dt><dd className={sum.net > 0 ? 'pos' : ''}>{fmtMoney(sum.net)}</dd></div>
            <div><dt>In</dt><dd className={sum.income > 0 ? 'pos' : ''}>{fmtMoney(sum.income)}</dd></div>
            <div><dt>Out</dt><dd>{fmtMoney(sum.expense)}</dd></div>
          </dl>

          {!rows.length ? (
            <div className="empty tx-none">
              <h2>No matching transactions</h2>
              <p className="muted">Nothing matches these filters. Try a wider date or amount range, or start over.</p>
              <div className="row"><button type="button" onClick={clear}>Clear filters</button></div>
            </div>
          ) : (
            <>
              <div className="tx-bulk" role="group" aria-label="Bulk actions">
                <label className="tx-bulk-all">
                  <input ref={bulkAllRef} type="checkbox" checked={allPicked} onChange={(e) => pickAll(e.target.checked)} />
                  <span>{picked.length ? `${picked.length.toLocaleString('en-US')} selected` : `Select all ${visible.toLocaleString('en-US')} shown`}</span>
                </label>
                {picked.length > 0 && (
                  <>
                    <select
                      ref={bulkCategoryRef} value="" aria-label="Set category for selected transactions"
                      onChange={(e) => bulkCategory(e.target.value)}
                    >
                      <option value="">Set category…</option>
                      {categories.map((c) => <option key={c}>{c}</option>)}
                    </select>
                    <button type="button" onClick={() => ledger.setReviewed(picked, true)}>Mark reviewed</button>
                    <button type="button" className="link" onClick={() => pickAll(false)}>Clear selection</button>
                  </>
                )}
              </div>
              <div className={`tx-layout${active ? ' has-detail' : ''}`}>
                <div className="tx-list">
                  {groups.map((g) => (
                    <section key={g.date} className="tx-day" aria-label={fmtDay(g.date)}>
                      <h4 className="tx-day-head">
                        <span>{fmtDay(g.date)}</span>
                        <span className={g.total > 0 ? 'pos' : ''}>{fmtMoney(g.total)}</span>
                      </h4>
                      <ul>
                        {g.rows.map((t) => (
                          <li
                            key={t.id}
                            className={`tx-row${t.reviewed ? ' is-reviewed' : ''}${t.id === activeId ? ' is-active' : ''}${checked.has(t.id) ? ' is-picked' : ''}`}
                          >
                            <input
                              type="checkbox" className="tx-pick" checked={checked.has(t.id)}
                              onChange={(e) => toggle(t.id, e.target.checked)} aria-label={`Select ${t.description}`}
                            />
                            <button
                              type="button" className="tx-open" aria-current={t.id === activeId ? 'true' : undefined}
                              ref={(el) => { if (el) rowRefs.current.set(t.id, el); else rowRefs.current.delete(t.id); }}
                              onClick={() => (t.id === activeId ? close() : openRow(t.id))}
                            >
                              <span className="tx-main">
                                <span className="tx-desc">
                                  {!t.reviewed && <span className="tx-dot" title="Needs review"><span className="sr-only">Needs review: </span></span>}
                                  {t.description}
                                </span>
                                <span className="tx-meta">
                                  {[t.merchant && t.merchant !== t.description ? t.merchant : '', accountName[t.accountId] ?? '—']
                                    .filter(Boolean).join(' · ')}
                                  {t.notes && <em> — {t.notes}</em>}
                                </span>
                              </span>
                              <span className="tx-cat">
                                <i style={{ background: (t.categoryId && color[t.categoryId]) || 'var(--color-text-muted)' }} aria-hidden />
                                {t.category}
                              </span>
                              <span className={`tx-amt num ${t.amount > 0 ? 'pos' : ''}`}>{fmtMoney(t.amount)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
                {active && (
                  <TxDetail
                    key={active.id} tx={active} accountName={accountName[active.accountId] ?? '—'} categories={categories}
                    rules={ledger.state.rules} ledger={ledger} categoryRef={categoryRef} onClose={close}
                  />
                )}
              </div>
              {active && <button type="button" className="tx-backdrop" aria-label="Close details" tabIndex={-1} onClick={close} />}
              <div className="tx-more">
                <span className="muted">Showing {visible.toLocaleString('en-US')} of {rows.length.toLocaleString('en-US')}</span>
                {visible < rows.length && (
                  <button type="button" className="btn ghost" onClick={() => setPage({ key: shownKey, limit: limit + PAGE_SIZE })}>
                    Show {Math.min(PAGE_SIZE, rows.length - visible)} more
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}
