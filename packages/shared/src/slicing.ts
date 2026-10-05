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

/**
 * Per-job changes on top of the process profile. Omitted sections keep the profile's values.
 */
export const sliceOverridesSchema = z
  .object({
    support: z
      .object({
        enabled: z.boolean(),
        type: z.enum(['normal', 'tree']).default('tree'),
        buildPlateOnly: z.boolean().default(false),
        /** Overhang angle (°) from which support is generated. */
        angle: z.number().int().min(0).max(90).optional(),
      })
      .optional(),
    brim: z
      .object({
        type: z.enum(['none', 'outer', 'auto', 'ears']),
        width: z.number().min(0).max(50).optional(),
      })
      .optional(),
    skirt: z
      .object({
        loops: z.number().int().min(0).max(20),
        distance: z.number().min(0).max(50).optional(),
      })
      .optional(),
    /** Spiral vase: one wall, no top layers, no infill. Only for a single object. */
    vase: z.boolean().optional(),
  })
  .strict();
export type SliceOverrides = z.infer<typeof sliceOverridesSchema>;

export interface JobModel {
  id: number;
  name: string;
  thumbnailUrl: string;
  dimensions: [number, number, number];
  copies: number;
}

export interface JobInfo {
  id: number;
  status: JobStatus;
  /** First model (for compact displays); all models are in `models`. */
  model: JobModel;
  models: JobModel[];
  overrides: SliceOverrides;
  printer: { id: number; name: string } | null;
  profiles: Record<ProfileKind, { id: number; name: string; version: number }>;
  /** Total number of objects on the plate. */
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

export const MAX_PLATE_OBJECTS = 100;

export const createJobSchema = z
  .object({
    /** Models to place on one plate; Orca arranges them automatically. */
    items: z
      .array(z.object({ modelId: z.number().int().positive(), copies: z.number().int().min(1).max(50).default(1) }))
      .min(1, 'Mindestens ein Modell wählen')
      .max(20, 'Höchstens 20 verschiedene Modelle pro Auftrag'),
    printerId: z.number().int().positive(),
    process: z.string().min(1).max(256),
    filament: z.string().min(1).max(256),
    autoOrient: z.boolean().default(false),
    autoPrint: z.boolean().default(false),
    overrides: sliceOverridesSchema.default({}),
    note: z.string().trim().max(500).optional(),
  })
  .refine((j) => new Set(j.items.map((i) => i.modelId)).size === j.items.length, 'Jedes Modell nur einmal auswählen (Stückzahl stattdessen erhöhen)')
  .refine((j) => j.items.reduce((n, i) => n + i.copies, 0) <= MAX_PLATE_OBJECTS, `Höchstens ${MAX_PLATE_OBJECTS} Objekte pro Druckbett`)
  .refine((j) => !j.overrides.vase || (j.items.length === 1 && j.items[0]!.copies === 1), 'Der Vasenmodus funktioniert nur mit genau einem Objekt');
export type CreateJobInput = z.input<typeof createJobSchema>;

export const sendJobSchema = z.object({
  print: z.boolean().default(false),
});
