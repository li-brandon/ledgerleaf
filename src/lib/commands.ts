/** Command palette entries and filtering. Pure, so they can be unit tested. */
import { ROUTES, SUBPAGES, routeHref } from './routes';
import { THEMES, THEME_LABEL, type Theme } from './settings';

/** A palette entry: it either opens a hash or switches the theme. */
export type Command = { id: string; label: string; hint: string } & ({ href: string } | { theme: Theme });

/** Connections with the CSV import card brought into view. */
export const IMPORT_CSV_HREF = routeHref('connections', { import: 'csv' });

const COMMANDS: Command[] = [
  ...[...ROUTES, ...SUBPAGES].map(({ id, label }) => ({ id: `go-${id}`, label, hint: 'Page', href: routeHref(id) })),
  { id: 'import-csv', label: 'Import CSV', hint: 'Action', href: IMPORT_CSV_HREF },
  ...THEMES.map((t) => ({ id: `theme-${t}`, label: `Theme: ${THEME_LABEL[t]}`, hint: 'Theme', theme: t })),
];

/** The commands whose label contains `query`, ignoring case and surrounding spaces. */
export function matchCommands(query: string): Command[] {
  const q = query.trim().toLowerCase();
  return COMMANDS.filter((c) => c.label.toLowerCase().includes(q));
}

/** Transactions searched for `query`, or null while it is blank. */
export function searchCommand(query: string): Command | null {
  const q = query.trim();
  return q ? { id: 'search', label: `Search transactions for “${q}”`, hint: 'Search', href: routeHref('transactions', { q }) } : null;
}
