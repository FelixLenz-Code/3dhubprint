import { describe, expect, it } from 'vitest';
import { aiThreshold, compareAi, embed, modelAvailable } from '../src/bedcheck/ai.js';
import { gridMask, verdict, type Region, type Rgba } from '../src/bedcheck/analyze.js';

// Needs the model (`pnpm model`); the Docker image ships it.
const region = { x0: 0.05, y0: 0.5, x1: 0.95, y1: 0.95 };

/** A wall above a plate with fine texture; plate color, light, a glare spot and a part are adjustable. */
function scene(o: { plate?: [number, number, number]; light?: number; glare?: boolean; part?: [number, number, number]; seed?: number } = {}): Rgba {
  const w = 320, h = 240;
  const data = new Uint8Array(w * h * 4);
  const plate = o.plate ?? [45, 50, 60];
  let r = o.seed ?? 1;
  const noise = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) % 7) - 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      let c: number[] = y < 110 ? [190, 180, 160] : plate.map((v) => v + ((x * 5 + y * 3) % 6));
      if (o.glare && y >= 110) c = c.map((v) => v + 90 * Math.exp(-(((x - 200) / 45) ** 2 + ((y - 170) / 15) ** 2)));
      if (o.part && x >= 140 && x < 165 && y >= 165 && y < 190) c = y < 172 ? o.part.map((v) => v + 40) : o.part;
      for (let k = 0; k < 3; k++) data[p + k] = Math.max(0, Math.min(255, Math.round(c[k]! * (o.light ?? 1) + noise())));
      data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

describe.skipIf(!modelAvailable())('AI bed check', () => {
  const check = async (img: Rgba, refs: Rgba[], r: Region = region) => {
    const cur = await embed(img, r);
    const cmp = compareAi(cur, await Promise.all(refs.map((ref) => embed(ref, r))), gridMask(r, cur.cols, cur.rows));
    return verdict(cmp!.cells, aiThreshold(3)).verdict;
  };

  it('ignores a part outside the lasso outline', async () => {
    // Left part of the bed only; the part sits at x ≈ 0.44–0.52.
    const lasso: Region = { ...region, points: [[0.05, 0.5], [0.35, 0.5], [0.35, 0.95], [0.05, 0.95]] };
    const refs = [scene({ seed: 1 }), scene({ seed: 2 })];
    expect(await check(scene({ seed: 3, part: [200, 60, 40] }), refs, lasso)).toBe('clear');
    expect(await check(scene({ seed: 3, part: [200, 60, 40] }), refs)).toBe('occupied');
  }, 30_000);

  it('ignores light changes but sees a part, also one in the color of the plate', async () => {
    const refs = [scene({ seed: 1 }), scene({ seed: 2 })];
    expect(await check(scene({ seed: 3, light: 1.3 }), refs)).toBe('clear');
    expect(await check(scene({ seed: 3, light: 0.75 }), refs)).toBe('clear');
    expect(await check(scene({ seed: 3, part: [200, 60, 40] }), refs)).toBe('occupied');
    expect(await check(scene({ seed: 3, part: [55, 60, 70] }), refs)).toBe('occupied');
  }, 30_000);

  it('compares with the matching plate, so another plate neither looks occupied nor hides a part', async () => {
    const dark = scene({ seed: 1 });
    const gold = scene({ seed: 2, plate: [150, 120, 50], glare: true });
    expect(await check(scene({ seed: 3, plate: [150, 120, 50], glare: true }), [dark, gold])).toBe('clear');
    expect(await check(scene({ seed: 3, plate: [150, 120, 50], glare: true, part: [45, 50, 60] }), [dark, gold])).toBe('occupied');
  }, 30_000);
});
