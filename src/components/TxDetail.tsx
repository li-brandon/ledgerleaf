import { useState, type KeyboardEvent, type Ref } from 'react';
import { fmtDay, fmtMoney } from '../format';
import { merchantRule } from '../lib/txEdits';
import { isTypingTarget } from '../lib/txKeys';
import type { Rule, Transaction } from '../lib/types';
import type { Ledger } from '../store';

interface Props {
  tx: Transaction;
  accountName: string;
  /** Category names to offer, sorted. */
  categories: string[];
  rules: Rule[];
  ledger: Ledger;
  categoryRef: Ref<HTMLSelectElement>;
  onClose: () => void;
}

/**
 * Edit one transaction: merchant, category (optionally as a rule for the merchant), notes
 * and reviewed. Render with `key={tx.id}` so drafts reset when the transaction changes.
 * Text fields are saved when they lose focus or on Enter (merchant).
 */
export default function TxDetail({ tx, accountName, categories, rules, ledger, categoryRef, onClose }: Props) {
  const [merchant, setMerchant] = useState(tx.merchant ?? tx.description);
  const [notes, setNotes] = useState(tx.notes ?? '');
  const rule = merchantRule(rules, tx);
  const always = !!rule && rule.categoryId === tx.categoryId;

  const saveMerchant = () => {
    ledger.editTransaction(tx.id, { merchant });
    if (!merchant.trim()) setMerchant(tx.description);
  };
  const saveNotes = () => ledger.editTransaction(tx.id, { notes });

  // Escape leaves a field (saving it on blur); list shortcuts ignore keys typed in fields.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && isTypingTarget(e.target)) (e.target as HTMLElement).blur();
  };

  return (
    <aside className="tx-detail" aria-labelledby="tx-detail-title" onKeyDown={onKeyDown}>
      <header className="tx-detail-head">
        <div className="tx-detail-title">
          <h2 id="tx-detail-title">{tx.description}</h2>
          <p className="muted">{fmtDay(tx.date)} · {accountName}</p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details">×</button>
      </header>
      <p className={`tx-detail-amt num${tx.amount > 0 ? ' pos' : ''}`}>{fmtMoney(tx.amount)}</p>

      <button
        type="button" className={`tx-review-toggle${tx.reviewed ? ' on' : ''}`} aria-pressed={!!tx.reviewed}
        onClick={() => ledger.setReviewed(tx.id, !tx.reviewed)}
      >
        {tx.reviewed ? '✓ Reviewed' : 'Mark reviewed'}
      </button>

      <label className="field">Merchant
        <input
          value={merchant} onChange={(e) => setMerchant(e.target.value)} onBlur={saveMerchant}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>

      <label className="field">Category
        <select
          ref={categoryRef} value={tx.category}
          onChange={(e) => ledger.setCategory(tx.id, e.target.value, { always })}
        >
          {categories.map((c) => <option key={c}>{c}</option>)}
        </select>
      </label>
      <label className="check tx-always">
        <input type="checkbox" checked={always} onChange={(e) => ledger.setAlways(tx.id, e.target.checked)} />
        <span>
          Always categorize like this
          <em>“{tx.description}” in new imports and unreviewed transactions becomes {tx.category}.</em>
        </span>
      </label>

      <label className="field">Notes
        <textarea rows={3} value={notes} placeholder="Add a note…" onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} />
      </label>

      <p className="tx-keys muted" aria-hidden>
        <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>r</kbd> reviewed · <kbd>c</kbd> category · <kbd>Esc</kbd> close
      </p>
    </aside>
  );
}
