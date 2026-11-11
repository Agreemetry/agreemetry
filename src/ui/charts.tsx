/**
 * Charts: thin marks, one axis, recessive grid, palette tokens, a hover tooltip on every mark, a legend
 * whenever there are two or more series, and a table alternative next to each chart.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { raterColor } from './components';

/** Series are adjudicators: each keeps the identity colour it has everywhere else (R1 to R4). */
const seriesColor = (name: string, k: number) => raterColor(name, k) ?? 'var(--muted)';

interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

function useTip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const show = (e: React.MouseEvent | React.FocusEvent, content: ReactNode) => {
    const r = 'clientX' in e ? { x: e.clientX, y: e.clientY } : (() => {
      const b = (e.target as Element).getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top };
    })();
    setTip({ x: r.x + 12, y: r.y + 12, content });
  };
  const node = tip ? (
    <div className="tip" style={{ left: Math.min(tip.x, window.innerWidth - 290), top: tip.y }} role="tooltip">
      {tip.content}
    </div>
  ) : null;
  return { show, hide: () => setTip(null), node };
}

export interface Segment {
  label: string;
  value: number;
  color: string;
  /** Legend group, such as Settled, Open or Pending. */
  group?: string;
}

/** One stacked bar of workflow states, with a legend that carries the counts, grouped by meaning when given. */
export function StatusBar({ segments, total }: { segments: Segment[]; total: number }) {
  const t = useTip();
  const shown = segments.filter((s) => s.value > 0);
  const groups = [...new Set(segments.map((s) => s.group).filter((g): g is string => Boolean(g)))];
  const item = (s: Segment) => (
    <span key={s.label}>
      <i style={{ background: s.color }} />
      {s.label} <strong className="num">{s.value}</strong>
    </span>
  );
  return (
    <div>
      <div className="statusbar" role="img" aria-label={shown.map((s) => `${s.label} ${s.value}`).join(', ')}>
        {shown.map((s) => (
          <span key={s.label} style={{ width: `${(s.value / Math.max(total, 1)) * 100}%`, background: s.color }} onMouseMove={(e) => t.show(e, <><strong>{s.label}</strong><br />{s.value} of {total} ({((s.value / Math.max(total, 1)) * 100).toFixed(1)}%)</>)} onMouseLeave={t.hide} />
        ))}
      </div>
      {groups.length ? (
        <div className="legend-groups">
          {groups.map((g) => (
            <div key={g}>
              <h4>{g} <span className="num">{segments.filter((s) => s.group === g).reduce((n, s) => n + s.value, 0)}</span></h4>
              <div className="legend">{segments.filter((s) => s.group === g).map(item)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="legend">{segments.map(item)}</div>
      )}
      {t.node}
    </div>
  );
}

export interface ForestRow {
  label: string;
  value: number;
  lo?: number;
  hi?: number;
  n: number;
  note?: string;
}

/** Point estimates with intervals on one shared scale (reliability by subgroup or by coefficient). */
export function ForestPlot({ rows, min = -0.2, max = 1, refLines = [0], unit = '' }: { rows: ForestRow[]; min?: number; max?: number; refLines?: number[]; unit?: string }) {
  const t = useTip();
  const finite = rows.flatMap((r) => [r.value, r.lo, r.hi]).filter((x): x is number => x !== undefined && Number.isFinite(x));
  const lo = Math.min(min, ...finite);
  const hi = Math.max(max, ...finite);
  const W = 640;
  const left = 190;
  const right = 70;
  const rowH = 28;
  const top = 18;
  const H = rows.length * rowH + 30 + top;
  const x = (v: number) => left + ((v - lo) / (hi - lo || 1)) * (W - left - right);
  const marks = refLines.includes(0) ? [{ v: 0, label: 'chance' }, { v: 1, label: 'perfect' }].filter((m) => m.v >= lo && m.v <= hi) : [];
  const ticks = useMemo(() => {
    const step = hi - lo > 1.5 ? 0.5 : 0.2;
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
    return out;
  }, [lo, hi]);
  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Estimates with 95% intervals">
        {refLines.includes(0) && lo < 0 && (
          <rect x={x(lo)} y={top} width={x(0) - x(lo)} height={H - 22 - top} fill="var(--dispute-soft)" opacity={0.7}>
            <title>Below 0: less agreement than chance would give</title>
          </rect>
        )}
        {ticks.map((v) => (
          <g key={v}>
            <line className="grid" x1={x(v)} x2={x(v)} y1={top} y2={H - 22} />
            <text x={x(v)} y={H - 6} textAnchor="middle">{v.toFixed(1)}</text>
          </g>
        ))}
        {refLines.map((v) => <line key={`r${v}`} className="axis" x1={x(v)} x2={x(v)} y1={top - 4} y2={H - 22} strokeDasharray="3 3" />)}
        {marks.map((m) => <text key={m.label} className="ref-label" x={x(m.v)} y={top - 7} textAnchor="middle">{m.label}</text>)}
        {rows.map((r, i) => {
          const y = top + 14 + i * rowH;
          const ok = Number.isFinite(r.value);
          return (
            <g key={r.label + i} tabIndex={0} onMouseMove={(e) => t.show(e, <><strong>{r.label}</strong><br />{ok ? r.value.toFixed(3) : 'undefined'}{unit}{r.lo !== undefined && Number.isFinite(r.lo) ? ` [${r.lo.toFixed(3)}, ${r.hi!.toFixed(3)}]` : ''}<br />n = {r.n}{r.note ? <><br />{r.note}</> : null}</>)} onMouseLeave={t.hide} onFocus={(e) => t.show(e, `${r.label}: ${ok ? r.value.toFixed(3) : 'undefined'}`)} onBlur={t.hide}>
              <rect x={0} y={y - rowH / 2} width={W} height={rowH} fill="transparent" />
              <text x={left - 10} y={y + 4} textAnchor="end" style={{ fill: 'var(--ink)' }}>{r.label.length > 30 ? r.label.slice(0, 29) + '…' : r.label}</text>
              {ok && r.lo !== undefined && Number.isFinite(r.lo) && Number.isFinite(r.hi) && <line x1={x(r.lo)} x2={x(r.hi!)} y1={y} y2={y} stroke="var(--estimate)" strokeWidth={2} strokeLinecap="round" />}
              {ok ? <circle cx={x(r.value)} cy={y} r={5} fill="var(--estimate)" stroke="var(--surface)" strokeWidth={2} /> : <text x={left + 4} y={y + 4} className="muted">undefined</text>}
              <text x={W - right + 8} y={y + 4} className="num" style={{ fill: 'var(--ink)', fontWeight: 600 }}>{ok ? r.value.toFixed(2) : 'NA'}</text>
            </g>
          );
        })}
      </svg>
      {t.node}
    </div>
  );
}

/**
 * Cross-tabulation of two raters. Two one-hue ramps: the diagonal (same category, agreement) in teal and the
 * off-diagonal (disagreement) in orange, each darker with more items, so where the disagreements sit shows at once.
 */
export function CrossHeat({ rowLabel, colLabel, categories, counts }: { rowLabel: string; colLabel: string; categories: { value: string; label: string }[]; counts: number[][] }) {
  const max = Math.max(1, ...counts.flat());
  const total = counts.flat().reduce((s, x) => s + x, 0);
  const bg = (v: number, diag: boolean) => {
    const t = v / max;
    return t === 0 ? 'var(--surface)' : `color-mix(in srgb, var(${diag ? '--state-agreed' : '--state-disagreement'}) ${Math.round(14 + t * 62)}%, var(--surface))`;
  };
  const ramp = (v: string) => `linear-gradient(90deg, color-mix(in srgb, var(${v}) 14%, var(--surface)), color-mix(in srgb, var(${v}) 76%, var(--surface)))`;
  return (
    <div>
    <div className="table-wrap">
      <table className="data heat">
        <thead>
          <tr>
            <th>{rowLabel} {'↓'} / {colLabel} {'→'}</th>
            {categories.map((c) => <th key={c.value} className="num">{c.label}</th>)}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {categories.map((r, i) => (
            <tr key={r.value}>
              <th>{r.label}</th>
              {categories.map((c, j) => {
                const v = counts[i]?.[j] ?? 0;
                return (
                  <td key={c.value} className="cell" title={`${r.label} by ${rowLabel}, ${c.label} by ${colLabel}: ${v} (${((v / Math.max(total, 1)) * 100).toFixed(1)}%), ${i === j ? 'agreement' : 'disagreement'}`} style={{ background: bg(v, i === j), color: v ? 'var(--ink)' : 'var(--muted)' }}>
                    {v}
                  </td>
                );
              })}
              <td className="num">{(counts[i] ?? []).reduce((s, x) => s + x, 0)}</td>
            </tr>
          ))}
          <tr>
            <th>Total</th>
            {categories.map((c, j) => <td key={c.value} className="num">{counts.reduce((s, r) => s + (r[j] ?? 0), 0)}</td>)}
            <td className="num">{total}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div className="heat-key">
      <span><i style={{ background: ramp('--state-agreed') }} />Same category (agreement)</span>
      <span><i style={{ background: ramp('--state-disagreement') }} />Different categories (disagreement)</span>
      <span className="muted">Darker means more items.</span>
    </div>
    </div>
  );
}

/** Share of each category by rater: grouped horizontal bars (at most four raters, else a table). */
export function CategoryBars({ categories, series }: { categories: { value: string; label: string }[]; series: { name: string; counts: Record<string, number>; total: number }[] }) {
  const t = useTip();
  if (series.length > 4 || series.length === 0) return null;
  const W = 640;
  const left = 170;
  const barH = 9;
  const gap = 2;
  const groupH = series.length * (barH + gap) + 14;
  const H = categories.length * groupH + 24;
  const x = (p: number) => left + p * (W - left - 60);
  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Category use by rater">
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <g key={p}>
            <line className="grid" x1={x(p)} x2={x(p)} y1={0} y2={H - 20} />
            <text x={x(p)} y={H - 6} textAnchor="middle">{Math.round(p * 100)}%</text>
          </g>
        ))}
        {categories.map((c, i) => {
          const y0 = i * groupH + 6;
          return (
            <g key={c.value}>
              <text x={left - 10} y={y0 + (series.length * (barH + gap)) / 2 + 3} textAnchor="end" style={{ fill: 'var(--ink)' }}>{c.label.length > 24 ? c.label.slice(0, 23) + '…' : c.label}</text>
              {series.map((s, k) => {
                const p = s.total ? (s.counts[c.value] ?? 0) / s.total : 0;
                const y = y0 + k * (barH + gap);
                return (
                  <g key={s.name} onMouseMove={(e) => t.show(e, <><strong>{s.name}</strong>: {c.label}<br />{s.counts[c.value] ?? 0} of {s.total} ({(p * 100).toFixed(1)}%)</>)} onMouseLeave={t.hide}>
                    <rect x={left} y={y - 2} width={W - left} height={barH + 4} fill="transparent" />
                    <rect x={left} y={y} width={Math.max(0, x(p) - left)} height={barH} rx={3} fill={seriesColor(s.name, k)} />
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <div className="legend">
        {series.map((s, k) => (
          <span key={s.name}>
            <i style={{ background: seriesColor(s.name, k) }} />
            {s.name}
          </span>
        ))}
      </div>
      {t.node}
    </div>
  );
}

/** Cumulative submitted judgments over time (one line per adjudicator, crosshair tooltip). */
export function Cumulative({ series }: { series: { name: string; times: number[] }[] }) {
  const t = useTip();
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const all = series.flatMap((s) => s.times);
  if (all.length < 2 || series.length > 4) return null;
  const t0 = Math.min(...all);
  const t1 = Math.max(...all);
  const maxN = Math.max(...series.map((s) => s.times.length));
  const W = 640;
  const H = 200;
  const L = 44;
  const R = 16;
  const T = 10;
  const B = 26;
  const x = (v: number) => L + ((v - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (n: number) => H - B - (n / Math.max(maxN, 1)) * (H - T - B);
  const sorted = series.map((s) => s.times.slice().sort((a, b) => a - b));
  const path = (ts: number[]) => ts.map((v, i) => `${i ? 'L' : 'M'}${x(v).toFixed(1)},${y(i + 1).toFixed(1)}`).join('');
  const countAt = (ts: number[], v: number) => ts.filter((q) => q <= v).length;
  const fmtDate = (v: number) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <div>
      <svg ref={ref} className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cumulative submitted judgments"
        onMouseMove={(e) => {
          const box = ref.current!.getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * W;
          const v = t0 + ((px - L) / (W - L - R)) * (t1 - t0);
          if (px < L || px > W - R) return setHover(null);
          setHover(v);
          t.show(e, <><strong>{new Date(v).toLocaleString()}</strong>{series.map((s, k) => <div key={s.name}>{s.name}: {countAt(sorted[k], v)}</div>)}</>);
        }}
        onMouseLeave={() => {
          setHover(null);
          t.hide();
        }}>
        {[0, 0.5, 1].map((p) => (
          <g key={p}>
            <line className="grid" x1={L} x2={W - R} y1={y(p * maxN)} y2={y(p * maxN)} />
            <text x={L - 6} y={y(p * maxN) + 4} textAnchor="end">{Math.round(p * maxN)}</text>
          </g>
        ))}
        <line className="axis" x1={L} x2={W - R} y1={H - B} y2={H - B} />
        <text x={L} y={H - 8}>{fmtDate(t0)}</text>
        <text x={W - R} y={H - 8} textAnchor="end">{fmtDate(t1)}</text>
        {sorted.map((ts, k) => <path key={series[k].name} d={path(ts)} fill="none" stroke={seriesColor(series[k].name, k)} strokeWidth={2} />)}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--muted)" strokeDasharray="3 3" />}
      </svg>
      <div className="legend">
        {series.map((s, k) => (
          <span key={s.name}>
            <i style={{ background: seriesColor(s.name, k) }} />
            {s.name} <strong className="num">{s.times.length}</strong>
          </span>
        ))}
      </div>
      {t.node}
    </div>
  );
}
