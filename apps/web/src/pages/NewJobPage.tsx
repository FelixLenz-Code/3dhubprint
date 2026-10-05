import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Box, Check, Trash2, Upload } from 'lucide-react';
import clsx from 'clsx';
import type { JobInfo, ModelInfo, PrinterProfileAssignment, SlicerProfileInfo } from '@printhub/shared';
import { api, uploadWithProgress } from '../lib/api';
import { confirm, toast, useAction } from '../lib/feedback';
import { formatDims } from '../lib/jobs';
import { live, useLive } from '../lib/live';
import { formatBytes } from '../lib/files';
import { allowedProfiles } from '../lib/profiles';
import { Alert, Button, Card, Field, Input, ProgressBar, Spinner } from '../components/ui';

const MODEL_EXT = /\.(stl|3mf|obj)$/i;

export function NewJobPage() {
  const navigate = useNavigate();
  const printers = useLive((s) => s.printers);
  const qc = useQueryClient();
  const models = useQuery({ queryKey: ['models'], queryFn: () => api<ModelInfo[]>('/models') });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<SlicerProfileInfo[]>('/slicer/profiles') });
  const assignments = useQuery({
    queryKey: ['assignments', printers.map((p) => p.id).join(',')],
    queryFn: () => Promise.all(printers.map((p) => api<PrinterProfileAssignment>(`/printers/${p.id}/profiles`))),
    enabled: printers.length > 0,
  });

  const [modelId, setModelId] = useState<number>();
  const [printerId, setPrinterId] = useState<number>();
  const [proc, setProc] = useState('');
  const [fil, setFil] = useState('');
  const [copies, setCopies] = useState(1);
  const [autoOrient, setAutoOrient] = useState(false);
  const [autoPrint, setAutoPrint] = useState(false);
  const [note, setNote] = useState('');
  const { busy, run } = useAction();

  const model = models.data?.find((m) => m.id === modelId);
  const assignment = assignments.data?.find((a) => a.printerId === printerId);
  const byKind = (kind: string) => profiles.data?.filter((p) => p.kind === kind) ?? [];
  const machine = byKind('machine').find((p) => p.name === assignment?.machine);
  const processes = allowedProfiles('process', profiles.data ?? [], assignment);
  const filaments = allowedProfiles('filament', profiles.data ?? [], assignment);

  const fits = useMemo(() => {
    if (!model || !machine) return true;
    const { bedX, bedY, height } = machine.summary as { bedX?: number; bedY?: number; height?: number };
    const [x, y, z] = model.dimensions;
    const flat = Math.max(x, y) <= Math.max(bedX ?? Infinity, bedY ?? Infinity) && Math.min(x, y) <= Math.min(bedX ?? Infinity, bedY ?? Infinity);
    return flat && z <= (height ?? Infinity);
  }, [model, machine]);

  const selectPrinter = (id: number) => {
    setPrinterId(id);
    setProc('');
    setFil('');
  };

  const submit = () =>
    run('create', async () => {
      const job = await api<JobInfo>('/jobs', {
        body: { modelId, printerId, process: proc, filament: fil, copies, autoOrient, autoPrint, note: note || undefined },
      });
      live.upsertJob(job);
      navigate('/jobs');
    });

  const ready = modelId && printerId && proc && fil;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex items-center gap-3">
        <Link to="/jobs" className="rounded-lg p-2 text-text-2 hover:bg-surface-2 hover:text-text" aria-label="Zurück">
          <ArrowLeft className="size-5" />
        </Link>
        <h1 className="text-2xl font-semibold">Neuer Auftrag</h1>
      </header>

      <Step n={1} title="Modell">
        <ModelUpload
          onUploaded={(m) => {
            qc.setQueryData<ModelInfo[]>(['models'], (old) => [m, ...(old ?? []).filter((x) => x.id !== m.id)]);
            setModelId(m.id);
          }}
        />
        {models.isLoading ? (
          <Spinner />
        ) : (
          <ModelLibrary
            models={models.data ?? []}
            selected={modelId}
            onSelect={setModelId}
            onDeleted={(id) => {
              qc.setQueryData<ModelInfo[]>(['models'], (old) => old?.filter((m) => m.id !== id));
              if (id === modelId) setModelId(undefined);
            }}
          />
        )}
      </Step>

      <Step n={2} title="Drucker">
        <div className="grid gap-2 sm:grid-cols-2">
          {printers.map((p) => {
            const a = assignments.data?.find((x) => x.printerId === p.id);
            const usable = !!a?.machine;
            return (
              <button
                key={p.id}
                disabled={!usable}
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
                {printerId === p.id && <Check className="size-5 text-accent" />}
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
        {model && machine && !fits && (
          <Alert tone="warning">
            <AlertTriangle className="mr-1 inline size-4" />
            Das Modell ({formatDims(model.dimensions)}) ist größer als der Bauraum ({String(machine.summary.bedX)} × {String(machine.summary.bedY)} ×{' '}
            {String(machine.summary.height)} mm). Ggf. „Automatisch ausrichten“ aktivieren.
          </Alert>
        )}
      </Step>

      <Step n={3} title="Profile & Optionen">
        {!printerId ? (
          <p className="text-sm text-text-3">Zuerst einen Drucker wählen.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <ProfilePicker label="Prozess (Qualität)" profiles={processes} value={proc} onChange={setProc} describe={describeProcess} />
              <ProfilePicker label="Filament" profiles={filaments} value={fil} onChange={setFil} describe={describeFilament} />
            </div>
            <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
              <Field label="Kopien">
                <Input type="number" min={1} max={50} value={copies} onChange={(e) => setCopies(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
              </Field>
              <Field label="Notiz (optional)">
                <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="z. B. für wen, Farbe…" />
              </Field>
            </div>
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

      <div className="flex justify-end gap-2">
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

function ModelUpload({ onUploaded }: { onUploaded: (m: ModelInfo) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<{ name: string; value: number } | null>(null);

  const upload = async (file: File) => {
    if (!MODEL_EXT.test(file.name)) return toast('Nur STL-, 3MF- oder OBJ-Dateien', 'critical');
    const form = new FormData();
    form.append('file', file, file.name);
    setProgress({ name: file.name, value: 0 });
    try {
      onUploaded(await uploadWithProgress<ModelInfo>('/models', form, (v) => setProgress({ name: file.name, value: v })));
    } catch (err) {
      toast((err as Error).message, 'critical');
    } finally {
      setProgress(null);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files[0];
        if (f) void upload(f);
      }}
      className={clsx('flex flex-wrap items-center gap-3 rounded-xl border-2 border-dashed px-4 py-4', drag ? 'border-accent bg-accent/5' : 'border-border')}
    >
      <input
        ref={input}
        type="file"
        accept=".stl,.3mf,.obj"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void upload(f);
        }}
      />
      {progress ? (
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="tabular flex justify-between gap-2 text-sm">
            <span className="truncate">{progress.name}</span>
            <span className="text-text-2">{progress.value < 1 ? `${Math.round(progress.value * 100)} %` : 'wird analysiert…'}</span>
          </div>
          <ProgressBar value={progress.value} />
        </div>
      ) : (
        <>
          <Button onClick={() => input.current?.click()}>
            <Upload className="size-4" /> Modell hochladen
          </Button>
          <span className="text-sm text-text-3">STL, 3MF oder OBJ, auch per Drag & Drop</span>
        </>
      )}
    </div>
  );
}

function ModelLibrary({
  models,
  selected,
  onSelect,
  onDeleted,
}: {
  models: ModelInfo[];
  selected?: number;
  onSelect: (id: number) => void;
  onDeleted: (id: number) => void;
}) {
  const [filter, setFilter] = useState('');
  const { run } = useAction();
  if (!models.length) return <p className="text-sm text-text-3">Die Modell-Bibliothek ist noch leer.</p>;
  const shown = filter ? models.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase())) : models;

  const remove = async (m: ModelInfo) => {
    if (await confirm({ title: 'Modell löschen?', body: `„${m.name}“ wird aus der Bibliothek entfernt.`, confirmLabel: 'Löschen', danger: true })) {
      if (await run('del', () => api(`/models/${m.id}`, { method: 'DELETE' }))) onDeleted(m.id);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-text-2">Bibliothek ({models.length})</span>
        {models.length > 6 && <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Suchen…" className="max-w-48" />}
      </div>
      <div className="grid max-h-[26rem] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4">
        {shown.map((m) => (
          <div
            key={m.id}
            className={clsx(
              'group relative rounded-xl border p-2 transition-colors',
              selected === m.id ? 'border-accent bg-accent/5' : 'border-border hover:border-text-3',
            )}
          >
            <button onClick={() => onSelect(m.id)} className="block w-full text-left">
              <img src={m.thumbnailUrl} alt="" loading="lazy" className="aspect-square w-full rounded-lg bg-surface-2 object-contain" />
              <div className="mt-1.5 truncate text-sm font-medium" title={m.name}>
                {m.name}
              </div>
              <div className="tabular truncate text-xs text-text-3">
                {formatDims(m.dimensions)} · {formatBytes(m.size)}
              </div>
            </button>
            {selected === m.id && <Check className="absolute right-3 top-3 size-5 rounded-full bg-accent p-0.5 text-accent-ink" />}
            <button
              onClick={() => remove(m)}
              className="absolute left-3 top-3 rounded-md bg-surface/90 p-1 text-text-3 opacity-0 transition-opacity hover:text-critical focus:opacity-100 group-hover:opacity-100"
              aria-label={`${m.name} löschen`}
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        {!shown.length && (
          <div className="col-span-full flex items-center gap-2 text-sm text-text-3">
            <Box className="size-4" /> Keine Treffer
          </div>
        )}
      </div>
    </div>
  );
}

function ProfilePicker({
  label,
  profiles,
  value,
  onChange,
  describe,
}: {
  label: string;
  profiles: SlicerProfileInfo[];
  value: string;
  onChange: (v: string) => void;
  describe: (p: SlicerProfileInfo) => string;
}) {
  return (
    <Field label={label}>
      <div className="space-y-1.5">
        {profiles.length === 0 && <p className="text-sm text-text-3">Keine Profile verfügbar.</p>}
        {profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.name)}
            className={clsx(
              'flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left',
              value === p.name ? 'border-accent bg-accent/5' : 'border-border hover:border-text-3',
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{p.name}</div>
              <div className="truncate text-xs text-text-3">{describe(p)}</div>
            </div>
            {value === p.name && <Check className="size-4 shrink-0 text-accent" />}
          </button>
        ))}
      </div>
    </Field>
  );
}

export function describeProcess(p: SlicerProfileInfo) {
  const s = p.summary;
  return [s.layerHeight && `${s.layerHeight} mm`, s.walls && `${s.walls} Wände`, s.infill && `${s.infill} Infill`, s.support && 'Stützen'].filter(Boolean).join(' · ');
}

export function describeFilament(p: SlicerProfileInfo) {
  const s = p.summary;
  return [s.material, s.nozzleTemp && `${s.nozzleTemp} °C`, s.bedTemp && `Bett ${s.bedTemp} °C`, s.flow && `Flow ${s.flow}`].filter(Boolean).join(' · ');
}
