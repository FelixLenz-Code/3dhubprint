import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, CheckSquare, ClipboardList, Download, FileText, ListPlus, ListX, Pencil, Play, Plus, RotateCw, Send, Trash2 } from 'lucide-react';
import type { JobInfo, JobStatus, SlicerStatus } from '@printhub/shared';
import { api } from '../lib/api';
import { useIsAdmin } from '../lib/auth';
import { confirm, toast, useAction } from '../lib/feedback';
import { confirmPrintStart } from '../lib/printStart';
import { formatDuration, formatFilament, isActivePrint } from '../lib/format';
import { JOB_STATUS, PRINTABLE, formatDims, jobTitle, queueOf, useJobs } from '../lib/jobs';
import { useLive } from '../lib/live';
import { Alert, Badge, Button, Card, Spinner } from '../components/ui';
import { describeOverrides } from '../components/slicing/SliceOptions';
import { PlatePreview } from '../components/slicing/PlatePreview';
import { Modal } from '../components/Modal';

/** Jobs that are over: printed, failed or cancelled. */
const FINISHED: JobStatus[] = ['done', 'print_failed', 'print_cancelled', 'failed', 'cancelled'];

/** Selection for deleting several jobs at once; undefined = not selecting. */
export interface Selection {
  ids: Set<number>;
  toggle: (id: number) => void;
}

export function JobsPage() {
  const jobs = useJobs();
  const isAdmin = useIsAdmin();
  const status = useQuery({ queryKey: ['slicer-status'], queryFn: () => api<SlicerStatus>('/slicer/status') });
  const [selected, setSelected] = useState<Set<number>>();
  const { busy, run } = useAction();
  // Jobs that went away (deleted elsewhere) drop out of the selection.
  const ids = selected && jobs ? new Set([...selected].filter((id) => jobs.some((j) => j.id === id))) : selected;
  const selection: Selection | undefined = ids && {
    ids,
    toggle: (id) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelected(next);
    },
  };

  const deleteSelected = async () => {
    if (!ids?.size) return;
    const n = ids.size;
    const affectsQueue = jobs?.some((j) => ids.has(j.id) && (j.status === 'waiting' || j.status === 'slicing'));
    if (
      !(await confirm({
        title: `${n} ${n === 1 ? 'Auftrag' : 'Aufträge'} löschen?`,
        body: `Die geslicten G-Codes in PrintHub werden gelöscht (nicht auf den Druckern).${affectsQueue ? ' Laufendes Slicen wird abgebrochen, wartende Aufträge verlassen die Warteschlange.' : ''}`,
        confirmLabel: 'Löschen',
        danger: true,
      }))
    )
      return;
    await run('bulk', async () => {
      const r = await api<{ deleted: number[]; skipped: { id: number; reason: string }[] }>('/jobs/delete', { body: { ids: [...ids] } });
      if (r.skipped.length) toast(`${r.deleted.length} gelöscht, ${r.skipped.length} übersprungen: ${r.skipped[0]!.reason}`, 'critical');
      else toast(`${r.deleted.length} ${r.deleted.length === 1 ? 'Auftrag' : 'Aufträge'} gelöscht`);
      setSelected(undefined);
    });
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Aufträge</h1>
          <p className="text-sm text-text-2">Modelle slicen und an die Drucker senden</p>
        </div>
        {isAdmin && (
          <div className="flex gap-2">
            {!!jobs?.length && !selection && (
              <Button variant="secondary" onClick={() => setSelected(new Set())}>
                <CheckSquare className="size-4" /> Auswählen
              </Button>
            )}
            <Link to="/jobs/new">
              <Button>
                <Plus className="size-4" /> Neuer Auftrag
              </Button>
            </Link>
          </div>
        )}
      </header>

      {selection && jobs && (
        <Card className="sticky top-2 z-10 flex flex-wrap items-center gap-2 p-3 shadow-lg">
          <span className="mr-auto text-sm font-medium">
            {selection.ids.size} {selection.ids.size === 1 ? 'Auftrag' : 'Aufträge'} ausgewählt
          </span>
          <Button variant="ghost" className="min-h-9 px-3" onClick={() => setSelected(new Set(jobs.filter((j) => FINISHED.includes(j.status)).map((j) => j.id)))}>
            Abgeschlossene
          </Button>
          <Button
            variant="ghost"
            className="min-h-9 px-3"
            onClick={() => setSelected(selection.ids.size === jobs.length ? new Set() : new Set(jobs.map((j) => j.id)))}
          >
            {selection.ids.size === jobs.length ? 'Keine' : 'Alle'}
          </Button>
          <Button variant="secondary" className="min-h-9 px-3" onClick={() => setSelected(undefined)}>
            Fertig
          </Button>
          <Button variant="danger" className="min-h-9 px-3" onClick={deleteSelected} loading={busy === 'bulk'} disabled={!selection.ids.size}>
            <Trash2 className="size-4" /> Löschen
          </Button>
        </Card>
      )}

      {status.data && !status.data.available && (
        <Alert tone="warning">Slicen ist nicht möglich: {status.data.reason}. In der Docker-Installation ist OrcaSlicer enthalten.</Alert>
      )}

      {jobs === null ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : jobs.length === 0 ? (
        <Card className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <ClipboardList className="size-10 text-text-3" />
          <div>
            <h2 className="font-semibold">Noch keine Aufträge</h2>
            <p className="text-sm text-text-2">Lade ein STL-, 3MF- oder OBJ-Modell hoch und lass es für einen Drucker slicen.</p>
          </div>
          {isAdmin && (
            <Link to="/jobs/new">
              <Button>
                <Plus className="size-4" /> Neuer Auftrag
              </Button>
            </Link>
          )}
        </Card>
      ) : (
        <>
          <Queues jobs={jobs} editable={isAdmin} selection={selection} />
          {jobs.some((j) => j.status !== 'waiting') && (
            <section className="space-y-2">
              <h2 className="text-sm font-medium text-text-2">Alle Aufträge</h2>
              <Card className="divide-y divide-border overflow-hidden">
                {jobs
                  .filter((j) => j.status !== 'waiting')
                  .map((j) => (
                    <JobRow key={j.id} job={j} editable={isAdmin} selection={selection} />
                  ))}
              </Card>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** One block per printer with its waiting jobs in order. */
function Queues({ jobs, editable, selection }: { jobs: JobInfo[]; editable: boolean; selection?: Selection }) {
  const printers = useLive((s) => s.printers);
  const withQueue = printers.map((p) => ({ printer: p, queue: queueOf(jobs, p.id) })).filter((x) => x.queue.length);
  if (!withQueue.length) return null;
  return (
    <>
      {withQueue.map(({ printer, queue }) => (
        <section key={printer.id} className="space-y-2">
          <h2 className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-text-2">
            <span>Warteschlange {printer.name}</span>
            <span className="text-xs font-normal text-text-3">
              {isActivePrint(printer.status)
                ? 'startet nach dem aktuellen Druck, sobald das Bett freigegeben ist'
                : printer.bedClear
                  ? 'startet automatisch'
                  : 'wartet auf „Bett frei“ (Druckerseite oder Dashboard)'}
            </span>
          </h2>
          <Card className="divide-y divide-border overflow-hidden">
            {queue.map((j, i) => (
              <JobRow key={j.id} job={j} editable={editable} first={i === 0} last={i === queue.length - 1} selection={selection} />
            ))}
          </Card>
        </section>
      ))}
    </>
  );
}

function JobRow({
  job,
  editable,
  first,
  last,
  selection,
}: {
  job: JobInfo;
  editable: boolean;
  first?: boolean;
  last?: boolean;
  selection?: Selection;
}) {
  const { busy, run } = useAction();
  const [log, setLog] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const printer = useLive((s) => s.printers.find((p) => p.id === job.printer?.id));
  const st = JOB_STATUS[job.status];
  const working = job.status === 'queued' || job.status === 'slicing' || job.status === 'uploading';
  const ready = PRINTABLE.includes(job.status) || job.status === 'printing' || job.status === 'waiting';
  const printable = PRINTABLE.includes(job.status);
  const printerBusy = !printer || printer.status.connection !== 'connected' || isActivePrint(printer.status);

  const send = async (print: boolean) => {
    if (
      print &&
      (!printer ||
        !(await confirmPrintStart(printer, {
        title: job.status === 'done' ? 'Erneut drucken?' : 'Druck starten?',
        body: (
          <>
            „{jobTitle(job)}“ wird an <b>{job.printer?.name}</b> gesendet und sofort gedruckt. Ist das Druckbett frei und sauber?
          </>
        ),
        })))
    )
      return;
    await run(print ? 'print' : 'send', () => api(`/jobs/${job.id}/send`, { body: { print } }), print ? 'Druck gestartet' : 'An den Drucker übertragen');
  };

  const remove = async () => {
    if (
      await confirm({
        title: 'Auftrag löschen?',
        body: job.status === 'slicing' ? 'Das laufende Slicen wird abgebrochen.' : 'Der gesliced G-Code in PrintHub wird gelöscht (nicht auf dem Drucker).',
        confirmLabel: 'Löschen',
        danger: true,
      })
    )
      void run('delete', () => api(`/jobs/${job.id}`, { method: 'DELETE' }));
  };

  const showLog = async () => {
    if (log !== null) return setLog(null);
    const res = await api<{ log: string }>(`/jobs/${job.id}/log`);
    setLog(res.log || '(kein Log)');
  };

  return (
    <div className={clsx('space-y-3 p-4', selection?.ids.has(job.id) && 'bg-accent/5')}>
      <div className="flex gap-4">
        {selection && (
          <label className="-my-1 -ml-1 flex shrink-0 cursor-pointer items-center self-stretch px-1">
            <input
              type="checkbox"
              checked={selection.ids.has(job.id)}
              onChange={() => selection.toggle(job.id)}
              className="size-5 accent-[var(--accent)]"
              aria-label={`${jobTitle(job)} auswählen`}
            />
          </label>
        )}
        <button
          type="button"
          className="relative shrink-0 disabled:cursor-default"
          onClick={() => setShowPreview(true)}
          disabled={!job.preview}
          title={job.preview ? 'Vorschau der geslicten Platte' : undefined}
        >
          <img
            src={job.preview?.iso ?? job.model.thumbnailUrl}
            alt=""
            loading="lazy"
            className="size-16 rounded-lg bg-surface-2 object-contain sm:size-20"
          />
          {job.models.length > 1 && (
            <span className="absolute -bottom-1 -right-1 rounded-full border-2 border-surface bg-accent px-1.5 text-xs font-semibold text-accent-ink">
              +{job.models.length - 1}
            </span>
          )}
        </button>
        {job.preview && (
          <Modal open={showPreview} onClose={() => setShowPreview(false)} title={`Vorschau: ${jobTitle(job)}`}>
            <PlatePreview preview={job.preview} />
          </Modal>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-words font-medium">{job.models.map((m) => (m.copies > 1 ? `${m.name} ×${m.copies}` : m.name)).join(', ')}</span>
            <Badge tone={st.tone}>
              {working && <Spinner className="size-3" />}
              {st.label}
            </Badge>
          </div>
          <div className="truncate text-sm text-text-2">
            {job.printer?.name ?? 'gelöschter Drucker'} · {job.profiles.process.name} · {job.profiles.filament.name}
          </div>
          <div className="tabular text-xs text-text-3">
            {job.models.length === 1 ? formatDims(job.model.dimensions) : `${job.copies} Objekte`}
            {job.estimatedTime !== null && ` · ${formatDuration(job.estimatedTime)}`}
            {job.filamentMm !== null && ` · ${formatFilament(job.filamentMm)}`}
            {job.filamentG !== null && ` · ${job.filamentG.toFixed(1).replace('.', ',')} g`}
            {' · '}
            {new Date(job.createdAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </div>
          {describeOverrides(job.overrides).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {describeOverrides(job.overrides).map((t) => (
                <span key={t} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs text-text-2">
                  {t}
                </span>
              ))}
            </div>
          )}
          {job.note && <div className="text-xs text-text-2">{job.note}</div>}
        </div>
      </div>

      {job.error && <Alert tone={job.status === 'failed' ? 'critical' : 'warning'}>{job.error}</Alert>}

      <div className="flex flex-wrap gap-2">
        {editable && job.status === 'waiting' && (
          <>
            <span className="tabular flex size-10 items-center justify-center rounded-lg bg-surface-2 text-sm font-semibold" title="Position in der Warteschlange">
              {job.queuePosition}
            </span>
            <Button variant="secondary" className="px-3" disabled={first} onClick={() => run('up', () => api(`/jobs/${job.id}/move`, { body: { direction: 'up' } }))} aria-label="Nach vorne">
              <ArrowUp className="size-4" />
            </Button>
            <Button variant="secondary" className="px-3" disabled={last} onClick={() => run('down', () => api(`/jobs/${job.id}/move`, { body: { direction: 'down' } }))} aria-label="Nach hinten">
              <ArrowDown className="size-4" />
            </Button>
            <Button variant="ghost" onClick={() => run('dequeue', () => api(`/jobs/${job.id}/dequeue`, { body: {} }))} loading={busy === 'dequeue'}>
              <ListX className="size-4" /> Herausnehmen
            </Button>
          </>
        )}
        {editable && printable && (
          <>
            <Button onClick={() => send(true)} loading={busy === 'print'} disabled={printerBusy} title={printerBusy ? 'Drucker nicht bereit oder beschäftigt' : undefined}>
              <Play className="size-4" /> {job.status === 'sliced' || job.status === 'uploaded' ? 'Drucken' : 'Nochmal drucken'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => run('enqueue', () => api(`/jobs/${job.id}/enqueue`, { body: {} }), 'In die Warteschlange gestellt')}
              loading={busy === 'enqueue'}
            >
              <ListPlus className="size-4" /> Einreihen
            </Button>
            {job.status === 'sliced' && (
              <Button variant="secondary" onClick={() => send(false)} loading={busy === 'send'} disabled={!printer || printer.status.connection !== 'connected'}>
                <Send className="size-4" /> Nur übertragen
              </Button>
            )}
          </>
        )}
        {editable && (job.status === 'failed' || job.status === 'cancelled') && (
          <Button variant="secondary" onClick={() => run('retry', () => api(`/jobs/${job.id}/retry`, { body: {} }))} loading={busy === 'retry'}>
            <RotateCw className="size-4" /> Erneut slicen
          </Button>
        )}
        {editable && job.status !== 'uploading' && job.status !== 'printing' && (
          <Link to={`/jobs/${job.id}/edit`}>
            <Button variant="ghost">
              <Pencil className="size-4" /> Bearbeiten
            </Button>
          </Link>
        )}
        {ready && (
          <a href={`/api/jobs/${job.id}/gcode`} download>
            <Button variant="ghost">
              <Download className="size-4" /> G-Code
            </Button>
          </a>
        )}
        {(job.status === 'failed' || ready || job.status === 'print_failed') && (
          <Button variant="ghost" onClick={showLog}>
            <FileText className="size-4" /> {log === null ? 'Log' : 'Log ausblenden'}
          </Button>
        )}
        {editable && job.status !== 'uploading' && job.status !== 'printing' && (
          <Button variant="ghost" onClick={remove} loading={busy === 'delete'} className="ml-auto" aria-label="Auftrag löschen">
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>

      {log !== null && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs text-text-2">{log}</pre>
      )}
    </div>
  );
}
