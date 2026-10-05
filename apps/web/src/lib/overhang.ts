/**
 * Estimates which surfaces of an oriented part would print into thin air without supports.
 *
 * A face counts as overhang when it faces down at a slope (from horizontal) below the support
 * threshold and does not rest on the bed. Connected overhang faces form regions; narrow
 * regions (threads, chamfers, small ledges) print fine thanks to the walls below them, so only
 * regions at least MIN_WIDTH wide are reported. Width = 2 · projected area / projected outline.
 */

export interface OverhangResult {
  /** Footprint (mm², projected onto the bed) of overhangs that likely need support. */
  area: number;
  /** Per triangle: 0 = fine, 1 = minor overhang (ignored), 2 = needs support. */
  faces: Uint8Array;
}

const MIN_WIDTH = 1.5; // mm
const MIN_AREA = 4; // mm², per region
const ON_BED = 0.15; // mm above the lowest point

/** `tris`: 9 floats per triangle, already rotated/scaled, Z up. */
export function findOverhangs(tris: Float32Array, thresholdDeg: number): OverhangResult {
  const n = tris.length / 9;
  const faces = new Uint8Array(n);
  let zmin = Infinity;
  for (let i = 2; i < tris.length; i += 3) zmin = Math.min(zmin, tris[i]!);
  const maxNz = -Math.cos((thresholdDeg * Math.PI) / 180); // slope < threshold  <=>  nz < -cos(threshold)

  const over: number[] = [];
  const projArea = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ux = tris[o + 3]! - tris[o]!, uy = tris[o + 4]! - tris[o + 1]!, uz = tris[o + 5]! - tris[o + 2]!;
    const vx = tris[o + 6]! - tris[o]!, vy = tris[o + 7]! - tris[o + 1]!, vz = tris[o + 8]! - tris[o + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!len || nz / len >= maxNz) continue;
    if (Math.min(tris[o + 2]!, tris[o + 5]!, tris[o + 8]!) < zmin + ON_BED) continue;
    faces[t] = 1;
    projArea[t] = -nz / 2; // |cross|/2 · |nz/len| = area projected onto XY
    over.push(t);
  }
  if (!over.length) return { area: 0, faces };

  // Weld vertices so neighbouring triangles share edge keys.
  const ids = new Map<string, number>();
  const vid = (t: number, k: number) => {
    const o = t * 9 + k * 3;
    const key = `${Math.round(tris[o]! * 1000)},${Math.round(tris[o + 1]! * 1000)},${Math.round(tris[o + 2]! * 1000)}`;
    let id = ids.get(key);
    if (id === undefined) ids.set(key, (id = ids.size));
    return id;
  };
  const edges = new Map<string, number[]>();
  const triEdges = new Map<number, [string, number, number][]>();
  for (const t of over) {
    const v = [vid(t, 0), vid(t, 1), vid(t, 2)];
    const list: [string, number, number][] = [];
    for (let k = 0; k < 3; k++) {
      const a = v[k]!, b = v[(k + 1) % 3]!;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      (edges.get(key) ?? edges.set(key, []).get(key)!).push(t);
      list.push([key, k, (k + 1) % 3]);
    }
    triEdges.set(t, list);
  }

  // Union-find over triangles sharing an edge.
  const parent = new Map<number, number>(over.map((t) => [t, t]));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (x !== r) {
      const next = parent.get(x)!;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  for (const ts of edges.values()) for (let i = 1; i < ts.length; i++) parent.set(find(ts[i]!), find(ts[0]!));

  const regions = new Map<number, { area: number; outline: number; tris: number[] }>();
  for (const t of over) {
    const r = find(t);
    const reg = regions.get(r) ?? regions.set(r, { area: 0, outline: 0, tris: [] }).get(r)!;
    reg.area += projArea[t]!;
    reg.tris.push(t);
    for (const [key, a, b] of triEdges.get(t)!) {
      if (edges.get(key)!.length !== 1) continue; // inner edge
      const o = t * 9;
      reg.outline += Math.hypot(tris[o + b * 3]! - tris[o + a * 3]!, tris[o + b * 3 + 1]! - tris[o + a * 3 + 1]!);
    }
  }

  let area = 0;
  for (const reg of regions.values()) {
    const width = reg.outline > 0 ? (2 * reg.area) / reg.outline : Infinity;
    if (width < MIN_WIDTH || reg.area < MIN_AREA) continue;
    area += reg.area;
    for (const t of reg.tris) faces[t] = 2;
  }
  return { area, faces };
}
