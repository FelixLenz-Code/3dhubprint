import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check } from 'lucide-react';
import clsx from 'clsx';
import type { JobInfo, ModelInfo, PrinterProfileAssignment, SliceOverrides, SlicerProfileInfo } from '@printhub/shared';
import { api } from '../lib/api';
import { useAction } from '../lib/feedback';
import { formatDims } from '../lib/jobs';
import { live, useLive } from '../lib/live';
import { allowedProfiles } from '../lib/profiles';
import { Alert, Button, Card, Field, Input } from '../components/ui';
import { ModelPicker, type PlateItem } from '../components/slicing/ModelPicker';
import { ProfileSelect, describeFilament, describeProcess } from '../components/slicing/ProfileSelect';
import { SliceOptions } from '../components/slicing/SliceOptions';

/** All printers' profile assignments (for printer cards and profile filtering). */
export function useAssignments() {
  const printers = useLive((s) => s.printers);
  return useQuery({
    queryKey: ['assignments', printers.map((p) => p.id).join(',')],
    queryFn: () => Promise.all(printers.map((p) => api<PrinterProfileAssignment>(`/printers/${p.id}/profiles`))),
    enabled: printers.length > 0,
  });
}

/** Models that exceed the printer's build volume in any lying orientation. */
export function oversized(models: ModelInfo[], machine: SlicerProfileInfo | undefined): ModelInfo[] {
  if (!machine) return [];
  const { bedX, bedY, height } = machine.summary as { bedX?: number; bedY?: number; height?: number };
  const big = Math.max(bedX ?? Infinity, bedY ?? Infinity);
  const small = Math.min(bedX ?? Infinity, bedY ?? Infinity);
  return models.filter(({ dimensions: [x, y, z] }) => !(Math.max(x, y) <= big && Math.min(x, y) <= small && z <= (height ?? Infinity)));
}

export function NewJobPage() {
  const navigate = useNavigate();
  const printers = useLive((s) => s.printers);
  const models = useQuery({ queryKey: ['models'], queryFn: () => api<ModelInfo[]>('/models') });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<SlicerProfileInfo[]>('/slicer/profiles') });
  const assignments = useAssignments();

  const [items, setItems] = useState<PlateItem[]>([]);
  const [printerId, setPrinterId] = useState<number>();
  const [proc, setProc] = useState('');
  const [fil, setFil] = useState('');
  const [overrides, setOverrides] = useState<SliceOverrides>({});
  const [autoOrient, setAutoOrient] = useState(false);
  const [autoPrint, setAutoPrint] = useState(false);
  const [note, setNote] = useState('');
  const { busy, run } = useAction();

  const assignment = assignments.data?.find((a) => a.printerId === printerId);
  const machine = profiles.data?.find((p) => p.kind === 'machine' && p.name === assignment?.machine);
  const processes = allowedProfiles('process', profiles.data ?? [], assignment);
  const filaments = allowedProfiles('filament', profiles.data ?? [], assignment);
  const objectCount = items.reduce((n, i) => n + i.copies, 0);
  const chosenModels = useMemo(() => items.map((i) => models.data?.find((m) => m.id === i.modelId)).filter((m): m is ModelInfo => !!m), [items, models.data]);
  const tooBig = oversized(chosenModels, machine);

  // Vase mode needs exactly one object; drop it when the plate changes.
  useEffect(() => {
    if (overrides.vase && objectCount !== 1) setOverrides(({ vase: _, ...rest }) => rest);
  }, [objectCount, overrides.vase]);

  const selectPrinter = (id: number) => {
    setPrinterId(id);
    setProc('');
    setFil('');
  };

  const submit = () =>
    run('create', async () => {
      const job = await api<JobInfo>('/jobs', {
        body: { items, printerId, process: proc, filament: fil, autoOrient, autoPrint, overrides, note: note || undefined },
      });
      live.upsertJob(job);
      navigate('/jobs');
    });

  const ready = items.length > 0 && printerId && proc && fil;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex items-center gap-3">
        <Link to="/jobs" className="rounded-lg p-2 text-text-2 hover:bg-surface-2 hover:text-text" aria-label="Zurück">
          <ArrowLeft className="size-5" />
        </Link>
        <h1 className="text-2xl font-semibold">Neuer Auftrag</h1>
      </header>

      <Step n={1} title="Modelle">
        <ModelPicker value={items} onChange={setItems} />
      </Step>

      <Step n={2} title="Drucker">
        <div className="grid gap-2 sm:grid-cols-2">
          {printers.map((p) => {
            const a = assignments.data?.find((x) => x.printerId === p.id);
            return (
              <button
                key={p.id}
                disabled={!a?.machine}
                onClick={() => selectPrinter(p.id)}
                className={clsx(
                  'flex items-start gap-3 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                  printerId === p.id ? 'border-accent bg-accent/5' : 'border-border enabled:hover:border-text-3',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{p.name}</div>
                  <div className="truncate text-xs text-text-3">{a?.machine ?? 'Kein Druckerprofil zugeordnet'}</div>
                </div>
                {printerId === p.id && <Check className="size-5 shrink-0 text-accent" />}
              </button>
            );
          })}
        </div>
        {assignments.data && !assignments.data.some((a) => a.machine) && (
          <Alert tone="warning">
            Noch keinem Drucker ist ein Orca-Druckerprofil zugeordnet.{' '}
            <Link to="/settings/slicer" className="underline">
              Profile importieren und zuordnen
            </Link>
          </Alert>
        )}
        {tooBig.length > 0 && machine && (
          <Alert tone="warning">
            <AlertTriangle className="mr-1 inline size-4" />
            Größer als der Bauraum ({String(machine.summary.bedX)} × {String(machine.summary.bedY)} × {String(machine.summary.height)} mm):{' '}
            {tooBig.map((m) => `${m.name} (${formatDims(m.dimensions)})`).join(', ')}. Ggf. „Automatisch ausrichten“ aktivieren.
          </Alert>
        )}
      </Step>

      <Step n={3} title="Profile & Optionen">
        {!printerId ? (
          <p className="text-sm text-text-3">Zuerst einen Drucker wählen.</p>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <ProfileSelect label="Prozess (Qualität)" profiles={processes} value={proc} onChange={setProc} describe={describeProcess} />
              <ProfileSelect label="Filament" profiles={filaments} value={fil} onChange={setFil} describe={describeFilament} />
            </div>
            <SliceOptions value={overrides} onChange={setOverrides} process={processes.find((p) => p.name === proc)} objectCount={objectCount} />
            <Field label="Notiz (optional)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="z. B. für wen, Farbe…" />
            </Field>
            <label className="flex items-center gap-2 text-sm text-text-2">
              <input type="checkbox" checked={autoOrient} onChange={(e) => setAutoOrient(e.target.checked)} className="accent-[var(--accent)]" />
              Automatisch ausrichten (OrcaSlicer wählt die beste Auflagefläche)
            </label>
            <label className="flex items-center gap-2 text-sm text-text-2">
              <input type="checkbox" checked={autoPrint} onChange={(e) => setAutoPrint(e.target.checked)} className="accent-[var(--accent)]" />
              Nach dem Slicen sofort drucken (nur wenn der Drucker frei ist)
            </label>
            {autoPrint && <Alert tone="warning">Der Druck startet ohne weitere Rückfrage. Das Druckbett muss frei und sauber sein.</Alert>}
          </div>
        )}
      </Step>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {items.length > 0 && <span className="mr-auto text-sm text-text-2">
            {objectCount === 1 ? '1 Objekt' : `${objectCount} Objekte werden von OrcaSlicer auf dem Bett verteilt.`}
          </span>}
        <Link to="/jobs">
          <Button variant="ghost">Abbrechen</Button>
        </Link>
        <Button onClick={submit} disabled={!ready} loading={busy === 'create'}>
          Auftrag anlegen & slicen
        </Button>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <span className="flex size-6 items-center justify-center rounded-full bg-surface-2 text-xs text-text-2">{n}</span>
        {title}
      </h2>
      {children}
    </Card>
  );
}
