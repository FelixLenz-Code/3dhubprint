import type { PrinterSummary } from '@printhub/shared';
import { api } from '../../lib/api';
import { useAction } from '../../lib/feedback';
import { Card, ProgressBar } from '../ui';
import { FanSlider } from './TuningCard';

/** All fans Klipper knows; the controllable ones get a slider for admins. */
export function FanCard({ printer, editable }: { printer: PrinterSummary; editable: boolean }) {
  const { run } = useAction();
  const fans = printer.capabilities?.fans ?? [];
  if (fans.length === 0) return null;
  const speed = (name: string) => Math.round((printer.status.fans?.[name] ?? (name === 'fan' ? printer.status.fanSpeed : 0) ?? 0) * 100);

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="mb-4 font-semibold">Lüfter</h2>
      <div className="space-y-3">
        {fans.map((f) =>
          f.controllable && editable ? (
            <FanSlider
              key={f.name}
              label={f.label}
              value={speed(f.name)}
              onCommit={(v) => run(f.name, () => api(`/printers/${printer.id}/fan`, { body: { percent: v, fan: f.name } }))}
            />
          ) : (
            <div key={f.name} className="flex items-center gap-2">
              <span className="w-32 shrink-0 truncate text-sm text-text-2" title={f.label}>
                {f.label}
              </span>
              <ProgressBar value={speed(f.name) / 100} className="h-1.5 min-w-0 flex-1" />
              <span className="tabular w-12 text-right text-sm font-semibold">{speed(f.name)} %</span>
            </div>
          ),
        )}
        {editable && fans.some((f) => !f.controllable) && <p className="text-xs text-text-3">Lüfter ohne Regler steuert Klipper automatisch, z. B. nach der Hotend-Temperatur.</p>}
      </div>
    </Card>
  );
}
