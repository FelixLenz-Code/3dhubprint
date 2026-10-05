import { useEffect, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import type { PrinterSummary, TempSample } from '@printhub/shared';
import { api } from '../lib/api';
import { useIsAdmin } from '../lib/auth';
import { live, useLive } from '../lib/live';
import { Badge, Card, ProgressBar, Spinner, Stat } from '../components/ui';
import { Webcam } from '../components/Webcam';
import { TempChart } from '../components/TempChart';
import { PrintControls } from '../components/printer/PrintControls';
import { HeaterControl } from '../components/printer/HeaterControl';
import { MotionCard } from '../components/printer/MotionCard';
import { TuningControls } from '../components/printer/TuningCard';
import { MacrosCard } from '../components/printer/MacrosCard';
import { ExcludeObjects } from '../components/printer/ExcludeObjects';
import { FilesTab } from '../components/printer/FilesTab';
import { HistoryTab } from '../components/printer/HistoryTab';
import { ConsoleTab } from '../components/printer/ConsoleTab';
import { QuickPrintButton } from '../components/printer/QuickPrint';
import { thumbUrl } from '../lib/files';
import { fileLabel, formatClock, formatDuration, formatFilament, formatTemp, isActivePrint, statusBadge } from '../lib/format';

const EMPTY: TempSample[] = [];

const TABS = [
  { id: 'overview', label: 'Übersicht' },
  { id: 'files', label: 'Dateien' },
  { id: 'history', label: 'Verlauf' },
  { id: 'console', label: 'Konsole' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function PrinterPage() {
  const id = Number(useParams().id);
  const printer = useLive((s) => s.printers.find((p) => p.id === id));
  const isAdmin = useIsAdmin();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'overview') as TabId;

  if (!printer) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const badge = statusBadge(printer.status);

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link to="/" className="rounded-lg p-2 text-text-2 hover:bg-surface-2 hover:text-text" aria-label="Zurück">
          <ArrowLeft className="size-5" />
        </Link>
        <h1 className="min-w-0 truncate text-2xl font-semibold">{printer.name}</h1>
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {isAdmin && printer.status.connection === 'connected' && <QuickPrintButton printer={printer} />}
          {isAdmin && <PrintControls printer={printer} />}
          <a
            href={printer.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-text-2 hover:bg-surface-2 hover:text-text"
            title="Fluidd/Mainsail öffnen"
          >
            <span className="hidden sm:inline">Fluidd/Mainsail</span> <ExternalLink className="size-3.5" />
          </a>
        </div>
      </header>

      {printer.status.connection === 'klippy_not_ready' && printer.status.klippyMessage && (
        <Card className="whitespace-pre-wrap border-critical/40 p-4 font-mono text-xs text-text-2">{printer.status.klippyMessage}</Card>
      )}

      <nav className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setParams(t.id === 'overview' ? {} : { tab: t.id }, { replace: true })}
            className={clsx(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
              tab === t.id ? 'border-accent text-text' : 'border-transparent text-text-2 hover:text-text',
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && <Overview printer={printer} editable={isAdmin} />}
      {tab === 'files' && <FilesTab printer={printer} editable={isAdmin} />}
      {tab === 'history' && <HistoryTab printer={printer} editable={isAdmin} />}
      {tab === 'console' && <ConsoleTab printer={printer} editable={isAdmin} />}
    </div>
  );
}

function Overview({ printer, editable }: { printer: PrinterSummary; editable: boolean }) {
  const s = printer.status;
  const temps = useLive((st) => st.temps[printer.id] ?? EMPTY);
  const connected = s.connection === 'connected';
  const active = isActivePrint(s);
  const cam = printer.webcams[0];
  const thumb = thumbUrl(printer.id, s.file?.thumbnailPath);
  const seeded = useRef(false);

  // Backfill the chart with Moonraker's 20-minute temperature store once per visit.
  useEffect(() => {
    if (!connected || seeded.current) return;
    seeded.current = true;
    api<TempSample[]>(`/printers/${printer.id}/temperature-store`)
      .then((samples) => live.seedTemps(printer.id, samples))
      .catch(() => {});
  }, [printer.id, connected]);

  const heaters = printer.capabilities?.heaters ?? [];
  const heaterState = (name: string) =>
    name === 'extruder' ? s.extruder : name === 'heater_bed' ? s.heaterBed : s.sensors?.[name.slice(name.indexOf(' ') + 1)];
  const extraSensors = Object.entries(s.sensors ?? {}).filter(([n]) => !heaters.some((h) => h.name.endsWith(` ${n}`)));

  return (
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
                {heaters.map((h) => (
                  <HeaterControl key={h.name} printerId={printer.id} info={h} state={heaterState(h.name)} editable={editable} />
                ))}
                {extraSensors.map(([name, h]) => (
                  <div key={name} className="rounded-xl bg-surface-2 px-3 py-2.5">
                    <div className="truncate text-xs capitalize text-text-3">{name.replace(/_/g, ' ')}</div>
                    <div className="tabular text-lg font-semibold">{formatTemp(h.temperature)}</div>
                    <div className="text-xs text-text-3">Sensor</div>
                  </div>
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
                <Stat label="Schicht" value={s.currentLayer != null && s.totalLayers ? `${s.currentLayer} / ${s.totalLayers}` : '–'} />
                <Stat
                  label="Filament"
                  value={formatFilament(s.filamentUsed)}
                  sub={s.file?.filamentTotal ? `von ${formatFilament(s.file.filamentTotal)}` : undefined}
                />
              </div>
              {active && <ExcludeObjects printer={printer} editable={editable} />}
            </div>
          ) : (
            <p className="text-sm text-text-3">Kein Druck aktiv.</p>
          )}
        </Card>

        {connected && (
          <Card className="p-4 sm:p-5">
            <h2 className="mb-4 font-semibold">Feineinstellung</h2>
            {editable ? (
              <TuningControls printer={printer} />
            ) : (
              <div className="grid grid-cols-3 gap-4">
                <Stat label="Geschwindigkeit" value={`${Math.round((s.speedFactor ?? 1) * 100)} %`} />
                <Stat label="Fluss" value={`${Math.round((s.extrudeFactor ?? 1) * 100)} %`} />
                <Stat label="Lüfter" value={`${Math.round((s.fanSpeed ?? 0) * 100)} %`} />
              </div>
            )}
          </Card>
        )}

        {connected && <MotionCard printer={printer} editable={editable} />}
        {connected && editable && <MacrosCard printer={printer} />}
      </div>
    </div>
  );
}
