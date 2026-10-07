import { z } from 'zod';

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

const money = z.number().min(0).max(100_000);

export const costSettingsSchema = z.object({
  /** €/kWh */
  electricityPrice: money,
  /** €/kg, used when neither the spool nor the filament profile has a price. */
  filamentPrice: money,
  /** Average power draw while printing (W), for printers without their own value. */
  defaultPowerW: z.number().min(0).max(10_000),
  /** Per printer (keyed by id): own power draw and wear/depreciation per print hour. */
  printers: z.record(
    z.string().regex(/^\d+$/),
    z.object({ powerW: z.number().min(0).max(10_000).nullable(), hourlyCost: money }),
  ),
});
export type CostSettings = z.infer<typeof costSettingsSchema>;

export const DEFAULT_COST_SETTINGS: CostSettings = { electricityPrice: 0.35, filamentPrice: 20, defaultPowerW: 120, printers: {} };

/** Where the material price came from. */
export type PriceSource = 'spool' | 'profile' | 'default';

export interface CostBreakdown {
  material: number;
  energy: number;
  wear: number;
  total: number;
}

/**
 * Material (grams × €/kg), electricity (power × hours) and wear (€/h × print hours).
 * `seconds` is the time the printer is busy, `printSeconds` the pure print time for wear.
 */
export function estimateCost(
  input: { grams: number | null | undefined; pricePerKg: number | null | undefined; seconds: number | null | undefined; printSeconds?: number | null; printerId: number | null | undefined },
  s: CostSettings,
): CostBreakdown {
  const p = input.printerId != null ? s.printers[String(input.printerId)] : undefined;
  const hours = Math.max(0, input.seconds ?? 0) / 3600;
  const printHours = Math.max(0, input.printSeconds ?? input.seconds ?? 0) / 3600;
  const material = (Math.max(0, input.grams ?? 0) / 1000) * (input.pricePerKg ?? s.filamentPrice);
  const energy = ((p?.powerW ?? s.defaultPowerW) / 1000) * hours * s.electricityPrice;
  const wear = (p?.hourlyCost ?? 0) * printHours;
  return { material, energy, wear, total: material + energy + wear };
}

export const addCosts = (a: CostBreakdown, b: CostBreakdown): CostBreakdown => ({
  material: a.material + b.material,
  energy: a.energy + b.energy,
  wear: a.wear + b.wear,
  total: a.total + b.total,
});

export const ZERO_COST: CostBreakdown = { material: 0, energy: 0, wear: 0, total: 0 };

/** Typical densities (g/cm³) by material. */
export const MATERIAL_DENSITY: Record<string, number> = { PLA: 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21, PA: 1.14, PC: 1.2, PVA: 1.23, HIPS: 1.04 };

/** Weight of a filament length (mm) from diameter (mm) and density (g/cm³). */
export function filamentGrams(mm: number, diameter = 1.75, density = 1.24): number {
  return Math.PI * (diameter / 2) ** 2 * mm * density / 1000;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export const STATS_RANGES = { '7d': '7 Tage', '30d': '30 Tage', '90d': '90 Tage', '12m': '12 Monate', all: 'Gesamt' } as const;
export type StatsRange = keyof typeof STATS_RANGES;

export const statsQuerySchema = z.object({
  range: z.enum(Object.keys(STATS_RANGES) as [StatsRange, ...StatsRange[]]).default('30d'),
  printerId: z.coerce.number().int().positive().optional(),
  /** IANA time zone of the viewer, for day/week/month buckets. */
  tz: z.string().max(64).default('UTC'),
});

export const printListQuerySchema = z.object({
  printerId: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** Moonraker history states, grouped. In-progress prints are not counted. */
export type PrintOutcome = 'completed' | 'cancelled' | 'failed';

export interface PrintRecord {
  id: number;
  printerId: number | null;
  printerName: string;
  filename: string;
  /** Moonraker history status (completed, cancelled, error, klippy_shutdown, …). */
  status: string;
  outcome: PrintOutcome | 'in_progress';
  /** Unix ms */
  startTime: number;
  endTime: number | null;
  /** Seconds */
  printDuration: number;
  totalDuration: number;
  filamentMm: number;
  filamentG: number | null;
  material: string | null;
  filamentName: string | null;
  color: string | null;
  /** PrintHub job this print came from. */
  jobId: number | null;
  spool: { id: number; name: string } | null;
  priceSource: PriceSource;
  cost: CostBreakdown;
}

export interface PrintRecordPage {
  prints: PrintRecord[];
  total: number;
}

export interface StatsBucket {
  /** Unix ms of the bucket's first local day. */
  start: number;
  prints: number;
  completed: number;
  printTime: number;
  filamentG: number;
  cost: number;
}

export interface StatsGroup {
  key: string;
  label: string;
  prints: number;
  completed: number;
  printTime: number;
  filamentG: number;
  cost: number;
}

export interface PrintStats {
  range: StatsRange;
  bucket: 'day' | 'week' | 'month';
  /** null = all time */
  from: number | null;
  to: number;
  totals: {
    prints: number;
    completed: number;
    cancelled: number;
    failed: number;
    printTime: number;
    filamentG: number;
    filamentMm: number;
    cost: CostBreakdown;
    /** Prints priced with the default filament price (no spool or profile price known). */
    defaultPriced: number;
  };
  buckets: StatsBucket[];
  byPrinter: StatsGroup[];
  byMaterial: StatsGroup[];
  /** Unix ms of the last successful history sync (any printer). */
  lastSync: number | null;
}

// ---------------------------------------------------------------------------
// Spoolman
// ---------------------------------------------------------------------------

export const spoolmanUrlSchema = z.object({
  url: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https?:\/\//.test(u), 'URL muss mit http:// oder https:// beginnen')
    .transform((u) => u.replace(/\/+$/, '')),
});

export interface SpoolmanStatus {
  configured: boolean;
  url: string | null;
  /** Installed alongside PrintHub (printhub spoolman on): address fixed by the installation. */
  managed?: boolean;
  /** Address of Spoolman's own web interface for the browser (LAN). */
  webUrl?: string | null;
  reachable?: boolean;
  version?: string;
  error?: string;
}

export interface SpoolInfo {
  id: number;
  /** Filament name, e.g. "PLA Basic". */
  name: string;
  vendor: string | null;
  material: string | null;
  /** "#rrggbb" */
  color: string | null;
  remainingG: number | null;
  initialG: number | null;
  usedG: number;
  pricePerKg: number | null;
  density: number | null;
  diameter: number | null;
  location: string | null;
  lastUsed: number | null;
  archived: boolean;
}

export interface PrinterSpool {
  printerId: number;
  spool: SpoolInfo | null;
  /**
   * "moonraker": Moonraker's own Spoolman integration tracks usage.
   * "printhub": PrintHub books the used filament after each print.
   */
  tracking: 'moonraker' | 'printhub';
}

export const setSpoolSchema = z.object({ spoolId: z.number().int().positive().nullable() });

export const spoolLabel = (s: Pick<SpoolInfo, 'id' | 'name' | 'vendor'>) => `#${s.id} ${s.vendor ? `${s.vendor} ` : ''}${s.name}`;

export interface FilamentInfo {
  id: number;
  name: string;
  vendor: string | null;
  material: string | null;
  color: string | null;
  density: number | null;
  diameter: number | null;
  /** Net filament weight of a full spool (g). */
  weight: number | null;
  spoolWeight: number | null;
  /** Price of a full spool (€). */
  price: number | null;
}

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || undefined);

export const newFilamentSchema = z.object({
  vendor: optText(64),
  name: z.string().trim().min(1, 'Name fehlt').max(64),
  material: z.string().trim().min(1, 'Material fehlt').max(64),
  color: z
    .string()
    .regex(/^#?[0-9a-fA-F]{6}$/)
    .transform((c) => c.replace('#', '').toLowerCase())
    .optional(),
  density: z.number().positive().max(10),
  diameter: z.number().positive().max(5).default(1.75),
  weight: z.number().positive().max(100_000).default(1000),
  spoolWeight: z.number().min(0).max(10_000).optional(),
  price: money.optional(),
});

export const createSpoolSchema = z
  .object({
    filamentId: z.number().int().positive().optional(),
    filament: newFilamentSchema.optional(),
    /** Several identical spools at once. */
    count: z.number().int().min(1).max(20).default(1),
    /** Default: the filament's net weight. */
    initialWeight: z.number().positive().max(100_000).optional(),
    /** Default: the filament's price. */
    price: money.optional(),
    location: optText(64),
    /** Make the (first) new spool the active spool of this printer. */
    printerId: z.number().int().positive().optional(),
  })
  .refine((s) => (s.filamentId === undefined) !== (s.filament === undefined), 'Entweder ein vorhandenes Filament wählen oder ein neues angeben');
export type CreateSpoolInput = z.input<typeof createSpoolSchema>;

export const updateSpoolSchema = z
  .object({
    /** Weighed: what is left on the spool (g, without the empty spool). */
    remainingWeight: z.number().min(0).max(100_000).optional(),
    archived: z.boolean().optional(),
  })
  .refine((u) => u.remainingWeight !== undefined || u.archived !== undefined, 'Keine Änderung angegeben');
