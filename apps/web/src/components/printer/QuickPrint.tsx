import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Clock, Coins, FileText, Layers, ListPlus, Play, Save, Send, Settings2, Weight, Zap } from 'lucide-react';
import type { JobInfo, PrinterProfileAssignment, PrinterSummary, SliceOverrides, SlicerProfileInfo, SlicerStatus } from '@printhub/shared';
import { api } from '../../lib/api';
import { toast, useAction } from '../../lib/feedback';
import { formatClock, formatDuration, formatFilament, isActivePrint } from '../../lib/format';
import { JOB_STATUS, useJobs } from '../../lib/jobs';
import { live } from '../../lib/live';
import { allowedProfiles } from '../../lib/profiles';
import { Alert, Button, Spinner } from '../ui';
import { Modal } from '../Modal';
import { ModelPicker, type PlateItem } from '../slicing/ModelPicker';
import { describeOverrides, SliceOptions } from '../slicing/SliceOptions';
import { PlatePreview } from '../slicing/PlatePreview';

/** "Schnelldruck" button + dialog: upload → slice → review → print. */
export function QuickPrintButton({ printer }: { printer: PrinterSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Zap className="size-4" /> Schnelldruck
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Schnelldruck auf ${printer.name}`}>
        <QuickPrint printer={printer} onDone={() => setOpen(false)} />
      </Modal>
    </>
  );
}

function QuickPrint({ printer, onDone }: { printer: PrinterSummary; onDone: () => void }) {
  const jobs = useJobs();
  const status = useQuery({ queryKey: ['slicer-status'], queryFn: () => api<SlicerStatus>('/slicer/status') });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<SlicerProfileInfo[]>('/slicer/profiles') });
  const assignment = useQuery({
    queryKey: ['assignment', printer.id],
    queryFn: () => api<PrinterProfileAssignment>(`/printers/${printer.id}/profiles`),
  });

  const [items, setItems] = useState<PlateItem[]>([]);
  const [proc, setProc] = useState('');
  const [fil, setFil] = useState('');
  const [overrides, setOverrides] = useState<SliceOverrides>({});
  const [advanced, setAdvanced] = useState(false);
  const [jobId, setJobId] = useState<number>();
  const { busy, run } = useAction();

  const processes = allowedProfiles('process', profiles.data ?? [], assignment.data);
  const filaments = allowedProfiles('filament', profiles.data ?? [], assignment.data);
  const job = jobs?.find((j) => j.id === jobId);
  const objectCount = items.reduce((n, i) => n + i.copies, 0);

  // Defaults: the profiles last used on this printer, else a "Standard" process.
  useEffect(() => {
    if (!profiles.data || !assignment.data || !jobs) return;
    const last = jobs.find((j) => j.printer?.id === printer.id);
    if (!proc && processes.length) {
      setProc(
        processes.find((p) => p.name === last?.profiles.process.name)?.name ??
          processes.find((p) => /standard/i.test(p.name))?.name ??
          processes[0]!.name,
      );
    }
    if (!fil && filaments.length) setFil(filaments.find((p) => p.name === last?.profiles.filament.name)?.name ?? filaments[0]!.name);
  }, [profiles.data, assignment.data, jobs, processes, filaments, proc, fil, printer.id]);

  useEffect(() => {
    if (overrides.vase && objectCount !== 1) setOverrides(({ vase: _, ...rest }) => rest);
  }, [objectCount, overrides.vase]);

  if (status.isLoading || profiles.isLoading || assignment.isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  if (status.data && !status.data.available) return <Alert tone="warning">Slicen ist nicht möglich: {status.data.reason}</Alert>;
  if (!assignment.data?.machine) {
    return (
      <Alert tone="warning">
        Diesem Drucker ist noch kein OrcaSlicer-Druckerprofil zugeordnet.{' '}
        <Link to="/settings/slicer" className="underline" onClick={onDone}>
          Jetzt zuordnen
        </Link>
      </Alert>
    );
  }

  const slice = () =>
    run('slice', async () => {
      const created = await api<JobInfo>('/jobs', { body: { items, printerId: printer.id, process: proc, filament: fil, overrides } });
      live.upsertJob(created);
      setJobId(created.id);
    });

  // Back to the settings; the unprinted job is discarded.
  const reset = async () => {
    if (jobId) await api(`/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
    setJobId(undefined);
  };

  if (job) {
    return <SliceResult job={job} printer={printer} filament={filaments.find((f) => f.name === fil)} onBack={reset} onDone={onDone} />;
  }

  return (
    <div className="space-y-5">
      <ModelPicker value={items} onChange={setItems} library="collapsed" />

      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Qualität" value={proc} onChange={setProc} options={processes} />
        <Select label="Filament" value={fil} onChange={setFil} options={filaments} />
      </div>

      <div>
        <button
          type="button"
          onClick={() => setAdvanced((a) => !a)}
          className="flex items-center gap-1.5 text-sm font-medium text-text-2 hover:text-text"
          aria-expanded={advanced}
        >
          <Settings2 className="size-4" /> Stützen, Brim & Vase
          {describeOverrides(overrides).length > 0 && <span className="text-accent">({describeOverrides(overrides).join(', ')})</span>}
          <ChevronDown className={`size-4 transition-transform ${advanced ? 'rotate-180' : ''}`} />
        </button>
        {advanced && (
          <div className="mt-3">
            <SliceOptions value={overrides} onChange={setOverrides} process={processes.find((p) => p.name === proc)} objectCount={objectCount} />
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button onClick={slice} disabled={!items.length || !proc || !fil} loading={busy === 'slice'}>
          Slicen
        </Button>
      </div>
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: SlicerProfileInfo[] }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-text-2">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text"
      >
        {options.map((p) => (
          <option key={p.id} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

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
          OrcaSlicer bereitet {job.copies === 1 ? 'das Modell' : `${job.copies} Objekte`} vor. Du kannst den Dialog schließen; der Auftrag läuft unter „Aufträge“ weiter.
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
