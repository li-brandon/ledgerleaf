import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { IS_MAC, isPaletteKey, matchCommands, searchCommand, type Command } from '../lib/commands';
import type { Theme } from '../lib/settings';

/**
 * ⌘K / Ctrl+K command palette: jump to a page, search transactions, import a CSV or switch
 * the theme. Focus returns to where it was when the palette closes.
 */
export default function CommandPalette({ onTheme }: { onTheme(theme: Theme): void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const matches = matchCommands(query);
  const search = searchCommand(query);
  const items = search ? [...matches, search] : matches;
  const optionId = (i: number) => `${id}-${i}`;

  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => {
      if (!isPaletteKey(e, IS_MAC)) return;
      e.preventDefault();
      setOpen((o) => !o);
      setQuery('');
      setActive(0);
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, []);

  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => back?.focus();
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  });

  if (!open) return null;

  function run(c: Command) {
    setOpen(false);
    if ('href' in c) location.hash = c.href;
    else onTheme(c.theme);
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step && items.length) setActive((active + step + items.length) % items.length);
    else if (e.key === 'Enter' && items[active]) run(items[active]);
    else if (e.key === 'Escape') setOpen(false);
    // Focus stays in the input while the palette is open.
    else if (e.key !== 'Tab') return;
    e.preventDefault();
  };

  return (
    <div className="palette-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette"
        onMouseDown={(e) => {
          e.stopPropagation();
          // Clicking anywhere but the input must not take focus out of it; option clicks still fire.
          if (e.target !== inputRef.current) e.preventDefault();
        }} onKeyDown={onKeyDown}>
        <input ref={inputRef} type="text" role="combobox" aria-label="Search commands" aria-expanded="true"
          aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={items.length ? optionId(active) : undefined}
          placeholder="Jump to a page, search transactions…" value={query} autoComplete="off" spellCheck={false}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }} />
        {!matches.length && <p className="palette-empty muted" role="status">No matches</p>}
        <ul className="palette-list" role="listbox" id={`${id}-list`} aria-label="Commands">
          {items.map((c, i) => (
            <li key={c.id} id={optionId(i)} role="option" aria-selected={i === active}
              onMouseEnter={() => setActive(i)} onClick={() => run(c)}>
              <span>{c.label}</span><span className="palette-hint">{c.hint}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
