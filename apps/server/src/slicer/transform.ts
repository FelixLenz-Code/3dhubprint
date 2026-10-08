import fs from 'node:fs';
import type { ModelTransform } from '@printhub/shared';
import { meshInfo, type Mesh } from './mesh.js';
import { applyMat, type Mat } from './threemf.js';

type Quat = ModelTransform['rotation'];

export function isIdentity(t: Pick<ModelTransform, 'rotation' | 'scale'>): boolean {
  const [x, y, z, w] = t.rotation;
  return t.scale === 1 && Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9 && Math.abs(z) < 1e-9 && Math.abs(Math.abs(w) - 1) < 1e-9;
}

function rotationMatrix([x, y, z, w]: Quat): number[] {
  const n = Math.hypot(x, y, z, w) || 1;
  [x, y, z, w] = [x / n, y / n, z / n, w / n];
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/**
 * Rotates and scales a mesh around its bounding-box center, then moves it so that the
 * center lies at `at` (XY) and the lowest point at Z = 0. Without `at` the part stays
 * centered on the origin (Orca arranges it). Returned as a 3MF matrix, so the same placement
 * can be applied to the mesh or written into a 3MF project.
 */
export function placementMatrix(mesh: Mesh, t: Pick<ModelTransform, 'rotation' | 'scale'>, at?: [number, number]): Mat {
  const info = meshInfo(mesh);
  const c = [0, 1, 2].map((k) => (info.min[k]! + info.max[k]!) / 2);
  const r = rotationMatrix(t.rotation);
  // p' = A (p - c): A = s R, as 3MF row-vector matrix (transposed).
  const a = r.map((v) => v * t.scale);
  const lin = [a[0]!, a[3]!, a[6]!, a[1]!, a[4]!, a[7]!, a[2]!, a[5]!, a[8]!];
  const shift = [0, 1, 2].map((i) => -(a[i * 3]! * c[0]! + a[i * 3 + 1]! * c[1]! + a[i * 3 + 2]! * c[2]!));
  const moved = meshInfo({ triangles: applyMat(mesh.triangles, [...lin, ...shift]) });
  const d = [(at?.[0] ?? 0) - (moved.min[0] + moved.max[0]) / 2, (at?.[1] ?? 0) - (moved.min[1] + moved.max[1]) / 2, -moved.min[2]];
  return [...lin, shift[0]! + d[0]!, shift[1]! + d[1]!, shift[2]! + d[2]!];
}

export function transformMesh(mesh: Mesh, t: Pick<ModelTransform, 'rotation' | 'scale'>, at?: [number, number]): Mesh {
  return { triangles: applyMat(mesh.triangles, placementMatrix(mesh, t, at)) };
}

export async function writeStl(mesh: Mesh, file: string): Promise<void> {
  const n = mesh.triangles.length / 9;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write('PrintHub', 0, 'ascii');
  buf.writeUInt32LE(n, 80);
  const t = mesh.triangles;
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50;
    // Normal left at 0: slicers recompute it from the vertices.
    for (let k = 0; k < 9; k++) buf.writeFloatLE(t[i * 9 + k]!, o + 12 + k * 4);
  }
  await fs.promises.writeFile(file, buf);
}

/**
 * Reduces a mesh for display by merging vertices on a grid (vertex clustering). Coarse,
 * but keeps the shape recognizable and the browser responsive with huge scans.
 */
export function simplifyForDisplay(mesh: Mesh, maxTriangles: number): Mesh {
  const src = mesh.triangles;
  const n = src.length / 9;
  if (n <= maxTriangles) return mesh;
  const info = meshInfo(mesh);
  const extent = Math.max(...info.size, 1e-6);
  // Grid cell per vertex; vertices in the same cell are merged into the cell center.
  const cellOf = new Uint32Array(n * 3);
  for (let cells = Math.min(1000, Math.ceil(Math.sqrt(maxTriangles))); ; cells = Math.floor(cells * 0.8)) {
    const size = extent / cells;
    for (let v = 0; v < n * 3; v++) {
      const o = v * 3;
      const ix = Math.min(cells, Math.floor((src[o]! - info.min[0]) / size));
      const iy = Math.min(cells, Math.floor((src[o + 1]! - info.min[1]) / size));
      const iz = Math.min(cells, Math.floor((src[o + 2]! - info.min[2]) / size));
      cellOf[v] = ix + (cells + 1) * (iy + (cells + 1) * iz);
    }
    const seen = new Set<string>();
    const keep: number[] = [];
    for (let t = 0; t < n; t++) {
      const a = cellOf[t * 3]!, b = cellOf[t * 3 + 1]!, c = cellOf[t * 3 + 2]!;
      if (a === b || b === c || a === c) continue; // collapsed
      const key = a < b ? (b < c ? `${a},${b},${c}` : a < c ? `${a},${c},${b}` : `${c},${a},${b}`) : a < c ? `${b},${a},${c}` : b < c ? `${b},${c},${a}` : `${c},${b},${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      keep.push(t);
    }
    if (keep.length <= maxTriangles || cells < 16) {
      const out = new Float32Array(keep.length * 9);
      const r = cells + 1;
      keep.forEach((t, i) => {
        for (let k = 0; k < 3; k++) {
          const id = cellOf[t * 3 + k]!;
          const ix = id % r, iy = Math.floor(id / r) % r, iz = Math.floor(id / (r * r));
          out[i * 9 + k * 3] = info.min[0] + (ix + 0.5) * size;
          out[i * 9 + k * 3 + 1] = info.min[1] + (iy + 0.5) * size;
          out[i * 9 + k * 3 + 2] = info.min[2] + (iz + 0.5) * size;
        }
      });
      return { triangles: out };
    }
  }
}
