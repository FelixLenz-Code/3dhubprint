import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import type { HeaterState, TempSample } from '@printhub/shared';
import { api } from '../lib/api';
import { live, useLive } from '../lib/live';
import { Badge, Card, ProgressBar, Spinner, Stat } from '../components/ui';
import { Webcam } from '../components/Webcam';
import { TempChart } from '../components/TempChart';
import {
  fileLabel,
  formatClock,
  formatDuration,
  formatFilament,
  formatTemp,
  isActivePrint,
  statusBadge,
} from '../lib/format';

const EMPTY: TempSample[] = [];

export function PrinterPage() {
  const id = Number(useParams().id);
  const printer = useLive((s) => s.printers.find((p) => p.id === id));
  const temps = useLive((s) => s.temps[id] ?? EMPTY);
  const connected = printer?.status.connection === 'connected';
  const seeded = useRef(false);

  // Backfill the chart with Moonraker's 20-minute temperature store once per visit.
  useEffect(() => {
    if (!connected || seeded.current) return;
    seeded.current = true;
    api<TempSample[]>(`/printers/${id}/temperature-store`)
      .then((samples) => live.seedTemps(id, samples))
      .catch(() => {});
  }, [id, connected]);

  if (!printer) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const s = printer.status;
  const badge = statusBadge(s);
  const active = isActivePrint(s);
  const cam = printer.webcams[0];
  const thumb = s.file?.thumbnailPath
    ? `/api/printers/${printer.id}/files/thumbnail?path=${encodeURIComponent(s.file.thumbnailPath)}`
    : undefined;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link to="/" className="rounded-lg p-2 text-text-2 hover:bg-surface-2 hover:text-text" aria-label="Zurück">
          <ArrowLeft className="size-5" />
        </Link>
        <h1 className="min-w-0 truncate text-2xl font-semibold">{printer.name}</h1>
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <a
          href={printer.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-text-2 hover:bg-surface-2 hover:text-text"
        >
          Fluidd/Mainsail <ExternalLink className="size-3.5" />
        </a>
      </header>

      {s.connection === 'klippy_not_ready' && s.klippyMessage && (
        <Card className="whitespace-pre-wrap p-4 font-mono text-xs text-text-2">{s.klippyMessage}</Card>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          {cam && connected && (
            <Card className="overflow-hidden">
              <Webcam cam={cam} mode="stream" />
            </Card>
          )}

          <Card className="p-4 sm:p-5">
            <h2 className="mb-4 font-semibold">Temperaturen</h2>
            {connected ? (
              <>
                <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <HeaterTile label="Düse" h={s.extruder} />
                  <HeaterTile label="Bett" h={s.heaterBed} />
                  {Object.entries(s.sensors ?? {}).map(([name, h]) => (
                    <HeaterTile key={name} label={name.replace(/_/g, ' ')} h={h} />
                  ))}
                </div>
                <TempChart samples={temps} />
              </>
            ) : (
              <p className="text-sm text-text-3">Keine Daten, Drucker nicht verbunden.</p>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-4 sm:p-5">
            <h2 className="mb-4 font-semibold">Aktueller Druck</h2>
            {active || s.filename ? (
              <div className="space-y-4">
                <div className="flex gap-4">
                  {thumb && <img src={thumb} alt="" className="size-20 shrink-0 rounded-lg bg-surface-2 object-contain" />}
                  <div className="min-w-0">
                    <div className="break-words font-medium">{fileLabel(s.filename)}</div>
                    {s.file?.slicer && <div className="text-xs text-text-3">{s.file.slicer}</div>}
                    {s.message && <div className="mt-1 text-sm text-text-2">{s.message}</div>}
                  </div>
                </div>
                {active && (
                  <div className="space-y-1.5">
                    <div className="tabular flex justify-between text-sm">
                      <span>{((s.progress ?? 0) * 100).toFixed(1)} %</span>
                      <span className="text-text-2">fertig um {formatClock(s.eta)}</span>
                    </div>
                    <ProgressBar value={s.progress ?? 0} className="h-2.5" />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
                  <Stat label="Druckzeit" value={formatDuration(s.printDuration)} />
                  <Stat label="Verbleibend" value={active ? formatDuration(s.eta) : '–'} />
                  <Stat label="Slicer-Schätzung" value={formatDuration(s.file?.estimatedTime)} />
                  <Stat
                    label="Schicht"
                    value={s.currentLayer != null && s.totalLayers ? `${s.currentLayer} / ${s.totalLayers}` : '–'}
                  />
                  <Stat
                    label="Filament"
                    value={formatFilament(s.filamentUsed)}
                    sub={s.file?.filamentTotal ? `von ${formatFilament(s.file.filamentTotal)}` : undefined}
                  />
                  <Stat
                    label="Speed / Flow"
                    value={`${Math.round((s.speedFactor ?? 1) * 100)} % / ${Math.round((s.extrudeFactor ?? 1) * 100)} %`}
                  />
                </div>
              </div>
            ) : (
              <p className="text-sm text-text-3">Kein Druck aktiv.</p>
            )}
          </Card>

          {connected && (
            <Card className="p-4 sm:p-5">
              <h2 className="mb-4 font-semibold">Maschine</h2>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
                <Stat
                  label="Position"
                  value={s.position ? s.position.slice(0, 3).map((v) => v.toFixed(1)).join(' / ') : '–'}
                  sub="X / Y / Z"
                />
                <Stat label="Referenziert" value={s.homedAxes ? s.homedAxes.toUpperCase() : 'nein'} />
                <Stat label="Lüfter" value={`${Math.round((s.fanSpeed ?? 0) * 100)} %`} />
                <Stat
                  label="Bauraum"
                  value={s.axisMaximum ? s.axisMaximum.slice(0, 3).map((v) => Math.round(v)).join(' × ') : '–'}
                  sub="mm"
                />
              </div>
              <p className="mt-4 text-xs text-text-3">Steuerung (Pause, Abbruch, Temperaturen, Makros) folgt in Phase 2.</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function HeaterTile({ label, h }: { label: string; h?: HeaterState }) {
  const heating = !!h?.target;
  return (
    <div className="rounded-xl bg-surface-2 px-3 py-2.5">
      <div className="truncate text-xs capitalize text-text-3">{label}</div>
      <div className="tabular text-lg font-semibold">{formatTemp(h?.temperature)}</div>
      <div className="tabular text-xs text-text-3">
        {heating ? `Ziel ${h!.target}°` : h?.target === 0 ? 'aus' : ' '}
        {heating && h?.power !== undefined && ` · ${Math.round(h.power * 100)} %`}
      </div>
    </div>
  );
}
