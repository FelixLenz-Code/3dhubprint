import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bedFromSettings, readToolpaths, renderPlatePreview } from '../src/slicer/gcodePreview.js';

const write = (text: string) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-')), 'a.gcode');
  fs.writeFileSync(f, text);
  return f;
};

describe('readToolpaths', () => {
  it('keeps only extrusion moves, in relative and absolute E mode', async () => {
    const f = write(
      ['G90', 'M83', 'G1 X0 Y0 F3000', 'G1 X10 Y0 E1', 'G1 X10 Y10', 'G1 E-0.5', 'M82', 'G92 E0', 'G1 X0 Y10 E2', 'G1 X0 Y0 E2', ''].join('\n'),
    );
    const s = await readToolpaths(f);
    // X0→X10 (relative E), X10→X0 at Y10 (absolute E increased); travel, retract and E=const are skipped.
    expect(s.count).toBe(2);
    expect(Array.from(s.pos.subarray(0, 6))).toEqual([0, 0, 0, 10, 0, 0]);
    expect(Array.from(s.pos.subarray(6, 12))).toEqual([10, 10, 0, 0, 10, 0]);
  });

  it('splits arcs into chords that end exactly at the target', async () => {
    const f = write(['G90', 'M83', 'G1 X10 Y0 Z0.2', 'G2 X-10 Y0 I-10 J0 E1', ''].join('\n'));
    const s = await readToolpaths(f);
    expect(s.count).toBeGreaterThan(10);
    const last = s.pos.subarray((s.count - 1) * 6, s.count * 6);
    expect(last[3]).toBeCloseTo(-10);
    expect(last[4]).toBeCloseTo(0);
    // Clockwise from (10,0) to (-10,0) around the origin passes through negative Y.
    const ys = Array.from({ length: s.count }, (_, k) => s.pos[k * 6 + 4]!);
    expect(Math.min(...ys)).toBeCloseTo(-10, 0);
  });

  it('renders PNGs and reads the bed from Orca settings', async () => {
    const f = write(['G90', 'M83', ';TYPE:Outer wall', 'G1 X100 Y100 Z0.2', 'G1 X120 Y100 E1', 'G1 X120 Y120 E1', ''].join('\n'));
    const bed = bedFromSettings({ printable_area: ['0x0', '220x0', '220x220', '0x220'], printable_height: '250' });
    expect(bed).toEqual({ bed: [[0, 0], [220, 0], [220, 220], [0, 220]], height: 250 });
    // Some vendor profiles keep the area as one string.
    expect(bedFromSettings({ printable_area: '0x0,300x0,300x300,0x300' }).bed).toEqual([[0, 0], [300, 0], [300, 300], [0, 300]]);
    const p = await renderPlatePreview(f, bed, [32]);
    expect(p.segments).toBe(2);
    for (const png of [p.top, p.iso, p.thumbnails.get(32)!]) expect(png.subarray(1, 4).toString()).toBe('PNG');
  });
});
