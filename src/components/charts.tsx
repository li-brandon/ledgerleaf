import { fmtMoney, fmtWhole } from '../format';

/** Categorical slots, assigned to categories in a fixed order (never by rank). */
const SLOTS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const SPEND_ORDER = ['Rent', 'Groceries', 'Dining', 'Transport', 'Shopping', 'Utilities', 'Entertainment', 'Health'];
export const OTHER = 'Other';
export const OTHER_COLOR = '#a3a29b';

/** Categories outside the fixed eight fold into "Other". */
export const chartCategory = (c: string) => (SPEND_ORDER.includes(c) ? c : OTHER);
export const categoryColor = (c: string) => SLOTS[SPEND_ORDER.indexOf(c)] ?? OTHER_COLOR;

export interface Bar {
  label: string;
  value: number;
  /** Optional stacked segments; when present they replace the single bar. */
  segments?: { key: string; value: number }[];
}

const H = 220;
const PAD = { top: 16, right: 8, bottom: 28, left: 52 };

function ticks(max: number) {
  const step = niceStep(max / 4);
  return Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
}
function niceStep(raw: number) {
  if (raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)!;
}

/** Vertical bar chart (optionally stacked) in plain SVG. */
export function BarChart({ bars, label, highlightLast, W = 440 }: { bars: Bar[]; label: string; highlightLast?: boolean; W?: number }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const ts = ticks(max);
  const top = ts[ts.length - 1] < max ? ts[ts.length - 1] + niceStep(max / 4) : ts[ts.length - 1];
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + ih - (v / top) * ih;
  const slot = iw / bars.length;
  const bw = Math.min(56, slot * 0.6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={label}>
      {[...ts, top].filter((v, i, a) => a.indexOf(v) === i).map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
          <text x={PAD.left - 8} y={y(t) + 4} className="axis" textAnchor="end">{fmtWhole(t)}</text>
        </g>
      ))}
      {bars.map((b, i) => {
        const x = PAD.left + slot * i + (slot - bw) / 2;
        const segs = b.segments ?? [{ key: b.label, value: b.value }];
        let acc = 0;
        return (
          <g key={b.label} className="bar">
            <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={ih} className="hit" />
            {segs.map((s, j) => {
              const y0 = y(acc), y1 = y(acc + s.value);
              acc += s.value;
              const h = Math.max(0, y0 - y1 - (j < segs.length - 1 ? 2 : 0));
              return (
                <rect key={s.key} x={x} y={y1} width={bw} height={h} rx={j === segs.length - 1 ? 4 : 0}
                  fill={b.segments ? categoryColor(s.key) : highlightLast && i === bars.length - 1 ? 'var(--leaf)' : 'var(--moss)'} />
              );
            })}
            <title>{`${b.label}: ${fmtMoney(b.value)}${b.segments ? '\n' + b.segments.filter((s) => s.value).map((s) => `${s.key}: ${fmtMoney(s.value)}`).reverse().join('\n') : ''}`}</title>
            <text x={x + bw / 2} y={H - 8} className="axis" textAnchor="middle">{b.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** Single-series line chart with point markers and native tooltips. */
export function LineChart({ points, label, W = 440 }: { points: { label: string; value: number }[]; label: string; W?: number }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const top = Math.ceil(max / niceStep(max / 4)) * niceStep(max / 4);
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * (iw - 40) + 20);
  const y = (v: number) => PAD.top + ih - (v / top) * ih;
  const avg = points.reduce((s, p) => s + p.value, 0) / (points.length || 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={label}>
      {ticks(top).map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
          <text x={PAD.left - 8} y={y(t) + 4} className="axis" textAnchor="end">{fmtWhole(t)}</text>
        </g>
      ))}
      <line x1={PAD.left} x2={W - PAD.right} y1={y(avg)} y2={y(avg)} className="avg" />
      <text x={W - PAD.right} y={y(avg) - 6} className="axis" textAnchor="end">avg {fmtWhole(avg)}</text>
      <polyline fill="none" stroke="var(--leaf)" strokeWidth={2} strokeLinejoin="round"
        points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} />
      {points.map((p, i) => (
        <g key={p.label}>
          <circle cx={x(i)} cy={y(p.value)} r={5} fill="var(--leaf)" stroke="var(--paper)" strokeWidth={2} />
          <circle cx={x(i)} cy={y(p.value)} r={16} fill="transparent"><title>{`${p.label}: ${fmtMoney(p.value)}`}</title></circle>
          <text x={x(i)} y={H - 8} className="axis" textAnchor="middle">{p.label}</text>
        </g>
      ))}
    </svg>
  );
}

/** Horizontal progress meter; `ratio` may exceed 1. */
/** Progress bar; `mark` (0..1) draws a tick, e.g. where spending should be by today. */
export function Meter({ ratio, status, mark, label }: { ratio: number; status?: 'ok' | 'near' | 'over'; mark?: number; label?: string }) {
  const pct = Math.min(100, Math.max(0, (Number.isFinite(ratio) ? ratio : 1) * 100));
  const showMark = mark !== undefined && mark > 0 && mark < 1;
  return (
    <div className={`meter ${status ?? 'ok'}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <span style={{ width: `${pct}%` }} />
      {showMark && <i style={{ left: `${mark * 100}%` }} aria-hidden />}
    </div>
  );
}

export function Legend({ keys }: { keys: string[] }) {
  return (
    <ul className="legend">
      {keys.map((k) => <li key={k}><i style={{ background: categoryColor(k) }} />{k}</li>)}
    </ul>
  );
}
