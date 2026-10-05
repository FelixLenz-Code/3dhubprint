import { describe, expect, it, vi } from 'vitest';
import type { PrinterStatus } from '@printhub/shared';
import { PrintEventTracker, diffStatus } from '../src/printers/events.js';

const st = (printState: PrinterStatus['printState'], extra: Partial<PrinterStatus> = {}): PrinterStatus => ({
  connection: 'connected',
  printState,
  filename: 'teil.gcode',
  ...extra,
});

describe('diffStatus', () => {
  it('detects start, pause and the different endings', () => {
    expect(diffStatus(1, st('standby'), st('printing')).map((e) => e.type)).toEqual(['started']);
    expect(diffStatus(1, st('printing'), st('paused', { message: 'Filament leer' }))).toEqual([
      { type: 'paused', printerId: 1, filename: 'teil.gcode', message: 'Filament leer' },
    ]);
    expect(diffStatus(1, st('printing', { printDuration: 600 }), st('complete'))).toEqual([
      { type: 'finished', printerId: 1, filename: 'teil.gcode', result: 'complete', message: undefined, duration: 600 },
      { type: 'idle', printerId: 1 },
    ]);
    expect(diffStatus(1, st('paused'), st('cancelled'))[0]).toMatchObject({ type: 'finished', result: 'cancelled' });
    expect(diffStatus(1, st('printing'), st('error', { message: 'Heater extruder not heating' }))[0]).toMatchObject({
      result: 'error',
      message: 'Heater extruder not heating',
    });
    // Resuming is not a new start.
    expect(diffStatus(1, st('paused'), st('printing'))).toEqual([]);
  });

  it('reports Klipper shutdowns but not normal startup', () => {
    const shutdown = diffStatus(1, st('printing'), { connection: 'klippy_not_ready', klippyState: 'shutdown', klippyMessage: 'MCU timeout' });
    expect(shutdown).toEqual([{ type: 'klippy_error', printerId: 1, message: 'MCU timeout', wasPrinting: true, filename: 'teil.gcode' }]);
    expect(diffStatus(1, st('standby'), { connection: 'klippy_not_ready', klippyState: 'startup' })).toEqual([]);
  });
});

describe('PrintEventTracker', () => {
  it('reports offline-while-printing only after the grace period', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const t = new PrintEventTracker((e) => events.push(e.type), 1000);
    t.update(1, st('printing'));
    t.update(1, { connection: 'offline' });
    vi.advanceTimersByTime(500);
    t.update(1, st('printing')); // back within the grace period
    vi.advanceTimersByTime(2000);
    expect(events).toEqual([]);
    t.update(1, { connection: 'offline' });
    vi.advanceTimersByTime(1500);
    expect(events).toEqual(['offline_while_printing']);
    t.stop();
    vi.useRealTimers();
  });
});
