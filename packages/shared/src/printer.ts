import { z } from 'zod';
import type { PrinterCapabilities } from './control.js';

export const printerInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  // Base URL of Moonraker, e.g. http://192.168.1.112 or http://host:7125
  url: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https?:\/\//.test(u), 'URL muss mit http:// oder https:// beginnen')
    .transform((u) => u.replace(/\/+$/, '')),
  // Empty string removes a stored key, undefined keeps it unchanged.
  apiKey: z.string().trim().max(128).optional(),
  enabled: z.boolean().default(true),
});
export type PrinterInput = z.input<typeof printerInputSchema>;

/** Connection state between PrintHub and Moonraker/Klipper. */
export type ConnectionState =
  | 'connecting'
  | 'connected' // Moonraker reachable, Klipper ready
  | 'klippy_not_ready' // Moonraker reachable, Klipper in startup/shutdown/error
  | 'offline'
  | 'disabled';

export type PrintState = 'standby' | 'printing' | 'paused' | 'complete' | 'cancelled' | 'error';

export interface HeaterState {
  temperature: number;
  target: number;
  power?: number;
}

export interface Webcam {
  name: string;
  /** Proxied through PrintHub, relative to the app origin. */
  streamUrl: string;
  snapshotUrl: string;
  flipH: boolean;
  flipV: boolean;
  rotation: number;
}

export interface PrinterStatus {
  connection: ConnectionState;
  klippyState?: string;
  klippyMessage?: string;
  printState?: PrintState;
  filename?: string;
  /** 0..1 */
  progress?: number;
  printDuration?: number;
  totalDuration?: number;
  /** Seconds, estimated from file progress. */
  eta?: number;
  filamentUsed?: number;
  currentLayer?: number | null;
  totalLayers?: number | null;
  message?: string;
  /** Slicer metadata of the current/last file. */
  file?: FileMetadata;
  extruder?: HeaterState;
  heaterBed?: HeaterState;
  /** Other temperature sensors/heaters, keyed by object name. */
  sensors?: Record<string, HeaterState>;
  /** Part cooling fan, 0..1. */
  fanSpeed?: number;
  /** All fans by Klipper object name (see capabilities.fans), 0..1. */
  fans?: Record<string, number>;
  speedFactor?: number;
  extrudeFactor?: number;
  position?: [number, number, number, number];
  homedAxes?: string;
  axisMaximum?: [number, number, number, number];
  /** Unix ms of last update received from the printer. */
  updatedAt?: number;
  excludeObject?: {
    objects: { name: string; center?: [number, number]; polygon?: [number, number][] }[];
    excluded: string[];
    current?: string | null;
  };
}

export interface PrinterSummary {
  id: number;
  name: string;
  url: string;
  hasApiKey: boolean;
  enabled: boolean;
  webcams: Webcam[];
  status: PrinterStatus;
  capabilities?: PrinterCapabilities;
  /** The bed was confirmed empty after the last print. */
  bedClear: boolean;
}

export interface FileMetadata {
  filename: string;
  size?: number;
  modified?: number;
  estimatedTime?: number;
  filamentTotal?: number;
  filamentWeightTotal?: number;
  layerHeight?: number;
  slicer?: string;
  /** Path of the largest thumbnail relative to Moonraker's gcodes root. */
  thumbnailPath?: string;
}

export interface TempSample {
  t: number;
  extruder?: number;
  extruderTarget?: number;
  bed?: number;
  bedTarget?: number;
}
