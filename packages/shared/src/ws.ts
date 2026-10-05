import type { PrinterStatus, PrinterSummary, TempSample } from './printer.js';
import type { ConsoleLine } from './control.js';
import type { JobInfo } from './slicing.js';

/** Messages sent from server to browser over /api/ws. */
export type ServerMessage =
  | { type: 'snapshot'; printers: PrinterSummary[] }
  | { type: 'status'; printerId: number; status: PrinterStatus }
  | { type: 'temps'; printerId: number; sample: TempSample }
  | { type: 'console'; printerId: number; lines: ConsoleLine[] }
  | { type: 'job'; job: JobInfo }
  | { type: 'job_removed'; id: number };
