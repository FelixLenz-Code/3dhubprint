import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { meshInfo } from '../src/slicer/mesh.js';
import { IDENTITY, mergedTriangles, plateGroups, read3mf, rewrite3mf } from '../src/slicer/threemf.js';
import { bambuProject, boxesMesh, make3mf, plainTwoParts } from './threemfFixtures.js';

describe('3MF', () => {
  it('reads all build items of a plain 3MF in place', () => {
    const tm = read3mf(plainTwoParts());
    expect(tm.project).toBeNull();
    expect(tm.items.map((i) => i.objectId)).toEqual(['1', '2']);
    expect(meshInfo({ triangles: mergedTriangles(tm) }).size).toEqual([32, 32, 10]);
    expect(plateGroups(tm)).toHaveLength(1);
  });

  it('converts the model unit to millimeters', () => {
    const tm = read3mf(make3mf(`<resources><object id="1" type="model">${boxesMesh([0, 0, 0, 1, 2, 0.5])}</object></resources><build><item objectid="1"/></build>`, {}, 'inch'));
    expect(meshInfo({ triangles: mergedTriangles(tm) }).size.map((v) => +v.toFixed(3))).toEqual([25.4, 50.8, 12.7]);
  });

  it('leaves out modifiers of Bambu/Orca projects and finds their plates', () => {
    const tm = read3mf(bambuProject());
    expect(tm.project).toBe('bambu');
    const [cube, big] = tm.items;
    expect(meshInfo({ triangles: cube!.triangles })).toMatchObject({ size: [10, 10, 10], min: [123, 123, 0] });
    expect(meshInfo({ triangles: big!.triangles }).size).toEqual([20, 20, 20]);
    expect(plateGroups(tm).map((g) => g.map((i) => i.objectId))).toEqual([['3'], ['4']]);
  });

  it('leaves out PrusaSlicer modifier volumes and groups items by bed', () => {
    const prusa = make3mf(
      `<resources><object id="1" type="model">${boxesMesh([0, 0, 0, 10, 10, 10], [-40, -40, 0, 40, 40, 40])}</object><object id="2" type="model">${boxesMesh([0, 0, 0, 5, 5, 5])}</object></resources>` +
        `<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 100 0"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 550 150 0"/></build>`,
      {
        'Metadata/Slic3r_PE_model.config':
          '<config><object id="1" instances_count="1"><volume firstid="0" lastid="11"><metadata type="volume" key="volume_type" value="ModelPart"/></volume><volume firstid="12" lastid="23"><metadata type="volume" key="volume_type" value="ModifierVolume"/></volume></object>' +
          '<object id="2" instances_count="1"><volume firstid="0" lastid="11"><metadata type="volume" key="volume_type" value="ModelPart"/></volume></object></config>',
        'Metadata/Slic3r_PE.config': '; bed_shape = 0x0,300x0,300x300,0x300\n',
      },
    );
    const tm = read3mf(prusa);
    expect(tm.project).toBe('prusa');
    expect(meshInfo({ triangles: tm.items[0]!.triangles })).toMatchObject({ triangles: 12, size: [10, 10, 10] });
    // Bed 2 of PrusaSlicer 2.9 starts 400 mm (bed + a third) to the right.
    expect(plateGroups(tm).map((g) => g.map((i) => i.objectId))).toEqual([['1'], ['2']]);
    const bed2 = read3mf(rewrite3mf(tm, IDENTITY, new Set(['2'])));
    expect(bed2.items.map((i) => i.objectId)).toEqual(['2']);
    expect(strFromU8(bed2.files['Metadata/Slic3r_PE_model.config']!)).not.toContain('<object id="1"');
  });

  it('rewrites a project with a new placement and only the kept items', () => {
    const tm = read3mf(bambuProject());
    const moved = rewrite3mf(tm, [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, -20, 0], new Set(['4']));
    const files = unzipSync(moved);
    const main = strFromU8(files['3D/3dmodel.model']!);
    expect(main.match(/<item\b[^>]*>/g)).toEqual(['<item objectid="4" transform="1 0 0 0 1 0 0 0 1 445 108 10" printable="1"/>']);
    const cfg = strFromU8(files['Metadata/model_settings.config']!);
    expect(cfg).not.toContain('<plate>');
    expect(cfg).not.toContain('<object id="3">');
    expect(cfg).toContain('<object id="4">');
    expect(cfg).not.toContain('object_id="3"'); // Orca cannot read the file with leftovers in <assemble>
    expect(cfg).toContain('<assemble_item object_id="4"');
    // Parts, modifiers and their settings stay untouched.
    expect(files['3D/Objects/object_1.model']).toEqual(tm.files['3D/Objects/object_1.model']);
    expect(meshInfo({ triangles: read3mf(moved).items[0]!.triangles }).min).toEqual([435, 98, 0]);
    // Same input, same bytes (models are deduplicated by hash).
    expect(rewrite3mf(tm, IDENTITY, new Set(['4']))).toEqual(rewrite3mf(read3mf(bambuProject()), IDENTITY, new Set(['4'])));
  });
});
