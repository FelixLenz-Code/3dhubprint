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

/**
 * OrcaSlicer bed types (`curr_bed_type`). The bed temperature comes from the filament setting
 * of the chosen plate; the CLI would otherwise always use the Cool Plate values.
 */
export const BED_TYPES = {
  'High Temp Plate': { label: 'Glatte PEI-Platte (High Temp)', temp: 'hot_plate_temp' },
  'Textured PEI Plate': { label: 'Texturierte PEI-Platte', temp: 'textured_plate_temp' },
  'Cool Plate': { label: 'Cool Plate', temp: 'cool_plate_temp' },
  'Engineering Plate': { label: 'Engineering Plate', temp: 'eng_plate_temp' },
  'Textured Cool Plate': { label: 'Texturierte Cool Plate', temp: 'textured_cool_plate_temp' },
  'Supertack Plate': { label: 'Supertack Plate', temp: 'supertack_plate_temp' },
} as const;
export type BedType = keyof typeof BED_TYPES;
export const bedTypeSchema = z.enum(Object.keys(BED_TYPES) as [BedType, ...BedType[]]);
/** Used when neither the printer nor its machine profile names a plate (OrcaSlicer's usual choice). */
export const FALLBACK_BED_TYPE: BedType = 'High Temp Plate';

export interface PrinterProfileAssignment {
  printerId: number;
  machine: string | null;
  process: string[];
  filament: string[];
  /** Plate on the printer; null = the machine profile's default. */
  bedType: BedType | null;
}

export const assignmentSchema = z.object({
  machine: z.string().min(1).max(256).nullable(),
  process: z.array(z.string().min(1).max(256)).max(200),
  filament: z.array(z.string().min(1).max(256)).max(200),
  bedType: bedTypeSchema.nullable().optional(),
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

export type JobStatus =
  | 'queued' // waiting to be sliced
  | 'slicing'
  | 'sliced'
  | 'uploading'
  | 'uploaded'
  | 'waiting' // in the printer's print queue
  | 'printing'
  | 'done'
  | 'print_failed'
  | 'print_cancelled'
  | 'failed' // slicing failed
  | 'cancelled'; // slicing cancelled

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

/**
 * Manual orientation/placement of one model on the plate. Rotation and scale are applied
 * around the model's bounding-box center (Z up); Orca then drops the part onto the bed.
 */
export const modelTransformSchema = z
  .object({
    /** Unit quaternion [x, y, z, w]. */
    rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]).default([0, 0, 0, 1]),
    /** Uniform scale, e.g. 25.4 for a model drawn in inches. */
    scale: z.number().min(0.001).max(10000).default(1),
    /** Bed XY of each copy's bounding-box center; only used when the plate is not auto-arranged. */
    positions: z.array(z.tuple([z.number(), z.number()])).max(50).optional(),
  })
  .strict();
export type ModelTransform = z.infer<typeof modelTransformSchema>;

export interface JobModel {
  id: number;
  name: string;
  thumbnailUrl: string;
  dimensions: [number, number, number];
  copies: number;
  transform: ModelTransform | null;
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
  /** false = parts were placed manually. */
  arrange: boolean;
  bedType: BedType | null;
  /** Not saved yet (job wizard review). */
  draft: boolean;
  error: string | null;
  gcodeName: string | null;
  printerPath: string | null;
  estimatedTime: number | null;
  filamentMm: number | null;
  filamentG: number | null;
  note: string | null;
  /** Rendered from the sliced G-code: whole bed from above and a 3D view of the parts. */
  preview: { top: string; iso: string } | null;
  /** 1-based position in the printer's print queue (status = waiting). */
  queuePosition: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export const moveJobSchema = z.object({ direction: z.enum(['up', 'down']) });
export const bedClearSchema = z.object({
  /** Also start the next queued job right away. */
  start: z.boolean().default(true),
});

export const MAX_PLATE_OBJECTS = 100;

export const createJobSchema = z
  .object({
    /** Models to place on one plate; Orca arranges them automatically. */
    items: z
      .array(
        z.object({
          modelId: z.number().int().positive(),
          copies: z.number().int().min(1).max(50).default(1),
          transform: modelTransformSchema.optional(),
        }),
      )
      .min(1, 'Mindestens ein Modell wählen')
      .max(20, 'Höchstens 20 verschiedene Modelle pro Auftrag'),
    printerId: z.number().int().positive(),
    process: z.string().min(1).max(256),
    filament: z.string().min(1).max(256),
    autoOrient: z.boolean().default(false),
    autoPrint: z.boolean().default(false),
    /** Slice for review only: hidden from lists until saved (sending/queueing saves it too). */
    draft: z.boolean().default(false),
    /** false: keep the positions given per model instead of letting Orca arrange the plate. */
    arrange: z.boolean().default(true),
    /** Default: the printer's plate. */
    bedType: bedTypeSchema.optional(),
    overrides: sliceOverridesSchema.default({}),
    note: z.string().trim().max(500).optional(),
  })
  .refine((j) => new Set(j.items.map((i) => i.modelId)).size === j.items.length, 'Jedes Modell nur einmal auswählen (Stückzahl stattdessen erhöhen)')
  .refine((j) => j.items.reduce((n, i) => n + i.copies, 0) <= MAX_PLATE_OBJECTS, `Höchstens ${MAX_PLATE_OBJECTS} Objekte pro Druckbett`)
  .refine(
    (j) => j.arrange || j.items.every((i) => i.transform?.positions?.length === i.copies),
    'Ohne automatische Anordnung braucht jedes Objekt eine Position',
  )
  .refine((j) => !j.overrides.vase || (j.items.length === 1 && j.items[0]!.copies === 1), 'Der Vasenmodus funktioniert nur mit genau einem Objekt');
export type CreateJobInput = z.input<typeof createJobSchema>;

export const sendJobSchema = z.object({
  print: z.boolean().default(false),
});
