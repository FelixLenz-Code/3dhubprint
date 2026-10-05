import { useMemo, useState } from 'react';
import { Clock, Coins, FileText, Layers, ListPlus, Play, Save, Send, Weight } from 'lucide-react';
import type { JobInfo, PrinterSummary, SlicerProfileInfo } from '@printhub/shared';
import { api } from '../../lib/api';
import { toast, useAction } from '../../lib/feedback';
import { formatClock, formatDuration, formatFilament, isActivePrint } from '../../lib/format';
import { JOB_STATUS } from '../../lib/jobs';
import { Alert, Button, Spinner } from '../ui';
import { describeOverrides } from './SliceOptions';
import { PlatePreview } from './PlatePreview';

/** Sliced job: preview, time, filament, cost, then print, transfer or queue (and, for wizard drafts, save). */
export function SliceResult({
  job,
  printer,
  filament,
  onBack,
  onDone,
  onSave,
  backLabel = 'Einstellungen ändern',
}: {
  job: JobInfo;
  printer: PrinterSummary;
  filament?: SlicerProfileInfo;
  onBack: () => void;
  onDone: () => void;
  /** Offers "Speichern" (keep the job without sending it). */
  onSave?: () => void;
  backLabel?: string;
}) {
  const { busy, run } = useAction();
  const [log, setLog] = useState<string>();
  const busyPrinter = isActivePrint(printer.status);
  const offline = printer.status.connection !== 'connected';
  const cost = useMemo(() => {
    const perKg = Number(filament?.summary.cost);
    return job.filamentG !== null && perKg > 0 ? (job.filamentG / 1000) * perKg : undefined;
  }, [job.filamentG, filament]);

  if (job.status === 'queued' || job.status === 'slicing') {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <Spinner className="size-8" />
        <div className="font-medium">{JOB_STATUS[job.status].label}…</div>
        <p className="max-w-sm text-sm text-text-3">
          OrcaSlicer bereitet {job.copies === 1 ? 'das Modell' : `${job.copies} Objekte`} vor. {job.draft ? 'Bitte hier warten: Wer die Seite oder den Dialog verlässt, verwirft den Auftrag.' : 'Der Auftrag läuft unter „Aufträge“ weiter.'}
        </p>
      </div>
    );
  }

  if (job.status === 'failed' || job.status === 'cancelled') {
    return (
      <div className="space-y-4">
        <Alert>{job.error ?? 'Slicen fehlgeschlagen'}</Alert>
        {log !== undefined && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs">{log || '(kein Log)'}</pre>}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onBack}>
            {backLabel}
          </Button>
          <Button variant="ghost" onClick={async () => setLog((await api<{ log: string }>(`/jobs/${job.id}/log`)).log)}>
            <FileText className="size-4" /> Log
          </Button>
        </div>
      </div>
    );
  }

  const send = (print: boolean) =>
    run(print ? 'print' : 'send', async () => {
      await api(`/jobs/${job.id}/send`, { body: { print } });
      toast(print ? `Druck auf ${printer.name} gestartet` : `An ${printer.name} übertragen`);
      onDone();
    });

  return (
    <div className="space-y-5">
      {job.preview && <PlatePreview preview={job.preview} />}
      <div className="flex gap-4">
        {!job.preview && <img src={job.model.thumbnailUrl} alt="" className="size-24 shrink-0 rounded-xl bg-surface-2 object-contain sm:size-32" />}
        <div className="min-w-0 space-y-1">
          <div className="break-words font-semibold">{job.models.map((m) => (m.copies > 1 ? `${m.name} ×${m.copies}` : m.name)).join(', ')}</div>
          <div className="text-sm text-text-2">
            {job.profiles.process.name} · {job.profiles.filament.name}
          </div>
          {describeOverrides(job.overrides).length > 0 && <div className="text-xs text-text-3">{describeOverrides(job.overrides).join(' · ')}</div>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile icon={Clock} label="Druckdauer" value={formatDuration(job.estimatedTime ?? undefined)} sub={`fertig ca. ${formatClock(job.estimatedTime ?? undefined)}`} />
        <Tile icon={Layers} label="Filament" value={formatFilament(job.filamentMm ?? undefined)} />
        <Tile icon={Weight} label="Gewicht" value={job.filamentG !== null ? `${job.filamentG.toFixed(1).replace('.', ',')} g` : '–'} />
        <Tile icon={Coins} label="Materialkosten" value={cost !== undefined ? cost.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }) : '–'} />
      </div>

      {offline ? (
        <Alert tone="warning">
          Der Drucker ist nicht verbunden. {onSave ? 'Du kannst den Auftrag speichern und später drucken.' : 'Der Auftrag bleibt unter „Aufträge“ gespeichert.'}
        </Alert>
      ) : busyPrinter ? (
        <Alert tone="warning">Auf dem Drucker läuft gerade ein Druck. Stell den Auftrag in die Warteschlange; er startet, sobald du das Bett danach freigibst.</Alert>
      ) : (
        <Alert tone="neutral">Vor dem Start: Ist das Druckbett frei und sauber und das richtige Filament ({String(filament?.summary.material ?? '')}) geladen?</Alert>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onBack} className="mr-auto">
          {backLabel}
        </Button>
        {onSave && (
          <Button variant="secondary" onClick={onSave}>
            <Save className="size-4" /> Speichern
          </Button>
        )}
        {busyPrinter ? (
          <Button
            onClick={() =>
              run('enqueue', async () => {
                await api(`/jobs/${job.id}/enqueue`, { body: {} });
                toast('In die Warteschlange gestellt');
                onDone();
              })
            }
            loading={busy === 'enqueue'}
          >
            <ListPlus className="size-4" /> In Warteschlange
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => send(false)} disabled={offline} loading={busy === 'send'}>
              <Send className="size-4" /> Nur übertragen
            </Button>
            <Button onClick={() => send(true)} disabled={offline} loading={busy === 'print'}>
              <Play className="size-4" /> Drucken
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function Tile({ icon: Icon, label, value, sub }: { icon: typeof Clock; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-surface-2 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-text-3">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className="tabular text-lg font-semibold">{value}</div>
      {sub && <div className="tabular text-xs text-text-3">{sub}</div>}
    </div>
  );
}
