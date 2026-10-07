import type { PrinterStatus } from '@printhub/shared';

export type PrintEvent =
  | { type: 'started'; printerId: number; filename?: string }
  | {
      type: 'finished';
      printerId: number;
      filename?: string;
      result: 'complete' | 'cancelled' | 'error';
      message?: string;
      duration?: number;
      /** Extruded filament (mm). */
      filamentUsed?: number;
    }
  | { type: 'paused'; printerId: number; filename?: string; message?: string }
  | { type: 'klippy_error'; printerId: number; message?: string; wasPrinting: boolean; filename?: string }
  | { type: 'offline_while_printing'; printerId: number; filename?: string }
  /** Connected, Klipper ready and not printing: the queue may start something. */
  | { type: 'idle'; printerId: number };

const ACTIVE = new Set(['printing', 'paused']);
const isIdle = (s: PrinterStatus) => s.connection === 'connected' && !ACTIVE.has(s.printState ?? '');

/** Events implied by a status change. Pure, so it is easy to test. */
export function diffStatus(printerId: number, prev: PrinterStatus, next: PrinterStatus): PrintEvent[] {
  const events: PrintEvent[] = [];
  const wasActive = prev.connection === 'connected' && ACTIVE.has(prev.printState ?? '');
  const filename = next.filename ?? prev.filename;

  if (prev.connection === 'connected' && next.connection === 'connected') {
    const from = prev.printState;
    const to = next.printState;
    if (to === 'printing' && from !== 'printing' && from !== 'paused') events.push({ type: 'started', printerId, filename });
    if (from === 'printing' && to === 'paused') events.push({ type: 'paused', printerId, filename, message: next.message });
    if (wasActive && !ACTIVE.has(to ?? '')) {
      // Klipper reports "standby" after SDCARD_RESET_FILE or a cancel macro that resets the file.
      const result = to === 'complete' ? 'complete' : to === 'error' ? 'error' : 'cancelled';
      events.push({ type: 'finished', printerId, filename, result, message: next.message, duration: prev.printDuration, filamentUsed: next.filamentUsed ?? prev.filamentUsed });
    }
  }

  if (prev.connection === 'connected' && next.connection === 'klippy_not_ready' && next.klippyState !== 'startup') {
    events.push({ type: 'klippy_error', printerId, message: next.klippyMessage, wasPrinting: wasActive, filename: prev.filename });
  }

  if (isIdle(next) && !isIdle(prev)) events.push({ type: 'idle', printerId });
  return events;
}

/**
 * Feeds status updates per printer and reports transitions. "Offline while printing" is only
 * reported if the printer stays unreachable for `offlineGraceMs` (Wi-Fi hiccups are common).
 */
export class PrintEventTracker {
  private last = new Map<number, PrinterStatus>();
  private offlineTimers = new Map<number, NodeJS.Timeout>();

  constructor(
    private readonly emit: (e: PrintEvent) => void,
    private readonly offlineGraceMs = 90_000,
  ) {}

  update(printerId: number, next: PrinterStatus) {
    const prev = this.last.get(printerId);
    this.last.set(printerId, next);
    if (!prev) {
      if (isIdle(next)) this.emit({ type: 'idle', printerId });
      return;
    }
    for (const e of diffStatus(printerId, prev, next)) this.emit(e);

    const wasActive = prev.connection === 'connected' && ACTIVE.has(prev.printState ?? '');
    if (wasActive && next.connection === 'offline' && !this.offlineTimers.has(printerId)) {
      const filename = prev.filename;
      this.offlineTimers.set(
        printerId,
        setTimeout(() => {
          this.offlineTimers.delete(printerId);
          if (this.last.get(printerId)?.connection === 'offline') this.emit({ type: 'offline_while_printing', printerId, filename });
        }, this.offlineGraceMs),
      );
    }
    if (next.connection !== 'offline' && this.offlineTimers.has(printerId)) {
      clearTimeout(this.offlineTimers.get(printerId));
      this.offlineTimers.delete(printerId);
    }
  }

  forget(printerId: number) {
    this.last.delete(printerId);
    clearTimeout(this.offlineTimers.get(printerId));
    this.offlineTimers.delete(printerId);
  }

  stop() {
    for (const t of this.offlineTimers.values()) clearTimeout(t);
    this.offlineTimers.clear();
  }
}
