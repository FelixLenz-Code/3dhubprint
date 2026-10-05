import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Download, FileText, Play, Plus, RotateCw, Send, Trash2 } from 'lucide-react';
import type { JobInfo, SlicerStatus } from '@printhub/shared';
import { api } from '../lib/api';
import { useIsAdmin } from '../lib/auth';
import { confirm, useAction } from '../lib/feedback';
import { formatDuration, formatFilament, isActivePrint } from '../lib/format';
import { JOB_STATUS, formatDims, useJobs } from '../lib/jobs';
import { useLive } from '../lib/live';
import { Alert, Badge, Button, Card, Spinner } from '../components/ui';
import { describeOverrides } from '../components/slicing/SliceOptions';

export function JobsPage() {
  const jobs = useJobs();
  const isAdmin = useIsAdmin();
  const status = useQuery({ queryKey: ['slicer-status'], queryFn: () => api<SlicerStatus>('/slicer/status') });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Aufträge</h1>
          <p className="text-sm text-text-2">Modelle slicen und an die Drucker senden</p>
        </div>
        {isAdmin && (
          <Link to="/jobs/new">
            <Button>
              <Plus className="size-4" /> Neuer Auftrag
            </Button>
          </Link>
        )}
      </header>

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
        <Card className="divide-y divide-border overflow-hidden">
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} editable={isAdmin} />
          ))}
        </Card>
      )}
    </div>
  );
}

function JobRow({ job, editable }: { job: JobInfo; editable: boolean }) {
  const { busy, run } = useAction();
  const [log, setLog] = useState<string | null>(null);
  const printer = useLive((s) => s.printers.find((p) => p.id === job.printer?.id));
  const st = JOB_STATUS[job.status];
  const working = job.status === 'queued' || job.status === 'slicing' || job.status === 'uploading';
  const ready = job.status === 'sliced' || job.status === 'uploaded' || job.status === 'printing';
  const printerBusy = !printer || printer.status.connection !== 'connected' || isActivePrint(printer.status);

  const send = async (print: boolean) => {
    if (
      print &&
      !(await confirm({
        title: 'Druck starten?',
        body: (
          <>
            „{job.models.map((m) => m.name).join(', ')}“ wird an <b>{job.printer?.name}</b> gesendet und sofort gedruckt. Ist das Druckbett frei und sauber?
          </>
        ),
        confirmLabel: 'Drucken',
      }))
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
    <div className="space-y-3 p-4">
      <div className="flex gap-4">
        <div className="relative shrink-0">
          <img src={job.model.thumbnailUrl} alt="" loading="lazy" className="size-16 rounded-lg bg-surface-2 object-contain sm:size-20" />
          {job.models.length > 1 && (
            <span className="absolute -bottom-1 -right-1 rounded-full border-2 border-surface bg-accent px-1.5 text-xs font-semibold text-accent-ink">
              +{job.models.length - 1}
            </span>
          )}
        </div>
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
        {editable && ready && (
          <>
            <Button onClick={() => send(true)} loading={busy === 'print'} disabled={printerBusy} title={printerBusy ? 'Drucker nicht bereit oder beschäftigt' : undefined}>
              <Play className="size-4" /> Drucken
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
        {ready && (
          <a href={`/api/jobs/${job.id}/gcode`} download>
            <Button variant="ghost">
              <Download className="size-4" /> G-Code
            </Button>
          </a>
        )}
        {(job.status === 'failed' || ready) && (
          <Button variant="ghost" onClick={showLog}>
            <FileText className="size-4" /> {log === null ? 'Log' : 'Log ausblenden'}
          </Button>
        )}
        {editable && job.status !== 'uploading' && (
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
