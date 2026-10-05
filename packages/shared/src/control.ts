import { z } from 'zod';

export const temperatureSchema = z.object({
  /** Klipper heater object name, e.g. "extruder", "heater_bed", "heater_generic chamber". */
  heater: z.string().min(1).max(64),
  target: z.number().min(0).max(500),
});

export const homeSchema = z.object({
  axes: z.array(z.enum(['x', 'y', 'z'])).max(3).default([]),
});

export const moveSchema = z.object({
  axis: z.enum(['x', 'y', 'z']),
  /** Relative distance in mm. */
  distance: z.number().min(-500).max(500).refine((d) => d !== 0, 'Distanz darf nicht 0 sein'),
  /** mm/s */
  speed: z.number().min(1).max(500).optional(),
});

export const factorSchema = z.object({
  /** Percent, e.g. 100 = normal. */
  percent: z.number().int().min(1).max(500),
});

export const fanSchema = z.object({
  percent: z.number().int().min(0).max(100),
});

export const gcodeSchema = z.object({
  script: z.string().trim().min(1).max(4000),
});

export const macroSchema = z.object({
  name: z.string().min(1).max(128),
});

export const excludeObjectSchema = z.object({
  name: z.string().min(1).max(256),
});

export const printFileSchema = z.object({
  path: z.string().min(1).max(512),
});

export const printerActionSchema = z.enum([
  'pause',
  'resume',
  'cancel',
  'emergency_stop',
  'firmware_restart',
  'restart',
]);
export type PrinterAction = z.infer<typeof printerActionSchema>;

export interface HeaterInfo {
  /** Klipper object name. */
  name: string;
  /** Human-readable label. */
  label: string;
  minTemp: number;
  maxTemp: number;
}

export interface PrinterCapabilities {
  heaters: HeaterInfo[];
  /** User-facing macros (names not starting with "_"). */
  macros: string[];
  hasFan: boolean;
  hasExcludeObject: boolean;
}

export interface FileEntry {
  /** Path relative to the gcodes root. */
  path: string;
  name: string;
  size: number;
  modified: number;
  estimatedTime?: number;
  filamentTotal?: number;
  thumbnailPath?: string;
}

export interface DirectoryListing {
  path: string;
  dirs: { name: string; path: string; modified: number }[];
  files: FileEntry[];
  diskFree?: number;
  diskTotal?: number;
}

export type HistoryJobStatus = 'completed' | 'cancelled' | 'error' | 'klippy_shutdown' | 'klippy_disconnect' | 'interrupted' | 'in_progress' | 'server_exit';

export interface HistoryJob {
  id: string;
  filename: string;
  status: HistoryJobStatus | string;
  startTime: number;
  endTime?: number;
  printDuration: number;
  totalDuration: number;
  filamentUsed: number;
  thumbnailPath?: string;
  fileExists: boolean;
}

export interface HistoryPage {
  jobs: HistoryJob[];
  total: number;
  totals?: { jobs: number; printTime: number; filamentUsed: number; longestPrint: number };
}

export interface ConsoleLine {
  t: number;
  text: string;
  /** "command" = sent by a user, "response" = from Klipper. */
  kind: 'command' | 'response';
}
