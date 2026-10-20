/** Small browser-only helpers (downloads, per-tab memory). Nothing here touches the network. */
import { EMPTY_FILTERS, filtersToParams, parseFilters, type TxFilters } from './lib/txFilters';

/** Save `text` as a file via a temporary object URL. */
export function downloadFile(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

const FILTERS_KEY = 'ledgerleaf:txFilters';

/** Remember the Transactions filters for this tab, so Settings can export the same rows. */
export function rememberTxFilters(f: TxFilters) {
  try { sessionStorage.setItem(FILTERS_KEY, JSON.stringify(filtersToParams(f))); } catch { /* storage unavailable */ }
}

/** The filters last used on Transactions in this tab; none set if it was never opened. */
export function rememberedTxFilters(): TxFilters {
  try {
    const raw = JSON.parse(sessionStorage.getItem(FILTERS_KEY) ?? '{}');
    return typeof raw === 'object' && raw ? parseFilters(raw) : EMPTY_FILTERS;
  } catch {
    return EMPTY_FILTERS;
  }
}
