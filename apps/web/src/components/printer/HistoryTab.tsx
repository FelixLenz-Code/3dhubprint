import { useInfiniteQuery } from '@tanstack/react-query';
import { FileCode2, RotateCw } from 'lucide-react';
import type { HistoryJob, HistoryPage, PrinterSummary } from '@printhub/shared';
import { api } from '../../lib/api';
import { confirm, useAction } from '../../lib/feedback';
import { confirmPrintStart } from '../../lib/printStart';
import { fileLabel, formatDuration, formatFilament, isActivePrint, type Tone } from '../../lib/format';
import { formatDate, thumbUrl } from '../../lib/files';
import { Badge, Button, Card, Spinner, Stat } from '../ui';

const PAGE = 30;

const STATUS: Record<string, { label: string; tone: Tone }> = {
  completed: { label: 'Fertig', tone: 'good' },
  cancelled: { label: 'Abgebrochen', tone: 'warning' },
  error: { label: 'Fehler', tone: 'critical' },
  klippy_shutdown: { label: 'Klipper-Shutdown', tone: 'critical' },
  klippy_disconnect: { label: 'Verbindung verloren', tone: 'critical' },
  interrupted: { label: 'Unterbrochen', tone: 'critical' },
  server_exit: { label: 'Server beendet', tone: 'critical' },
  in_progress: { label: 'Läuft', tone: 'info' },
};

export function HistoryTab({ printer, editable }: { printer: PrinterSummary; editable: boolean }) {
  const history = useInfiniteQuery({
    queryKey: ['history', printer.id],
    queryFn: ({ pageParam }) => api<HistoryPage>(`/printers/${printer.id}/history?start=${pageParam}&limit=${PAGE}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.jobs.length, 0);
      return last.jobs.length === PAGE && loaded < last.total ? loaded : undefined;
    },
    enabled: printer.status.connection === 'connected' || printer.status.connection === 'klippy_not_ready',
  });

  if (history.isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Spinner />
      </div>
    );
  }
  if (history.error) return <p className="text-sm text-critical">{(history.error as Error).message}</p>;

  const totals = history.data?.pages[0]?.totals;
  const jobs = history.data?.pages.flatMap((p) => p.jobs) ?? [];

  return (
    <div className="space-y-4">
      {totals && (
        <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4 sm:p-5">
          <Stat label="Drucke gesamt" value={totals.jobs} />
          <Stat label="Druckzeit gesamt" value={formatDuration(totals.printTime)} />
          <Stat label="Filament gesamt" value={formatFilament(totals.filamentUsed)} />
          <Stat label="Längster Druck" value={formatDuration(totals.longestPrint)} />
        </Card>
      )}
      <Card className="overflow-hidden">
        <ul className="divide-y divide-border">
          {jobs.map((j) => (
            <JobRow key={j.id} printer={printer} job={j} editable={editable} />
          ))}
          {!jobs.length && <li className="p-5 text-sm text-text-3">Noch keine Drucke.</li>}
        </ul>
      </Card>
      {history.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => history.fetchNextPage()} loading={history.isFetchingNextPage}>
            Mehr laden
          </Button>
        </div>
      )}
    </div>
  );
}

function JobRow({ printer, job, editable }: { printer: PrinterSummary; job: HistoryJob; editable: boolean }) {
  const { busy, run } = useAction();
  const st = STATUS[job.status] ?? { label: job.status, tone: 'neutral' as Tone };
  const thumb = job.fileExists ? thumbUrl(printer.id, job.thumbnailPath) : undefined;
  const blocked = isActivePrint(printer.status) || printer.status.connection !== 'connected';

  const reprint = async () => {
    if (
      await confirmPrintStart(printer, {
        title: 'Erneut drucken?',
        body: `„${fileLabel(job.filename)}“ noch einmal drucken. Ist das Druckbett frei?`,
      })
    )
      void run('print', () => api(`/printers/${printer.id}/files/print`, { body: { path: job.filename } }), 'Druck gestartet');
  };

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      {thumb ? (
        <img src={thumb} alt="" loading="lazy" className="size-12 shrink-0 rounded-lg bg-surface-2 object-contain" />
      ) : (
        <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-surface-2">
          <FileCode2 className="size-5 text-text-3" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium" title={job.filename}>
            {fileLabel(job.filename)}
          </span>
          <Badge tone={st.tone}>{st.label}</Badge>
        </div>
        <div className="tabular truncate text-xs text-text-3">
          {formatDate(job.startTime)} · {formatDuration(job.printDuration)} · {formatFilament(job.filamentUsed)}
          {!job.fileExists && ' · Datei gelöscht'}
        </div>
      </div>
      {editable && job.fileExists && (
        <Button variant="ghost" onClick={reprint} disabled={blocked} loading={busy === 'print'} aria-label="Erneut drucken" title="Erneut drucken">
          <RotateCw className="size-4" />
        </Button>
      )}
    </li>
  );
}
