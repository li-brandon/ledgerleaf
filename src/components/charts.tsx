import { fmtMoney, fmtWhole } from '../format';

/** Categorical slots (`--chart-1…8` in styles.css, retuned for dark), assigned to categories in a fixed order (never by rank). */
const SLOTS = Array.from({ length: 8 }, (_, i) => `var(--chart-${i + 1})`);
const SPEND_ORDER = ['Rent', 'Groceries', 'Dining', 'Transport', 'Shopping', 'Utilities', 'Entertainment', 'Health'];
export const OTHER = 'Other';
export const OTHER_COLOR = 'var(--chart-other)';

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

/**
 * Single-series line chart with point markers and native tooltips; points with an `href` are links.
 * `labelEvery` thins the axis labels (always keeping the last) when space is tight.
 */
export function LineChart({ points, label, W = 440, labelEvery = 1 }: {
  points: { label: string; value: number; href?: string }[]; label: string; W?: number; labelEvery?: number;
}) {
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
          {p.href
            ? <a href={p.href} aria-label={`${p.label}: ${fmtMoney(p.value)}`}><circle cx={x(i)} cy={y(p.value)} r={16} className="hit"><title>{`${p.label}: ${fmtMoney(p.value)}`}</title></circle></a>
            : <circle cx={x(i)} cy={y(p.value)} r={16} fill="transparent"><title>{`${p.label}: ${fmtMoney(p.value)}`}</title></circle>}
          {(points.length - 1 - i) % labelEvery === 0 && <text x={x(i)} y={H - 8} className="axis" textAnchor="middle">{p.label}</text>}
        </g>
      ))}
    </svg>
  );
}

/**
 * Cumulative daily spend: this month (solid) against last month (dashed), with an optional
 * budget line. Series are indexed by day of month, starting at day 1.
 */
export function PaceChart({ current, previous, budget, label, W = 440 }: {
  current: number[]; previous: number[]; budget?: number; label: string; W?: number;
}) {
  const days = Math.max(28, current.length, previous.length);
  const max = Math.max(1, ...current, ...previous, budget ?? 0);
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (day: number) => PAD.left + ((day - 1) / (days - 1)) * iw;
  const y = (v: number) => PAD.top + ih - (v / top) * ih;
  const path = (s: number[]) => s.map((v, i) => `${x(i + 1)},${y(v)}`).join(' ');
  const last = current.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={label}>
      {ticks(top).map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
          <text x={PAD.left - 8} y={y(t) + 4} className="axis" textAnchor="end">{fmtWhole(t)}</text>
        </g>
      ))}
      {[1, 8, 15, 22, days].map((d) => (
        <text key={d} x={x(d)} y={H - 8} className="axis" textAnchor={d === 1 ? 'start' : d === days ? 'end' : 'middle'}>{d}</text>
      ))}
      {budget !== undefined && budget > 0 && (
        <>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(budget)} y2={y(budget)} className="avg" />
          <text x={PAD.left + 4} y={y(budget) - 6} className="axis">budget {fmtWhole(budget)}</text>
        </>
      )}
      {previous.length > 1 && (
        <polyline fill="none" stroke="var(--moss)" strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" points={path(previous)}>
          <title>{`Last month: ${fmtMoney(previous[previous.length - 1])}`}</title>
        </polyline>
      )}
      {last > 0 && (
        <>
          <polyline fill="none" stroke="var(--leaf)" strokeWidth={2.5} strokeLinejoin="round" points={path(current)} />
          <circle cx={x(last)} cy={y(current[last - 1])} r={5} fill="var(--leaf)" stroke="var(--paper)" strokeWidth={2}>
            <title>{`Day ${last}: ${fmtMoney(current[last - 1])}`}</title>
          </circle>
        </>
      )}
    </svg>
  );
}

export interface Slice {
  key: string;
  value: number;
  /** Where clicking the slice goes. */
  href?: string;
}

/** Donut of shares (colored by category) with the total in the middle; slices with an `href` are links. */
export function DonutChart({ slices, label, center }: { slices: Slice[]; label: string; center?: string }) {
  const S = 220, R = 100, r = 64, c = S / 2;
  const sum = slices.reduce((a, s) => a + Math.max(0, s.value), 0);
  const point = (a: number, rad: number) => `${c + rad * Math.sin(a)},${c - rad * Math.cos(a)}`;
  let acc = 0;
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="chart donut" role="img" aria-label={label}>
      {sum <= 0 && <circle cx={c} cy={c} r={(R + r) / 2} fill="none" stroke="var(--color-track)" strokeWidth={R - r} />}
      {sum > 0 && slices.filter((s) => s.value > 0).map((s) => {
        const a0 = (acc / sum) * 2 * Math.PI;
        acc += s.value;
        // A full circle can't be one arc; stop just short of it.
        const a1 = Math.min((acc / sum) * 2 * Math.PI, a0 + 2 * Math.PI - 1e-4);
        const big = a1 - a0 > Math.PI ? 1 : 0;
        const d = `M${point(a0, R)}A${R},${R} 0 ${big} 1 ${point(a1, R)}L${point(a1, r)}A${r},${r} 0 ${big} 0 ${point(a0, r)}Z`;
        const tip = `${s.key}: ${fmtMoney(s.value)} · ${Math.round((s.value / sum) * 100)}%`;
        const path = <path d={d} fill={categoryColor(s.key)} stroke="var(--card)" strokeWidth={2} strokeLinejoin="round"><title>{tip}</title></path>;
        return s.href ? <a key={s.key} href={s.href} aria-label={tip} className="slice">{path}</a> : <g key={s.key} className="slice">{path}</g>;
      })}
      {center && (
        <>
          <text x={c} y={c + 2} className="donut-total" textAnchor="middle" dominantBaseline="middle">{center}</text>
          <text x={c} y={c + 24} className="axis" textAnchor="middle">spent</text>
        </>
      )}
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
