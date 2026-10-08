import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export class ThreeMfError extends Error {}

/**
 * Affine transform in 3MF order: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32.
 * 3MF uses row vectors: p' = p * M, i.e. x' = x*m00 + y*m10 + z*m20 + m30.
 */
export type Mat = number[];
export const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export function parseMat(attr: string | undefined): Mat {
  if (!attr) return IDENTITY;
  const m = attr.trim().split(/\s+/).map(Number);
  return m.length === 12 && m.every(Number.isFinite) ? m : IDENTITY;
}

const formatMat = (m: Mat) => m.map((v) => +v.toPrecision(12)).join(' ');

/** a then b. */
export function mul(a: Mat, b: Mat): Mat {
  const r = (i: number, j: number, m: Mat) => m[i * 3 + j]!;
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      let s = i === 3 ? r(3, j, b) : 0;
      for (let k = 0; k < 3; k++) s += r(i, k, a) * r(k, j, b);
      out.push(s);
    }
  }
  return out;
}

export function applyMat(src: Float32Array, m: Mat): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i]!, y = src[i + 1]!, z = src[i + 2]!;
    out[i] = x * m[0]! + y * m[3]! + z * m[6]! + m[9]!;
    out[i + 1] = x * m[1]! + y * m[4]! + z * m[7]! + m[10]!;
    out[i + 2] = x * m[2]! + y * m[5]! + z * m[8]! + m[11]!;
  }
  return out;
}

const UNITS: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

export interface ThreeMfItem {
  /** Object id of the build item in the main model file. */
  objectId: string;
  transform: Mat;
  /** Slicers mark parts that should not be printed with printable="0". */
  printable: boolean;
  /** Bambu Studio / Orca plate the item is on. */
  plate: number | null;
  /** Printable geometry in mm, item transform applied; modifiers and the like left out. */
  triangles: Float32Array;
}

export interface ThreeMf {
  files: Record<string, Uint8Array>;
  /** Zip entry of the main model, e.g. "3D/3dmodel.model". */
  mainEntry: string;
  /** mm per model unit. */
  unit: number;
  /**
   * Project of a slicer that stores parts, modifiers and per-object settings next to the
   * geometry. Orca reads these itself, so the file should reach it as a 3MF.
   */
  project: 'bambu' | 'prusa' | null;
  items: ThreeMfItem[];
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const BAMBU_CONFIG = 'Metadata/model_settings.config';
const PRUSA_CONFIG = 'Metadata/Slic3r_PE_model.config';
const PRUSA_SETTINGS = 'Metadata/Slic3r_PE.config';

export function read3mf(buf: Uint8Array): ThreeMf {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf);
  } catch {
    throw new ThreeMfError('Keine gültige 3MF-Datei');
  }
  const xml = new Map<string, string>();
  for (const [name, data] of Object.entries(files)) if (name.endsWith('.model')) xml.set('/' + name.replace(/^\//, ''), strFromU8(data));
  const mainPath = [...xml.keys()].find((p) => /\/3D\/3dmodel\.model$/i.test(p)) ?? [...xml.keys()][0];
  if (!mainPath) throw new ThreeMfError('3MF enthält kein Modell');
  const main = xml.get(mainPath)!;
  const unit = UNITS[attr(/<model\b[^>]*>/.exec(main)?.[0] ?? '', 'unit') ?? 'millimeter'] ?? 1;

  const bambu = files[BAMBU_CONFIG] ? strFromU8(files[BAMBU_CONFIG]) : undefined;
  const prusa = files[PRUSA_CONFIG] ? strFromU8(files[PRUSA_CONFIG]) : undefined;

  // Bambu/Orca: parts of an object are components; their kind is in the model settings.
  const skipPart = new Set<string>();
  const plateOf = new Map<string, number>();
  if (bambu) {
    for (const o of bambu.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
      const id = attr(o[1]!, 'id');
      for (const p of o[2]!.matchAll(/<part\b([^>]*)>/g)) {
        const subtype = attr(p[1]!, 'subtype');
        if (subtype && subtype !== 'normal_part') skipPart.add(`${id}:${attr(p[1]!, 'id')}`);
      }
    }
    for (const p of bambu.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
      const plate = Number(/key="plater_id" value="(\d+)"/.exec(p[1]!)?.[1]);
      for (const inst of p[1]!.matchAll(/<model_instance>([\s\S]*?)<\/model_instance>/g)) {
        const obj = /key="object_id" value="(\d+)"/.exec(inst[1]!)?.[1];
        if (obj && Number.isFinite(plate)) plateOf.set(obj, plate);
      }
    }
  }
  // PrusaSlicer: all volumes of an object share one mesh; triangle ranges say which is which.
  const skipRanges = new Map<string, [number, number][]>();
  if (prusa) {
    for (const o of prusa.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
      const id = attr(o[1]!, 'id')!;
      for (const v of o[2]!.matchAll(/<volume\b([^>]*)>([\s\S]*?)<\/volume>/g)) {
        const type = /key="volume_type" value="([^"]*)"/.exec(v[2]!)?.[1];
        const modifier = /key="modifier" value="1"/.test(v[2]!);
        if ((type && type !== 'ModelPart') || (!type && modifier)) {
          const list = skipRanges.get(id) ?? [];
          list.push([Number(attr(v[1]!, 'firstid')), Number(attr(v[1]!, 'lastid'))]);
          skipRanges.set(id, list);
        }
      }
    }
  }

  type Obj = { type: string; mesh?: Float32Array; components: { path: string; id: string; m: Mat }[] };
  const objects = new Map<string, Obj>();
  for (const [file, text] of xml) {
    for (const om of text.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
      const id = attr(om[1]!, 'id')!;
      const body = om[2]!;
      const obj: Obj = { type: attr(om[1]!, 'type') ?? 'model', components: [] };
      const meshBody = /<mesh>([\s\S]*?)<\/mesh>/.exec(body)?.[1];
      if (meshBody) {
        const verts: number[] = [];
        for (const v of meshBody.matchAll(/<vertex\b([^>]*)\/>/g)) verts.push(+attr(v[1]!, 'x')!, +attr(v[1]!, 'y')!, +attr(v[1]!, 'z')!);
        const skip = file === mainPath ? skipRanges.get(id) : undefined;
        const tris: number[] = [];
        let t = -1;
        for (const tm of meshBody.matchAll(/<triangle\b([^>]*)\/>/g)) {
          t++;
          if (skip?.some(([a, b]) => t >= a && t <= b)) continue;
          for (const k of ['v1', 'v2', 'v3']) {
            const i = Number(attr(tm[1]!, k)) * 3;
            tris.push(verts[i]!, verts[i + 1]!, verts[i + 2]!);
          }
        }
        obj.mesh = Float32Array.from(tris);
      }
      for (const c of body.matchAll(/<component\b([^>]*)\/>/g)) {
        obj.components.push({ path: attr(c[1]!, 'p:path') ?? file, id: attr(c[1]!, 'objectid')!, m: parseMat(attr(c[1]!, 'transform')) });
      }
      objects.set(`${file}#${id}`, obj);
    }
  }

  const scale: Mat = [unit, 0, 0, 0, unit, 0, 0, 0, unit, 0, 0, 0];
  const items: ThreeMfItem[] = [];
  const build = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(main)?.[1] ?? '';
  for (const it of build.matchAll(/<item\b([^>]*)\/>/g)) {
    const objectId = attr(it[1]!, 'objectid')!;
    const transform = parseMat(attr(it[1]!, 'transform'));
    const out: number[] = [];
    const emit = (key: string, m: Mat, depth: number, topId: string) => {
      const obj = objects.get(key);
      // "support" and "other" objects are not printed (3MF core spec), e.g. Orca's modifiers.
      if (!obj || depth > 10 || obj.type === 'support' || obj.type === 'other') return;
      if (obj.mesh) for (const v of applyMat(obj.mesh, m)) out.push(v);
      for (const c of obj.components) {
        if (depth === 0 && skipPart.has(`${topId}:${c.id}`)) continue;
        emit(`${c.path}#${c.id}`, mul(c.m, m), depth + 1, topId);
      }
    };
    emit(`${mainPath}#${objectId}`, mul(transform, scale), 0, objectId);
    items.push({ objectId, transform, printable: attr(it[1]!, 'printable') !== '0', plate: plateOf.get(objectId) ?? null, triangles: Float32Array.from(out) });
  }

  return { files, mainEntry: mainPath.slice(1), unit, project: bambu ? 'bambu' : prusa ? 'prusa' : null, items };
}

/** Printable geometry of all build items in one triangle soup. */
export function mergedTriangles(tm: ThreeMf, items = tm.items): Float32Array {
  const parts = items.filter((i) => i.printable);
  const out = new Float32Array(parts.reduce((n, i) => n + i.triangles.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p.triangles, o);
    o += p.triangles.length;
  }
  return out;
}

/**
 * Build items by plate, for projects spread over several plates (Bambu Studio/Orca) or beds
 * (PrusaSlicer 2.9, which only stores the position: beds are laid out on a grid with a third
 * of the bed size between them). A single group when everything is on one plate.
 */
export function plateGroups(tm: ThreeMf): ThreeMfItem[][] {
  const keyOf = new Map<ThreeMfItem, string>();
  if (tm.project === 'bambu') {
    for (const i of tm.items) if (i.plate !== null) keyOf.set(i, String(i.plate).padStart(4, '0'));
  } else if (tm.project === 'prusa') {
    const bed = /^; bed_shape = (.*)$/m
      .exec(tm.files[PRUSA_SETTINGS] ? strFromU8(tm.files[PRUSA_SETTINGS]) : '')?.[1]
      ?.split(',')
      .map((p) => p.split('x').map(Number));
    if (!bed || bed.length < 3 || bed.some((p) => p.length !== 2 || !p.every(Number.isFinite))) return [tm.items];
    const [x0, x1] = [Math.min(...bed.map((p) => p[0]!)), Math.max(...bed.map((p) => p[0]!))];
    const [y0, y1] = [Math.min(...bed.map((p) => p[1]!)), Math.max(...bed.map((p) => p[1]!))];
    const [sx, sy] = [((x1 - x0) * 4) / 3, ((y1 - y0) * 4) / 3];
    for (const i of tm.items) {
      const t = i.triangles;
      if (!t.length) continue;
      let [ax, bx, ay, by] = [Infinity, -Infinity, Infinity, -Infinity];
      for (let k = 0; k < t.length; k += 3) {
        ax = Math.min(ax, t[k]!);
        bx = Math.max(bx, t[k]!);
        ay = Math.min(ay, t[k + 1]!);
        by = Math.max(by, t[k + 1]!);
      }
      const [col, row] = [Math.floor(((ax + bx) / 2 - x0) / sx), Math.floor(((ay + by) / 2 - y0) / sy)];
      keyOf.set(i, `${String(row + 1000).padStart(5, '0')}:${String(col + 1000).padStart(5, '0')}`);
    }
  }
  const groups = new Map<string, ThreeMfItem[]>();
  for (const i of tm.items) {
    // Items without a plate (or geometry) go with the first plate.
    const key = keyOf.get(i) ?? '';
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, items]) => items);
  if (sorted.length > 1 && !keyOf.get(sorted[0]![0]!)) sorted[1]!.unshift(...sorted.shift()!);
  return sorted.filter((g) => g.some((i) => i.printable && i.triangles.length));
}

/**
 * Writes the project back with every build item moved by `place` (applied after the item's
 * own transform) and, if given, only the items in `keep`. Bambu plate assignments are dropped:
 * Orca otherwise slices each plate separately and decides the plate from the position.
 * Everything else (parts, modifiers, per-object settings) stays as it is.
 */
export function rewrite3mf(tm: ThreeMf, place: Mat, keep?: Set<string>): Uint8Array {
  if (tm.unit !== 1) throw new ThreeMfError('Nur 3MF-Projekte in Millimetern können umgeschrieben werden');
  const files = { ...tm.files };
  const main = strFromU8(tm.files[tm.mainEntry]!);
  files[tm.mainEntry] = strToU8(
    main.replace(/<build\b[^>]*>[\s\S]*?<\/build>/, (build) =>
      build.replace(/<item\b([^>]*?)\s*\/>/g, (tag, attrs: string) => {
        const id = attr(attrs, 'objectid')!;
        if (keep && !keep.has(id)) return '';
        const m = formatMat(mul(parseMat(attr(attrs, 'transform')), place));
        return /\btransform="/.test(attrs) ? `<item${attrs.replace(/\btransform="[^"]*"/, `transform="${m}"`)}/>` : `<item${attrs} transform="${m}"/>`;
      }),
    ),
  );
  // Settings of items that were left out go too.
  const dropObjects = (cfg: string) =>
    keep
      ? cfg
          .replace(/\s*<object\b([^>]*)>[\s\S]*?<\/object>/g, (block, attrs: string) => (keep.has(attr(attrs, 'id')!) ? block : ''))
          .replace(/\s*<assemble_item\b([^>]*)\/>/g, (tag, attrs: string) => (keep.has(attr(attrs, 'object_id')!) ? tag : ''))
      : cfg;
  if (tm.files[BAMBU_CONFIG]) files[BAMBU_CONFIG] = strToU8(dropObjects(strFromU8(tm.files[BAMBU_CONFIG]).replace(/\s*<plate>[\s\S]*?<\/plate>/g, '')));
  if (tm.files[PRUSA_CONFIG]) files[PRUSA_CONFIG] = strToU8(dropObjects(strFromU8(tm.files[PRUSA_CONFIG])));
  // Fixed timestamps: the same input gives the same file (models are deduplicated by hash).
  return zipSync(files, { level: 6, mtime: new Date('2000-01-01T00:00:00Z') });
}
