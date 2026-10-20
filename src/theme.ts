import { useEffect } from 'react';
import { resolveTheme, type Theme } from './lib/settings';

/** localStorage key index.html reads before the app loads, so the first paint uses the right theme. */
export const THEME_KEY = 'ledgerleaf:theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Draw the app in `theme`, following the OS while it is "system". Undefined (still loading) leaves the page as it is. */
export function useTheme(theme: Theme | undefined) {
  useEffect(() => {
    if (!theme) return;
    const mq = matchMedia(DARK_QUERY);
    const apply = () => { document.documentElement.dataset.theme = resolveTheme(theme, mq.matches); };
    apply();
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable: only the first paint is affected */ }
    if (theme !== 'system') return;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}
