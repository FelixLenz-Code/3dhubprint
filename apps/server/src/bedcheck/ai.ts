import fs from 'node:fs';
import path from 'node:path';
import type { InferenceSession } from 'onnxruntime-node';
import type { Region, Rgba } from './analyze.js';

/**
 * Learned bed check: a pretrained vision model (DINOv2-small) describes every 14×14 patch of
 * the bed region as a feature vector. A patch of the current image counts as unusual when no
 * patch near the same spot in any image of the empty bed looks like it (few-shot anomaly
 * detection, as in AnomalyDINO). The features describe texture and shape rather than raw
 * brightness, so reflections and differently colored plates throw it off far less than a
 * pixel comparison.
 */

const PATCH = 14;
/** Patches along the longer side of the bed region. */
const GRID_LONG = 32;
/** How far (in patches) a match may lie from the same spot: camera shake, bed position. */
const NEIGHBORHOOD = 1;
/** Only the empty-bed images that match best overall count, so another plate can't hide a part. */
const BEST_REFERENCES = 3;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export interface PatchFeatures {
  cols: number;
  rows: number;
  dim: number;
  /** cols × rows unit vectors, row-major. */
  vecs: Float32Array;
}

export interface AiComparison {
  cols: number;
  rows: number;
  /** Per patch: 1 − cosine similarity to the best match among the chosen references. */
  cells: Float32Array;
  /** Indices of the references the comparison used, best first. */
  references: number[];
}

let session: Promise<InferenceSession> | undefined;
let sessionPath: string | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** Where the model file lives: BEDCHECK_MODEL, else models/ in the working directory (`pnpm model` puts it there). */
export function modelPath(): string {
  return process.env.BEDCHECK_MODEL || path.resolve('models/dinov2-small.onnx');
}

export function modelAvailable(): boolean {
  return fs.existsSync(modelPath());
}

async function model(): Promise<InferenceSession> {
  const p = modelPath();
  if (!session || sessionPath !== p) {
    sessionPath = p;
    session = (async () => {
      const ort = await import('onnxruntime-node');
      return ort.InferenceSession.create(p, { intraOpNumThreads: 2, graphOptimizationLevel: 'all' });
    })();
    session.catch(() => (session = undefined));
  }
  return session;
}

/** Patch features of the bed region (bilinear crop and resize, then the model). */
export async function embed(img: Rgba, r: Region): Promise<PatchFeatures> {
  const x0 = clamp01(r.x0) * img.width, x1 = clamp01(r.x1) * img.width;
  const y0 = clamp01(r.y0) * img.height, y1 = clamp01(r.y1) * img.height;
  const cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0);
  const cols = cw >= ch ? GRID_LONG : Math.max(1, Math.round((GRID_LONG * cw) / ch));
  const rows = cw >= ch ? Math.max(1, Math.round((GRID_LONG * ch) / cw)) : GRID_LONG;
  const W = cols * PATCH, H = rows * PATCH;
  const input = new Float32Array(3 * W * H);
  // Several bilinear samples per output pixel when shrinking, so a big camera image doesn't alias.
  const sub = Math.max(1, Math.ceil(Math.max(cw / W, ch / H)));
  const at = (sy: number, sx: number, k: number) => {
    sy = Math.min(img.height - 1, Math.max(0, sy - 0.5));
    sx = Math.min(img.width - 1, Math.max(0, sx - 0.5));
    const ya = Math.floor(sy), yb = Math.min(img.height - 1, ya + 1), fy = sy - ya;
    const xa = Math.floor(sx), xb = Math.min(img.width - 1, xa + 1), fx = sx - xa;
    const p = (yy: number, xx: number) => img.data[(yy * img.width + xx) * 4 + k]!;
    return (p(ya, xa) * (1 - fx) + p(ya, xb) * fx) * (1 - fy) + (p(yb, xa) * (1 - fx) + p(yb, xb) * fx) * fy;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let k = 0; k < 3; k++) {
        let v = 0;
        for (let j = 0; j < sub; j++) for (let i = 0; i < sub; i++) v += at(y0 + ((y + (j + 0.5) / sub) * ch) / H, x0 + ((x + (i + 0.5) / sub) * cw) / W, k);
        input[k * W * H + y * W + x] = (v / (sub * sub) / 255 - MEAN[k]!) / STD[k]!;
      }
    }
  }
  const ort = await import('onnxruntime-node');
  const s = await model();
  // One inference at a time: each already uses several cores.
  const job = queue.then(() => s.run({ [s.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, H, W]) }));
  queue = job.catch(() => undefined);
  const out = await job;
  const t = out[s.outputNames[0]!]!;
  const [, tokens, dim] = t.dims as number[];
  const data = t.data as Float32Array;
  const n = cols * rows;
  // Token 0 is the class token; any register tokens sit between it and the patches.
  const first = tokens! - n;
  const vecs = new Float32Array(n * dim!);
  for (let i = 0; i < n; i++) {
    let norm = 0;
    for (let d = 0; d < dim!; d++) norm += data[(first + i) * dim! + d]! ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim!; d++) vecs[i * dim! + d] = data[(first + i) * dim! + d]! / norm;
  }
  return { cols, rows, dim: dim!, vecs };
}

/** For each patch of `cur`, the distance to the closest nearby patch of `ref`. */
function distances(cur: PatchFeatures, ref: PatchFeatures): Float32Array {
  const { cols, rows, dim } = cur;
  const out = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const a = (y * cols + x) * dim;
      let best = -1;
      for (let dy = -NEIGHBORHOOD; dy <= NEIGHBORHOOD; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= rows) continue;
        for (let dx = -NEIGHBORHOOD; dx <= NEIGHBORHOOD; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= cols) continue;
          const b = (yy * cols + xx) * dim;
          let dot = 0;
          for (let d = 0; d < dim; d++) dot += cur.vecs[a + d]! * ref.vecs[b + d]!;
          if (dot > best) best = dot;
        }
      }
      out[y * cols + x] = 1 - best;
    }
  }
  return out;
}

/**
 * Compares the current bed with the empty-bed images. The references that match best overall
 * (typically the same plate) are kept, and each patch takes its closest match among them.
 */
export function compareAi(cur: PatchFeatures, refs: PatchFeatures[]): AiComparison | undefined {
  const scored: { i: number; d: Float32Array; mean: number }[] = [];
  refs.forEach((ref, i) => {
    if (ref.cols !== cur.cols || ref.rows !== cur.rows || ref.dim !== cur.dim) return;
    const d = distances(cur, ref);
    // A robust overall score: the mean of the better 80 %, so a part on the bed doesn't decide which plate it is.
    const sorted = Float32Array.from(d).sort();
    const keep = Math.max(1, Math.floor(sorted.length * 0.8));
    let sum = 0;
    for (let k = 0; k < keep; k++) sum += sorted[k]!;
    scored.push({ i, d, mean: sum / keep });
  });
  if (!scored.length) return undefined;
  scored.sort((a, b) => a.mean - b.mean);
  const chosen = scored.slice(0, BEST_REFERENCES);
  const cells = Float32Array.from(chosen[0]!.d);
  for (const c of chosen.slice(1)) for (let k = 0; k < cells.length; k++) cells[k] = Math.min(cells[k]!, c.d[k]!);
  return { cols: cur.cols, rows: cur.rows, cells, references: chosen.map((c) => c.i) };
}

/** Patch distance above which a patch counts as changed, by sensitivity (1 = coarse … 5 = fine). */
export function aiThreshold(sensitivity: number): number {
  return [0.55, 0.47, 0.4, 0.34, 0.29][Math.min(5, Math.max(1, Math.round(sensitivity))) - 1]!;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
