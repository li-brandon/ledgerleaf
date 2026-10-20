// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csvLedger, renderApp, stored } from '../../test/app';

const CSV = [
  'date,description,amount,category',
  '2026-09-10,Corner Grocer,-60,Groceries',
  '2026-10-05,Corner Grocer,-130,Groceries',
  '2026-10-06,Noodle Bar,-20,Dining',
].join('\n');

/** The budget card for a category. */
const card = (name: string) => within(screen.getByText(name, { selector: '.budget-name' }).closest<HTMLElement>('.budget')!);
const fig = (c: ReturnType<typeof card>, term: string) => c.getByText(term, { selector: 'dt' }).nextElementSibling;
const budgetsFor = async (categoryId: string) =>
  (await stored()).budgets.filter((b) => b.categoryId === categoryId).map(({ month, amount, rollover }) => ({ month, amount, rollover }));

async function open() {
  const user = userEvent.setup();
  // Without the default budgets a fresh ledger starts with, so every budget here is set by the test.
  await renderApp({ ...(await csvLedger(CSV)), budgets: [] }, '#/budgets');
  return user;
}

describe('budget editing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 20, 12));
  });
  afterEach(() => vi.useRealTimers());

  it('lists spending without a budget and adds a budget from the chips', async () => {
    const user = await open();
    expect(screen.getByText('October 2026')).toBeInTheDocument();
    const groceries = card('Groceries');
    expect(groceries.getByText('No budget')).toBeInTheDocument();
    expect(fig(groceries, 'Spent')).toHaveTextContent('$130.00');

    await user.click(screen.getByRole('button', { name: '+ Shopping' }));
    const shopping = card('Shopping');
    expect(shopping.getByRole('spinbutton')).toHaveValue(100);
    expect(shopping.getByText('On track')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Shopping' })).toBeNull();
    await waitFor(async () => expect(await budgetsFor('shopping')).toEqual([{ month: '2026-10', amount: 100, rollover: false }]));
  });

  it('updates status and totals as the limit is edited', async () => {
    const user = await open();
    const input = card('Groceries').getByRole('spinbutton');
    await user.type(input, '150');
    expect(card('Groceries').getByText('Close to limit')).toBeInTheDocument();
    expect(fig(card('Groceries'), 'Left')).toHaveTextContent('$20.00');

    await user.clear(input);
    await user.type(input, '100');
    expect(card('Groceries').getByText('Over by $30.00')).toBeInTheDocument();
    expect(fig(card('Groceries'), 'Over')).toHaveTextContent('$30.00');
    const total = within(screen.getByLabelText('Totals'));
    expect(fig(total, 'Budgeted')).toHaveTextContent('$100.00');
    expect(fig(total, 'Spent')).toHaveTextContent('$150.00');
    expect(screen.getByText(/spent of \$100\.00 available/)).toBeInTheDocument();
    await waitFor(async () => expect(await budgetsFor('groceries')).toEqual([{ month: '2026-10', amount: 100, rollover: false }]));
  });

  it('rolls what is left in one month into the next', async () => {
    const user = await open();
    await user.click(screen.getByRole('link', { name: /Previous month/ }));
    await screen.findByText('September 2026');
    expect(screen.getByRole('link', { name: 'This month' })).toBeInTheDocument();

    await user.type(card('Groceries').getByRole('spinbutton'), '100');
    await user.click(card('Groceries').getByLabelText('Roll over'));
    expect(fig(card('Groceries'), 'Left')).toHaveTextContent('$40.00');

    await user.click(screen.getByRole('link', { name: /Next month/ }));
    await screen.findByText('October 2026');
    // Editing a past month pins the month after it to what it was (no budget), but the $40 left still carries over.
    expect(card('Groceries').getByRole('spinbutton')).toHaveValue(null);
    expect(card('Groceries').getByLabelText('Roll over')).not.toBeChecked();
    expect(card('Groceries').getByText('+$40.00 rolled over from Sep')).toBeInTheDocument();
    expect(card('Groceries').getByText('Over by $90.00')).toBeInTheDocument();

    await user.type(card('Groceries').getByRole('spinbutton'), '100');
    expect(fig(card('Groceries'), 'Available')).toHaveTextContent('$140.00');
    expect(fig(card('Groceries'), 'Left')).toHaveTextContent('$10.00');
    expect(fig(within(screen.getByLabelText('Totals')), 'Rolled over')).toHaveTextContent('+$40.00');
    await waitFor(async () => expect(await budgetsFor('groceries')).toEqual([
      { month: '2026-09', amount: 100, rollover: true },
      { month: '2026-10', amount: 100, rollover: false },
    ]));

    // Turning rollover off in September stops the carry into October.
    await user.click(screen.getByRole('link', { name: /Previous month/ }));
    await screen.findByText('September 2026');
    await user.click(card('Groceries').getByLabelText('Roll over'));
    await user.click(screen.getByRole('link', { name: 'This month' }));
    await screen.findByText('October 2026');
    expect(card('Groceries').queryByText(/rolled over/)).toBeNull();
    expect(card('Groceries').getByText('Over by $30.00')).toBeInTheDocument();
  });
});
