import { useState } from 'react';
import { Camera, CheckCircle2, ListOrdered, X } from 'lucide-react';
import clsx from 'clsx';
import type { PrinterSummary } from '@printhub/shared';
import { api } from '../../lib/api';
import { useIsAdmin } from '../../lib/auth';
import { confirm, useAction } from '../../lib/feedback';
import { isActivePrint } from '../../lib/format';
import { jobTitle, queueOf, useJobs } from '../../lib/jobs';
import { Button } from '../ui';
import { CheckResult } from './BedCheckDialog';

/**
 * After a print the bed counts as occupied until someone confirms it is empty. This banner
 * asks for that confirmation and, if jobs are waiting, starts the next one. With the camera
 * check on, it shows what the camera sees; a person can always overrule it.
 */
export function BedBanner({ printer, compact = false }: { printer: PrinterSummary; compact?: boolean }) {
  const jobs = useJobs();
  const isAdmin = useIsAdmin();
  const { busy, run } = useAction();
  const [showImage, setShowImage] = useState(false);
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

  const bc = printer.bedCheck;
  const camera = bc && bc.mode !== 'off' && bc.ready ? bc : undefined;
  const sees = camera?.last?.verdict;
  const seesSomething = sees === 'occupied' || sees === 'uncertain';

  // The banner sits inside a link on the dashboard card.
  const stop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const confirmClear = async (e: React.MouseEvent) => {
    stop(e);
    const start = queue.length > 0;
    if (
      start &&
      // Answering the camera's question already is the confirmation.
      !camera?.suggestClear &&
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

  const reject = (e: React.MouseEvent) => {
    stop(e);
    void run('reject', () => api(`/printers/${printer.id}/bed-check/reject`, { body: {} }));
  };

  const waiting = queue.length ? `${queue.length} ${queue.length === 1 ? 'Auftrag wartet' : 'Aufträge warten'}.` : '';
  const btn = compact ? 'min-h-8 px-3 text-xs' : undefined;

  if (camera?.suggestClear) {
    return (
      <div className={clsx('space-y-2 rounded-xl border border-good/40 bg-good/10 px-3 py-2', compact ? 'text-xs' : 'text-sm')}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={clsx('min-w-0 flex-1 text-text', compact && 'basis-full')}>
            <Camera className="mr-1 inline size-4 align-text-bottom" />
            <b>Druckbett sieht frei aus. Stimmt das?</b> {waiting}
          </span>
          {isAdmin && (
            <>
              <Button variant="ghost" onClick={reject} loading={busy === 'reject'} className={clsx(btn, compact && 'ml-auto')}>
                <X className="size-4" /> Nein
              </Button>
              <Button onClick={confirmClear} loading={busy === 'clear'} className={btn}>
                <CheckCircle2 className="size-4" />
                {queue.length ? 'Ja, frei – starten' : 'Ja, Bett ist frei'}
              </Button>
            </>
          )}
        </div>
        {!compact && camera.last && <CheckResult printerId={printer.id} result={camera.last} />}
      </div>
    );
  }

  const hint = !camera
    ? waiting || 'Danach als frei bestätigen.'
    : seesSomething
      ? `Die Kamera sieht noch etwas auf dem Bett. ${waiting}`
      : camera.mode === 'auto'
        ? `Wird freigegeben, sobald die Kamera ein leeres Bett sieht. ${waiting}`
        : `PrintHub fragt nach, sobald die Kamera ein leeres Bett sieht. ${waiting}`;

  return (
    <div className={clsx('space-y-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2', compact ? 'text-xs' : 'text-sm')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-text">
          <b>Druckbett räumen.</b> {hint}
        </span>
        {!compact && camera?.last && camera.last.verdict !== 'error' && (
          <Button variant="ghost" onClick={() => setShowImage(!showImage)} className={btn}>
            <Camera className="size-4" /> {showImage ? 'Bild ausblenden' : 'Kamerabild'}
          </Button>
        )}
        {isAdmin && (
          <Button onClick={confirmClear} loading={busy === 'clear'} className={btn} title={seesSomething ? 'Die Kamera irrt sich: Bett ist leer. PrintHub merkt sich dieses Bild als leeres Bett.' : undefined}>
            <CheckCircle2 className="size-4" />
            {seesSomething ? (queue.length ? 'Trotzdem frei – starten' : 'Trotzdem frei') : queue.length ? 'Bett frei – starten' : 'Bett ist frei'}
          </Button>
        )}
      </div>
      {showImage && camera?.last && <CheckResult printerId={printer.id} result={camera.last} />}
    </div>
  );
}
