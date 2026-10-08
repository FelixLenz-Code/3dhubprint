import { encodePng } from './png.js';
import { mergedTriangles, read3mf, ThreeMfError } from './threemf.js';

export class MeshError extends Error {}

/** Flat triangle soup: 9 floats per triangle. */
export interface Mesh {
  triangles: Float32Array;
}

export type ModelFormat = 'stl' | '3mf' | 'obj';

export function formatOf(filename: string): ModelFormat | undefined {
  const ext = filename.toLowerCase().split('.').pop();
  return ext === 'stl' || ext === '3mf' || ext === 'obj' ? ext : undefined;
}

export function parseModel(format: ModelFormat, buf: Buffer): Mesh {
  const mesh = format === 'stl' ? parseStl(buf) : format === 'obj' ? parseObj(buf.toString('utf8')) : parse3mf(buf);
  if (mesh.triangles.length === 0) throw new MeshError('Das Modell enthält keine Dreiecke');
  return mesh;
}

export function parseStl(buf: Buffer): Mesh {
  if (buf.length >= 84) {
    const n = buf.readUInt32LE(80);
    if (84 + n * 50 === buf.length) {
      const t = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12; // skip normal
        for (let k = 0; k < 9; k++) t[i * 9 + k] = buf.readFloatLE(o + k * 4);
      }
      return { triangles: t };
    }
  }
  const text = buf.toString('latin1');
  if (!/^\s*solid/.test(text) || !text.includes('facet')) throw new MeshError('Keine gültige STL-Datei');
  const values: number[] = [];
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) values.push(+m[1]!, +m[2]!, +m[3]!);
  return { triangles: Float32Array.from(values.slice(0, values.length - (values.length % 9))) };
}

export function parseObj(text: string): Mesh {
  const v: number[][] = [];
  const out: number[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v') v.push([+parts[1]!, +parts[2]!, +parts[3]!]);
    else if (parts[0] === 'f') {
      const idx = parts.slice(1).map((p) => {
        const i = parseInt(p.split('/')[0]!, 10);
        return i < 0 ? v.length + i : i - 1;
      });
      for (let k = 1; k + 1 < idx.length; k++) {
        for (const i of [idx[0]!, idx[k]!, idx[k + 1]!]) {
          const p = v[i];
          if (!p) throw new MeshError('OBJ verweist auf einen nicht vorhandenen Punkt');
          out.push(p[0]!, p[1]!, p[2]!);
        }
      }
    }
  }
  return { triangles: Float32Array.from(out) };
}

export function parse3mf(buf: Buffer): Mesh {
  try {
    return { triangles: mergedTriangles(read3mf(new Uint8Array(buf))) };
  } catch (err) {
    if (err instanceof ThreeMfError) throw new MeshError(err.message);
    throw err;
  }
}

/**
 * Places several meshes (with copies) side by side on a grid, only for preview images;
 * the real arrangement is done by Orca. Renders at most 16 instances.
 */
export function layoutForPreview(items: { mesh: Mesh; copies: number }[]): Mesh {
  const instances = items.flatMap((i) => Array.from({ length: i.copies }, () => i.mesh)).slice(0, 16);
  if (instances.length === 1) return instances[0]!;
  const infos = instances.map((m) => meshInfo(m));
  const cols = Math.ceil(Math.sqrt(instances.length));
  const gap = 5;
  const colWidth = Math.max(...infos.map((i) => i.size[0])) + gap;
  const rowDepth = Math.max(...infos.map((i) => i.size[1])) + gap;
  const total = instances.reduce((n, m) => n + m.triangles.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  instances.forEach((m, idx) => {
    const info = infos[idx]!;
    const dx = (idx % cols) * colWidth - info.min[0];
    const dy = Math.floor(idx / cols) * rowDepth - info.min[1];
    const dz = -info.min[2];
    for (let i = 0; i < m.triangles.length; i += 3) {
      out[o++] = m.triangles[i]! + dx;
      out[o++] = m.triangles[i + 1]! + dy;
      out[o++] = m.triangles[i + 2]! + dz;
    }
  });
  return { triangles: out };
}

export interface MeshInfo {
  triangles: number;
  size: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
}

export function meshInfo(mesh: Mesh): MeshInfo {
  const min = [Infinity, Infinity, Infinity] as [number, number, number];
  const max = [-Infinity, -Infinity, -Infinity] as [number, number, number];
  const t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = t[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    triangles: t.length / 9,
    min: min.map(r) as MeshInfo['min'],
    max: max.map(r) as MeshInfo['max'],
    size: [r(max[0] - min[0]), r(max[1] - min[1]), r(max[2] - min[2])],
  };
}

/**
 * Software rasterizer for thumbnails: isometric-ish view, Lambert shading, transparent
 * background, 2x supersampling. Good enough for a recognizable preview.
 */
export function renderThumbnail(mesh: Mesh, size: number, color: [number, number, number] = [0x2a, 0xa1, 0x98]): Buffer {
  const ss = 2;
  const W = size * ss;
  const t = mesh.triangles;
  const info = meshInfo(mesh);
  const c = [(info.min[0] + info.max[0]) / 2, (info.min[1] + info.max[1]) / 2, (info.min[2] + info.max[2]) / 2];

  // View: rotate -40° around Z, then tilt the camera down 30°.
  const az = (-40 * Math.PI) / 180;
  const el = (30 * Math.PI) / 180;
  const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
  const proj = new Float32Array(t.length);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < t.length; i += 3) {
    const x = t[i]! - c[0]!, y = t[i + 1]! - c[1]!, z = t[i + 2]! - c[2]!;
    const xr = x * ca - y * sa;
    const yr = x * sa + y * ca;
    const sx = xr;
    const sy = -(z * ce - yr * se); // screen y grows downwards
    const depth = yr * ce + z * se; // larger = closer to the camera
    proj[i] = sx;
    proj[i + 1] = sy;
    proj[i + 2] = depth;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }
  const extent = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = (W * 0.86) / extent;
  const ox = W / 2 - ((minX + maxX) / 2) * scale;
  const oy = W / 2 - ((minY + maxY) / 2) * scale;

  const zbuf = new Float32Array(W * W).fill(-Infinity);
  const shade = new Float32Array(W * W).fill(-1);
  // Light from upper left front, in view space.
  const L = normalize([-0.4, -0.6, 0.7]);

  for (let i = 0; i < t.length; i += 9) {
    const ax = proj[i]! * scale + ox, ay = proj[i + 1]! * scale + oy, aZ = proj[i + 2]!;
    const bx = proj[i + 3]! * scale + ox, by = proj[i + 4]! * scale + oy, bZ = proj[i + 5]!;
    const cx = proj[i + 6]! * scale + ox, cy = proj[i + 7]! * scale + oy, cZ = proj[i + 8]!;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) continue;
    // Face normal in view space (x right, y down, z towards viewer).
    const ux = bx - ax, uy = by - ay, uz = (bZ - aZ) * scale;
    const vx = cx - ax, vy = cy - ay, vz = (cZ - aZ) * scale;
    const n = normalize([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
    if (n[2] < 0) { n[0] = -n[0]; n[1] = -n[1]; n[2] = -n[2]; } // treat as double-sided
    const lambert = Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
    const light = 0.35 + 0.65 * lambert;

    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(W - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const sx = px + 0.5, sy = py + 0.5;
        const w0 = ((bx - sx) * (cy - sy) - (by - sy) * (cx - sx)) / area;
        const w1 = ((cx - sx) * (ay - sy) - (cy - sy) * (ax - sx)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * aZ + w1 * bZ + w2 * cZ;
        const idx = py * W + px;
        if (z > zbuf[idx]!) {
          zbuf[idx] = z;
          shade[idx] = light;
        }
      }
    }
  }

  // Downsample with a box filter; coverage becomes alpha for smooth edges.
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0, cov = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const s = shade[(y * ss + dy) * W + x * ss + dx]!;
          if (s >= 0) { sum += s; cov++; }
        }
      }
      const o = (y * size + x) * 4;
      if (!cov) continue;
      const l = sum / cov;
      out[o] = Math.min(255, color[0] * l);
      out[o + 1] = Math.min(255, color[1] * l);
      out[o + 2] = Math.min(255, color[2] * l);
      out[o + 3] = Math.round((cov / (ss * ss)) * 255);
    }
  }
  return encodePng(size, size, out);
}

function normalize(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}
