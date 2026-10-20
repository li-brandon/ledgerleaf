import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { PageProps } from '../App';
import { fmtDate, fmtMoney } from '../format';
import { spendExclusions } from '../lib/budget';
import { UPCOMING_DAYS, isoDate, upcomingRecurring } from '../lib/overview';
import {
  CADENCES, CADENCE_LABELS, PRICE_INCREASE_THRESHOLD, isCounted, monthlyTotal, recurringCharges, recurringSeries,
  type ManualDraft, type RecurringSeries,
} from '../lib/recurring';
import { EMPTY_FILTERS, filtersHref } from '../lib/txFilters';
import EmptyState from './EmptyState';

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Short date, with the year when it is not this year. */
function fmtDue(iso: string, today: string) {
  return iso.slice(0, 4) === today.slice(0, 4) ? fmtDate(iso) : `${fmtDate(iso)}, ${iso.slice(0, 4)}`;
}

export default function Recurring({ ledger }: PageProps) {
  const { transactions, accounts, categories, recurring } = ledger.state;
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState('');
  const today = new Date();
  const now = isoDate(today);
  const series = useMemo(
    () => recurringSeries({ transactions, recurring }, new Date(), spendExclusions(categories)),
    [transactions, recurring, categories],
  );
  if (!transactions.length && !accounts.length && !recurring?.manual.length) {
    return <><h1>Recurring</h1><EmptyState ledger={ledger} /></>;
  }

  const counted = series.filter(isCounted);
  const total = monthlyTotal(series);
  const soon = upcomingRecurring(recurringCharges(series), today);
  const soonTotal = -soon.reduce((s, c) => s + c.amount, 0);
  const flagged = counted.filter((s) => s.state === 'missed' || s.priceIncrease);
  const kept = series.filter((s) => (s.status === 'confirmed' || s.status === 'manual') && s.state !== 'inactive');
  const suggested = series.filter((s) => s.status === 'suggested' && s.state !== 'inactive');
  const inactive = series.filter((s) => s.status !== 'dismissed' && s.state === 'inactive');
  const dismissed = series.filter((s) => s.status === 'dismissed');

  const decide = (s: RecurringSeries, d: 'confirmed' | 'dismissed' | undefined, text: string) => {
    ledger.setRecurring(s.key, d);
    setMsg(text);
  };
  const actions = (s: RecurringSeries) => {
    if (s.status === 'manual') {
      return (
        <button type="button" className="link" aria-label={`Remove ${s.name}`}
          onClick={() => { if (confirm(`Remove “${s.name}” from recurring?`)) { ledger.removeRecurring(s.key); setMsg(`Removed “${s.name}”.`); } }}>
          Remove
        </button>
      );
    }
    if (s.status === 'dismissed') {
      return <button type="button" className="link" onClick={() => decide(s, undefined, `Restored “${s.name}”.`)}>Restore</button>;
    }
    return (
      <span className="rec-actions">
        {s.status === 'suggested' && (
          <button type="button" className="link" aria-label={`Confirm ${s.name}`}
            onClick={() => decide(s, 'confirmed', `Confirmed “${s.name}”.`)}>Confirm</button>
        )}
        <button type="button" className="link" aria-label={`Dismiss ${s.name}`}
          onClick={() => decide(s, 'dismissed', `Dismissed “${s.name}”; it no longer counts toward your recurring total.`)}>
          {s.status === 'confirmed' ? 'Not recurring' : 'Dismiss'}
        </button>
      </span>
    );
  };

  return (
    <>
      <h1>Recurring <small>{plural(counted.length, 'charge')} · {fmtMoney(total)} a month</small></h1>
      <div className="grid two">
        <section className="card" aria-label="Recurring cost">
          <h3>What repeats</h3>
          <p className="hero">{fmtMoney(total)} <small>a month</small></p>
          <dl className="stats">
            <div><dt>A year</dt><dd>{fmtMoney(total * 12)}</dd></div>
            <div><dt>Next {UPCOMING_DAYS} days</dt><dd>{fmtMoney(soonTotal)}</dd></div>
          </dl>
          <p className="muted">
            Weekly and yearly charges are converted to their monthly equivalent. Dismissed and inactive series are left out.
          </p>
        </section>
        <section className="card" aria-label="Needs attention">
          <h3>Needs attention {flagged.length > 0 && <span className="tag over">{flagged.length}</span>}</h3>
          {flagged.length ? (
            <ul className="ruled">
              {flagged.map((s) => (
                <li key={s.key}>
                  <span>
                    {s.name}
                    <em>
                      {s.priceIncrease
                        ? `Up ${pct(s.priceIncrease.change)}: ${fmtMoney(s.priceIncrease.from)} → ${fmtMoney(s.priceIncrease.to)}`
                        : `Expected ${fmtDue(s.nextDate, now)}, no charge yet`}
                    </em>
                  </span>
                  <span className={`tag ${s.priceIncrease ? 'over' : 'near'}`}>{s.priceIncrease ? 'Price up' : 'Missed'}</span>
                </li>
              ))}
            </ul>
          ) : <p className="muted">No price increases or missed charges.</p>}
        </section>
      </div>

      <section className="card" aria-labelledby="rec-kept">
        <h3 id="rec-kept">
          Tracking
          {!adding && <button type="button" className="link more" onClick={() => { setMsg(''); setAdding(true); }}>+ Add recurring</button>}
        </h3>
        {msg && <p className="notice" role="status">{msg}</p>}
        {adding && (
          <ManualForm
            today={now}
            onCancel={() => setAdding(false)}
            onSave={(d) => {
              const error = ledger.addRecurring(d);
              if (!error) { setAdding(false); setMsg(`Added “${d.name.trim()}”.`); }
              return error;
            }}
          />
        )}
        {kept.length
          ? <SeriesTable series={kept} today={now} actions={actions} />
          : <p className="muted">Confirm a detected series below, or add one by hand, to track it here.</p>}
      </section>

      <section className="card" aria-labelledby="rec-suggested">
        <h3 id="rec-suggested">Detected · {suggested.length}</h3>
        {suggested.length
          ? <SeriesTable series={suggested} today={now} actions={actions} />
          : <p className="muted">Nothing new. Charges from the same merchant, of a similar amount, at least three times on a weekly, monthly or yearly schedule show up here.</p>}
        <p className="muted">
          Detected series count toward your total until you dismiss them. A price is flagged when the latest charge is more
          than {pct(PRICE_INCREASE_THRESHOLD)} above the usual amount; a charge is missed once a few days pass after its due date.
        </p>
      </section>

      {(inactive.length > 0 || dismissed.length > 0) && (
        <section className="card" aria-label="Inactive and dismissed">
          {inactive.length > 0 && (
            <details>
              <summary>Inactive · {inactive.length} <span className="muted">— no charge for two or more cycles</span></summary>
              <SeriesTable series={inactive} today={now} actions={actions} />
            </details>
          )}
          {dismissed.length > 0 && (
            <details>
              <summary>Dismissed · {dismissed.length}</summary>
              <SeriesTable series={dismissed} today={now} actions={actions} />
            </details>
          )}
        </section>
      )}
    </>
  );
}

function SeriesTable({ series, today, actions }: {
  series: RecurringSeries[];
  today: string;
  actions(s: RecurringSeries): ReactNode;
}) {
  return (
    <div className="table-scroll">
      <table className="tx rec-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Cadence</th>
            <th className="num">Typical</th>
            <th>Next expected</th>
            <th className="num">Per month</th>
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {series.map((s) => {
            const last = s.charges.at(-1);
            return (
              <tr key={s.key}>
                <td>
                  <a className="rec-name" href={filtersHref({ ...EMPTY_FILTERS, q: s.name })}>{s.name}</a>
                  {s.status === 'manual' && <span className="tag rec-tag">Manual</span>}
                  {s.status === 'confirmed' && <span className="tag ok rec-tag">Confirmed</span>}
                  {s.priceIncrease && <span className="tag over rec-tag">Price up {pct(s.priceIncrease.change)}</span>}
                  {s.state === 'missed' && <span className="tag near rec-tag">Missed</span>}
                  <em className="rec-meta">
                    {last
                      ? `${plural(s.charges.length, 'charge')} · last ${fmtDue(last.date, today)} (${fmtMoney(last.amount)})`
                      : 'No matching charges yet'}
                  </em>
                </td>
                <td>{CADENCE_LABELS[s.cadence]}</td>
                <td className="num">{fmtMoney(s.typical)}</td>
                <td>
                  {fmtDue(s.state === 'missed' ? s.nextDate : s.upcomingDate, today)}
                  {s.state === 'missed' && <em className="rec-meta">then {fmtDue(s.upcomingDate, today)}</em>}
                </td>
                <td className="num">{fmtMoney(s.monthly)}</td>
                <td className="rec-act">{actions(s)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ManualForm({ today, onCancel, onSave }: {
  today: string;
  onCancel(): void;
  /** Saves the draft; returns an error message when it cannot be saved. */
  onSave(d: ManualDraft): string | undefined;
}) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [cadence, setCadence] = useState<ManualDraft['cadence']>('monthly');
  const [nextDate, setNextDate] = useState(today);
  const [error, setError] = useState<string>();

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(onSave({ name, amount: Number(amount), cadence, nextDate }));
  }

  return (
    <form className="cat-form" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onCancel()} aria-label="New recurring charge">
      <label className="field">Name
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
      </label>
      <label className="field">Amount
        <input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </label>
      <label className="field">Repeats
        <select value={cadence} onChange={(e) => setCadence(e.target.value as ManualDraft['cadence'])}>
          {CADENCES.map((c) => <option key={c} value={c}>{CADENCE_LABELS[c]}</option>)}
        </select>
      </label>
      <label className="field">Next due
        <input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} required />
      </label>
      <p className="muted">Charges from a merchant with the same name, within 10% of the amount, are matched to it.</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="row">
        <button type="submit">Add recurring</button>
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
