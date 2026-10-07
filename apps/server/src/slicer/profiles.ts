import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { BED_TYPES, type SliceOverrides } from '@printhub/shared';
import { printableArea } from './gcodePreview.js';

export type ProfileKind = 'machine' | 'process' | 'filament';
type Json = Record<string, unknown>;

export class ProfileError extends Error {}

interface IndexEntry {
  vendor: string;
  data: Json;
}

const LIST_KEYS = { machine: 'machine_list', process: 'process_list', filament: 'filament_list' } as const;

/**
 * Index of OrcaSlicer's bundled system profiles (resources/profiles/<Vendor>/...).
 * User presets only store their differences, so slicing needs these to resolve `inherits`.
 * Only the vendor catalogs (<Vendor>.json: name -> sub_path) are read up front; the ~80 MB
 * of profile files are loaded on demand.
 */
export class SystemProfiles {
  private files = new Map<string, { vendor: string; file: string }[]>();
  private cache = new Map<string, Json | null>();
  readonly count: number;

  constructor(readonly root: string) {
    let n = 0;
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        if (!entry.endsWith('.json')) continue;
        const vendor = entry.slice(0, -5);
        let catalog: Record<string, { name: string; sub_path: string }[]>;
        try {
          catalog = JSON.parse(fs.readFileSync(path.join(root, entry), 'utf8'));
        } catch {
          continue;
        }
        for (const kind of ['machine', 'process', 'filament'] as const) {
          for (const item of catalog[LIST_KEYS[kind]] ?? []) {
            if (!item?.name || !item.sub_path) continue;
            const key = `${kind}:${item.name}`;
            const list = this.files.get(key) ?? [];
            list.push({ vendor, file: path.join(root, vendor, item.sub_path) });
            this.files.set(key, list);
            n++;
          }
        }
      }
    }
    this.count = n;
  }

  /** Same-vendor match first (system profiles inherit within their vendor), then the shared library. */
  get(kind: ProfileKind, name: string, vendor?: string): IndexEntry | undefined {
    const list = this.files.get(`${kind}:${name}`);
    if (!list) return undefined;
    const hit =
      (vendor && list.find((e) => e.vendor === vendor)) || list.find((e) => e.vendor === 'OrcaFilamentLibrary') || list[0]!;
    const data = this.load(hit.file);
    return data ? { vendor: hit.vendor, data } : undefined;
  }

  private load(file: string): Json | null {
    if (!this.cache.has(file)) {
      try {
        this.cache.set(file, JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        this.cache.set(file, null);
      }
    }
    return this.cache.get(file)!;
  }
}

export function detectKind(data: Json): ProfileKind | undefined {
  if (data.type === 'machine' || data.type === 'process' || data.type === 'filament') return data.type;
  if (data.printer_settings_id) return 'machine';
  if (data.print_settings_id) return 'process';
  if (data.filament_settings_id) return 'filament';
  return undefined;
}

/** Fields that must never be stored or passed on: printer addresses and API keys. */
const SENSITIVE = /^(print_host|printhost_)/;

export function sanitize(data: Json): Json {
  return Object.fromEntries(Object.entries(data).filter(([k]) => !SENSITIVE.test(k)));
}

export interface UploadedPreset {
  /** Original file name inside the upload (for error messages). */
  file: string;
  data: Json;
}

/** Extracts preset JSONs from plain .json uploads and Orca bundles (.orca_printer/.orca_filament/.zip). */
export function readUpload(filename: string, buf: Buffer): UploadedPreset[] {
  if (/\.json$/i.test(filename)) {
    return [{ file: filename, data: parseJson(filename, buf.toString('utf8')) }];
  }
  if (/\.(orca_printer|orca_filament|zip)$/i.test(filename)) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(buf));
    } catch {
      throw new ProfileError(`${filename}: keine gültige ZIP-/Bundle-Datei`);
    }
    return Object.entries(entries)
      .filter(([name]) => name.endsWith('.json') && !name.endsWith('bundle_structure.json'))
      .map(([name, bytes]) => ({ file: `${filename}/${name}`, data: parseJson(name, strFromU8(bytes)) }));
  }
  throw new ProfileError(`${filename}: nur .json, .orca_printer, .orca_filament oder .zip werden unterstützt`);
}

function parseJson(file: string, text: string): Json {
  try {
    const d = JSON.parse(text);
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error();
    return d;
  } catch {
    throw new ProfileError(`${file}: kein gültiges JSON`);
  }
}

export interface ResolvedProfile {
  kind: ProfileKind;
  name: string;
  /** Fully merged settings, without inherits/host fields. */
  settings: Json;
  /** For machines: the system printer the preset derives from (needed by the CLI's compatibility check). */
  systemPrinter?: string;
  /** Name of the direct parent preset as given in the file. */
  parent?: string;
}

/**
 * Merges a preset with its ancestors. `siblings` are other presets from the same upload,
 * so user presets may inherit from each other.
 */
export function resolvePreset(
  kind: ProfileKind,
  data: Json,
  system: SystemProfiles,
  siblings: Map<string, Json> = new Map(),
): ResolvedProfile {
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : undefined;
  if (!name) throw new ProfileError('Preset ohne Namen');

  const chain: { data: Json; system: boolean; vendor?: string }[] = [{ data, system: data.from === 'system' }];
  const seen = new Set([name]);
  let vendor: string | undefined;
  let parentName = typeof data.inherits === 'string' ? data.inherits : '';
  while (parentName) {
    if (seen.has(parentName)) throw new ProfileError(`${name}: zyklische Vererbung über „${parentName}“`);
    seen.add(parentName);
    const sibling = siblings.get(`${kind}:${parentName}`);
    const entry = sibling ? { vendor: undefined, data: sibling } : system.get(kind, parentName, vendor);
    if (!entry) {
      throw new ProfileError(
        `${name}: Basisprofil „${parentName}“ nicht gefunden. Es muss in OrcaSlicer enthalten sein oder mit hochgeladen werden.`,
      );
    }
    vendor = entry.vendor ?? vendor;
    chain.push({ data: entry.data, system: !sibling, vendor: entry.vendor });
    parentName = typeof entry.data.inherits === 'string' ? entry.data.inherits : '';
  }

  const settings: Json = {};
  for (const link of [...chain].reverse()) Object.assign(settings, link.data);
  for (const k of ['inherits', 'instantiation', 'setting_id', 'is_custom_defined', 'base_id', 'filament_id_alias']) delete settings[k];
  settings.name = name;
  settings.type = kind;
  settings.from = 'User';

  let systemPrinter: string | undefined;
  if (kind === 'machine') {
    // The nearest instantiable system printer in the chain.
    systemPrinter = chain.find((l) => l.system && l.data.instantiation === 'true')?.data.name as string | undefined;
    if (!systemPrinter && data.from === 'system') systemPrinter = name;
    if (!systemPrinter) throw new ProfileError(`${name}: kein Orca-System-Drucker als Basis gefunden`);
  }

  return {
    kind,
    name,
    settings: sanitize(settings),
    systemPrinter,
    parent: typeof data.inherits === 'string' && data.inherits ? data.inherits : undefined,
  };
}

const first = (v: unknown): string | undefined => {
  const x = Array.isArray(v) ? v[0] : v;
  return x === undefined || x === null || x === '' ? undefined : String(x);
};
const num = (v: unknown): number | undefined => {
  const s = first(v);
  const n = s === undefined ? NaN : Number(String(s).replace('%', ''));
  return Number.isFinite(n) ? n : undefined;
};

export type ProfileSummary = Record<string, string | number | boolean | undefined>;

/** The handful of values worth showing in lists. */
export function summarize(kind: ProfileKind, s: Json): ProfileSummary {
  if (kind === 'machine') {
    const area = printableArea(s);
    const xs = area.map((p) => Number(p.split('x')[0]));
    const ys = area.map((p) => Number(p.split('x')[1]));
    return {
      model: first(s.printer_model),
      nozzle: num(s.nozzle_diameter),
      bedX: xs.length ? Math.max(...xs) - Math.min(...xs) : undefined,
      bedY: ys.length ? Math.max(...ys) - Math.min(...ys) : undefined,
      bedX0: xs.length ? Math.min(...xs) : undefined,
      bedY0: ys.length ? Math.min(...ys) : undefined,
      height: num(s.printable_height),
      flavor: first(s.gcode_flavor),
      defaultBedType: first(s.default_bed_type),
    };
  }
  if (kind === 'process') {
    return {
      layerHeight: num(s.layer_height),
      walls: num(s.wall_loops),
      infill: first(s.sparse_infill_density),
      infillPattern: first(s.sparse_infill_pattern),
      support: first(s.enable_support) === '1' || first(s.enable_support) === 'true',
      supportType: first(s.support_type)?.startsWith('tree') ? 'tree' : 'normal',
      supportBuildPlateOnly: first(s.support_on_build_plate_only) === '1',
      supportAngle: num(s.support_threshold_angle),
      brimType: BRIM_FROM_ORCA[first(s.brim_type) ?? ''] ?? 'auto',
      brimWidth: num(s.brim_width),
      skirtLoops: num(s.skirt_loops),
      skirtDistance: num(s.skirt_distance),
      vase: first(s.spiral_mode) === '1',
    };
  }
  return {
    material: first(s.filament_type),
    nozzleTemp: num(s.nozzle_temperature),
    bedTemp: num(s.hot_plate_temp) ?? num(s.textured_plate_temp),
    // Per plate, keyed like the Orca setting (see BED_TYPES).
    ...Object.fromEntries(PLATE_TEMPS.map((k) => [k, num(s[k])])),
    flow: num(s.filament_flow_ratio),
    diameter: num(s.filament_diameter),
    density: num(s.filament_density),
    cost: num(s.filament_cost),
  };
}

const PLATE_TEMPS = Object.values(BED_TYPES).map((b) => b.temp);

const BRIM_TO_ORCA = { none: 'no_brim', outer: 'outer_only', auto: 'auto_brim', ears: 'brim_ears' } as const;
const BRIM_FROM_ORCA: Record<string, keyof typeof BRIM_TO_ORCA> = Object.fromEntries(
  Object.entries(BRIM_TO_ORCA).map(([k, v]) => [v, k as keyof typeof BRIM_TO_ORCA]),
);

/** Applies per-job overrides (support, brim, skirt, vase) to resolved process settings. */
export function applyOverrides(process: Json, o: SliceOverrides): Json {
  const s: Json = { ...process };
  const bool = (b: boolean) => (b ? '1' : '0');
  if (o.infill) {
    s.sparse_infill_density = `${o.infill.density}%`;
    if (o.infill.pattern) s.sparse_infill_pattern = o.infill.pattern;
  }
  if (o.support) {
    s.enable_support = bool(o.support.enabled);
    s.support_type = o.support.type === 'tree' ? 'tree(auto)' : 'normal(auto)';
    s.support_on_build_plate_only = bool(o.support.buildPlateOnly);
    if (o.support.angle !== undefined) s.support_threshold_angle = String(o.support.angle);
  }
  if (o.brim) {
    s.brim_type = BRIM_TO_ORCA[o.brim.type];
    if (o.brim.width !== undefined) s.brim_width = String(o.brim.width);
  }
  if (o.skirt) {
    s.skirt_loops = String(o.skirt.loops);
    if (o.skirt.distance !== undefined) s.skirt_distance = String(o.skirt.distance);
  }
  if (o.vase) {
    // What OrcaSlicer's GUI enforces when enabling spiral vase.
    s.spiral_mode = '1';
    s.wall_loops = '1';
    s.top_shell_layers = '0';
    s.sparse_infill_density = '0%';
    s.enable_support = '0';
  } else if (o.vase === false) {
    s.spiral_mode = '0';
  }
  return s;
}

/**
 * Whether a process/filament preset is meant for a machine, by Orca's `compatible_printers`
 * list (empty = universal). Condition expressions are not evaluated.
 */
export function isCompatible(settings: Json, machine: { name: string; systemPrinter: string | null }): boolean {
  const list = Array.isArray(settings.compatible_printers) ? (settings.compatible_printers as string[]) : [];
  return list.length === 0 || list.includes(machine.name) || (!!machine.systemPrinter && list.includes(machine.systemPrinter));
}

/**
 * Builds the three JSON documents the Orca CLI accepts: the machine keeps `inherits` = its
 * system printer, and process/filament declare compatibility with both names. The bed type
 * picks the filament's plate temperature.
 */
export function cliProfiles(
  machine: { name: string; settings: Json; systemPrinter: string },
  process: Json,
  filament: Json,
  bedType?: string,
) {
  const compat = [machine.name, machine.systemPrinter];
  const forCli = (s: Json) => ({ ...s, compatible_printers: compat, compatible_printers_condition: '', compatible_prints: [], compatible_prints_condition: '' });
  // The plate is a GUI/project setting; without it the CLI slices for the Cool Plate.
  const plate = bedType ? { curr_bed_type: bedType } : {};
  return {
    machine: { ...machine.settings, name: machine.name, inherits: machine.systemPrinter, ...plate },
    process: { ...forCli(process), ...plate },
    filament: forCli(filament),
  };
}
