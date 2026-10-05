import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TempSample } from '@printhub/shared';

const HEIGHT = 200;
const PAD = { top: 12, right: 72, bottom: 22, left: 34 };

// Categorical slots in fixed order: slot 1 = bed, slot 2 = hotend.
const SERIES = [
  { key: 'bed', target: 'bedTarget', label: 'Bett', color: 'var(--series-1)' },
  { key: 'extruder', target: 'extruderTarget', label: 'Düse', color: 'var(--series-2)' },
] as const;

/** Temperature history: actual (solid) and target (dashed) per heater, one shared °C axis. */
export function TempChart({ samples }: { samples: TempSample[] }) {
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
  }, []);

  const geom = useMemo(() => {
    const now = samples.at(-1)?.t ?? Date.now();
    const t0 = now - 20 * 60 * 1000;
    let maxV = 60;
    for (const s of samples)
      for (const v of [s.bed, s.bedTarget, s.extruder, s.extruderTarget]) if (v !== undefined && v > maxV) maxV = v;
    const yMax = Math.ceil((maxV + 10) / 50) * 50;
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + ((t - t0) / (now - t0)) * plotW;
    const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
    const path = (get: (s: TempSample) => number | undefined) => {
      let d = '';
      let pen = false;
      for (const s of samples) {
        const v = get(s);
        if (v === undefined || s.t < t0) {
          pen = false;
          continue;
        }
        d += `${pen ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      }
      return d;
    };
    const yTicks = Array.from({ length: yMax / 50 + 1 }, (_, i) => i * 50).filter((v, _, a) => a.length <= 7 || v % 100 === 0);
    const xTicks = (plotW < 420 ? [20, 10, 0] : [20, 15, 10, 5, 0]).map((m) => ({ m, x: x(now - m * 60000) }));
    return { now, t0, x, y, path, yTicks, xTicks, plotW, plotH };
  }, [samples, width]);

  const last = samples.at(-1);
  const hovered = hover !== null ? samples[hover] : undefined;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!samples.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = geom.t0 + ((px - PAD.left) / geom.plotW) * (geom.now - geom.t0);
    // Samples are time-sorted: binary search for the nearest one.
    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid]!.t < t) lo = mid + 1;
      else hi = mid;
    }
    setHover(lo);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-2">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <svg width="16" height="8" aria-hidden>
              <line x1="0" y1="4" x2="16" y2="4" stroke={s.color} strokeWidth="2" />
            </svg>
            {s.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <svg width="16" height="8" aria-hidden>
            <line x1="0" y1="4" x2="16" y2="4" stroke="var(--text-3)" strokeWidth="1.5" strokeDasharray="3 3" />
          </svg>
          Ziel
        </span>
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          className="ml-auto rounded px-1.5 py-0.5 text-text-3 hover:bg-surface-2 hover:text-text"
        >
          {showTable ? 'Diagramm' : 'Tabelle'}
        </button>
      </div>

      {showTable ? (
        <TempTable samples={samples} />
      ) : (
        <div ref={wrapRef} className="relative w-full min-w-0 overflow-hidden">
          {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            className="block touch-none select-none"
            role="img"
            aria-label={`Temperaturverlauf der letzten 20 Minuten. Bett ${last?.bed?.toFixed(1) ?? '–'} Grad, Düse ${last?.extruder?.toFixed(1) ?? '–'} Grad.`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            {geom.yTicks.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={width - PAD.right} y1={geom.y(v)} y2={geom.y(v)} stroke="var(--grid)" />
                <text x={PAD.left - 6} y={geom.y(v)} dy="0.32em" textAnchor="end" className="fill-text-3 text-[10px]">
                  {v}°
                </text>
              </g>
            ))}
            {geom.xTicks.map(({ m, x }) => (
              <text key={m} x={x} y={HEIGHT - 4} textAnchor={m === 20 ? 'start' : m === 0 ? 'end' : 'middle'} className="fill-text-3 text-[10px]">
                {m === 0 ? 'jetzt' : `−${m} min`}
              </text>
            ))}

            {SERIES.map((s) => (
              <g key={s.key}>
                <path d={geom.path((p) => p[s.target] || undefined)} fill="none" stroke={s.color} strokeWidth={1.5} strokeDasharray="4 4" opacity={0.7} />
                <path d={geom.path((p) => p[s.key])} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
              </g>
            ))}

            {/* Direct labels at the line ends, in text ink with a colored marker; nudged apart if they collide. */}
            {last &&
              endLabels(last, geom.y).map(({ s, v, ly }) => (
                <g key={s.key}>
                  <circle cx={geom.x(last.t)} cy={geom.y(v)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                  <text x={geom.x(last.t) + 8} y={ly} dy="0.32em" className="tabular fill-text-2 text-[11px] font-medium">
                    {s.label} {Math.round(v)}°
                  </text>
                </g>
              ))}

            {hovered && (
              <g pointerEvents="none">
                <line x1={geom.x(hovered.t)} x2={geom.x(hovered.t)} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="var(--text-3)" strokeWidth={1} />
                {SERIES.map((s) =>
                  hovered[s.key] !== undefined ? (
                    <circle key={s.key} cx={geom.x(hovered.t)} cy={geom.y(hovered[s.key]!)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                  ) : null,
                )}
              </g>
            )}
          </svg>
          )}

          {hovered && (
            <div
              className="pointer-events-none absolute top-2 z-10 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg"
              style={geom.x(hovered.t) > width / 2 ? { right: width - geom.x(hovered.t) + 12 } : { left: geom.x(hovered.t) + 12 }}
            >
              <div className="mb-1 text-text-3">{new Date(hovered.t).toLocaleTimeString('de-DE')}</div>
              {SERIES.map((s) => (
                <div key={s.key} className="tabular flex items-center gap-2 text-text">
                  <span className="size-2 rounded-full" style={{ background: s.color }} />
                  <span className="text-text-2">{s.label}</span>
                  <span className="ml-auto font-medium">
                    {hovered[s.key]?.toFixed(1) ?? '–'}° <span className="text-text-3">/ {hovered[s.target] ?? 0}°</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function endLabels(last: TempSample, y: (v: number) => number) {
  const labels = SERIES.flatMap((s) => {
    const v = last[s.key];
    return v === undefined ? [] : [{ s, v, ly: y(v) }];
  }).sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < labels.length; i++) {
    const min = labels[i - 1]!.ly + 13;
    if (labels[i]!.ly < min) labels[i]!.ly = min;
  }
  return labels;
}

function TempTable({ samples }: { samples: TempSample[] }) {
  // One row per minute, newest first.
  const rows: TempSample[] = [];
  let lastMinute = -1;
  for (let i = samples.length - 1; i >= 0 && rows.length < 20; i--) {
    const m = Math.floor(samples[i]!.t / 60000);
    if (m !== lastMinute) {
      rows.push(samples[i]!);
      lastMinute = m;
    }
  }
  return (
    <div className="max-h-[200px] overflow-auto rounded-lg border border-border">
      <table className="tabular w-full text-xs">
        <thead className="sticky top-0 bg-surface-2 text-text-2">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">Zeit</th>
            <th className="px-3 py-1.5 text-right font-medium">Bett (Ziel)</th>
            <th className="px-3 py-1.5 text-right font-medium">Düse (Ziel)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.t} className="border-t border-border">
              <td className="px-3 py-1 text-text-2">{new Date(r.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</td>
              <td className="px-3 py-1 text-right">{r.bed?.toFixed(1) ?? '–'}° ({r.bedTarget ?? 0}°)</td>
              <td className="px-3 py-1 text-right">{r.extruder?.toFixed(1) ?? '–'}° ({r.extruderTarget ?? 0}°)</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
