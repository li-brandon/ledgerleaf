// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp, stored } from '../../test/app';

const BANK_CSV = [
  'Date,Description,Amount,Category',
  '10/01/2026,Corner Grocer,-42.10,Groceries',
  '10/02/2026,Paycheck,2500.00,Income',
  '10/03/2026,Bus pass,-30,Transport',
].join('\n');

const csvFile = (text: string, name = 'fernway_checking.csv') => new File([text], name, { type: 'text/csv' });

/** The CSV import card on Connections. */
const card = () => screen.getByRole('heading', { name: /CSV import/ }).closest('section')!;
const fileInput = () => card().querySelector<HTMLInputElement>('input[type=file]')!;

describe('CSV import flow', () => {
  it('detects the columns, previews the rows and imports them into a new account', async () => {
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');

    await user.upload(fileInput(), csvFile(BANK_CSV));
    const ui = within(card());
    expect(await ui.findByText('fernway_checking.csv')).toBeInTheDocument();
    expect(ui.getByText('Detected from the header row')).toBeInTheDocument();
    // The account name comes from the file name; columns are detected from the headers.
    expect(ui.getByLabelText('Name')).toHaveValue('fernway checking');
    expect(ui.getByLabelText(/^Date/)).toHaveValue('Date');
    expect(ui.getByLabelText(/^Description/)).toHaveValue('Description');
    expect(ui.getByLabelText(/^Amount$/)).toHaveValue('Amount');
    expect(ui.getByLabelText(/^Category/)).toHaveValue('Category');
    expect(ui.getAllByRole('row')).toHaveLength(4);
    expect(ui.getByText('3 rows ready to import.')).toBeInTheDocument();

    await user.clear(ui.getByLabelText('Name'));
    await user.type(ui.getByLabelText('Name'), 'Everyday');
    await user.selectOptions(ui.getByLabelText('Type'), 'savings');
    await user.click(ui.getByRole('button', { name: 'Import 3 rows' }));

    const summary = await ui.findByRole('status');
    expect(summary).toHaveTextContent('fernway_checking.csv imported into Everyday.');
    expect(within(summary).getByText('Added').nextSibling).toHaveTextContent('3');
    expect(within(summary).getByText('Duplicates skipped').nextSibling).toHaveTextContent('0');

    const state = await stored();
    expect(state.accounts).toEqual([expect.objectContaining({ id: 'csv-everyday', name: 'Everyday', type: 'savings' })]);
    expect(state.transactions.map((t) => [t.date, t.description, t.amount, t.category]).sort()).toEqual([
      ['2026-10-01', 'Corner Grocer', -42.1, 'Groceries'],
      ['2026-10-02', 'Paycheck', 2500, 'Income'],
      ['2026-10-03', 'Bus pass', -30, 'Transport'],
    ]);
    expect(state.importMappings?.['csv-everyday']).toMatchObject({ date: 'Date', amount: 'Amount', category: 'Category' });
  });

  it('reuses the saved mapping for a known layout and skips rows already imported', async () => {
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');
    await user.upload(fileInput(), csvFile(BANK_CSV));
    await user.click(await within(card()).findByRole('button', { name: 'Import 3 rows' }));
    await within(card()).findByRole('status');

    await user.upload(fileInput(), csvFile(`${BANK_CSV}\n10/04/2026,Bakery,-6.50,Dining`, 'october.csv'));
    const ui = within(card());
    expect(await ui.findByText('Saved mapping for this account')).toBeInTheDocument();
    expect(ui.getByLabelText('Account')).toHaveValue('csv-fernway-checking');
    await user.click(ui.getByRole('button', { name: 'Import 4 rows' }));

    const summary = await ui.findByRole('status');
    expect(within(summary).getByText('Added').nextSibling).toHaveTextContent('1');
    expect(within(summary).getByText('Duplicates skipped').nextSibling).toHaveTextContent('3');
    expect((await stored()).transactions).toHaveLength(4);
  });

  it('handles split debit/credit columns, flipped signs and rows with errors', async () => {
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');
    const csv = ['Date,Memo,Withdrawal,Deposit', '2026-10-01,Coffee,4.50,', '2026-10-02,Refund,,12', 'not a date,Broken,1,'].join('\n');
    await user.upload(fileInput(), csvFile(csv, 'card.csv'));
    const ui = within(card());
    await ui.findByText('card.csv');

    expect(ui.getByLabelText('Amounts are in')).toHaveValue('split');
    expect(ui.getByText((_, el) => el?.tagName === 'P' && /^2 rows ready to import/.test(el.textContent ?? '')))
      .toHaveTextContent('2 rows ready to import, 1 with errors (first: row 4, Unreadable date "not a date").');
    await user.click(ui.getByRole('button', { name: 'Import 2 rows' }));

    const summary = await ui.findByRole('status');
    expect(within(summary).getByText('Rows with errors').nextSibling).toHaveTextContent('1');
    expect(ui.getByRole('button', { name: 'Download error rows' })).toBeInTheDocument();
    const amounts = Object.fromEntries((await stored()).transactions.map((t) => [t.description, t.amount]));
    expect(amounts).toEqual({ Coffee: -4.5, Refund: 12 });
  });

  it('detects a decimal comma, flags ambiguous amounts and lets the user choose the separator', async () => {
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');
    const csv = ['Date,Description,Amount', '2026-10-01,Rent,"-1,234"', '2026-10-02,Tea,-3'].join('\n');
    await user.upload(fileInput(), csvFile(csv, 'eu.csv'));
    const ui = within(card());
    await ui.findByText('eu.csv');

    const separator = ui.getByLabelText('Decimal separator');
    expect(separator).toHaveValue('');
    expect(within(separator).getByRole('option', { name: 'Detect (unclear from the rows)' })).toBeInTheDocument();
    expect(ui.getByText((_, el) => el?.tagName === 'P' && /^1 rows ready to import/.test(el.textContent ?? '')))
      .toHaveTextContent('1 rows ready to import, 1 with errors (first: row 2, Ambiguous amount "-1,234": choose the decimal separator).');

    await user.selectOptions(separator, ',');
    expect(ui.getByText('2 rows ready to import.')).toBeInTheDocument();
    await user.click(ui.getByRole('button', { name: 'Import 2 rows' }));
    await ui.findByRole('status');
    const state = await stored();
    expect(state.transactions.map((t) => t.amount).sort()).toEqual([-1.23, -3]);
    expect(state.importMappings?.['csv-eu']).toMatchObject({ decimal: ',' });

    await user.upload(fileInput(), csvFile('Date,Description,Amount\n2026-10-03,Cake,"4,50"', 'eu2.csv'));
    await ui.findByText('eu2.csv');
    expect(ui.getByLabelText('Decimal separator')).toHaveValue(',');
  });

  it('blocks the import until required columns are mapped and the new account is named', async () => {
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');
    await user.upload(fileInput(), csvFile('When,What,How much\n10/01/2026,Tea,-3'));
    const ui = within(card());
    await ui.findByText('fernway_checking.csv');

    const importBtn = () => ui.getByRole('button', { name: /^Import/ });
    await user.selectOptions(ui.getByLabelText(/^Date/), '');
    expect(ui.getByRole('alert')).toHaveTextContent('Choose the column that holds the date.');
    expect(importBtn()).toBeDisabled();
    await user.selectOptions(ui.getByLabelText(/^Date/), 'When');
    await user.selectOptions(ui.getByLabelText(/^Description/), 'What');
    // No amount column was recognised, so it starts as separate debit/credit columns.
    expect(ui.getByRole('alert')).toHaveTextContent('Choose a debit or credit column.');
    await user.selectOptions(ui.getByLabelText('Amounts are in'), 'single');
    await user.selectOptions(ui.getByLabelText(/^Amount$/), 'How much');
    expect(ui.queryByRole('alert')).toBeNull();

    await user.clear(ui.getByLabelText('Name'));
    expect(ui.getByRole('alert')).toHaveTextContent('Name the new account.');
    expect(importBtn()).toBeDisabled();

    await user.type(ui.getByLabelText('Name'), 'Tea fund');
    await user.click(ui.getByLabelText(/flip signs/));
    await user.click(importBtn());
    await ui.findByRole('status');
    expect((await stored()).transactions.map((t) => t.amount)).toEqual([3]);
  });

  it('rejects a file with no rows and can be cancelled', async () => {
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');
    await user.upload(fileInput(), csvFile('Date,Description,Amount\n', 'empty.csv'));
    expect(await within(card()).findByRole('alert')).toHaveTextContent('empty.csv has no rows to import.');

    await user.upload(fileInput(), csvFile(BANK_CSV));
    await user.click(await within(card()).findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(within(card()).queryByText('fernway_checking.csv')).toBeNull());
    expect((await stored()).transactions).toHaveLength(0);
  });
});
