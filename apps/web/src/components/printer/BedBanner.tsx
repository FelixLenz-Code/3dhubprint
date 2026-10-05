import { CheckCircle2, ListOrdered } from 'lucide-react';
import clsx from 'clsx';
import type { PrinterSummary } from '@printhub/shared';
import { api } from '../../lib/api';
import { useIsAdmin } from '../../lib/auth';
import { confirm, useAction } from '../../lib/feedback';
import { isActivePrint } from '../../lib/format';
import { jobTitle, queueOf, useJobs } from '../../lib/jobs';
import { Button } from '../ui';

/**
 * After a print the bed counts as occupied until someone confirms it is empty. This banner
 * asks for that confirmation and, if jobs are waiting, starts the next one.
 */
export function BedBanner({ printer, compact = false }: { printer: PrinterSummary; compact?: boolean }) {
  const jobs = useJobs();
  const isAdmin = useIsAdmin();
  const { busy, run } = useAction();
  const queue = queueOf(jobs, printer.id);
  const s = printer.status;
  const active = isActivePrint(s);
  if (s.connection !== 'connected') return null;

  // While printing, only show what comes next.
  if (active) {
    if (!queue.length) return null;
    return (
      <div className={clsx('flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-2', compact && 'mt-1')}>
        <ListOrdered className="size-3.5 shrink-0" />
        <span className="truncate">
          Als Nächstes: {jobTitle(queue[0]!)}
          {queue.length > 1 && ` (+${queue.length - 1})`}
        </span>
      </div>
    );
  }
  if (printer.bedClear) return null;

  const confirmClear = async (e: React.MouseEvent) => {
    // The banner sits inside a link on the dashboard card.
    e.preventDefault();
    e.stopPropagation();
    const start = queue.length > 0;
    if (
      start &&
      !(await confirm({
        title: 'Nächsten Druck starten?',
        body: (
          <>
            Das Druckbett von <b>{printer.name}</b> ist leer und sauber? Danach startet „{jobTitle(queue[0]!)}“.
          </>
        ),
        confirmLabel: 'Bett frei – starten',
      }))
    )
      return;
    await run('clear', () => api(`/printers/${printer.id}/bed-clear`, { body: { start } }), start ? 'Nächster Druck gestartet' : 'Druckbett als frei markiert');
  };

  return (
    <div className={clsx('flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2', compact ? 'text-xs' : 'text-sm')}>
      <span className="min-w-0 flex-1 text-text">
        <b>Druckbett räumen.</b>{' '}
        {queue.length ? `${queue.length} ${queue.length === 1 ? 'Auftrag wartet' : 'Aufträge warten'}.` : 'Danach als frei bestätigen.'}
      </span>
      {isAdmin && (
        <Button onClick={confirmClear} loading={busy === 'clear'} className={compact ? 'min-h-8 px-3 text-xs' : undefined}>
          <CheckCircle2 className="size-4" />
          {queue.length ? 'Bett frei – starten' : 'Bett ist frei'}
        </Button>
      )}
    </div>
  );
}
