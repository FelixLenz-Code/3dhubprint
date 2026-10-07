import { Suspense, lazy, useState } from 'react';
import clsx from 'clsx';

// three.js only loads when the 3D view is shown.
const ToolpathViewer = lazy(() => import('./ToolpathViewer'));

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

/**
 * The sliced plate from the G-code: interactive 3D toolpaths (when available), the bed from
 * above, or the rendered 3D image (older jobs).
 */
export function PlatePreview({ preview, className }: { preview: { top: string; iso: string; paths?: string | null }; className?: string }) {
  const views = preview.paths
    ? ([
        ['3d', '3D'],
        ['top', 'Druckbett'],
      ] as const)
    : ([
        ['top', 'Druckbett'],
        ['iso', '3D'],
      ] as const);
  const [view, setView] = useState<'3d' | 'top' | 'iso'>(views[0][0]);
  return (
    <div className={clsx('space-y-2', className)}>
      <div className="relative">
        {view === '3d' && preview.paths ? (
          <Suspense fallback={<div className="aspect-square w-full rounded-xl bg-[#1a1a19] sm:aspect-[4/3]" />}>
            <ToolpathViewer url={preview.paths} />
          </Suspense>
        ) : (
          // Same frame as the 3D view; the image fills its height so the bed is shown as large as possible.
          <div className="aspect-square w-full overflow-hidden rounded-xl bg-[#1a1a19] sm:aspect-[4/3]">
            <img src={view === 'top' ? preview.top : preview.iso} alt={view === 'top' ? 'Druckbett von oben' : '3D-Ansicht der Druckteile'} className="size-full object-contain" />
          </div>
        )}
        <div className="absolute right-2 top-2 flex overflow-hidden rounded-lg border border-white/10 bg-black/50 text-xs backdrop-blur">
          {views.map(([v, l]) => (
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
        {view === 'top' && <span className="text-text-3">Raster 5 cm</span>}
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
