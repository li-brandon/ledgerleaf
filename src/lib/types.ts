export type AccountType = 'checking' | 'savings' | 'credit';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  /** Explicit balance from the provider; when absent it is derived from transactions. */
  balance?: number;
}

export interface Transaction {
  id: string;
  /** ISO date, YYYY-MM-DD */
  date: string;
  description: string;
  /** Negative = money out, positive = money in. */
  amount: number;
  category: string;
  accountId: string;
}

/** Monthly budget amount per category. */
export type Budgets = Record<string, number>;

export const CATEGORIES = [
  'Groceries', 'Dining', 'Transport', 'Shopping', 'Utilities', 'Rent',
  'Entertainment', 'Health', 'Travel', 'Income', 'Transfer', 'Other',
] as const;

/** Categories that never count as spending. */
export const NON_SPEND = new Set(['Income', 'Transfer']);
