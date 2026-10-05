import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Cog } from 'lucide-react';
import clsx from 'clsx';
import type { BedType, JobInfo, ModelInfo, PrinterProfileAssignment, SliceOverrides, SlicerProfileInfo, SlicerStatus } from '@printhub/shared';
import { api } from '../../lib/api';
import { toast, useAction } from '../../lib/feedback';
import { useJobs, useLiveJob } from '../../lib/jobs';
import { live, useLive } from '../../lib/live';
import { allowedProfiles, effectiveBedType } from '../../lib/profiles';
import type { Bed, PlateReport } from '../../lib/plate';
import { Alert, Button, Card, Field, Input, Spinner } from '../ui';
import { ModelPicker, type PlateItem } from './ModelPicker';
import { BedTypeSelect, ProfileSelect, describeFilament, describeProcess } from './ProfileSelect';
import { SliceOptions } from './SliceOptions';
import { SliceResult } from './SliceResult';

// three.js is large: only load it when the plate is shown.
const PlateEditor = lazy(() => import('./PlateEditor'));

const STEPS = ['Modelle & Drucker', 'Druckbett', 'Einstellungen', 'Prüfen'] as const;
type Step = 0 | 1 | 2 | 3;

/** Values to start from, e.g. when editing a job. */
export interface WizardInitial {
  items: PlateItem[];
  printerId?: number;
  process?: string;
  filament?: string;
  overrides?: SliceOverrides;
  arrange?: boolean;
  bedType?: BedType | null;
  note?: string;
}

/** Prefill from an existing job (editing). */
export function initialFromJob(job: JobInfo): WizardInitial {
  return {
    items: job.models.map((m) => ({ modelId: m.id, copies: m.copies, ...(m.transform && { transform: m.transform }) })),
    printerId: job.printer?.id,
    process: job.profiles.process.name,
    filament: job.profiles.filament.name,
    overrides: job.overrides,
    arrange: job.arrange,
    bedType: job.bedType,
    note: job.note ?? '',
  };
}

/**
 * Job wizard: models and printer, arrange and orient the parts on the bed, settings, then
 * slice and review before saving, printing or queueing. The job is sliced as a draft;
 * going back or leaving discards it. Used for new jobs, editing and quick print.
 */
export function JobWizard({
  initial,
  fixedPrinter,
  replaces,
  startStep = 0,
  compact = false,
  onFinish,
}: {
  initial?: WizardInitial;
  /** Quick print: the printer is given, step 1 only picks models. */
  fixedPrinter?: number;
  /** Editing: the job that the saved result replaces. */
  replaces?: number;
  startStep?: Step;
  /** In a dialog: collapsed library, no outer page chrome. */
  compact?: boolean;
  /** Called after saving/sending; `to` is where the user should go next. */
  onFinish: (to: 'jobs' | 'printer', job: JobInfo) => void;
}) {
  const printers = useLive((s) => s.printers);
  const jobs = useJobs();
  const status = useQuery({ queryKey: ['slicer-status'], queryFn: () => api<SlicerStatus>('/slicer/status') });
  const models = useQuery({ queryKey: ['models'], queryFn: () => api<ModelInfo[]>('/models') });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<SlicerProfileInfo[]>('/slicer/profiles') });
  const assignments = useQuery({
    queryKey: ['assignments', printers.map((p) => p.id).join(',')],
    queryFn: () => Promise.all(printers.map((p) => api<PrinterProfileAssignment>(`/printers/${p.id}/profiles`))),
    enabled: printers.length > 0,
  });

  const [items, setItems] = useState<PlateItem[]>(initial?.items ?? []);
  const [step, setStep] = useState<Step>(startStep);
  const [printerId, setPrinterId] = useState<number | undefined>(fixedPrinter ?? initial?.printerId);
  const [proc, setProc] = useState(initial?.process ?? '');
  const [fil, setFil] = useState(initial?.filament ?? '');
  const [overrides, setOverrides] = useState<SliceOverrides>(initial?.overrides ?? {});
  const [arrange, setArrange] = useState(initial?.arrange ?? true);
  const [bedType, setBedType] = useState<BedType | null>(initial?.bedType ?? null);
  const [report, setReport] = useState<PlateReport>({ blocking: null, overhangs: null });
  const [note, setNote] = useState(initial?.note ?? '');
  const [draftId, setDraftId] = useState<number>();
  const { busy, run } = useAction();
  const top = useRef<HTMLDivElement>(null);

  const printer = printers.find((p) => p.id === printerId);
  const assignment = assignments.data?.find((a) => a.printerId === printerId);
  const machine = profiles.data?.find((p) => p.kind === 'machine' && p.name === assignment?.machine);
  const processes = allowedProfiles('process', profiles.data ?? [], assignment);
  const filaments = allowedProfiles('filament', profiles.data ?? [], assignment);
  const process = processes.find((p) => p.name === proc);
  const filament = filaments.find((p) => p.name === fil);
  const objectCount = items.reduce((n, i) => n + i.copies, 0);
  const modelMap = useMemo(() => new Map((models.data ?? []).map((m) => [m.id, m])), [models.data]);
  const plate = bedType ?? effectiveBedType(assignment, machine);
  const bed = useMemo(() => bedOf(machine), [machine]);
  const supportOn = overrides.support?.enabled ?? !!process?.summary.support;
  const supportAngle = overrides.support?.angle || Number(process?.summary.supportAngle) || 30;

  // Kept current by push messages; polled as a fallback until the live list has it.
  const liveDraft = useLiveJob(draftId);
  const polled = useQuery({
    queryKey: ['job', draftId],
    queryFn: () => api<JobInfo>(`/jobs/${draftId}`),
    enabled: !!draftId && !liveDraft,
    refetchInterval: 2000,
  });
  const draft = liveDraft ?? polled.data;

  // Defaults per printer: the profiles last used on it, else a "Standard" process.
  // Names that are no longer allowed (e.g. an edited job's old profile) are replaced.
  useEffect(() => {
    if (!printerId || !profiles.data || !assignment || !jobs) return;
    const last = jobs.find((j) => j.printer?.id === printerId);
    if (processes.length && !processes.some((p) => p.name === proc)) {
      setProc(processes.find((p) => p.name === last?.profiles.process.name)?.name ?? processes.find((p) => /standard/i.test(p.name))?.name ?? processes[0]!.name);
    }
    if (filaments.length && !filaments.some((p) => p.name === fil)) {
      setFil(filaments.find((p) => p.name === last?.profiles.filament.name)?.name ?? filaments[0]!.name);
    }
  }, [printerId, profiles.data, assignment, jobs, processes, filaments, proc, fil]);

  // Vase mode needs exactly one object; drop it when the plate changes.
  useEffect(() => {
    if (overrides.vase && objectCount !== 1) setOverrides(({ vase: _, ...rest }) => rest);
  }, [objectCount, overrides.vase]);

  // An unsaved draft is discarded when going back or leaving.
  const draftRef = useRef<{ id?: number; saved: boolean }>({ saved: false });
  draftRef.current.id = draftId;
  useEffect(
    () => () => {
      const { id, saved } = draftRef.current;
      if (id && !saved) void fetch(`/api/jobs/${id}`, { method: 'DELETE', keepalive: true, credentials: 'same-origin', headers: { 'x-printhub-request': '1' } });
    },
    [],
  );
  const discardDraft = () => {
    if (draftId && !draftRef.current.saved) void api(`/jobs/${draftId}`, { method: 'DELETE' }).catch(() => {});
    setDraftId(undefined);
  };

  const selectPrinter = (id: number) => {
    if (id === printerId) return;
    setPrinterId(id);
    setProc('');
    setFil('');
    setBedType(null);
  };

  const goTo = (s: Step) => {
    if (step === 3 && s < 3) discardDraft();
    setStep(s);
    top.current?.scrollIntoView({ block: 'start' });
  };

  const slice = () =>
    run('slice', async () => {
      const job = await api<JobInfo>('/jobs', {
        body: {
          // Positions only matter for a manually arranged plate.
          items: items.map(({ transform, ...i }) => ({
            ...i,
            ...(transform && { transform: arrange ? { rotation: transform.rotation, scale: transform.scale } : transform }),
          })),
          printerId,
          process: proc,
          filament: fil,
          arrange,
          bedType: plate,
          overrides,
          note: note || undefined,
          draft: true,
          ...(replaces && { replaces }),
        },
      });
      live.upsertJob(job);
      draftRef.current.saved = false;
      setDraftId(job.id);
      setStep(3);
      top.current?.scrollIntoView({ block: 'start' });
    });

  const finish = (to: 'jobs' | 'printer', job: JobInfo) => {
    draftRef.current.saved = true;
    onFinish(to, job);
  };
  const save = () =>
    run('keep', async () => {
      const job = await api<JobInfo>(`/jobs/${draftId}/keep`, { body: {} });
      live.upsertJob(job);
      toast(replaces ? 'Änderungen gespeichert' : 'Auftrag gespeichert');
      finish('jobs', job);
    });

  if (status.data && !status.data.available) return <Alert tone="warning">Slicen ist nicht möglich: {status.data.reason}</Alert>;
  if (fixedPrinter && assignments.data && !assignment?.machine) {
    return (
      <Alert tone="warning">
        Diesem Drucker ist noch kein OrcaSlicer-Druckerprofil zugeordnet.{' '}
        <Link to="/settings/slicer" className="underline">
          Jetzt zuordnen
        </Link>
      </Alert>
    );
  }

  const canNext: Record<Step, boolean> = {
    0: items.length > 0 && !!printerId && !!bed,
    1: !report.blocking,
    2: !!proc && !!fil,
    3: false,
  };
  const Section = compact ? PlainSection : CardSection;

  return (
    <div ref={top} className="scroll-mt-4 space-y-5">
      <ol className="flex gap-1 overflow-x-auto text-sm">
        {STEPS.map((label, i) => {
          const reachable = i < step || (i === step + 1 && canNext[step]);
          const text = i === 0 && fixedPrinter ? 'Modelle' : label;
          return (
            <li key={label} className="min-w-0 flex-1">
              <button
                type="button"
                disabled={i === step || !reachable || i === 3}
                onClick={() => goTo(i as Step)}
                className={clsx(
                  'flex w-full items-center gap-2 whitespace-nowrap rounded-lg border-b-2 px-2 py-2 text-left',
                  i === step ? 'border-accent font-medium text-text' : i < step ? 'border-good text-text-2 hover:text-text' : 'border-border text-text-3',
                )}
              >
                <span
                  className={clsx(
                    'flex size-6 shrink-0 items-center justify-center rounded-full text-xs',
                    i < step ? 'bg-good text-white' : i === step ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-text-2',
                  )}
                >
                  {i < step ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span className={clsx('truncate', i !== step && 'hidden md:inline')}>{text}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {step === 0 && (
        <>
          <Section title="Modelle">
            <ModelPicker value={items} onChange={setItems} library={compact ? 'collapsed' : 'open'} />
          </Section>
          {!fixedPrinter && (
            <Section title="Drucker">
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
            </Section>
          )}
          {printerId && machine && !bed && <Alert tone="warning">Das Druckerprofil enthält keine Bettgröße.</Alert>}
        </>
      )}

      {step === 1 && bed && (
        <Section
          title="Druckbett"
          hint="In der Teileliste ein Teil antippen: „Flach hinlegen“ sucht die beste Auflageseite, außerdem drehen, Fläche wählen oder Einheit umstellen."
        >
          <Suspense fallback={<Spinner />}>
            <PlateEditor
              items={items}
              onChange={setItems}
              models={modelMap}
              bed={bed}
              arrange={arrange}
              onArrangeChange={setArrange}
              supportAngle={supportAngle}
              supportOn={supportOn}
              onEnableSupport={() =>
                setOverrides({ ...overrides, support: { enabled: true, type: 'tree', buildPlateOnly: false, ...(overrides.support?.angle && { angle: overrides.support.angle }) } })
              }
              onReport={setReport}
            />
          </Suspense>
        </Section>
      )}

      {step === 2 && (
        <Section title="Einstellungen">
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <ProfileSelect label="Prozess (Qualität)" profiles={processes} value={proc} onChange={setProc} describe={describeProcess} />
              <div className="space-y-4">
                <Field label="Druckplatte" hint="Bestimmt die Betttemperatur aus dem Filamentprofil">
                  <BedTypeSelect value={plate} onChange={setBedType} />
                </Field>
                <ProfileSelect label="Filament" profiles={filaments} value={fil} onChange={setFil} describe={(p) => describeFilament(p, plate)} />
              </div>
            </div>
            <SliceOptions value={overrides} onChange={setOverrides} process={process} objectCount={objectCount} />
            <Field label="Notiz (optional)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="z. B. für wen, Farbe…" />
            </Field>
          </div>
        </Section>
      )}

      {step === 3 && (
        <Section title="Prüfen">
          {!draft || !printer ? (
            <Spinner />
          ) : (
            <SliceResult
              job={draft}
              printer={printer}
              filament={filament}
              backLabel="Zurück zum Druckbett"
              onBack={() => goTo(1)}
              onSave={draft.status === 'sliced' ? save : undefined}
              onDone={() => finish('printer', draft)}
            />
          )}
        </Section>
      )}

      {step < 3 && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {step === 1 && report.blocking && <span className="mr-auto text-sm text-critical">{report.blocking}</span>}
          {step === 0 && items.length > 0 && <span className="mr-auto text-sm text-text-2">{objectCount === 1 ? '1 Objekt' : `${objectCount} Objekte`}</span>}
          {step > 0 && (
            <Button variant="ghost" onClick={() => goTo((step - 1) as Step)}>
              <ArrowLeft className="size-4" /> Zurück
            </Button>
          )}
          {step < 2 ? (
            <Button onClick={() => goTo((step + 1) as Step)} disabled={!canNext[step]}>
              Weiter <ArrowRight className="size-4" />
            </Button>
          ) : (
            <Button onClick={slice} disabled={!canNext[2]} loading={busy === 'slice'}>
              <Cog className="size-4" /> Slicen & prüfen
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function bedOf(machine: SlicerProfileInfo | undefined): Bed | null {
  const s = machine?.summary;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const width = n(s?.bedX);
  const depth = n(s?.bedY);
  if (!width || !depth) return null;
  return { x0: n(s?.bedX0) ?? 0, y0: n(s?.bedY0) ?? 0, width, depth, height: n(s?.height) ?? 250 };
}

function CardSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <SectionHead title={title} hint={hint} />
      {children}
    </Card>
  );
}

function PlainSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <SectionHead title={title} hint={hint} />
      {children}
    </section>
  );
}

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <h2 className="font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 text-sm text-text-3">{hint}</p>}
    </div>
  );
}
