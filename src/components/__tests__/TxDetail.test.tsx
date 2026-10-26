// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { csvLedger, renderApp, stored } from '../../test/app';

const CSV = [
  'date,description,amount,category',
  '2026-10-01,SQ *BLUE BOTTLE,-5.25,Shopping',
  '2026-10-02,PAYROLL ACME,2500,Income',
  '2026-10-05,SQ *BLUE BOTTLE,-4.75,Shopping',
].join('\n');

const row = (description: string, nth = 0) =>
  screen.getAllByRole('button', { name: new RegExp(description.replace(/[*]/g, '\\*')) })
    .filter((b) => b.classList.contains('tx-open'))[nth];
const detail = () => within(screen.getByRole('complementary', { name: /./ }));
const txBy = async (date: string) => (await stored()).transactions.find((t) => t.date === date)!;

async function open() {
  const user = userEvent.setup();
  await renderApp(await csvLedger(CSV), '#/transactions');
  return user;
}

describe('transaction detail editing', () => {
  it('opens a row in the detail panel and closes it again', async () => {
    const user = await open();
    await user.click(row('PAYROLL ACME'));
    expect(screen.getByRole('heading', { level: 2, name: 'PAYROLL ACME' })).toBeInTheDocument();
    expect(detail().getByText(/Everyday/)).toBeInTheDocument();
    expect(row('PAYROLL ACME')).toHaveAttribute('aria-current', 'true');

    await user.click(detail().getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('renames the merchant and saves notes when the fields lose focus', async () => {
    const user = await open();
    await user.click(row('PAYROLL ACME'));
    const merchant = detail().getByLabelText('Merchant');
    expect(merchant).toHaveValue('PAYROLL ACME');
    await user.clear(merchant);
    await user.type(merchant, 'Acme Corp{Enter}');
    expect(merchant).not.toHaveFocus();
    await user.type(detail().getByLabelText('Notes'), 'October salary');
    await user.tab();

    expect(row('PAYROLL ACME')).toHaveTextContent('Acme Corp · Everyday');
    expect(row('PAYROLL ACME')).toHaveTextContent('October salary');
    await waitFor(async () => expect(await txBy('2026-10-02')).toMatchObject({
      merchant: 'Acme Corp', merchantEdited: true, notes: 'October salary',
    }));
  });

  it('a blank merchant falls back to the description', async () => {
    const user = await open();
    await user.click(row('PAYROLL ACME'));
    const merchant = detail().getByLabelText('Merchant');
    await user.clear(merchant);
    await user.tab();
    expect(merchant).toHaveValue('PAYROLL ACME');
    await waitFor(async () => expect((await txBy('2026-10-02')).merchantEdited).toBeUndefined());
  });

  it('changes the category, and "always" turns it into a rule for the merchant', async () => {
    const user = await open();
    await user.click(row('SQ *BLUE BOTTLE', 0));
    expect(detail().getByRole('heading', { level: 2 })).toHaveTextContent('SQ *BLUE BOTTLE');
    const category = detail().getByLabelText('Category');
    await user.selectOptions(category, 'Dining');
    expect(category).toHaveValue('Dining');
    // Only this transaction changed so far.
    expect(row('SQ *BLUE BOTTLE', 0)).toHaveTextContent('Dining');
    expect(row('SQ *BLUE BOTTLE', 1)).toHaveTextContent('Shopping');

    await user.click(detail().getByLabelText(/Always categorize like this/));
    expect(detail().getByLabelText(/Always categorize like this/)).toBeChecked();
    expect(row('SQ *BLUE BOTTLE', 1)).toHaveTextContent('Dining');
    await waitFor(async () => {
      const s = await stored();
      expect(s.rules).toHaveLength(1);
      expect(s.transactions.filter((t) => t.description === 'SQ *BLUE BOTTLE').map((t) => t.category)).toEqual(['Dining', 'Dining']);
    });

    await user.click(detail().getByLabelText(/Always categorize like this/));
    await waitFor(async () => expect((await stored()).rules).toHaveLength(0));
  });

  it('toggles reviewed from the button and the keyboard', async () => {
    const user = await open();
    await user.click(row('PAYROLL ACME'));
    const toggle = detail().getByRole('button', { name: 'Mark reviewed' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(detail().getByRole('button', { name: '✓ Reviewed' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(async () => expect((await txBy('2026-10-02')).reviewed).toBe(true));

    // `r` marks the open row reviewed and moves on to the next one; Escape closes the panel.
    await user.click(row('SQ *BLUE BOTTLE', 0));
    await user.keyboard('r');
    await waitFor(async () => expect((await txBy('2026-10-05')).reviewed).toBe(true));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('PAYROLL ACME');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('sets the category of several selected transactions at once', async () => {
    const user = await open();
    await user.click(screen.getByLabelText('Select PAYROLL ACME'));
    await user.click(screen.getAllByLabelText('Select SQ *BLUE BOTTLE')[0]);
    const bulk = within(screen.getByRole('group', { name: 'Bulk actions' }));
    expect(bulk.getByText('2 selected')).toBeInTheDocument();
    await user.selectOptions(bulk.getByLabelText('Set category for selected transactions'), 'Transfer');
    await waitFor(async () => {
      const cats = (await stored()).transactions.map((t) => [t.date, t.category]).sort();
      expect(cats).toEqual([['2026-10-01', 'Shopping'], ['2026-10-02', 'Transfer'], ['2026-10-05', 'Transfer']]);
    });
  });
});

describe('deleting a transaction', () => {
  afterEach(() => vi.useRealTimers());

  const toast = () => screen.getByText(/^Deleted /).closest<HTMLElement>('[role=status]')!;

  it('asks first; cancelling keeps it', async () => {
    const user = await open();
    const before = await stored();
    await user.click(row('PAYROLL ACME'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(detail().getByRole('button', { name: 'Delete transaction' }));
    expect(confirm).toHaveBeenCalledWith("Delete PAYROLL ACME ($2,500.00 on Fri, Oct 2, 2026)? Re-importing or syncing won't add it back.");
    expect(row('PAYROLL ACME')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'PAYROLL ACME' })).toBeInTheDocument();
    expect(screen.queryByText(/^Deleted /)).toBeNull();
    expect(await stored()).toEqual(before);
  });

  it('deletes it once confirmed, closes the detail and offers to undo, which restores it', async () => {
    const user = await open();
    const payroll = await txBy('2026-10-02');
    await user.click(row('PAYROLL ACME'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(detail().getByRole('button', { name: 'Delete transaction' }));

    expect(await screen.findByText('Deleted PAYROLL ACME.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /PAYROLL ACME/ })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    const deleted = await stored();
    expect(deleted.transactions.map((t) => t.description)).not.toContain('PAYROLL ACME');
    expect(deleted.deletedTransactions).toEqual([expect.objectContaining({ id: payroll.id })]);

    await user.click(within(toast()).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText(/PAYROLL ACME/, { selector: '.tx-desc' })).toBeInTheDocument();
    expect(screen.queryByText(/^Deleted /)).toBeNull();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    await waitFor(async () => {
      const after = await stored();
      expect(after.transactions.find((t) => t.id === payroll.id)).toEqual(payroll);
      expect(after.deletedTransactions).toBeUndefined();
    });
  });

  it('the undo toast goes away by itself after a few seconds, and the delete stays', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    const user = await open();
    await user.click(row('PAYROLL ACME'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(detail().getByRole('button', { name: 'Delete transaction' }));
    expect(await screen.findByText('Deleted PAYROLL ACME.')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText('Deleted PAYROLL ACME.')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText('Deleted PAYROLL ACME.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect((await stored()).transactions.map((t) => t.description)).not.toContain('PAYROLL ACME');
  });

  it('keeps it and says so when the delete cannot be saved', async () => {
    const user = await open();
    const before = await stored();
    await user.click(row('PAYROLL ACME'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementationOnce(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    await user.click(detail().getByRole('button', { name: 'Delete transaction' }));
    expect(await detail().findByRole('alert')).toHaveTextContent('The transaction could not be deleted; nothing was changed.');
    expect(detail().getByRole('button', { name: 'Delete transaction' })).toBeEnabled();
    expect(row('PAYROLL ACME')).toBeInTheDocument();
    expect(screen.queryByText(/^Deleted /)).toBeNull();
    expect(await stored()).toEqual(before);
  });
});
