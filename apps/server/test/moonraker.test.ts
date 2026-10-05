import { describe, expect, it } from 'vitest';
import { deriveStatus, toFileMetadata } from '../src/printers/moonraker.js';
import { webcamUrl } from '../src/printers/routes.js';

describe('deriveStatus', () => {
  it('returns only connection info when not connected', () => {
    expect(deriveStatus({ extruder: { temperature: 200 } }, { connection: 'offline' })).toEqual({ connection: 'offline' });
  });

  it('derives progress and ETA from file progress once past 5 %', () => {
    const s = deriveStatus(
      {
        print_stats: { state: 'printing', filename: 'a.gcode', print_duration: 600, info: { current_layer: 3, total_layer: 10 } },
        virtual_sdcard: { progress: 0.25 },
        extruder: { temperature: 210.2, target: 210, power: 0.4 },
        heater_bed: { temperature: 60, target: 60 },
        'temperature_sensor mcu_temp': { temperature: 41 },
      },
      { connection: 'connected', file: { filename: 'a.gcode', estimatedTime: 3000 } },
    );
    expect(s.printState).toBe('printing');
    expect(s.progress).toBe(0.25);
    expect(s.eta).toBe(1800); // 600 / 0.25 - 600
    expect(s.currentLayer).toBe(3);
    expect(s.extruder).toEqual({ temperature: 210.2, target: 210, power: 0.4 });
    expect(s.sensors).toEqual({ mcu_temp: { temperature: 41, target: 0 } });
  });

  it('falls back to the slicer estimate early in the print', () => {
    const s = deriveStatus(
      { print_stats: { state: 'printing', print_duration: 100 }, virtual_sdcard: { progress: 0.01 } },
      { connection: 'connected', file: { filename: 'a.gcode', estimatedTime: 1000 } },
    );
    expect(s.eta).toBe(900);
  });

  it('has no ETA when idle', () => {
    const s = deriveStatus({ print_stats: { state: 'standby', print_duration: 0 } }, { connection: 'connected' });
    expect(s.eta).toBeUndefined();
  });
});

describe('toFileMetadata', () => {
  it('picks the largest thumbnail relative to the file directory', () => {
    const m = toFileMetadata('sub/part.gcode', {
      estimated_time: 123,
      slicer: 'OrcaSlicer',
      slicer_version: '2.4.2',
      thumbnails: [
        { width: 32, relative_path: '.thumbs/part-32x32.png' },
        { width: 300, relative_path: '.thumbs/part-300x300.png' },
      ],
    });
    expect(m.thumbnailPath).toBe('sub/.thumbs/part-300x300.png');
    expect(m.slicer).toBe('OrcaSlicer 2.4.2');
    expect(m.estimatedTime).toBe(123);
  });
});

describe('webcamUrl', () => {
  it('resolves relative URLs against the web UI, not the Moonraker port', () => {
    expect(webcamUrl('http://192.168.1.112:7125', '/webcam/?action=stream')).toBe('http://192.168.1.112/webcam/?action=stream');
    expect(webcamUrl('http://192.168.1.112', '/webcam/?action=snapshot')).toBe('http://192.168.1.112/webcam/?action=snapshot');
  });
  it('keeps absolute URLs', () => {
    expect(webcamUrl('http://p', 'http://cam:8080/?action=stream')).toBe('http://cam:8080/?action=stream');
  });
});
