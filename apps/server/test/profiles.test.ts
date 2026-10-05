import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { SystemProfiles, cliProfiles, detectKind, readUpload, resolvePreset, summarize, ProfileError } from '../src/slicer/profiles.js';

const FIX = path.resolve(import.meta.dirname, '../../../fixtures/orca-2.4.2');
const system = new SystemProfiles(path.join(FIX, 'system'));
const user = (p: string) => JSON.parse(fs.readFileSync(path.join(FIX, 'user', p), 'utf8'));

describe('SystemProfiles', () => {
  it('indexes vendor catalogs', () => {
    expect(system.count).toBeGreaterThan(500);
    expect(system.get('machine', 'Creality Ender-3 S1 Plus 0.4 nozzle')?.data.printable_height).toBe('300');
    expect(system.get('filament', 'Generic PLA @System')?.vendor).toBe('OrcaFilamentLibrary');
  });
});

describe('resolvePreset', () => {
  it('flattens a machine preset and finds its system printer', () => {
    const r = resolvePreset('machine', user('ender3s1plus/machine/Tuned (Claude) - Ender-3 S1 Plus 0.4.json'), system);
    expect(r.systemPrinter).toBe('Creality Ender-3 S1 Plus 0.4 nozzle');
    expect(r.settings.type).toBe('machine');
    expect(r.settings.inherits).toBeUndefined();
    // inherited from fdm_machine_common / fdm_creality_common
    expect(r.settings.printable_area).toEqual(['0x0', '300x0', '300x300', '0x300']);
    // own override wins
    expect(r.settings.machine_max_acceleration_x).toEqual(['2000', '2000']);
    expect(summarize('machine', r.settings)).toMatchObject({ nozzle: 0.4, bedX: 300, bedY: 300, height: 300 });
  });

  it('strips printer addresses and API keys', () => {
    const data = { ...user('k1/machine/Creality K1 (0.4 nozzle) - Copy.json'), print_host: '10.0.0.5', printhost_apikey: 'secret' };
    const r = resolvePreset('machine', data, system);
    expect(Object.keys(r.settings).filter((k) => /^(print_host|printhost_)/.test(k))).toEqual([]);
    expect(JSON.stringify(r.settings)).not.toContain('secret');
  });

  it('resolves filaments against the shared library and other uploaded presets', () => {
    const tpu = resolvePreset('filament', user('ender3s1plus/filament/Tuned (Claude) - TPU.json'), system);
    expect(summarize('filament', tpu.settings).material).toBe('TPU');
    const child = { name: 'Mein PLA', inherits: 'Tuned (Claude) - PLA', from: 'User', nozzle_temperature: ['215'], filament_settings_id: ['Mein PLA'] };
    const siblings = new Map([['filament:Tuned (Claude) - PLA', user('ender3s1plus/filament/Tuned (Claude) - PLA.json')]]);
    const r = resolvePreset('filament', child, system, siblings);
    expect(r.settings.nozzle_temperature).toEqual(['215']);
    expect(summarize('filament', r.settings).material).toBe('PLA');
  });

  it('reports a missing parent clearly', () => {
    expect(() => resolvePreset('process', { name: 'X', inherits: 'gibt es nicht', print_settings_id: 'X' }, system)).toThrow(ProfileError);
  });
});

describe('detectKind / readUpload / cliProfiles', () => {
  it('detects kinds from the *_settings_id keys', () => {
    expect(detectKind(user('k1/process/0.20mm Standard @Creality K1 (0.4 nozzle) - Copy.json'))).toBe('process');
    expect(detectKind(user('k1/filament/Generic PLA K1.json'))).toBe('filament');
  });

  it('reads Orca bundles (zip) and ignores the bundle manifest', () => {
    const zip = zipSync({
      'bundle_structure.json': strToU8('{}'),
      'printer/a.json': strToU8(JSON.stringify({ name: 'a', printer_settings_id: 'a' })),
      'filament/b.json': strToU8(JSON.stringify({ name: 'b', filament_settings_id: ['b'] })),
    });
    const presets = readUpload('set.orca_printer', Buffer.from(zip));
    expect(presets.map((p) => p.data.name).sort()).toEqual(['a', 'b']);
  });

  it('makes the CLI accept the combination', () => {
    const m = resolvePreset('machine', user('ender3s1plus/machine/Tuned (Claude) - Ender-3 S1 Plus 0.4.json'), system);
    const p = resolvePreset('process', user('ender3s1plus/process/Tuned (Claude) - 0.20mm Standard.json'), system);
    const f = resolvePreset('filament', user('ender3s1plus/filament/Tuned (Claude) - PLA.json'), system);
    const cli = cliProfiles({ name: m.name, settings: m.settings, systemPrinter: m.systemPrinter! }, p.settings, f.settings);
    expect(cli.machine.inherits).toBe('Creality Ender-3 S1 Plus 0.4 nozzle');
    expect(cli.process.compatible_printers).toEqual([m.name, 'Creality Ender-3 S1 Plus 0.4 nozzle']);
    expect(cli.filament.compatible_printers_condition).toBe('');
  });
});
