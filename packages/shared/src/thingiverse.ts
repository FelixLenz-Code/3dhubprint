import { z } from 'zod';

export const THINGIVERSE_SORTS = { relevant: 'Relevanz', popular: 'Beliebt', newest: 'Neueste', makes: 'Meiste Makes' } as const;
export type ThingiverseSort = keyof typeof THINGIVERSE_SORTS;

/** Lists shown before searching. */
export const THINGIVERSE_SUGGESTIONS = { popular: 'Beliebt', newest: 'Neu', featured: 'Empfohlen' } as const;
export type ThingiverseSuggestion = keyof typeof THINGIVERSE_SUGGESTIONS;

export const thingiverseSuggestSchema = z.object({
  list: z.enum(Object.keys(THINGIVERSE_SUGGESTIONS) as [ThingiverseSuggestion, ...ThingiverseSuggestion[]]).default('popular'),
  page: z.coerce.number().int().min(1).max(100).default(1),
});

export const thingiverseTokenSchema = z.object({ token: z.string().trim().min(10).max(200) });

export const thingiverseSearchSchema = z.object({
  q: z.string().trim().min(1).max(200),
  page: z.coerce.number().int().min(1).max(100).default(1),
  sort: z.enum(Object.keys(THINGIVERSE_SORTS) as [ThingiverseSort, ...ThingiverseSort[]]).default('relevant'),
});

export const thingiverseImportSchema = z.object({
  fileIds: z.array(z.number().int().positive()).min(1).max(30),
});

export interface ThingiverseStatus {
  configured: boolean;
}

export interface ThingSummary {
  id: number;
  name: string;
  /** Proxied through PrintHub. */
  thumbnail: string | null;
  creator: string | null;
  likes: number;
  downloads: number;
  url: string;
}

export interface ThingFile {
  id: number;
  name: string;
  size: number;
  thumbnail: string | null;
  /** stl/3mf/obj can be imported directly, zip archives are unpacked. */
  importable: boolean;
}

export interface ThingDetails extends ThingSummary {
  license: string | null;
  creatorUrl: string | null;
  description: string;
  images: string[];
  files: ThingFile[];
}

export interface ThingSearchPage {
  total: number;
  page: number;
  hits: ThingSummary[];
}
