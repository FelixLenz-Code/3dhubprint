import { z } from 'zod';

export type ProfileKind = 'machine' | 'process' | 'filament';

export interface SlicerProfileInfo {
  id: number;
  kind: ProfileKind;
  name: string;
  version: number;
  parent: string | null;
  systemPrinter: string | null;
  summary: Record<string, string | number | boolean | undefined>;
  /** System printers this process/filament is made for (empty = any printer). */
  compatiblePrinters: string[];
  sourceFile: string | null;
  createdAt: number;
}

export interface ProfileImportResult {
  imported: { kind: ProfileKind; name: string; version: number; updated: boolean }[];
  skipped: { file: string; reason: string }[];
}

export interface PrinterProfileAssignment {
  printerId: number;
  machine: string | null;
  process: string[];
  filament: string[];
}

export const assignmentSchema = z.object({
  machine: z.string().min(1).max(256).nullable(),
  process: z.array(z.string().min(1).max(256)).max(200),
  filament: z.array(z.string().min(1).max(256)).max(200),
});

export interface SlicerStatus {
  available: boolean;
  orcaVersion: string;
  systemProfiles: number;
  reason?: string;
}

export interface ModelInfo {
  id: number;
  name: string;
  filename: string;
  format: 'stl' | '3mf' | 'obj';
  size: number;
  triangles: number;
  /** mm, X/Y/Z */
  dimensions: [number, number, number];
  source: string;
  sourceUrl: string | null;
  license: string | null;
  author: string | null;
  createdAt: number;
  thumbnailUrl: string;
}

export type JobStatus = 'queued' | 'slicing' | 'sliced' | 'uploading' | 'uploaded' | 'printing' | 'failed' | 'cancelled';

export interface JobInfo {
  id: number;
  status: JobStatus;
  model: { id: number; name: string; thumbnailUrl: string; dimensions: [number, number, number] };
  printer: { id: number; name: string } | null;
  profiles: Record<ProfileKind, { id: number; name: string; version: number }>;
  copies: number;
  autoOrient: boolean;
  autoPrint: boolean;
  error: string | null;
  gcodeName: string | null;
  printerPath: string | null;
  estimatedTime: number | null;
  filamentMm: number | null;
  filamentG: number | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export const createJobSchema = z.object({
  modelId: z.number().int().positive(),
  printerId: z.number().int().positive(),
  process: z.string().min(1).max(256),
  filament: z.string().min(1).max(256),
  copies: z.number().int().min(1).max(50).default(1),
  autoOrient: z.boolean().default(false),
  autoPrint: z.boolean().default(false),
  note: z.string().trim().max(500).optional(),
});
export type CreateJobInput = z.input<typeof createJobSchema>;

export const sendJobSchema = z.object({
  print: z.boolean().default(false),
});
