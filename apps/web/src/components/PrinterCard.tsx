import { Link } from 'react-router-dom';
import { Flame, Layers, Clock, Printer as PrinterIcon } from 'lucide-react';
import type { PrinterSummary } from '@printhub/shared';
import { Badge, Card, ProgressBar, Stat } from './ui';
import { Webcam } from './Webcam';
import { fileLabel, formatClock, formatDuration, formatTemp, isActivePrint, statusBadge } from '../lib/format';

export function PrinterCard({ printer }: { printer: PrinterSummary }) {
  const s = printer.status;
  const badge = statusBadge(s);
  const active = isActivePrint(s);
  const cam = printer.webcams[0];
  const thumb = s.file?.thumbnailPath
    ? `/api/printers/${printer.id}/files/thumbnail?path=${encodeURIComponent(s.file.thumbnailPath)}`
    : undefined;

  return (
    <Link to={`/printers/${printer.id}`} className="group block focus-visible:outline-none">
      <Card className="overflow-hidden transition-colors group-hover:border-text-3 group-focus-visible:border-accent">
        {cam && s.connection === 'connected' ? (
          <Webcam cam={cam} mode="snapshot" />
        ) : (
          <div className="flex aspect-video items-center justify-center bg-surface-2">
            <PrinterIcon className="size-10 text-text-3" />
          </div>
        )}

        <div className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <h2 className="truncate font-semibold">{printer.name}</h2>
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </div>

          {s.connection === 'klippy_not_ready' && s.klippyMessage && (
            <p className="line-clamp-2 text-xs text-text-3">{s.klippyMessage}</p>
          )}

          {active && (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                {thumb && <img src={thumb} alt="" className="size-10 shrink-0 rounded-md bg-surface-2 object-contain" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm" title={s.filename}>
                    {fileLabel(s.filename)}
                  </div>
                  <div className="tabular text-xs text-text-3">
                    {Math.round((s.progress ?? 0) * 100)} % · noch {formatDuration(s.eta)}
                  </div>
                </div>
              </div>
              <ProgressBar value={s.progress ?? 0} />
            </div>
          )}

          {s.connection === 'connected' && (
            <div className="grid grid-cols-3 gap-2 border-t border-border pt-3">
              <Stat
                label="Düse"
                value={
                  <span className="inline-flex items-center gap-1">
                    <Flame className="size-3.5 text-text-3" aria-hidden />
                    {formatTemp(s.extruder?.temperature)}
                  </span>
                }
                sub={s.extruder?.target ? `→ ${s.extruder.target}°` : 'aus'}
              />
              <Stat
                label="Bett"
                value={formatTemp(s.heaterBed?.temperature)}
                sub={s.heaterBed?.target ? `→ ${s.heaterBed.target}°` : 'aus'}
              />
              {active ? (
                <Stat
                  label="Fertig um"
                  value={
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3.5 text-text-3" aria-hidden />
                      {formatClock(s.eta)}
                    </span>
                  }
                  sub={
                    s.currentLayer != null && s.totalLayers ? (
                      <span className="inline-flex items-center gap-1">
                        <Layers className="size-3" aria-hidden />
                        {s.currentLayer}/{s.totalLayers}
                      </span>
                    ) : undefined
                  }
                />
              ) : (
                <Stat label="Lüfter" value={`${Math.round((s.fanSpeed ?? 0) * 100)} %`} />
              )}
            </div>
          )}
        </div>
      </Card>
    </Link>
  );
}
