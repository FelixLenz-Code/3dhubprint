import { describe, expect, it } from 'vitest';
import { gcodeFileName } from '../src/slicer/service.js';

describe('G-code file name', () => {
  it('rounds the print time to whole minutes before splitting hours', () => {
    expect(gcodeFileName(['Teil'], 1, 'PLA', 4 * 3600 + 59 * 60 + 40)).toBe('Teil_PLA_5h0m.gcode');
    expect(gcodeFileName(['Teil'], 1, 'PLA', 25 * 60 + 10)).toBe('Teil_PLA_25m.gcode');
  });
});
