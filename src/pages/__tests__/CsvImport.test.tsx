// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { emptyLedger } from '../../lib/migrate';
import { DEFAULT_SETTINGS } from '../../lib/settings';
import { renderApp, stored } from '../../test/app';

// "10/13/2026" shows the dates are month first.
const BANK_CSV = [
  'Date,Description,Amount,Category',
  '10/13/2026,Corner Grocer,-42.10,Groceries',
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
    expect(ui.getByLabelText(/^Date$/)).toHaveValue('Date');
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
      ['2026-10-02', 'Paycheck', 2500, 'Income'],
      ['2026-10-03', 'Bus pass', -30, 'Transport'],
      ['2026-10-13', 'Corner Grocer', -42.1, 'Groceries'],
    ]);
    expect(state.importMappings?.['csv-everyday']).toMatchObject({ date: 'Date', amount: 'Amount', category: 'Category', dateOrder: 'MDY' });
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

  it('warns about and skips rows that match existing transactions except for sign', async () => {
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');
    await user.upload(fileInput(), csvFile(BANK_CSV));
    await user.click(await within(card()).findByRole('button', { name: 'Import 3 rows' }));
    await within(card()).findByRole('status');
    const before = (await stored()).transactions.map((t) => [t.description, t.amount]);

    await user.upload(fileInput(), csvFile(`${BANK_CSV}\n10/04/2026,Bakery,-6.50,Dining`, 'october.csv'));
    const ui = within(card());
    await ui.findByText('october.csv');
    expect(ui.queryByText(/opposite-sign duplicates/)).toBeNull();
    await user.click(ui.getByLabelText(/flip signs/));

    expect(ui.getByText(/^3 opposite-sign duplicates of existing transactions will be skipped/)).toBeInTheDocument();
    const table = within(card().querySelector<HTMLTableElement>('table.preview')!);
    const status = (description: string) => within(table.getByText(description).closest('tr')!).getAllByRole('cell').at(-1);
    for (const d of ['Corner Grocer', 'Paycheck', 'Bus pass']) expect(status(d)).toHaveTextContent('Opposite-sign duplicate');
    expect(status('Bakery')).toHaveTextContent('Ready');
    expect(ui.getByText('1 rows ready to import.')).toBeInTheDocument();
    await user.click(ui.getByRole('button', { name: 'Import 1 rows' }));

    const summary = await ui.findByRole('status');
    expect(within(summary).getByText('Added').nextSibling).toHaveTextContent('1');
    expect(within(summary).getByText('Opposite-sign duplicates skipped').nextSibling).toHaveTextContent('3');
    expect((await stored()).transactions.map((t) => [t.description, t.amount]).sort())
      .toEqual([...before, ['Bakery', 6.5]].sort());
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

  it('flags ambiguous amounts and lets the user choose the separator', async () => {
    const user = userEvent.setup();
    // CHF has no usual separator, so no one-click choice is offered.
    await renderApp({ ...emptyLedger(), settings: { ...DEFAULT_SETTINGS, currency: 'CHF' } }, '#/connections');
    const csv = ['Date,Description,Amount', '2026-10-01,Rent,"-1,234"', '2026-10-02,Tea,-3'].join('\n');
    await user.upload(fileInput(), csvFile(csv, 'eu.csv'));
    const ui = within(card());
    await ui.findByText('eu.csv');

    const separator = ui.getByLabelText('Decimal separator');
    expect(separator).toHaveValue('');
    expect(within(separator).getByRole('option', { name: 'Detect (unclear from the rows)' })).toBeInTheDocument();
    expect(ui.getByText((_, el) => el?.tagName === 'P' && /^1 rows ready to import/.test(el.textContent ?? '')))
      .toHaveTextContent('1 rows ready to import, 1 with errors (first: row 2, Ambiguous amount "-1,234": choose the decimal separator).');
    expect(ui.queryByRole('button', { name: /for ambiguous rows/ })).toBeNull();
    expect(ui.queryByRole('button', { name: /for ambiguous dates/ })).toBeNull();

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

  it('saves the separator the rows show, and offers the currency\'s one for ambiguous rows without guessing', async () => {
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');
    const ui = within(card());

    await user.upload(fileInput(), csvFile('Date,Description,Amount\n2026-10-01,Tea,"-3,50"\n2026-10-02,Rent,"-1.234"', 'eu.csv'));
    await ui.findByText('eu.csv');
    const separator = ui.getByLabelText('Decimal separator');
    expect(separator).toHaveValue('');
    expect(within(separator).getByRole('option', { name: 'Detect (Comma: 1.234,56)' })).toBeInTheDocument();
    await user.click(ui.getByRole('button', { name: 'Import 2 rows' }));
    await ui.findByRole('status');

    await user.upload(fileInput(), csvFile('Date,Payee,Amount\n2026-10-01,Rent,"-1,500"\n2026-10-02,Pay,"3,200"', 'us.csv'));
    await ui.findByText('us.csv');
    expect(ui.getByLabelText('Account')).toHaveValue('__new__');
    expect(ui.getByLabelText('Decimal separator')).toHaveValue('');
    expect(within(ui.getByLabelText('Decimal separator')).getByRole('option', { name: 'Detect (unclear from the rows)' }))
      .toBeInTheDocument();
    // The display currency (USD) does not settle "-1,500"; it is only offered.
    expect(ui.getByText((_, el) => el?.tagName === 'P' && /^0 rows ready to import/.test(el.textContent ?? '')))
      .toHaveTextContent('0 rows ready to import, 2 with errors (first: row 2, Ambiguous amount "-1,500": choose the decimal separator).');
    await user.click(ui.getByRole('button', { name: 'Use Point: 1,234.56 (usual for USD) for ambiguous rows' }));
    expect(ui.getByLabelText('Decimal separator')).toHaveValue('.');
    expect(ui.getByText('2 rows ready to import.')).toBeInTheDocument();
    expect(ui.queryByRole('button', { name: /for ambiguous rows/ })).toBeNull();
    await user.click(ui.getByRole('button', { name: 'Import 2 rows' }));
    await ui.findByRole('status');

    const state = await stored();
    expect(state.transactions.map((t) => t.amount).sort((a, b) => a - b)).toEqual([-1500, -1234, -3.5, 3200]);
    expect(state.importMappings?.['csv-eu']).toMatchObject({ decimal: ',' });
    expect(state.importMappings?.['csv-us']).toMatchObject({ decimal: '.' });
  });

  it('does not let a saved separator settle ambiguous rows until it is confirmed', async () => {
    const user = userEvent.setup();
    await renderApp({
      ...emptyLedger(),
      accounts: [{ id: 'giro', name: 'Giro', type: 'checking' }],
      importMappings: { giro: { date: 'Date', description: 'Description', amount: 'Amount', decimal: ',' } },
    }, '#/connections');
    const ui = within(card());
    await user.upload(fileInput(), csvFile('Date,Description,Amount\n2026-10-01,Pay,"1,234"\n2026-10-02,Rent,"-2,500"\n2026-10-03,Tea,-3', 'giro.csv'));
    await ui.findByText('giro.csv');
    expect(ui.getByLabelText('Account')).toHaveValue('giro');
    expect(ui.getByLabelText('Decimal separator')).toHaveValue(',');
    expect(ui.getByText((_, el) => el?.tagName === 'P' && /^1 rows ready to import/.test(el.textContent ?? '')))
      .toHaveTextContent('1 rows ready to import, 2 with errors (first: row 2, Ambiguous amount "1,234": choose the decimal separator).');
    expect(ui.getByRole('button', { name: 'Use Point: 1,234.56 (usual for USD) for ambiguous rows' })).toBeInTheDocument();

    await user.click(ui.getByRole('button', { name: 'Use Comma: 1.234,56 (saved for this account) for ambiguous rows' }));
    expect(ui.getByText('3 rows ready to import.')).toBeInTheDocument();
    expect(ui.queryByRole('button', { name: /for ambiguous rows/ })).toBeNull();
    await user.click(ui.getByRole('button', { name: 'Import 3 rows' }));
    await ui.findByRole('status');
    expect((await stored()).transactions.map((t) => t.amount).sort((a, b) => a - b)).toEqual([-3, -2.5, 1.23]);
  });

  it('warns when the rows show a different separator from the selected one', async () => {
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');
    const ui = within(card());
    await user.upload(fileInput(), csvFile('Date,Description,Amount\n2026-10-01,Tea,"-3,50"', 'eu.csv'));
    await user.click(await ui.findByRole('button', { name: 'Import 1 rows' }));
    await ui.findByRole('status');

    // Same layout, so the account's saved ',' is offered, but these rows are written with a point.
    await user.upload(fileInput(), csvFile('Date,Description,Amount\n2026-10-02,Rent,"-1,234.56"\n2026-10-03,Pay,"1,234"', 'eu2.csv'));
    await ui.findByText('eu2.csv');
    expect(ui.getByLabelText('Decimal separator')).toHaveValue(',');
    expect(ui.getByText(/^This file's amounts look like/))
      .toHaveTextContent('This file\'s amounts look like Point: 1,234.56, but Comma: 1.234,56 is selected.');

    await user.click(ui.getByRole('button', { name: 'Use Point: 1,234.56' }));
    expect(ui.getByLabelText('Decimal separator')).toHaveValue('.');
    expect(ui.queryByText(/^This file's amounts look like/)).toBeNull();
    await user.click(ui.getByRole('button', { name: 'Import 2 rows' }));
    await ui.findByRole('status');
    expect((await stored()).transactions.map((t) => t.amount).sort((a, b) => a - b)).toEqual([-1234.56, -3.5, 1234]);
  });

  it('detects dotted day-first dates and saves the order with the import', async () => {
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');
    const ui = within(card());
    await user.upload(fileInput(), csvFile('Date,Description,Amount\n31.12.2026,Rent,-1000\n01.02.2026,Tea,-3', 'eu.csv'));
    await ui.findByText('eu.csv');
    const order = ui.getByLabelText('Date order');
    expect(order).toHaveValue('');
    expect(within(order).getByRole('option', { name: 'Detect (Day first: 31/12/2026)' })).toBeInTheDocument();
    await user.click(ui.getByRole('button', { name: 'Import 2 rows' }));
    await ui.findByRole('status');
    const state = await stored();
    expect(state.transactions.map((t) => t.date).sort()).toEqual(['2026-02-01', '2026-12-31']);
    expect(state.importMappings?.['csv-eu']).toMatchObject({ dateOrder: 'DMY' });
  });

  it('flags ambiguous dates and lets the user choose the order with one click', async () => {
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');
    const ui = within(card());
    await user.upload(fileInput(), csvFile('Date,Description,Amount\n01/02/2026,Rent,-1000\n03/04/2026,Tea,-3', 'eu.csv'));
    await ui.findByText('eu.csv');
    expect(within(ui.getByLabelText('Date order')).getByRole('option', { name: 'Detect (unclear from the rows)' })).toBeInTheDocument();
    expect(ui.getByText((_, el) => el?.tagName === 'P' && /^0 rows ready to import/.test(el.textContent ?? '')))
      .toHaveTextContent('0 rows ready to import, 2 with errors (first: row 2, Ambiguous date "01/02/2026": choose the date order).');
    // Only the date is ambiguous, so no decimal separator is offered.
    expect(ui.queryByRole('button', { name: /for ambiguous rows/ })).toBeNull();
    expect(ui.getByRole('button', { name: 'Use Month first: 12/31/2026 for ambiguous dates' })).toBeInTheDocument();

    await user.click(ui.getByRole('button', { name: 'Use Day first: 31/12/2026 for ambiguous dates' }));
    expect(ui.getByLabelText('Date order')).toHaveValue('DMY');
    expect(ui.getByText('2 rows ready to import.')).toBeInTheDocument();
    expect(ui.queryByRole('button', { name: /for ambiguous dates/ })).toBeNull();
    await user.click(ui.getByRole('button', { name: 'Import 2 rows' }));
    await ui.findByRole('status');
    const state = await stored();
    expect(state.transactions.map((t) => t.date).sort()).toEqual(['2026-02-01', '2026-04-03']);
    expect(state.importMappings?.['csv-eu']).toMatchObject({ dateOrder: 'DMY' });
  });

  it('offers year first for two-digit years that may come first, and reads them with one click', async () => {
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');
    const ui = within(card());
    // Two-digit years don't show the order, and "25-10-01" is a date day first and year first.
    await user.upload(fileInput(), csvFile('Date,Description,Amount\n25-10-01,Rent,-1000\n26/12/31,Tea,-3\n2026-10-02,Pay,1', 'yy.csv'));
    await ui.findByText('yy.csv');
    expect(ui.getByText((_, el) => el?.tagName === 'P' && /^1 rows ready to import/.test(el.textContent ?? '')))
      .toHaveTextContent('1 rows ready to import, 2 with errors (first: row 2, Ambiguous date "25-10-01": choose the date order).');
    // Neither date is a date month first, so only day and year first are offered.
    expect(ui.getAllByRole('button', { name: /for ambiguous dates/ }).map((b) => b.textContent)).toEqual([
      'Use Day first: 31/12/2026 for ambiguous dates', 'Use Year first: 2026-12-31 for ambiguous dates',
    ]);

    await user.click(ui.getByRole('button', { name: 'Use Year first: 2026-12-31 for ambiguous dates' }));
    expect(ui.getByLabelText('Date order')).toHaveValue('YMD');
    await user.click(ui.getByRole('button', { name: 'Import 3 rows' }));
    await ui.findByRole('status');
    const state = await stored();
    expect(state.transactions.map((t) => t.date).sort()).toEqual(['2025-10-01', '2026-10-02', '2026-12-31']);
    expect(state.importMappings?.['csv-yy']).toMatchObject({ dateOrder: 'YMD' });
  });

  it('does not let a saved date order settle ambiguous dates until it is confirmed, and warns when the rows disagree', async () => {
    const user = userEvent.setup();
    await renderApp({
      ...emptyLedger(),
      accounts: [{ id: 'giro', name: 'Giro', type: 'checking' }],
      importMappings: { giro: { date: 'Date', description: 'Description', amount: 'Amount', dateOrder: 'DMY' } },
    }, '#/connections');
    const ui = within(card());
    await user.upload(fileInput(), csvFile('Date,Description,Amount\n01/02/2026,Pay,1\n03/04/2026,Rent,-2', 'giro.csv'));
    await ui.findByText('giro.csv');
    expect(ui.getByLabelText('Date order')).toHaveValue('DMY');
    expect(ui.getByText(/^0 rows ready to import/)).toBeInTheDocument();
    expect(ui.getByRole('button', { name: 'Use Month first: 12/31/2026 for ambiguous dates' })).toBeInTheDocument();
    await user.click(ui.getByRole('button', { name: 'Use Day first: 31/12/2026 (saved for this account) for ambiguous dates' }));
    expect(ui.getByText('2 rows ready to import.')).toBeInTheDocument();
    await user.click(ui.getByRole('button', { name: 'Import 2 rows' }));
    await ui.findByRole('status');
    expect((await stored()).transactions.map((t) => t.date).sort()).toEqual(['2026-02-01', '2026-04-03']);

    await user.upload(fileInput(), csvFile('Date,Description,Amount\n12/31/2026,Cake,-4', 'us.csv'));
    await ui.findByText('us.csv');
    expect(ui.getByText(/^This file's dates look like/))
      .toHaveTextContent('This file\'s dates look like Month first: 12/31/2026, but Day first: 31/12/2026 is selected.');
    await user.click(ui.getByRole('button', { name: 'Use Month first: 12/31/2026' }));
    expect(ui.getByLabelText('Date order')).toHaveValue('MDY');
    expect(ui.queryByText(/^This file's dates look like/)).toBeNull();
    expect(ui.getByText('1 rows ready to import.')).toBeInTheDocument();
  });

  it('detects a semicolon delimiter, lets the user override it, and saves it with the import', async () => {
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');
    const ui = within(card());
    const csv = 'Date;Description;Amount\n31.12.2026;"Kaffe; liten";-12,50\n01.10.2026;Lön;25.000,00';
    await user.upload(fileInput(), csvFile(csv, 'sek.csv'));
    await ui.findByText('sek.csv');
    const delimiter = ui.getByLabelText('Delimiter');
    expect(delimiter).toHaveValue('');
    expect(within(delimiter).getByRole('option', { name: 'Detect (Semicolon)' })).toBeInTheDocument();
    expect(ui.getByLabelText(/^Description/)).toHaveValue('Description');
    expect(ui.getByText('Kaffe; liten')).toBeInTheDocument();
    expect(ui.getByText('2 rows ready to import.')).toBeInTheDocument();

    // Read with commas, the file has other columns, so they are detected again.
    await user.selectOptions(delimiter, 'Comma');
    expect(ui.getByLabelText('Delimiter')).toHaveValue(',');
    expect(ui.getByText('Detected from the header row')).toBeInTheDocument();
    expect(ui.getByLabelText(/^Date$/)).toHaveValue('Date;Description;Amount');
    expect(ui.getByRole('alert')).toHaveTextContent('Choose the column that holds the description.');
    await user.selectOptions(ui.getByLabelText('Delimiter'), 'Semicolon');
    expect(ui.getByLabelText(/^Date$/)).toHaveValue('Date');
    expect(ui.getByText('2 rows ready to import.')).toBeInTheDocument();
    await user.click(ui.getByRole('button', { name: 'Import 2 rows' }));
    await ui.findByRole('status');
    const state = await stored();
    expect(state.transactions.map((t) => [t.description, t.amount]).sort()).toEqual([['Kaffe; liten', -12.5], ['Lön', 25000]]);
    expect(state.importMappings?.['csv-sek']).toMatchObject({ date: 'Date', delimiter: ';', decimal: ',', dateOrder: 'DMY' });

    // Left on Detect, the delimiter used is saved too; the account's saved mapping then offers it.
    await user.upload(fileInput(), csvFile('Date\tMemo\tAmount\n2026-10-01\tTea\t-3', 'tab.csv'));
    await ui.findByText('tab.csv');
    expect(within(ui.getByLabelText('Delimiter')).getByRole('option', { name: 'Detect (Tab)' })).toBeInTheDocument();
    await user.click(ui.getByRole('button', { name: 'Import 1 rows' }));
    await ui.findByRole('status');
    expect((await stored()).importMappings?.['csv-tab']).toMatchObject({ delimiter: '\t' });

    await user.upload(fileInput(), csvFile(`${csv}\n02.10.2026;Hyra;-8.000,00`, 'sek2.csv'));
    await ui.findByText('sek2.csv');
    expect(ui.getByLabelText('Account')).toHaveValue('csv-sek');
    expect(ui.getByText('Saved mapping for this account')).toBeInTheDocument();
    expect(ui.getByLabelText('Delimiter')).toHaveValue(';');
    expect(ui.getByText('3 rows ready to import.')).toBeInTheDocument();
  });

  it('reads a saved mapping with its own delimiter when the file\'s is not detected', async () => {
    const user = userEvent.setup();
    await renderApp({
      ...emptyLedger(),
      accounts: [{ id: 'giro', name: 'Giro', type: 'checking' }],
      importMappings: { giro: { date: 'Datum', description: 'Text', amount: 'Belopp', delimiter: ';' } },
    }, '#/connections');
    const ui = within(card());
    // The uneven last row leaves detection on its comma default.
    await user.upload(fileInput(), csvFile('Datum;Text;Belopp\n2026-10-01;Tea;-3\n2026-10-02;Rent;-800;', 'giro.csv'));
    await ui.findByText('giro.csv');
    expect(within(ui.getByLabelText('Delimiter')).getByRole('option', { name: 'Detect (Comma)' })).toBeInTheDocument();
    expect(ui.getByLabelText('Account')).toHaveValue('giro');
    expect(ui.getByText('Saved mapping for this account')).toBeInTheDocument();
    expect(ui.getByLabelText('Delimiter')).toHaveValue(';');
    expect(ui.getByText('2 rows ready to import.')).toBeInTheDocument();
  });

  it('blocks the import until required columns are mapped and the new account is named', async () => {
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');
    await user.upload(fileInput(), csvFile('When,What,How much\n10/13/2026,Tea,-3'));
    const ui = within(card());
    await ui.findByText('fernway_checking.csv');

    const importBtn = () => ui.getByRole('button', { name: /^Import/ });
    await user.selectOptions(ui.getByLabelText(/^Date$/), '');
    expect(ui.getByRole('alert')).toHaveTextContent('Choose the column that holds the date.');
    expect(importBtn()).toBeDisabled();
    await user.selectOptions(ui.getByLabelText(/^Date$/), 'When');
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

  describe('preview', () => {
    const preview = () => within(card().querySelector<HTMLTableElement>('table.preview')!);
    /** The preview's cells for the row whose description is `description`. */
    const previewRow = (description: string) => within(preview().getByText(description).closest('tr')!);

    it('shows the parsed amount of a comma-decimal row, with the raw text on hover', async () => {
      const user = userEvent.setup();
      await renderApp(undefined, '#/connections');
      await user.upload(fileInput(), csvFile('Date;Description;Amount\n31.12.2026;Kaffe;-12,50\n01.10.2026;Lön;25.000,00', 'sek.csv'));
      await within(card()).findByText('sek.csv');

      expect(preview().getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Date', 'Description', 'Amount', 'Category', 'Status']);
      const kaffe = previewRow('Kaffe');
      expect(kaffe.getByText('-$12.50')).toHaveAttribute('title', '-12,50');
      expect(kaffe.getByText('Thu, Dec 31, 2026')).toHaveAttribute('title', '31.12.2026');
      expect(kaffe.getByText('Ready')).toBeInTheDocument();
      expect(previewRow('Lön').getByText('$25,000.00')).toHaveAttribute('title', '25.000,00');
    });

    it('shows both raw cells on hover for debit and credit columns', async () => {
      const user = userEvent.setup();
      await renderApp(undefined, '#/connections');
      await user.upload(fileInput(), csvFile('Date,Memo,Withdrawal,Deposit\n2026-10-01,Coffee,4.50,', 'card.csv'));
      await within(card()).findByText('card.csv');
      expect(previewRow('Coffee').getByText('-$4.50')).toHaveAttribute('title', 'Withdrawal: 4.50, Deposit: ');
    });

    it('marks rows that will be rejected with the reason, before import', async () => {
      const user = userEvent.setup();
      await renderApp(undefined, '#/connections');
      await user.upload(fileInput(), csvFile('Date,Description,Amount\n2026-10-01,Broken,abc\n2026-10-02,Pay,5'));
      const ui = within(card());
      await ui.findByText('fernway_checking.csv');

      const broken = preview().getByText('Broken').closest('tr')!;
      expect(broken).toHaveClass('rejected');
      expect(within(broken).getByText('Unreadable amount "abc"')).toBeInTheDocument();
      expect(previewRow('Pay').getByText('$5.00')).toBeInTheDocument();
      expect(previewRow('Pay').getByText('Ready').closest('tr')).not.toHaveClass('rejected');
      expect(ui.getByRole('button', { name: 'Import 1 rows' })).toBeInTheDocument();
    });

    it('updates live when flip signs, the decimal separator, the date order or the delimiter change', async () => {
      const user = userEvent.setup();
      await renderApp(undefined, '#/connections');
      await user.upload(fileInput(), csvFile('Date;Description;Amount\n01/02/2026;Rent;"1,234"\n2026-10-01;Tea;-3', 'eu.csv'));
      const ui = within(card());
      await ui.findByText('eu.csv');

      expect(previewRow('Tea').getByText('-$3.00')).toBeInTheDocument();
      await user.click(ui.getByLabelText(/flip signs/));
      expect(previewRow('Tea').getByText('$3.00')).toBeInTheDocument();
      expect(previewRow('Tea').queryByText('-$3.00')).toBeNull();
      await user.click(ui.getByLabelText(/flip signs/));

      // Ambiguous date and amount: rejected until both are chosen.
      expect(previewRow('Rent').getByText('Ambiguous date "01/02/2026": choose the date order')).toBeInTheDocument();
      await user.selectOptions(ui.getByLabelText('Date order'), 'DMY');
      expect(previewRow('Rent').getByText('Ambiguous amount "1,234": choose the decimal separator')).toBeInTheDocument();
      await user.selectOptions(ui.getByLabelText('Decimal separator'), ',');
      expect(previewRow('Rent').getByText('Sun, Feb 1, 2026')).toBeInTheDocument();
      expect(previewRow('Rent').getByText('$1.23')).toBeInTheDocument();
      await user.selectOptions(ui.getByLabelText('Decimal separator'), '.');
      expect(previewRow('Rent').getByText('$1,234.00')).toBeInTheDocument();
      await user.selectOptions(ui.getByLabelText('Date order'), 'MDY');
      expect(previewRow('Rent').getByText('Fri, Jan 2, 2026')).toBeInTheDocument();

      // Read with commas the columns don't fit, so there are no parsed rows; back on semicolons they return.
      await user.selectOptions(ui.getByLabelText('Delimiter'), 'Comma');
      expect(preview().queryByText('-$3.00')).toBeNull();
      expect(preview().queryByRole('columnheader', { name: 'Status' })).toBeNull();
      await user.selectOptions(ui.getByLabelText('Delimiter'), 'Semicolon');
      expect(previewRow('Tea').getByText('-$3.00')).toBeInTheDocument();
    });
  });
});
