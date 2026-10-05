import type { PrinterStatus, PrinterSummary, TempSample } from './printer.js';

/** Messages sent from server to browser over /api/ws. */
export type ServerMessage =
  | { type: 'snapshot'; printers: PrinterSummary[] }
  | { type: 'status'; printerId: number; status: PrinterStatus }
  | { type: 'temps'; printerId: number; sample: TempSample };
