import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { encodePng } from './png.js';

/**
 * Renders the sliced plate from the actual G-code toolpaths: a top view of the whole bed
 * (shows how Orca arranged the parts, brim/skirt/supports included) and a 3D view of the
 * printed objects. Lines are colored by Orca's ;TYPE: feature like in the slicer.
 */

// Feature colors close to OrcaSlicer's preview, so they look familiar.
const FEATURES: [RegExp, [number, number, number]][] = [
  [/^outer wall/i, [255, 125, 56]],
  [/^inner wall/i, [255, 192, 77]],
  [/^overhang wall/i, [64, 128, 255]],
  [/^sparse infill/i, [176, 48, 41]],
  [/^internal solid infill/i, [150, 84, 204]],
  [/^top surface/i, [240, 90, 68]],
  [/^bottom surface/i, [102, 128, 245]],
  [/bridge/i, [77, 128, 186]],
  [/^gap infill/i, [255, 255, 255]],
  [/^(skirt|brim)/i, [0, 158, 128]],
  [/^support interface/i, [18, 120, 64]],
  [/^support/i, [100, 191, 77]],
  [/^ironing/i, [255, 140, 105]],
];
const DEFAULT_COLOR: [number, number, number] = [160, 160, 160];

export interface PlateGeometry {
  /** Bed polygon from the machine's printable_area, e.g. ["0x0","300x0","300x300","0x300"]. */
  bed: [number, number][];
  height: number;
}

export interface PlatePreview {
  top: Buffer;
  iso: Buffer;
  /** Square renders of the printed objects for G-code thumbnails, keyed by size. */
  thumbnails: Map<number, Buffer>;
  segments: number;
  /** Gzipped toolpaths for the browser's 3D viewer (see encodeToolpaths). */
  paths: Buffer;
}

interface Segments {
  /** x1,y1,z1,x2,y2,z2 per segment */
  pos: Float32Array;
  color: Uint8Array;
  count: number;
}

const MAX_SEGMENTS = 8_000_000;

/** Parses extrusion moves (G0/G1 and arcs G2/G3) into line segments. */
export async function readToolpaths(gcodePath: string): Promise<Segments> {
  let cap = 1 << 16;
  let pos = new Float32Array(cap * 6);
  let color = new Uint8Array(cap);
  let count = 0;
  const push = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, c: number) => {
    if (count >= MAX_SEGMENTS) return;
    if (count === cap) {
      cap *= 2;
      const p = new Float32Array(cap * 6);
      p.set(pos);
      pos = p;
      const c2 = new Uint8Array(cap);
      c2.set(color);
      color = c2;
    }
    const o = count * 6;
    pos[o] = x1;
    pos[o + 1] = y1;
    pos[o + 2] = z1;
    pos[o + 3] = x2;
    pos[o + 4] = y2;
    pos[o + 5] = z2;
    color[count++] = c;
  };

  let x = 0, y = 0, z = 0, e = 0;
  let absXYZ = true;
  let relE = false;
  let feature = 255; // unknown
  const handle = (line: string) => {
    const c0 = line.charCodeAt(0);
    // Fast path: only G/M commands and ;TYPE: comments matter (Orca writes them unindented).
    if (c0 !== 71 && c0 !== 77 && c0 !== 103 && c0 !== 109 && c0 !== 59) return;
    if (c0 === 59) {
      if (line.startsWith(';TYPE:')) {
        const name = line.slice(6);
        const idx = FEATURES.findIndex(([re]) => re.test(name));
        feature = idx < 0 ? 254 : idx;
        if (/^custom/i.test(name)) feature = 253; // start/end G-code (purge lines)
      }
      return;
    }
    // Tokenize once: "G1 X10 Y5.5 E.4" -> cmd + letter/value pairs (no regex per parameter).
    const semi = line.indexOf(';');
    const tokens = (semi >= 0 ? line.slice(0, semi) : line).trimEnd().split(' ');
    const cmd = tokens[0]!.toUpperCase();
    if (cmd !== 'G0' && cmd !== 'G1' && cmd !== 'G2' && cmd !== 'G3' && cmd !== 'G90' && cmd !== 'G91' && cmd !== 'M82' && cmd !== 'M83' && cmd !== 'G92') return;
    let px: number | undefined, py: number | undefined, pz: number | undefined, pe: number | undefined, pi = 0, pj = 0;
    for (let t = 1; t < tokens.length; t++) {
      const tok = tokens[t]!;
      if (!tok) return;
      const v = Number(tok.slice(1));
      if (!Number.isFinite(v)) return;
      switch (tok.charCodeAt(0) | 32) {
        case 120: px = v; break; // x
        case 121: py = v; break; // y
        case 122: pz = v; break; // z
        case 101: pe = v; break; // e
        case 105: pi = v; break; // i
        case 106: pj = v; break; // j
      }
    }
    if (cmd === 'G90') absXYZ = true;
    else if (cmd === 'G91') absXYZ = false;
    else if (cmd === 'M82') relE = false;
    else if (cmd === 'M83') relE = true;
    else if (cmd === 'G92') {
      if (pe !== undefined) e = pe;
    } else {
      const nx = coord(px, x, absXYZ);
      const ny = coord(py, y, absXYZ);
      const nz = coord(pz, z, absXYZ);
      let extruding = false;
      if (pe !== undefined) {
        const ne = relE ? e + pe : pe;
        extruding = ne - e > 1e-6;
        e = ne;
      }
      if (extruding && cmd !== 'G0') {
        if (cmd === 'G1') push(x, y, z, nx, ny, nz, feature);
        else arc(x, y, nx, ny, pi, pj, cmd === 'G2', (ax, ay, bx, by) => push(ax, ay, z, bx, by, nz, feature));
      }
      x = nx;
      y = ny;
      z = nz;
    }
  };

  // Lines are handled synchronously per 1 MB chunk; awaiting per line is far too slow.
  let rest = '';
  for await (const chunk of fs.createReadStream(gcodePath, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
    const text = rest + (chunk as string);
    let from = 0;
    for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n', from)) {
      handle(text.slice(from, nl));
      from = nl + 1;
    }
    rest = text.slice(from);
  }
  if (rest) handle(rest);
  return { pos, color, count };
}

const coord = (v: number | undefined, cur: number, abs: boolean) => (v === undefined ? cur : abs ? v : cur + v);

/** Splits a G2 (clockwise) / G3 arc into short chords. */
function arc(x0: number, y0: number, x1: number, y1: number, i: number, j: number, cw: boolean, out: (ax: number, ay: number, bx: number, by: number) => void) {
  const cx = x0 + i, cy = y0 + j;
  const r = Math.hypot(i, j);
  let a0 = Math.atan2(y0 - cy, x0 - cx);
  let a1 = Math.atan2(y1 - cy, x1 - cx);
  if (cw && a1 >= a0) a1 -= 2 * Math.PI;
  if (!cw && a1 <= a0) a1 += 2 * Math.PI;
  const steps = Math.max(2, Math.min(64, Math.ceil((Math.abs(a1 - a0) * r) / 1)));
  let px = x0, py = y0;
  for (let s = 1; s <= steps; s++) {
    const a = a0 + ((a1 - a0) * s) / steps;
    const nx = s === steps ? x1 : cx + r * Math.cos(a);
    const ny = s === steps ? y1 : cy + r * Math.sin(a);
    out(px, py, nx, ny);
    px = nx;
    py = ny;
  }
}

function colorOf(c: number): [number, number, number] {
  if (c < FEATURES.length) return FEATURES[c]![1];
  if (c === 253) return [110, 110, 110];
  return DEFAULT_COLOR;
}

/** Z-buffered canvas with supersampling; downsampled to RGBA on export. */
class Canvas {
  readonly rgb: Float32Array;
  readonly depth: Float32Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.rgb = new Float32Array(w * h * 3);
    this.depth = new Float32Array(w * h).fill(-Infinity);
  }

  /** Thick line with per-pixel depth test. */
  line(x0: number, y0: number, d0: number, x1: number, y1: number, d1: number, width: number, r: number, g: number, b: number) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const half = Math.max(0.5, width / 2);
    // Stamp spacing of about half the line width keeps the line solid with far fewer stamps.
    const steps = Math.max(1, Math.ceil(len / Math.max(0.7, half * 0.8)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = x0 + (x1 - x0) * t;
      const cy = y0 + (y1 - y0) * t;
      const d = d0 + (d1 - d0) * t;
      const xa = Math.max(0, Math.floor(cx - half)), xb = Math.min(this.w - 1, Math.floor(cx + half));
      const ya = Math.max(0, Math.floor(cy - half)), yb = Math.min(this.h - 1, Math.floor(cy + half));
      for (let py = ya; py <= yb; py++) {
        for (let px = xa; px <= xb; px++) {
          const i = py * this.w + px;
          if (d >= this.depth[i]!) {
            this.depth[i] = d;
            this.rgb[i * 3] = r;
            this.rgb[i * 3 + 1] = g;
            this.rgb[i * 3 + 2] = b;
          }
        }
      }
    }
  }

  fill(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, depth = -1e9) {
    for (let py = Math.max(0, Math.floor(y0)); py < Math.min(this.h, Math.ceil(y1)); py++) {
      for (let px = Math.max(0, Math.floor(x0)); px < Math.min(this.w, Math.ceil(x1)); px++) {
        const i = py * this.w + px;
        this.depth[i] = depth;
        this.rgb[i * 3] = r;
        this.rgb[i * 3 + 1] = g;
        this.rgb[i * 3 + 2] = b;
      }
    }
  }

  /** Area-resamples the whole canvas to size×size (for thumbnails of any size). */
  toPngSized(size: number): Buffer {
    const out = new Uint8Array(size * size * 4);
    const fx = this.w / size, fy = this.h / size;
    for (let y = 0; y < size; y++) {
      const ya = Math.floor(y * fy), yb = Math.max(ya + 1, Math.floor((y + 1) * fy));
      for (let x = 0; x < size; x++) {
        const xa = Math.floor(x * fx), xb = Math.max(xa + 1, Math.floor((x + 1) * fx));
        let r = 0, g = 0, b = 0, n = 0, total = 0;
        for (let py = ya; py < yb; py++) {
          for (let px = xa; px < xb; px++) {
            total++;
            const i = py * this.w + px;
            if (this.depth[i] === -Infinity) continue;
            r += this.rgb[i * 3]!;
            g += this.rgb[i * 3 + 1]!;
            b += this.rgb[i * 3 + 2]!;
            n++;
          }
        }
        if (!n) continue;
        const o = (y * size + x) * 4;
        out[o] = r / n;
        out[o + 1] = g / n;
        out[o + 2] = b / n;
        out[o + 3] = Math.round((n / total) * 255);
      }
    }
    return encodePng(size, size, out);
  }

  /** Downsamples by `ss` (box filter); empty pixels become transparent. */
  toPng(ss: number, crop?: { x: number; y: number; w: number; h: number }): Buffer {
    const c = crop ?? { x: 0, y: 0, w: this.w, h: this.h };
    const W = Math.floor(c.w / ss), H = Math.floor(c.h / ss);
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = 0; dy < ss; dy++) {
          for (let dx = 0; dx < ss; dx++) {
            const i = (c.y + y * ss + dy) * this.w + c.x + x * ss + dx;
            if (this.depth[i] === -Infinity) continue;
            r += this.rgb[i * 3]!;
            g += this.rgb[i * 3 + 1]!;
            b += this.rgb[i * 3 + 2]!;
            n++;
          }
        }
        if (!n) continue;
        const o = (y * W + x) * 4;
        out[o] = r / n;
        out[o + 1] = g / n;
        out[o + 2] = b / n;
        out[o + 3] = Math.round((n / (ss * ss)) * 255);
      }
    }
    return encodePng(W, H, out);
  }
}

/** Brightness by height, so stacked layers stay readable in a flat view. */
const shadeByZ = (z: number, zMax: number) => 0.55 + 0.45 * (zMax > 0 ? Math.min(1, z / zMax) : 1);

export async function renderPlatePreview(gcodePath: string, plate: PlateGeometry, thumbSizes: number[] = []): Promise<PlatePreview> {
  const seg = await readToolpaths(gcodePath);
  const { pos, color, count } = seg;

  let zMax = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let k = 0; k < count; k++) {
    if (color[k] === 253) continue; // purge lines don't define the object bounds
    const o = k * 6;
    zMax = Math.max(zMax, pos[o + 2]!, pos[o + 5]!);
    minX = Math.min(minX, pos[o]!, pos[o + 3]!);
    maxX = Math.max(maxX, pos[o]!, pos[o + 3]!);
    minY = Math.min(minY, pos[o + 1]!, pos[o + 4]!);
    maxY = Math.max(maxY, pos[o + 1]!, pos[o + 4]!);
  }

  const iso = renderIso(seg, zMax, { minX, maxX, minY, maxY }, 800, 2);
  return {
    top: renderTop(seg, plate, zMax),
    iso: iso.toPng(2),
    // Thumbnails are resampled from the 3D view instead of rendered again.
    thumbnails: new Map(thumbSizes.map((s) => [s, iso.toPngSized(s)])),
    segments: count,
    paths: gzipSync(encodeToolpaths(seg), { level: 6 }),
  };
}

/** Coordinates are stored as Int16 in steps of this many mm (±655 mm). */
const PATH_UNIT = 0.02;

/**
 * Compact toolpaths for the interactive viewer. Consecutive collinear segments (also the
 * many short chords of arcs) are merged. Little-endian layout:
 *   u32 segments, u32 layers, f32 unit, u32 palette size K
 *   K × (r, g, b, 0) colors, palette index K-1 = other
 *   u32[layers] first segment of each layer
 *   i16[segments × 6] x1 y1 z1 x2 y2 z2 (× unit)
 *   u8[segments] palette index
 */
export function encodeToolpaths(seg: Segments): Buffer {
  const { pos, color, count } = seg;
  const out: number[] = [];
  const feat: number[] = [];
  const layers: number[] = [];
  let layerZ = -Infinity;
  const K = FEATURES.length + 2; // + purge lines + other
  const paletteIdx = (c: number) => (c < FEATURES.length ? c : c === 253 ? FEATURES.length : FEATURES.length + 1);

  let run: { x1: number; y1: number; z: number; x2: number; y2: number; f: number } | null = null;
  const flush = () => {
    if (!run) return;
    if (run.z > layerZ + 0.04) {
      layers.push(feat.length);
      layerZ = run.z;
    }
    out.push(run.x1, run.y1, run.z, run.x2, run.y2, run.z);
    feat.push(paletteIdx(run.f));
    run = null;
  };
  for (let k = 0; k < count; k++) {
    const o = k * 6;
    const [x1, y1, z1, x2, y2, z2] = [pos[o]!, pos[o + 1]!, pos[o + 2]!, pos[o + 3]!, pos[o + 4]!, pos[o + 5]!];
    const f = color[k]!;
    if (run && f === run.f && Math.abs(z1 - run.z) < 1e-4 && Math.abs(z2 - run.z) < 1e-4 && Math.abs(x1 - run.x2) < 1e-3 && Math.abs(y1 - run.y2) < 1e-3) {
      const ax = run.x2 - run.x1, ay = run.y2 - run.y1;
      const bx = x2 - x1, by = y2 - y1;
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la > 0 && lb > 0 && (ax * bx + ay * by) / (la * lb) > 0.9995) {
        run.x2 = x2;
        run.y2 = y2;
        continue;
      }
    }
    flush();
    run = { x1, y1, z: Math.max(z1, z2), x2, y2, f };
  }
  flush();

  const n = feat.length;
  const head = 16 + K * 4 + layers.length * 4;
  const buf = Buffer.alloc(head + n * 12 + n);
  buf.writeUInt32LE(n, 0);
  buf.writeUInt32LE(layers.length, 4);
  buf.writeFloatLE(PATH_UNIT, 8);
  buf.writeUInt32LE(K, 12);
  for (let i = 0; i < K; i++) {
    const [r, g, b] = i < FEATURES.length ? FEATURES[i]![1] : i === FEATURES.length ? [110, 110, 110] : DEFAULT_COLOR;
    buf.writeUInt8(r, 16 + i * 4);
    buf.writeUInt8(g, 17 + i * 4);
    buf.writeUInt8(b, 18 + i * 4);
  }
  layers.forEach((l, i) => buf.writeUInt32LE(l, 16 + K * 4 + i * 4));
  const clamp = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v / PATH_UNIT)));
  for (let i = 0; i < out.length; i++) buf.writeInt16LE(clamp(out[i]!), head + i * 2);
  for (let i = 0; i < n; i++) buf.writeUInt8(feat[i]!, head + n * 12 + i);
  return buf;
}

/** Whole bed seen from above, with grid; parts colored by feature, brighter = higher. */
function renderTop(seg: Segments, plate: PlateGeometry, zMax: number): Buffer {
  const SS = 2;
  const SIZE = 800;
  const bx = plate.bed.map((p) => p[0]), by = plate.bed.map((p) => p[1]);
  const bedMinX = Math.min(...bx), bedMaxX = Math.max(...bx), bedMinY = Math.min(...by), bedMaxY = Math.max(...by);
  const bedW = bedMaxX - bedMinX || 1, bedH = bedMaxY - bedMinY || 1;
  const scale = ((SIZE - 20) * SS) / Math.max(bedW, bedH);
  const W = Math.ceil(bedW * scale + 20 * SS), H = Math.ceil(bedH * scale + 20 * SS);
  const ox = 10 * SS - bedMinX * scale, oy = 10 * SS + bedMaxY * scale; // y up on the bed, down in the image
  const c = new Canvas(W, H);
  const tx = (x: number) => ox + x * scale;
  const ty = (y: number) => oy - y * scale;

  c.fill(tx(bedMinX), ty(bedMaxY), tx(bedMaxX), ty(bedMinY), 44, 44, 42);
  for (let g = Math.ceil(bedMinX / 50) * 50; g <= bedMaxX; g += 50) c.fill(tx(g) - 1, ty(bedMaxY), tx(g) + 1, ty(bedMinY), 64, 64, 61);
  for (let g = Math.ceil(bedMinY / 50) * 50; g <= bedMaxY; g += 50) c.fill(tx(bedMinX), ty(g) - 1, tx(bedMaxX), ty(g) + 1, 64, 64, 61);

  const width = Math.max(1.5, 0.45 * scale);
  for (let k = 0; k < seg.count; k++) {
    const o = k * 6;
    const z = Math.max(seg.pos[o + 2]!, seg.pos[o + 5]!);
    const [r, g, b] = colorOf(seg.color[k]!);
    const l = seg.color[k] === 253 ? 0.8 : shadeByZ(z, zMax);
    c.line(tx(seg.pos[o]!), ty(seg.pos[o + 1]!), z, tx(seg.pos[o + 3]!), ty(seg.pos[o + 4]!), z, width, r * l, g * l, b * l);
  }
  return c.toPng(SS);
}

/** 3D view of the printed objects (purge lines excluded), fitted to their bounds. */
function renderIso(seg: Segments, zMax: number, b: { minX: number; maxX: number; minY: number; maxY: number }, size: number, SS: number): Canvas {
  if (!Number.isFinite(b.minX)) return new Canvas(size * SS, size * SS);
  const W = size * SS;
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2, cz = zMax / 2;
  const az = (-35 * Math.PI) / 180, el = (35 * Math.PI) / 180;
  const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
  const project = (x: number, y: number, z: number): [number, number, number] => {
    const X = x - cx, Y = y - cy, Z = z - cz;
    const xr = X * ca - Y * sa;
    const yr = X * sa + Y * ca;
    return [xr, -(Z * ce - yr * se), yr * ce + Z * se];
  };
  // Fit the projected bounding box of the objects.
  let pMinX = Infinity, pMaxX = -Infinity, pMinY = Infinity, pMaxY = -Infinity;
  for (const x of [b.minX, b.maxX]) for (const y of [b.minY, b.maxY]) for (const z of [0, zMax]) {
    const [px, py] = project(x, y, z);
    pMinX = Math.min(pMinX, px); pMaxX = Math.max(pMaxX, px); pMinY = Math.min(pMinY, py); pMaxY = Math.max(pMaxY, py);
  }
  const scale = (W * 0.9) / Math.max(pMaxX - pMinX, pMaxY - pMinY, 1);
  const ox = W / 2 - ((pMinX + pMaxX) / 2) * scale, oy = W / 2 - ((pMinY + pMaxY) / 2) * scale;
  const c = new Canvas(W, W);
  const width = Math.min(8, Math.max(1, 0.5 * scale));
  for (let k = 0; k < seg.count; k++) {
    if (seg.color[k] === 253) continue;
    const o = k * 6;
    const a = project(seg.pos[o]!, seg.pos[o + 1]!, seg.pos[o + 2]!);
    const d = project(seg.pos[o + 3]!, seg.pos[o + 4]!, seg.pos[o + 5]!);
    const [r, g, bl] = colorOf(seg.color[k]!);
    const l = 0.5 + 0.5 * shadeByZ(seg.pos[o + 2]!, zMax);
    c.line(ox + a[0] * scale, oy + a[1] * scale, a[2], ox + d[0] * scale, oy + d[1] * scale, d[2], width, r * l, g * l, bl * l);
  }
  return c;
}

/** Bed polygon from Orca's printable_area. */
export function bedFromSettings(machine: Record<string, unknown>): PlateGeometry {
  const area = Array.isArray(machine.printable_area) ? (machine.printable_area as string[]) : [];
  const bed = area.map((p) => p.split('x').map(Number) as [number, number]).filter((p) => p.every(Number.isFinite));
  const height = Number(Array.isArray(machine.printable_height) ? machine.printable_height[0] : machine.printable_height);
  return { bed: bed.length >= 3 ? bed : [[0, 0], [220, 0], [220, 220], [0, 220]], height: Number.isFinite(height) ? height : 250 };
}

/**
 * Renders in a worker thread (CPU-heavy for large files). Falls back to the current thread
 * if workers are unavailable, e.g. under the test runner.
 */
export async function renderPlatePreviewOffThread(gcodePath: string, plate: PlateGeometry, thumbSizes: number[]): Promise<PlatePreview> {
  const { Worker } = await import('node:worker_threads');
  const file = new URL(import.meta.url.endsWith('.ts') ? './previewWorker.ts' : './previewWorker.mjs', import.meta.url);
  try {
    return await new Promise<PlatePreview>((resolve, reject) => {
      const w = new Worker(file, { workerData: { gcodePath, plate, sizes: thumbSizes } });
      w.once('message', (m: { ok: boolean; error?: string; top: Uint8Array; iso: Uint8Array; thumbnails: [number, Uint8Array][]; segments: number; paths: Uint8Array }) => {
        void w.terminate();
        if (!m.ok) return reject(new Error(m.error));
        resolve({
          top: Buffer.from(m.top),
          iso: Buffer.from(m.iso),
          thumbnails: new Map(m.thumbnails.map(([s, b]) => [s, Buffer.from(b)])),
          segments: m.segments,
          paths: Buffer.from(m.paths),
        });
      });
      w.once('error', reject);
    });
  } catch {
    return renderPlatePreview(gcodePath, plate, thumbSizes);
  }
}
