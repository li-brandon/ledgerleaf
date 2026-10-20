/**
 * Auto-categorize rules: matching, priority order, validation and applying them to
 * transactions. Pure, so it can be unit tested.
 *
 * Rules are kept in priority order and the first matching rule wins. A rule sets the
 * category and can rename the merchant, but never touches a field the user edited by hand
 * (`categoryEdited` / `merchantEdited`).
 */
import { hashId } from './sync/hash';
import type { Category, LedgerState, Rule, Transaction } from './types';

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

const regexCache = new Map<string, RegExp | null>();

/** A case-insensitive RegExp for `source`, or null when it does not compile. Cached. */
export function compileRegex(source: string): RegExp | null {
  let re = regexCache.get(source);
  if (re === undefined) {
    try {
      re = new RegExp(source, 'i');
    } catch {
      re = null;
    }
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(source, re);
  }
  return re;
}

export const isValidRegex = (source: string) => compileRegex(source) !== null;

/** The texts a merchant condition looks at: the merchant and the provider's description. */
const merchantTexts = (t: Transaction) => [t.merchant ?? t.description, t.description];

/** Amounts are compared to the cent, so 12.3 equals 12.30000001. */
const cents = (n: number) => Math.round(n * 100);

/** The conditions a rule sets, used to tell an empty (match-everything) rule apart. */
const CONDITIONS = [
  'merchant', 'merchantContains', 'merchantRegex', 'descriptionContains', 'descriptionRegex',
  'amountEquals', 'amountMin', 'amountMax', 'accountId',
] as const satisfies readonly (keyof Rule)[];

/** Whether the rule's only condition is an exact merchant match (an "always categorize like this" rule). */
export const isMerchantOnly = (rule: Rule) =>
  rule.merchant !== undefined && CONDITIONS.every((k) => k === 'merchant' || rule[k] === undefined);

export const hasConditions = (rule: Rule) => CONDITIONS.some((k) => rule[k] !== undefined);

/**
 * Whether every condition the rule sets matches `t`. A rule without conditions, or with a
 * regex that does not compile, matches nothing.
 */
export function ruleMatches(rule: Rule, t: Transaction): boolean {
  if (!hasConditions(rule)) return false;
  if (rule.accountId !== undefined && rule.accountId !== t.accountId) return false;
  if (rule.amountEquals !== undefined && cents(t.amount) !== cents(rule.amountEquals)) return false;
  if (rule.amountMin !== undefined && t.amount < rule.amountMin) return false;
  if (rule.amountMax !== undefined && t.amount > rule.amountMax) return false;
  if (rule.merchant !== undefined) {
    const m = norm(rule.merchant);
    if (!merchantTexts(t).some((s) => norm(s) === m)) return false;
  }
  if (rule.merchantContains !== undefined) {
    const m = norm(rule.merchantContains);
    if (!merchantTexts(t).some((s) => norm(s).includes(m))) return false;
  }
  if (rule.merchantRegex !== undefined) {
    const re = compileRegex(rule.merchantRegex);
    if (!re || !merchantTexts(t).some((s) => re.test(s))) return false;
  }
  if (rule.descriptionContains !== undefined && !norm(t.description).includes(norm(rule.descriptionContains))) return false;
  if (rule.descriptionRegex !== undefined) {
    const re = compileRegex(rule.descriptionRegex);
    if (!re || !re.test(t.description)) return false;
  }
  return true;
}

/** The first rule (rules are in priority order) matching `t`. */
export const findRule = (rules: readonly Rule[], t: Transaction) => rules.find((r) => ruleMatches(r, t));

/**
 * `t` with the first matching rule applied: its category unless the user chose one, and
 * its merchant name unless the user renamed it. Returns `t` itself when nothing changes.
 */
export function applyRules(rules: readonly Rule[], t: Transaction): Transaction {
  const rule = findRule(rules, t);
  if (!rule) return t;
  const setCategory = !t.categoryEdited && rule.categoryId !== t.categoryId;
  const rename = rule.renameMerchant?.trim();
  const setMerchant = !!rename && !t.merchantEdited && rename !== t.merchant;
  if (!setCategory && !setMerchant) return t;
  const next = { ...t };
  if (setCategory) next.categoryId = rule.categoryId;
  if (setMerchant) next.merchant = rename;
  return next;
}

/** One transaction a rule run would change. */
export interface RuleChange {
  before: Transaction;
  after: Transaction;
  ruleId: string;
}

export interface ApplyOptions {
  /** Also change transactions already marked reviewed (fields the user edited are still kept). */
  includeReviewed?: boolean;
}

/** The transactions that applying the rules to the ledger would change, in ledger order. */
export function previewRules(state: Pick<LedgerState, 'rules' | 'transactions'>, opts: ApplyOptions = {}): RuleChange[] {
  const out: RuleChange[] = [];
  for (const t of state.transactions) {
    if (t.reviewed && !opts.includeReviewed) continue;
    const after = applyRules(state.rules, t);
    if (after !== t) out.push({ before: t, after, ruleId: findRule(state.rules, t)!.id });
  }
  return out;
}

/**
 * Apply the rules to existing transactions (see {@link previewRules}), keeping category
 * names in step with the ids. Returns `state` itself when nothing changes.
 */
export function applyRulesToLedger(state: LedgerState, opts: ApplyOptions = {}): LedgerState {
  const changes = previewRules(state, opts);
  if (!changes.length) return state;
  const name = new Map(state.categories.map((c) => [c.id, c.name]));
  const after = new Map(changes.map((c) => [c.before.id, c.after]));
  const transactions = state.transactions.map((t) => {
    const next = after.get(t.id);
    return next ? { ...next, category: name.get(next.categoryId!) ?? next.category } : t;
  });
  return { ...state, transactions };
}

/** A new rule id, unique among `rules`. */
export function newRuleId(rules: readonly Rule[], seed = `${Date.now()}-${Math.random()}`): string {
  const taken = new Set(rules.map((r) => r.id));
  let id = `rule-${hashId(seed)}`;
  for (let n = 1; taken.has(id); n++) id = `rule-${hashId(`${seed}#${n}`)}`;
  return id;
}

/**
 * Why `rule` cannot be saved, or undefined if it is fine: it needs at least one
 * condition, valid regexes, a sensible amount range and a known category.
 */
export function validateRule(rule: Rule, categories: readonly Category[]): string | undefined {
  if (!hasConditions(rule)) return 'Add at least one condition.';
  for (const [k, label] of [['merchantRegex', 'Merchant'], ['descriptionRegex', 'Description']] as const) {
    const src = rule[k];
    if (src !== undefined && !isValidRegex(src)) return `${label} pattern is not a valid regular expression.`;
  }
  for (const k of ['amountEquals', 'amountMin', 'amountMax'] as const) {
    if (rule[k] !== undefined && !Number.isFinite(rule[k])) return 'Amounts must be numbers.';
  }
  if (rule.amountMin !== undefined && rule.amountMax !== undefined && rule.amountMin > rule.amountMax) {
    return 'The minimum amount is above the maximum.';
  }
  if (!categories.some((c) => c.id === rule.categoryId)) return 'Choose a category.';
  return undefined;
}

/** Add `rule`, or replace the rule with its id in place (keeping its priority). New rules go last. */
export function upsertRule(rules: readonly Rule[], rule: Rule): Rule[] {
  const i = rules.findIndex((r) => r.id === rule.id);
  return i < 0 ? [...rules, rule] : rules.map((r, j) => (j === i ? rule : r));
}

export const removeRule = (rules: readonly Rule[], id: string): Rule[] => rules.filter((r) => r.id !== id);

/**
 * Move a rule up (`by < 0`, higher priority) or down. Returns `rules` itself when the id is
 * unknown or the rule is already at that end.
 */
export function moveRule(rules: Rule[], id: string, by: number): Rule[] {
  const i = rules.findIndex((r) => r.id === id);
  const j = Math.max(0, Math.min(rules.length - 1, i + by));
  if (i < 0 || i === j) return rules;
  const out = [...rules];
  const [r] = out.splice(i, 1);
  out.splice(j, 0, r);
  return out;
}

/** Keep only well-formed fields of a stored rule; undefined when it is unusable. */
export function normalizeRule(v: unknown, categoryIds: ReadonlySet<string>): Rule | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.categoryId !== 'string' || !categoryIds.has(r.categoryId)) return undefined;
  const out: Rule = { id: r.id, categoryId: r.categoryId };
  for (const k of ['merchant', 'merchantContains', 'merchantRegex', 'descriptionContains', 'descriptionRegex', 'accountId', 'renameMerchant'] as const) {
    const s = r[k];
    if (typeof s === 'string' && s.trim()) out[k] = s;
  }
  for (const k of ['amountEquals', 'amountMin', 'amountMax'] as const) {
    const n = r[k];
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  }
  return out;
}
