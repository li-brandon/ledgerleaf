import { useEffect, useRef } from 'react';

/** How long a toast stays up, in ms. */
export const TOAST_MS = 6000;

interface Props {
  text: string;
  /** Show an Undo button that calls this. */
  onUndo?: () => void;
  /** Called once the toast has been up for `ms`. */
  onDone: () => void;
  error?: boolean;
  ms?: number;
}

/**
 * A short message at the bottom of the screen that goes away by itself, optionally with Undo.
 * Render with a `key` per message so the timer starts again for a new one.
 */
export default function Toast({ text, onUndo, onDone, error, ms = TOAST_MS }: Props) {
  // The timer runs once per toast, however often the parent re-renders.
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const id = setTimeout(() => done.current(), ms);
    return () => clearTimeout(id);
  }, [ms]);

  return (
    <div className={`toast${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>
      <span>{text}</span>
      {onUndo && <button type="button" className="btn ghost" onClick={onUndo}>Undo</button>}
    </div>
  );
}
