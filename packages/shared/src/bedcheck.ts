import { z } from 'zod';

/** off: manual only. confirm: the camera suggests, a user confirms. auto: the camera decides. */
export const BED_CHECK_MODES = {
  off: 'Aus',
  confirm: 'Nachfragen',
  auto: 'Automatisch',
} as const;
export type BedCheckMode = keyof typeof BED_CHECK_MODES;

/** How the camera image is compared with the empty bed. */
export const BED_CHECK_METHODS = {
  ai: 'KI-Erkennung',
  classic: 'Bildvergleich',
} as const;
export type BedCheckMethod = keyof typeof BED_CHECK_METHODS;

const frac = z.number().min(0).max(1);

/** Part of the camera image that shows the bed, as fractions of width/height. */
export const bedRegionSchema = z
  .object({ x0: frac, y0: frac, x1: frac, y1: frac })
  .refine((r) => r.x1 - r.x0 >= 0.05 && r.y1 - r.y0 >= 0.05, 'Bereich ist zu klein');
export type BedRegion = z.infer<typeof bedRegionSchema>;

export const bedCheckSettingsSchema = z.object({
  mode: z.enum(Object.keys(BED_CHECK_MODES) as [BedCheckMode, ...BedCheckMode[]]),
  /** Index into the printer's webcams. */
  webcam: z.number().int().min(0).max(20).default(0),
  region: bedRegionSchema.nullable(),
  method: z.enum(Object.keys(BED_CHECK_METHODS) as [BedCheckMethod, ...BedCheckMethod[]]).default('ai'),
  /** 1 = coarse … 5 = notices small parts (and more false alarms). */
  sensitivity: z.number().int().min(1).max(5).default(3),
});
export type BedCheckSettings = z.infer<typeof bedCheckSettingsSchema>;

export const DEFAULT_BED_CHECK: BedCheckSettings = { mode: 'off', webcam: 0, region: null, method: 'ai', sensitivity: 3 };

export type BedVerdict = 'clear' | 'occupied' | 'uncertain';

export interface BedCheckResult {
  verdict: BedVerdict | 'error';
  at: number;
  /** Largest cell difference, relative to the threshold (1 = threshold). */
  score?: number;
  /** Number of grid cells that changed. */
  changed?: number;
  /** Method that produced the verdict (classic when the AI model is missing). */
  method?: BedCheckMethod;
  error?: string;
}

export interface BedReference {
  id: number;
  createdAt: number;
  /** manual: saved in the settings. confirmed: saved when someone confirmed an empty bed. */
  source: 'manual' | 'confirmed';
}

/** Live state shown with the printer. */
export interface BedCheckState {
  mode: BedCheckMode;
  /** Mode is on, but region or reference image is missing. */
  ready: boolean;
  last: BedCheckResult | null;
  /** confirm mode: the camera thinks the bed is empty and asks for confirmation. */
  suggestClear: boolean;
}

export interface BedCheckInfo {
  settings: BedCheckSettings;
  references: BedReference[];
  state: BedCheckState;
  /** The AI model is installed; without it the classic comparison runs instead. */
  aiAvailable: boolean;
}

export const MAX_BED_REFERENCES = 20;
