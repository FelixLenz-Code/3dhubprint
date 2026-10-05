import type { ModelTransform } from '@printhub/shared';

/** Overhang footprint per model (mm²) from which the job page suggests supports. */
export const OVERHANG_WARN_MM2 = 25;

export interface PlateReport {
  /** Reason the plate can't be sliced as shown, if any. */
  blocking: string | null;
  /** Overhang footprint (mm²) per model id; null while unknown (auto orientation, loading). */
  overhangs: Map<number, number> | null;
}

export type Quat = ModelTransform['rotation'];
export const IDENTITY: Quat = [0, 0, 0, 1];

/** Build plate in printer coordinates (mm). */
export interface Bed {
  x0: number;
  y0: number;
  width: number;
  depth: number;
  height: number;
}

export interface OrientedMesh {
  /** 9 floats per triangle, centered on X/Y = 0, lowest point at Z = 0. */
  tris: Float32Array;
  size: [number, number, number];
}

/**
 * Same as the server's transformMesh: rotate/scale around the bounding-box center, then
 * center on XY = 0 and put the lowest point on the bed.
 */
export function orient(src: Float32Array, rotation: Quat, scale: number): OrientedMesh {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < src.length; i++) {
    const k = i % 3;
    if (src[i]! < min[k]!) min[k] = src[i]!;
    if (src[i]! > max[k]!) max[k] = src[i]!;
  }
  const c = [0, 1, 2].map((k) => (min[k]! + max[k]!) / 2);
  const m = matrix(rotation);
  const out = new Float32Array(src.length);
  const rmin = [Infinity, Infinity, Infinity];
  const rmax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < src.length; i += 3) {
    const x = (src[i]! - c[0]!) * scale;
    const y = (src[i + 1]! - c[1]!) * scale;
    const z = (src[i + 2]! - c[2]!) * scale;
    const v = [m[0]! * x + m[1]! * y + m[2]! * z, m[3]! * x + m[4]! * y + m[5]! * z, m[6]! * x + m[7]! * y + m[8]! * z];
    for (let k = 0; k < 3; k++) {
      out[i + k] = v[k]!;
      if (v[k]! < rmin[k]!) rmin[k] = v[k]!;
      if (v[k]! > rmax[k]!) rmax[k] = v[k]!;
    }
  }
  const d = [-(rmin[0]! + rmax[0]!) / 2, -(rmin[1]! + rmax[1]!) / 2, -rmin[2]!];
  for (let i = 0; i < out.length; i++) out[i] = out[i]! + d[i % 3]!;
  return { tris: out, size: [rmax[0]! - rmin[0]!, rmax[1]! - rmin[1]!, rmax[2]! - rmin[2]!] };
}

function matrix([x, y, z, w]: Quat): number[] {
  const n = Math.hypot(x, y, z, w) || 1;
  [x, y, z, w] = [x / n, y / n, z / n, w / n];
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** Bounding box of a box of `dims` after rotation and scaling (when the mesh isn't loaded yet). */
export function rotatedSize(dims: [number, number, number], rotation: Quat, scale: number): [number, number, number] {
  const m = matrix(rotation);
  const out = [0, 1, 2].map((r) => scale * (Math.abs(m[r * 3]!) * dims[0] + Math.abs(m[r * 3 + 1]!) * dims[1] + Math.abs(m[r * 3 + 2]!) * dims[2]));
  return out as [number, number, number];
}

/** Hamilton product a·b (apply b, then a). */
export function mulQuat(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function axisAngle(axis: 'x' | 'y' | 'z', deg: number): Quat {
  const h = (deg * Math.PI) / 360;
  const s = Math.sin(h);
  return [axis === 'x' ? s : 0, axis === 'y' ? s : 0, axis === 'z' ? s : 0, Math.cos(h)];
}

/** Rotation that turns direction `n` (unit) to point straight down. */
export function faceDown(n: [number, number, number]): Quat {
  const [x, y, z] = n;
  // Rotation axis n × (0,0,-1) = (-y, x, 0); angle acos(-z).
  if (z < -0.999999) return IDENTITY;
  if (z > 0.999999) return [1, 0, 0, 0]; // 180° about X
  const len = Math.hypot(x, y);
  const angle = Math.acos(Math.max(-1, Math.min(1, -z)));
  const s = Math.sin(angle / 2);
  return [(-y / len) * s, (x / len) * s, 0, Math.cos(angle / 2)];
}

/** Rounds away float noise so 90° turns stay exact in stored transforms. */
export function cleanQuat(q: Quat): Quat {
  const n = Math.hypot(...q) || 1;
  return q.map((v) => Math.round((v / n) * 1e6) / 1e6) as Quat;
}

const GAP = 6;

/**
 * Simple shelf packing, centered on the bed: rows from front to back. Only a starting point
 * for manual placement (and the preview while Orca arranges).
 */
export function layout(footprints: [number, number][], bed: Bed): [number, number][] {
  const rows: { items: number[]; width: number; depth: number }[] = [];
  let row = { items: [] as number[], width: 0, depth: 0 };
  footprints.forEach(([w, d], i) => {
    if (row.items.length && row.width + GAP + w > bed.width) {
      rows.push(row);
      row = { items: [], width: 0, depth: 0 };
    }
    row.width += (row.items.length ? GAP : 0) + w;
    row.depth = Math.max(row.depth, d);
    row.items.push(i);
  });
  if (row.items.length) rows.push(row);

  const total = rows.reduce((n, r) => n + r.depth, 0) + GAP * Math.max(0, rows.length - 1);
  const out: [number, number][] = new Array(footprints.length);
  let y = bed.y0 + (bed.depth - total) / 2;
  for (const r of rows) {
    let x = bed.x0 + (bed.width - r.width) / 2;
    for (const i of r.items) {
      const [w] = footprints[i]!;
      out[i] = [round(x + w / 2), round(y + r.depth / 2)];
      x += w + GAP;
    }
    y += r.depth + GAP;
  }
  return out;
}

const round = (v: number) => Math.round(v * 10) / 10;

export interface LayFlatResult {
  rotation: Quat;
  /** Contact area on the bed (mm²) and overhang footprint (mm²) of the chosen side. */
  contact: number;
  overhang: number;
}

/**
 * Finds the side a part should lie on: flat outer surfaces are candidates (largest contact
 * first), the best few are compared by the overhang area they would leave. Mesh in model
 * coordinates; the result is an absolute rotation (like ModelTransform.rotation).
 */
export function bestLayFlat(
  src: Float32Array,
  overhangArea: (tris: Float32Array) => number,
  current: Quat = IDENTITY,
  maxCandidates = 6,
): LayFlatResult | null {
  const n = src.length / 9;
  const groups = new Map<string, { nx: number; ny: number; nz: number; area: number; tris: number[] }>();
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ux = src[o + 3]! - src[o]!, uy = src[o + 4]! - src[o + 1]!, uz = src[o + 5]! - src[o + 2]!;
    const vx = src[o + 6]! - src[o]!, vy = src[o + 7]! - src[o + 1]!, vz = src[o + 8]! - src[o + 2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!len) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    // ~1° bins: nearly coplanar facets of one flat surface land together.
    const key = `${Math.round(nx * 60)},${Math.round(ny * 60)},${Math.round(nz * 60)}`;
    const g = groups.get(key) ?? groups.set(key, { nx: 0, ny: 0, nz: 0, area: 0, tris: [] }).get(key)!;
    const a = len / 2;
    g.nx += nx * a;
    g.ny += ny * a;
    g.nz += nz * a;
    g.area += a;
    g.tris.push(t);
  }

  // Contact area: only facets in the outermost plane along the normal touch the bed.
  const candidates: { n: [number, number, number]; contact: number }[] = [];
  for (const g of [...groups.values()].sort((a, b) => b.area - a.area).slice(0, 40)) {
    const l = Math.hypot(g.nx, g.ny, g.nz);
    if (!l || g.area < 1) continue;
    const dir: [number, number, number] = [g.nx / l, g.ny / l, g.nz / l];
    let extent = -Infinity;
    for (let i = 0; i < src.length; i += 3) extent = Math.max(extent, dir[0] * src[i]! + dir[1] * src[i + 1]! + dir[2] * src[i + 2]!);
    let contact = 0;
    for (const t of g.tris) {
      const o = t * 9;
      const d = Math.min(...[0, 3, 6].map((k) => dir[0] * src[o + k]! + dir[1] * src[o + k + 1]! + dir[2] * src[o + k + 2]!));
      if (d >= extent - 0.1) {
        const ux = src[o + 3]! - src[o]!, uy = src[o + 4]! - src[o + 1]!, uz = src[o + 5]! - src[o + 2]!;
        const vx = src[o + 6]! - src[o]!, vy = src[o + 7]! - src[o + 1]!, vz = src[o + 8]! - src[o + 2]!;
        contact += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      }
    }
    if (contact >= 1) candidates.push({ n: dir, contact });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.contact - a.contact);

  const best = candidates[0]!.contact;
  let pick: LayFlatResult | null = null;
  let pickScore = Infinity;
  for (const c of candidates.slice(0, maxCandidates)) {
    if (c.contact < best * 0.05) break;
    const rotation = cleanQuat(faceDown(c.n));
    const overhang = overhangArea(orient(src, rotation, 1).tris);
    // Less overhang wins; a larger contact area (better adhesion) is worth some overhang.
    const score = overhang - 0.25 * c.contact;
    if (score < pickScore - 1e-6) {
      pick = { rotation, contact: c.contact, overhang };
      pickScore = score;
    }
  }
  // Keep the current orientation if it is already as good (avoids needless flips).
  if (pick) {
    const cur = orient(src, current, 1).tris;
    const curContact = candidates.find((c) => sameDown(c.n, current))?.contact ?? 0;
    if (curContact > 0 && overhangArea(cur) - 0.25 * curContact <= pickScore + 1e-6) return { rotation: current, contact: curContact, overhang: overhangArea(cur) };
  }
  return pick;
}

/** Whether rotation `q` turns model direction `n` to point down. */
function sameDown(n: [number, number, number], q: Quat): boolean {
  const m = matrix(q);
  return m[6]! * n[0] + m[7]! * n[1] + m[8]! * n[2] < -0.999;
}
