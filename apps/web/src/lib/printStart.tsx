import type { ReactNode } from 'react';
import type { BedCheckResult, PrinterSummary } from '@printhub/shared';
import { api } from './api';
import { confirm, toast } from './feedback';
import { CheckResult } from '../components/printer/BedCheckDialog';

/**
 * Confirmation before a print is started by hand. With the camera bed check set up, it takes a
 * fresh look first: a clear bed is shown with the question, anything else as a warning that
 * can be overruled with "Trotzdem drucken".
 */
export async function confirmPrintStart(
  printer: PrinterSummary,
  opts: { title: string; body: ReactNode; confirmLabel?: string; /** Without camera check: start without asking. */ onlyWithCamera?: boolean },
): Promise<boolean> {
  const bc = printer.bedCheck;
  if (!bc || bc.mode === 'off' || !bc.ready) return opts.onlyWithCamera ? true : confirm({ ...opts, confirmLabel: opts.confirmLabel ?? 'Drucken' });

  let result: BedCheckResult;
  try {
    toast('Kamera prüft das Druckbett …');
    result = await api<BedCheckResult>(`/printers/${printer.id}/bed-check/run`, { body: {} });
  } catch (err) {
    result = { verdict: 'error', at: Date.now(), error: (err as Error).message };
  }

  if (result.verdict === 'clear') {
    return confirm({
      ...opts,
      body: (
        <div className="space-y-3">
          <div>{opts.body}</div>
          <CheckResult printerId={printer.id} result={result} />
        </div>
      ),
      confirmLabel: opts.confirmLabel ?? 'Drucken',
    });
  }
  return confirm({
    title: result.verdict === 'error' ? 'Kamera nicht erreichbar' : 'Kamera sieht etwas auf dem Bett',
    body: (
      <div className="space-y-3">
        <div>
          {result.verdict === 'error'
            ? 'Das Druckbett konnte vor dem Start nicht geprüft werden.'
            : 'Vor dem Start liegt laut Kamera noch etwas auf dem Druckbett (rot markiert). Ein Druck auf ein belegtes Bett kann Teil und Drucker beschädigen.'}{' '}
          Nur fortfahren, wenn das Bett wirklich leer ist.
        </div>
        <CheckResult printerId={printer.id} result={result} />
      </div>
    ),
    confirmLabel: 'Trotzdem drucken',
    danger: true,
  });
}
