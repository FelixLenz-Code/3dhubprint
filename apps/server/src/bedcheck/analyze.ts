import jpeg from 'jpeg-js';
import { encodePng } from '../slicer/png.js';

/**
 * Part of the camera image that shows the bed, as fractions of width/height: bounding box and,
 * if drawn with the lasso, its outline. Only what lies inside the outline is compared.
 */
export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  points?: [number, number][];
}

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Bed region scaled down to a small image with three channels (brightness and two color
 * differences), each centered and scaled by the brightness spread, so global lighting
 * changes cancel out. Color matters: a print can be as bright as the bed but a different hue.
 */
export interface Features {
  width: number;
  height: number;
  /** Channel-interleaved: Y, R−Y, B−Y per pixel. */
  px: Float32Array;
  /** 1 for pixels inside the outline. */
  mask: Uint8Array;
}

const CHANNELS = 3;

export interface Comparison {
  /** Per grid cell: how different it is from the best-matching reference (normalized units). */
  cells: Float32Array;
  cols: number;
  rows: number;
  /** Index of the best-matching reference. */
  reference: number;
}

export type BedVerdict = 'clear' | 'occupied' | 'uncertain';

const FEATURE_WIDTH = 160;
const GRID_COLS = 16;
const SHIFT = 2;

export function decodeJpeg(buf: Buffer): Rgba {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('Kamerabild ist kein JPEG');
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 });
  return { width: img.width, height: img.height, data: img.data };
}

/** Grayscale, box-downscaled crop of the region with zero mean and unit variance. */
export function extractFeatures(img: Rgba, r: Region): Features {
  const x0 = Math.floor(clamp01(r.x0) * img.width), x1 = Math.ceil(clamp01(r.x1) * img.width);
  const y0 = Math.floor(clamp01(r.y0) * img.height), y1 = Math.ceil(clamp01(r.y1) * img.height);
  const cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0);
  const width = Math.min(FEATURE_WIDTH, cw);
  const height = Math.max(1, Math.round((width * ch) / cw));
  const n = width * height;
  const px = new Float32Array(n * CHANNELS);
  const count = new Uint32Array(n);
  for (let y = y0; y < y1; y++) {
    const fy = Math.min(height - 1, Math.floor(((y - y0) * height) / ch));
    for (let x = x0; x < x1; x++) {
      const i = fy * width + Math.min(width - 1, Math.floor(((x - x0) * width) / cw));
      const o = (y * img.width + x) * 4;
      const r = img.data[o]!, g = img.data[o + 1]!, b = img.data[o + 2]!;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      px[i * CHANNELS]! += lum;
      px[i * CHANNELS + 1]! += r - lum;
      px[i * CHANNELS + 2]! += b - lum;
      count[i]!++;
    }
  }
  for (let i = 0; i < n; i++) for (let k = 0; k < CHANNELS; k++) px[i * CHANNELS + k]! /= Math.max(1, count[i]!);
  // Lighting is taken from the bed alone, not from what lies around the outline.
  const mask = gridMask(r, width, height);
  const inside = Math.max(1, mask.reduce((a, v) => a + v, 0));
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i++) if (mask[i]) for (let k = 0; k < CHANNELS; k++) mean[k]! += px[i * CHANNELS + k]! / inside;
  let variance = 0;
  for (let i = 0; i < n; i++) if (mask[i]) variance += (px[i * CHANNELS]! - mean[0]!) ** 2;
  // A floor keeps a uniformly lit, featureless bed from blowing up sensor noise.
  const std = Math.max(8, Math.sqrt(variance / inside));
  for (let i = 0; i < n; i++) for (let k = 0; k < CHANNELS; k++) px[i * CHANNELS + k] = (px[i * CHANNELS + k]! - mean[k]!) / std;
  return { width, height, px, mask };
}

/** Whether the point (fractions of the image) lies inside the outline (even-odd rule). */
export function insideOutline(pts: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!, [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** For a cols × rows grid laid over the bounding box: 1 where the cell center is inside the outline. */
export function gridMask(r: Region, cols: number, rows: number): Uint8Array {
  const mask = new Uint8Array(cols * rows).fill(1);
  if (!r.points) return mask;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const fx = r.x0 + ((x + 0.5) / cols) * (r.x1 - r.x0), fy = r.y0 + ((y + 0.5) / rows) * (r.y1 - r.y0);
      if (!insideOutline(r.points, fx, fy)) mask[y * cols + x] = 0;
    }
  }
  return mask;
}

/**
 * Compares the current bed with each reference (allowing the camera to shift by a pixel or
 * two) and keeps the best match. Returns the per-cell difference of that match.
 */
export function compare(current: Features, references: Features[]): Comparison | undefined {
  const { width: w, height: h } = current;
  const cols = Math.min(GRID_COLS, w);
  const rows = Math.max(1, Math.round((cols * h) / w));
  let best: Comparison | undefined;
  let bestTotal = Infinity;
  references.forEach((ref, reference) => {
    if (ref.width !== w || ref.height !== h) return;
    for (let dy = -SHIFT; dy <= SHIFT; dy++) {
      for (let dx = -SHIFT; dx <= SHIFT; dx++) {
        const cells = new Float32Array(cols * rows);
        const n = new Uint32Array(cols * rows);
        for (let y = SHIFT; y < h - SHIFT; y++) {
          const cy = Math.min(rows - 1, Math.floor((y * rows) / h));
          for (let x = SHIFT; x < w - SHIFT; x++) {
            if (!current.mask[y * w + x]) continue;
            const c = cy * cols + Math.min(cols - 1, Math.floor((x * cols) / w));
            const a = (y * w + x) * CHANNELS, b = ((y + dy) * w + x + dx) * CHANNELS;
            for (let k = 0; k < CHANNELS; k++) cells[c]! += Math.abs(current.px[a + k]! - ref.px[b + k]!);
            n[c]!++;
          }
        }
        // A cell cut by the outline counts once a third of it is bed; slivers are mostly noise.
        const full = ((w - 2 * SHIFT) * (h - 2 * SHIFT)) / (cols * rows);
        let total = 0;
        for (let i = 0; i < cells.length; i++) total += cells[i] = n[i]! >= full / 3 ? cells[i]! / n[i]! : 0;
        if (total < bestTotal) {
          bestTotal = total;
          best = { cells, cols, rows, reference };
        }
      }
    }
  });
  return best;
}

/** Cell difference above which a cell counts as changed, by sensitivity (1 = coarse … 5 = fine). */
export function cellThreshold(sensitivity: number): number {
  return [0.9, 0.65, 0.45, 0.35, 0.28][Math.min(5, Math.max(1, Math.round(sensitivity))) - 1]!;
}

/**
 * clear: no cell changed and none close to the threshold `t`. occupied: at least one cell
 * clearly changed. Anything in between is left to a human.
 */
export function verdict(cells: Float32Array, t: number): { verdict: BedVerdict; changed: number[]; maxDiff: number } {
  const changed: number[] = [];
  let maxDiff = 0;
  cells.forEach((v, i) => {
    maxDiff = Math.max(maxDiff, v);
    if (v > t) changed.push(i);
  });
  const result: BedVerdict = changed.length > 0 ? (maxDiff > t * 1.25 || changed.length > 1 ? 'occupied' : 'uncertain') : maxDiff > t * 0.8 ? 'uncertain' : 'clear';
  return { verdict: result, changed, maxDiff };
}

/** The camera image with the bed region outlined and changed cells marked, as PNG. */
export function renderOverlay(img: Rgba, r: Region, cmp: { cols: number; rows: number } | undefined, changed: number[], width = 640): Buffer {
  const scale = Math.min(1, width / img.width);
  const W = Math.round(img.width * scale), H = Math.round(img.height * scale);
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < W; x++) {
      const so = (sy * img.width + Math.min(img.width - 1, Math.floor(x / scale))) * 4;
      const o = (y * W + x) * 4;
      out[o] = img.data[so]!;
      out[o + 1] = img.data[so + 1]!;
      out[o + 2] = img.data[so + 2]!;
      out[o + 3] = 255;
    }
  }
  const rx0 = Math.round(clamp01(r.x0) * W), rx1 = Math.round(clamp01(r.x1) * W);
  const ry0 = Math.round(clamp01(r.y0) * H), ry1 = Math.round(clamp01(r.y1) * H);
  const tint = (x: number, y: number, c: [number, number, number], a: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    for (let k = 0; k < 3; k++) out[o + k] = Math.round(out[o + k]! * (1 - a) + c[k]! * a);
  };
  if (cmp) {
    const set = new Set(changed);
    for (let cy = 0; cy < cmp.rows; cy++) {
      for (let cx = 0; cx < cmp.cols; cx++) {
        if (!set.has(cy * cmp.cols + cx)) continue;
        const x0 = rx0 + Math.floor(((rx1 - rx0) * cx) / cmp.cols), x1 = rx0 + Math.floor(((rx1 - rx0) * (cx + 1)) / cmp.cols);
        const y0 = ry0 + Math.floor(((ry1 - ry0) * cy) / cmp.rows), y1 = ry0 + Math.floor(((ry1 - ry0) * (cy + 1)) / cmp.rows);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) tint(x, y, [239, 68, 68], 0.45);
      }
    }
  }
  const outline: [number, number][] = r.points ?? [
    [r.x0, r.y0],
    [r.x1, r.y0],
    [r.x1, r.y1],
    [r.x0, r.y1],
  ];
  // Dim what the check ignores, then draw the outline.
  if (r.points) {
    for (let y = ry0; y <= ry1; y++) {
      for (let x = rx0; x <= rx1; x++) if (!insideOutline(r.points, (x + 0.5) / W, (y + 0.5) / H)) tint(x, y, [0, 0, 0], 0.45);
    }
  }
  outline.forEach(([ax, ay], i) => {
    const [bx, by] = outline[(i + 1) % outline.length]!;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax) * W, Math.abs(by - ay) * H)));
    for (let k = 0; k <= steps; k++) {
      const x = Math.round((ax + ((bx - ax) * k) / steps) * W), y = Math.round((ay + ((by - ay) * k) / steps) * H);
      for (let d = 0; d < 4; d++) tint(x - 1 + (d & 1), y - 1 + (d >> 1), [34, 197, 94], 1);
    }
  });
  return encodePng(W, H, out);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
