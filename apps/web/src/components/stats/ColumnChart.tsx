import { useLayoutEffect, useMemo, useRef, useState } from 'react';

const HEIGHT = 220;
const PAD = { top: 16, right: 8, bottom: 24, left: 52 };
const MAX_BAR = 24;

export interface Column {
  key: string;
  /** Axis label (short) and tooltip title (long). */
  label: string;
  title: string;
  value: number;
  /** Extra tooltip line, e.g. "3 Drucke". */
  detail?: string;
}

/** One series over time: thin columns from a shared baseline, per-column tooltip, optional table. */
export function ColumnChart({
  columns,
  format,
  axisFormat = format,
  title,
  integer = false,
}: {
  columns: Column[];
  format: (v: number) => string;
  axisFormat?: (v: number) => string;
  title: string;
  /** Counts: no fractional axis steps. */
  integer?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [showTable]);

  const geom = useMemo(() => {
    const plotW = Math.max(1, width - PAD.left - PAD.right);
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const ticks = niceTicks(Math.max(0, ...columns.map((c) => c.value)), integer);
    const yMax = ticks.at(-1)!;
    const slot = plotW / Math.max(1, columns.length);
    const bar = Math.max(2, Math.min(MAX_BAR, slot - 2));
    const x = (i: number) => PAD.left + i * slot + slot / 2;
    const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
    // Thin out axis labels so they never collide (~48px per label).
    const every = Math.max(1, Math.ceil(columns.length / Math.max(1, Math.floor(plotW / 48))));
    return { plotW, plotH, ticks, slot, bar, x, y, every };
  }, [columns, width, integer]);

  const hovered = hover !== null ? columns[hover] : undefined;

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <button type="button" onClick={() => setShowTable((v) => !v)} className="rounded px-1.5 py-0.5 text-xs text-text-3 hover:bg-surface-2 hover:text-text">
          {showTable ? 'Diagramm' : 'Tabelle'}
        </button>
      </div>
      {showTable ? (
        <div className="max-h-[220px] overflow-auto rounded-lg border border-border">
          <table className="tabular w-full text-xs">
            <thead className="sticky top-0 bg-surface-2 text-text-2">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Zeitraum</th>
                <th className="px-3 py-1.5 text-right font-medium">{title}</th>
              </tr>
            </thead>
            <tbody>
              {[...columns].reverse().map((c) => (
                <tr key={c.key} className="border-t border-border">
                  <td className="px-3 py-1 text-text-2">{c.title}</td>
                  <td className="px-3 py-1 text-right">{format(c.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrapRef} className="relative w-full min-w-0">
          {width > 0 && (
            <svg width={width} height={HEIGHT} className="block select-none" role="img" aria-label={`${title} je Zeitraum`} onPointerLeave={() => setHover(null)}>
              {geom.ticks.map((v) => (
                <g key={v}>
                  <line x1={PAD.left} x2={width - PAD.right} y1={geom.y(v)} y2={geom.y(v)} stroke="var(--grid)" />
                  <text x={PAD.left - 6} y={geom.y(v)} dy="0.32em" textAnchor="end" className="tabular fill-text-3 text-[10px]">
                    {axisFormat(v)}
                  </text>
                </g>
              ))}
              {columns.map((c, i) => {
                const top = geom.y(c.value);
                const h = HEIGHT - PAD.bottom - top;
                const r = Math.min(4, h, geom.bar / 2);
                const x0 = geom.x(i) - geom.bar / 2;
                const x1 = x0 + geom.bar;
                const base = HEIGHT - PAD.bottom;
                return (
                  <g key={c.key}>
                    {c.value > 0 && (
                      <path
                        // Rounded data end, square at the baseline.
                        d={`M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${base}Z`}
                        fill="var(--series-1)"
                        opacity={hover === null || hover === i ? 1 : 0.55}
                      />
                    )}
                    {i % geom.every === 0 && (
                      <text x={geom.x(i)} y={HEIGHT - 6} textAnchor="middle" className="fill-text-3 text-[10px]">
                        {c.label}
                      </text>
                    )}
                    {/* Hit target: the whole slot, not just the painted column. */}
                    <rect
                      x={geom.x(i) - geom.slot / 2}
                      y={PAD.top}
                      width={geom.slot}
                      height={geom.plotH}
                      fill="transparent"
                      tabIndex={0}
                      aria-label={`${c.title}: ${format(c.value)}`}
                      onPointerEnter={() => setHover(i)}
                      onFocus={() => setHover(i)}
                      onBlur={() => setHover(null)}
                      className="outline-none"
                    />
                  </g>
                );
              })}
              <line x1={PAD.left} x2={width - PAD.right} y1={HEIGHT - PAD.bottom} y2={HEIGHT - PAD.bottom} stroke="var(--border)" />
            </svg>
          )}
          {hovered && hover !== null && (
            <div
              className="pointer-events-none absolute top-0 z-10 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg"
              style={geom.x(hover) > width / 2 ? { right: width - geom.x(hover) + geom.slot / 2 + 4 } : { left: geom.x(hover) + geom.slot / 2 + 4 }}
            >
              <div className="tabular text-sm font-semibold text-text">{format(hovered.value)}</div>
              <div className="whitespace-nowrap text-text-2">{hovered.title}</div>
              {hovered.detail && <div className="whitespace-nowrap text-text-3">{hovered.detail}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 0 plus 3–5 clean steps (1, 2, 2.5, 5 × 10ⁿ) covering max. */
export function niceTicks(max: number, integer = false): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  if (integer) step = Math.max(1, Math.ceil(step));
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  if (ticks.at(-1)! < max) ticks.push(ticks.at(-1)! + step);
  return ticks;
}
