import { useState } from 'react';
import clsx from 'clsx';

// Same feature colors as the server-side renderer (Orca-like).
const LEGEND: [string, string][] = [
  ['Außenwand', 'rgb(255,125,56)'],
  ['Innenwand', 'rgb(255,192,77)'],
  ['Infill', 'rgb(176,48,41)'],
  ['Massives Infill', 'rgb(150,84,204)'],
  ['Oberseite', 'rgb(240,90,68)'],
  ['Unterseite', 'rgb(102,128,245)'],
  ['Brücke', 'rgb(77,128,186)'],
  ['Brim/Skirt', 'rgb(0,158,128)'],
  ['Stützen', 'rgb(100,191,77)'],
];

/** The sliced plate rendered from G-code: top view of the bed, or 3D view of the parts. */
export function PlatePreview({ preview, className }: { preview: { top: string; iso: string }; className?: string }) {
  const [view, setView] = useState<'top' | 'iso'>('top');
  return (
    <div className={clsx('space-y-2', className)}>
      <div className="relative overflow-hidden rounded-xl bg-[#1a1a19]">
        <img src={view === 'top' ? preview.top : preview.iso} alt={view === 'top' ? 'Druckbett von oben' : '3D-Ansicht der Druckteile'} className="mx-auto aspect-square w-full max-w-md object-contain" />
        <div className="absolute right-2 top-2 flex overflow-hidden rounded-lg border border-white/10 bg-black/50 text-xs backdrop-blur">
          {(
            [
              ['top', 'Druckbett'],
              ['iso', '3D'],
            ] as const
          ).map(([v, l]) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={clsx('px-2.5 py-1.5', view === v ? 'bg-white/15 text-white' : 'text-white/70 hover:text-white')}
              aria-pressed={view === v}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-2">
        {LEGEND.map(([label, color]) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: color }} aria-hidden />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
