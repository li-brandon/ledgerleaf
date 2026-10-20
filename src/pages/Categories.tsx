import { useMemo, useState, type FormEvent } from 'react';
import type { PageProps } from '../App';
import { fmtDay, fmtMoney } from '../format';
import { categoryUsage, inUse, type CategoryDraft, type CategoryUsage } from '../lib/categories';
import {
  countMatches, describeConditions, draftToRule, emptyRuleDraft, newRuleId, previewRules, ruleToDraft, type RuleDraft,
} from '../lib/rules';
import type { Budget, Category, Rule } from '../lib/types';
import type { Ledger } from '../store';

/** How many example changes the apply preview lists. */
const PREVIEW_ROWS = 8;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function usageText(u: CategoryUsage) {
  const parts = [
    u.transactions && plural(u.transactions, 'transaction'),
    u.budgets && plural(u.budgets, 'budget'),
    u.rules && plural(u.rules, 'rule'),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Not used';
}

/** Categories in their groups, groups in the order they first appear. */
function byGroup(categories: Category[]) {
  const groups = new Map<string, Category[]>();
  for (const c of categories) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  return [...groups];
}

export default function Categories({ ledger }: PageProps) {
  return (
    <>
      <p className="crumb"><a href="#/settings">← Settings</a></p>
      <h1>Categories &amp; rules</h1>
      <CategoriesCard ledger={ledger} />
      <RulesCard ledger={ledger} />
    </>
  );
}

function CategoriesCard({ ledger }: { ledger: Ledger }) {
  const { categories } = ledger.state;
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const groups = byGroup(categories);
  const groupNames = groups.map(([g]) => g);

  function remove(c: Category) {
    setMsg('');
    if (inUse(categoryUsage(ledger.state, c.id))) {
      setEditing(null);
      setDeleting(c.id);
      return;
    }
    if (!confirm(`Delete the category “${c.name}”?`)) return;
    const error = ledger.deleteCategory(c.id);
    setMsg(error ?? `Deleted “${c.name}”.`);
  }

  return (
    <section className="card" aria-labelledby="categories-title">
      <h3 id="categories-title">
        Categories
        {editing !== 'new' && (
          <button type="button" className="link more" onClick={() => { setDeleting(null); setEditing('new'); }}>+ Add category</button>
        )}
      </h3>
      {msg && <p className="notice" role="status">{msg}</p>}
      {editing === 'new' && (
        <CategoryForm
          groups={groupNames}
          onCancel={() => setEditing(null)}
          onSave={(d) => {
            const error = ledger.addCategory(d);
            if (!error) { setEditing(null); setMsg(`Added “${d.name.trim()}”.`); }
            return error;
          }}
        />
      )}
      <div className="cat-groups">
        {groups.map(([group, cats]) => (
          <div key={group} className="cat-group">
            <h4>{group}</h4>
            <ul className="ruled">
              {cats.map((c) => {
                const usage = categoryUsage(ledger.state, c.id);
                if (editing === c.id) {
                  return (
                    <li key={c.id}>
                      <CategoryForm
                        initial={c} groups={groupNames}
                        onCancel={() => setEditing(null)}
                        onSave={(d) => {
                          const error = ledger.updateCategory(c.id, d);
                          if (!error) setEditing(null);
                          return error;
                        }}
                      />
                    </li>
                  );
                }
                return (
                  <li key={c.id} className="cat-row">
                    <span>
                      <span className="cat-name">
                        <i className="cat-swatch" style={{ background: c.color }} aria-hidden />
                        <span aria-hidden>{c.icon}</span> {c.name}
                        {c.excludeFromSpend && <span className="tag"> Not spending</span>}
                      </span>
                      <em>
                        {usageText(usage)}
                        {' · '}
                        <button type="button" className="link" onClick={() => { setDeleting(null); setEditing(c.id); }}
                          aria-label={`Edit ${c.name}`}>Edit</button>
                        {' · '}
                        <button type="button" className="link" onClick={() => remove(c)} aria-label={`Delete ${c.name}`}>Delete</button>
                      </em>
                      {deleting === c.id && (
                        <DeleteCategory
                          category={c} usage={usage} categories={categories} budgets={ledger.state.budgets}
                          onCancel={() => setDeleting(null)}
                          onDelete={(to) => {
                            const error = ledger.deleteCategory(c.id, to);
                            if (!error) {
                              setDeleting(null);
                              setMsg(`Deleted “${c.name}” and moved its ${usageText(usage)} to “${categories.find((x) => x.id === to)?.name}”.`);
                            }
                            return error;
                          }}
                        />
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <p className="muted">
        Categories marked <b>Not spending</b> (like income and transfers) are left out of spending totals, budgets and insights.
      </p>
    </section>
  );
}

interface CategoryFormProps {
  initial?: Category;
  groups: string[];
  onCancel(): void;
  /** Saves the draft; returns an error message when it cannot be saved. */
  onSave(d: CategoryDraft): string | undefined;
}

function CategoryForm({ initial, groups, onCancel, onSave }: CategoryFormProps) {
  const [d, setD] = useState<CategoryDraft>(() => (initial
    ? { name: initial.name, group: initial.group, color: initial.color, icon: initial.icon, excludeFromSpend: initial.excludeFromSpend }
    : { name: '', group: 'Custom', color: '#4f9a5b', icon: '•', excludeFromSpend: false }));
  const [error, setError] = useState<string>();
  const set = <K extends keyof CategoryDraft>(k: K, v: CategoryDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const listId = `groups-${initial?.id ?? 'new'}`;

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(onSave(d));
  }

  return (
    <form className="cat-form" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      aria-label={initial ? `Edit ${initial.name}` : 'New category'}>
      <label className="field">Name
        <input value={d.name} onChange={(e) => set('name', e.target.value)} autoFocus required />
      </label>
      <label className="field">Group
        <input value={d.group} list={listId} onChange={(e) => set('group', e.target.value)} />
        <datalist id={listId}>{groups.map((g) => <option key={g} value={g} />)}</datalist>
      </label>
      <label className="field cat-icon">Icon
        <input value={d.icon} maxLength={8} onChange={(e) => set('icon', e.target.value)} aria-describedby={`${listId}-icon`} />
        <em id={`${listId}-icon`}>An emoji</em>
      </label>
      <label className="field cat-color">Color
        <input type="color" value={d.color} onChange={(e) => set('color', e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={d.excludeFromSpend} onChange={(e) => set('excludeFromSpend', e.target.checked)} />
        Exclude from spending (income, transfers, reimbursements…)
      </label>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="row">
        <button type="submit">{initial ? 'Save' : 'Add category'}</button>
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

interface DeleteCategoryProps {
  category: Category;
  usage: CategoryUsage;
  categories: Category[];
  budgets: Budget[];
  onCancel(): void;
  onDelete(reassignTo: string): string | undefined;
}

/** Deleting a category in use: pick where its transactions, budgets and rules go first. */
function DeleteCategory({ category, usage, categories, budgets, onCancel, onDelete }: DeleteCategoryProps) {
  const others = categories.filter((c) => c.id !== category.id);
  const [to, setTo] = useState(others.find((c) => c.id === 'other')?.id ?? others[0]?.id ?? '');
  const [error, setError] = useState<string>();

  return (
    <form className="cat-delete" onSubmit={(e) => { e.preventDefault(); setError(onDelete(to)); }}
      aria-label={`Delete ${category.name}`}>
      <p>
        “{category.name}” is used by {usageText(usage)}. Move {usage.transactions + usage.budgets + usage.rules === 1 ? 'it' : 'them'} to
        another category before deleting it.
        {usage.budgets > 0 && budgets.some((b) => b.categoryId === to) && ' Its budget is dropped because that category has its own.'}
      </p>
      <div className="row">
        <label className="field">Move to
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <button type="submit" className="danger" disabled={!to}>Move and delete</button>
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
    </form>
  );
}

function RulesCard({ ledger }: { ledger: Ledger }) {
  const { rules, categories, accounts, transactions } = ledger.state;
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const category = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'an unknown account';

  function remove(r: Rule, n: number) {
    if (!confirm(`Delete rule ${n}? Categories it already set are kept.`)) return;
    ledger.deleteRule(r.id);
    setMsg(`Deleted rule ${n}.`);
  }

  return (
    <section className="card" aria-labelledby="rules-title">
      <h3 id="rules-title">
        Rules
        {editing !== 'new' && <button type="button" className="link more" onClick={() => setEditing('new')}>+ Add rule</button>}
      </h3>
      <p className="muted">
        Rules categorize new transactions from CSV imports and syncs. They run in order and the first match wins. A category
        or merchant you set by hand is never changed by a rule.
      </p>
      {msg && <p className="notice" role="status">{msg}</p>}
      {editing === 'new' && (
        <RuleForm
          ledger={ledger} onDone={(saved) => { setEditing(null); if (saved) setMsg('Rule added. It runs last; move it up to give it priority.'); }}
        />
      )}
      {rules.length ? (
        <ol className="rules">
          {rules.map((r, i) => {
            const cat = category.get(r.categoryId);
            if (editing === r.id) {
              return <li key={r.id}><RuleForm ledger={ledger} rule={r} onDone={() => setEditing(null)} /></li>;
            }
            const n = countMatches(r, transactions);
            return (
              <li key={r.id} className="rule">
                <span className="rule-n" aria-hidden>{i + 1}</span>
                <span className="rule-body">
                  <span>
                    <span className="muted">If </span>{describeConditions(r, accountName).join(' and ')}
                    <span className="muted"> → </span>
                    <b className="rule-cat">
                      <i className="cat-swatch" style={{ background: cat?.color }} aria-hidden />{cat?.icon} {cat?.name ?? r.categoryId}
                    </b>
                    {r.renameMerchant && <><span className="muted">, rename to </span>“{r.renameMerchant}”</>}
                  </span>
                  <em>
                    Matches {plural(n, 'transaction')}
                    {' · '}
                    <button type="button" className="link" disabled={i === 0} onClick={() => ledger.moveRule(r.id, -1)}
                      aria-label={`Move rule ${i + 1} up`}>Move up</button>
                    {' · '}
                    <button type="button" className="link" disabled={i === rules.length - 1} onClick={() => ledger.moveRule(r.id, 1)}
                      aria-label={`Move rule ${i + 1} down`}>Move down</button>
                    {' · '}
                    <button type="button" className="link" onClick={() => setEditing(r.id)} aria-label={`Edit rule ${i + 1}`}>Edit</button>
                    {' · '}
                    <button type="button" className="link" onClick={() => remove(r, i + 1)} aria-label={`Delete rule ${i + 1}`}>Delete</button>
                  </em>
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="muted">
          No rules yet. Add one here, or tick “Always categorize like this” on a transaction.
        </p>
      )}
      {rules.length > 0 && <ApplyRules ledger={ledger} />}
    </section>
  );
}

interface RuleFormProps {
  ledger: Ledger;
  rule?: Rule;
  /** Called after saving (`true`) or cancelling. */
  onDone(saved: boolean): void;
}

function RuleForm({ ledger, rule, onDone }: RuleFormProps) {
  const { categories, accounts, transactions, rules } = ledger.state;
  const [d, setD] = useState<RuleDraft>(() => (rule ? ruleToDraft(rule) : emptyRuleDraft(categories[0]?.id)));
  const [error, setError] = useState<string>();
  const set = <K extends keyof RuleDraft>(k: K) => (e: { target: { value: string } }) =>
    setD((x) => ({ ...x, [k]: e.target.value }));
  const built = draftToRule(d, rule?.id ?? 'draft', categories);
  const matches = built.rule && countMatches(built.rule, transactions);

  function submit(e: FormEvent) {
    e.preventDefault();
    const out = draftToRule(d, rule?.id ?? newRuleId(rules), categories);
    if (!out.rule) return setError(out.error);
    ledger.saveRule(out.rule);
    onDone(true);
  }

  return (
    <form className="rule-form" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onDone(false)}
      aria-label={rule ? 'Edit rule' : 'New rule'}>
      <fieldset>
        <legend>When a transaction’s…</legend>
        <div className="rule-cond">
          <label className="field">Description
            <select value={d.descriptionOp} onChange={set('descriptionOp')}>
              <option value="any">any description</option>
              <option value="contains">contains</option>
              <option value="regex">matches regex</option>
            </select>
          </label>
          {d.descriptionOp !== 'any' && (
            <label className="field">Text
              <input value={d.description} onChange={set('description')} placeholder={d.descriptionOp === 'regex' ? '^AMZN.*' : 'AMZN'} autoFocus />
            </label>
          )}
        </div>
        <div className="rule-cond">
          <label className="field">Merchant
            <select value={d.merchantOp} onChange={set('merchantOp')}>
              <option value="any">any merchant</option>
              <option value="is">is</option>
              <option value="contains">contains</option>
              <option value="regex">matches regex</option>
            </select>
          </label>
          {d.merchantOp !== 'any' && (
            <label className="field">Text
              <input value={d.merchant} onChange={set('merchant')} />
            </label>
          )}
        </div>
        <div className="rule-cond">
          <label className="field">Amount
            <select value={d.amountOp} onChange={set('amountOp')}>
              <option value="any">any amount</option>
              <option value="equals">equals</option>
              <option value="range">between</option>
            </select>
          </label>
          {d.amountOp !== 'any' && (
            <label className="field">{d.amountOp === 'equals' ? 'Amount' : 'Minimum'}
              <input inputMode="decimal" value={d.amount} onChange={set('amount')} placeholder="-25.00" />
            </label>
          )}
          {d.amountOp === 'range' && (
            <label className="field">Maximum
              <input inputMode="decimal" value={d.amountMax} onChange={set('amountMax')} placeholder="-5.00" />
            </label>
          )}
        </div>
        {d.amountOp !== 'any' && <p className="muted rule-hint">Amounts are signed: money out is negative (−25.00), money in is positive.</p>}
        <div className="rule-cond">
          <label className="field">Account
            <select value={d.accountId} onChange={set('accountId')}>
              <option value="">any account</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>…matches, then</legend>
        <div className="rule-cond">
          <label className="field">Set category
            <select value={d.categoryId} onChange={set('categoryId')}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="field">Rename merchant to <em>(optional)</em>
            <input value={d.renameMerchant} onChange={set('renameMerchant')} placeholder="Keep as is" />
          </label>
        </div>
      </fieldset>
      <p className="muted" role="status">
        {matches === undefined ? 'Fill in the conditions to see what this rule matches.' : `Matches ${plural(matches, 'existing transaction')}.`}
      </p>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="row">
        <button type="submit">{rule ? 'Save rule' : 'Add rule'}</button>
        <button type="button" className="link" onClick={() => onDone(false)}>Cancel</button>
      </div>
    </form>
  );
}

/** Run every rule over existing transactions, after previewing what would change. */
function ApplyRules({ ledger }: { ledger: Ledger }) {
  const { categories, rules } = ledger.state;
  const [open, setOpen] = useState(false);
  const [includeReviewed, setIncludeReviewed] = useState(false);
  const [msg, setMsg] = useState('');
  const changes = useMemo(
    () => (open ? previewRules(ledger.state, { includeReviewed }) : []),
    [open, ledger.state.rules, ledger.state.transactions, includeReviewed],
  );
  const name = new Map(categories.map((c) => [c.id, c.name]));
  const ruleNo = new Map(rules.map((r, i) => [r.id, i + 1]));

  function apply() {
    ledger.applyRules({ includeReviewed });
    setOpen(false);
    setMsg(`Updated ${plural(changes.length, 'transaction')}.`);
  }

  return (
    <div className="apply-rules">
      <h4>Apply rules to existing transactions</h4>
      {msg && <p className="notice" role="status">{msg}</p>}
      {!open ? (
        <button type="button" className="btn ghost" onClick={() => { setMsg(''); setOpen(true); }}>Preview changes…</button>
      ) : (
        <>
          <label className="check">
            <input type="checkbox" checked={includeReviewed} onChange={(e) => setIncludeReviewed(e.target.checked)} />
            Include transactions already marked reviewed
          </label>
          <p role="status">
            <b>{plural(changes.length, 'transaction')}</b> would change.
            {' '}<span className="muted">Categories and merchants you edited by hand are kept.</span>
          </p>
          {changes.length > 0 && (
            <div className="table-scroll">
              <table className="tx preview">
                <thead><tr><th>Date</th><th>Transaction</th><th className="num">Amount</th><th>Change</th><th>Rule</th></tr></thead>
                <tbody>
                  {changes.slice(0, PREVIEW_ROWS).map(({ before: b, after: a, ruleId }) => (
                    <tr key={b.id}>
                      <td>{fmtDay(b.date)}</td>
                      <td>{b.merchant ?? b.description}</td>
                      <td className="num">{fmtMoney(b.amount)}</td>
                      <td>
                        {a.categoryId !== b.categoryId && <>{b.category} → <b>{name.get(a.categoryId!)}</b></>}
                        {a.categoryId !== b.categoryId && a.merchant !== b.merchant && '; '}
                        {a.merchant !== b.merchant && <>rename to <b>{a.merchant}</b></>}
                      </td>
                      <td>#{ruleNo.get(ruleId)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {changes.length > PREVIEW_ROWS && <p className="muted">…and {(changes.length - PREVIEW_ROWS).toLocaleString('en-US')} more.</p>}
          <div className="row">
            <button type="button" onClick={apply} disabled={!changes.length}>
              Apply to {plural(changes.length, 'transaction')}
            </button>
            <button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
