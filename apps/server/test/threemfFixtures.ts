import { strToU8, zipSync } from 'fflate';

/** <mesh> of axis-aligned boxes; triangles 12*i .. 12*i+11 belong to box i. */
export function boxesMesh(...boxes: [number, number, number, number, number, number][]): string {
  const v: string[] = [];
  const t: string[] = [];
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const o = v.length;
    for (const [x, y, z] of [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]]) v.push(`<vertex x="${x}" y="${y}" z="${z}" />`);
    for (const [a, b, c] of faces) t.push(`<triangle v1="${o + a!}" v2="${o + b!}" v3="${o + c!}" />`);
  }
  return `<mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh>`;
}

export function make3mf(model: string, extra: Record<string, string> = {}, unit = 'millimeter'): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">${model}</model>`),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)])),
  });
}

/** Print-in-place part as exported by FreeCAD: a lever inside a frame, two build items. */
export const plainTwoParts = () =>
  make3mf(
    `<resources><object id="1" type="model">${boxesMesh([-5, -5, 0, 5, 5, 8])}</object><object id="2" type="model">${boxesMesh([-16, -27, 0, 16, 5, 10])}</object></resources>` +
      `<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0" /><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0" /></build>`,
  );

/**
 * Bambu Studio/Orca project: object 3 (plate 1) has a 10 mm cube and a large modifier,
 * object 4 (plate 2, 307 mm to the right) has a 20 mm cube.
 */
export const bambuProject = () =>
  make3mf(
    `<resources>` +
      `<object id="3" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/><component p:path="/3D/Objects/object_1.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>` +
      `<object id="4" type="model"><components><component p:path="/3D/Objects/object_2.model" objectid="5" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>` +
      `</resources><build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 128 128 5" printable="1"/><item objectid="4" transform="1 0 0 0 1 0 0 0 1 435 128 10" printable="1"/></build>`,
    {
      '3D/Objects/object_1.model': `<model unit="millimeter"><resources><object id="1" type="model">${boxesMesh([-5, -5, -5, 5, 5, 5])}</object><object id="2" type="other">${boxesMesh([-50, -50, -5, 50, 50, 50])}</object></resources></model>`,
      '3D/Objects/object_2.model': `<model unit="millimeter"><resources><object id="5" type="model">${boxesMesh([-10, -10, -10, 10, 10, 10])}</object></resources></model>`,
      'Metadata/model_settings.config':
        `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <object id="3">\n    <metadata key="name" value="Würfel"/>\n    <part id="1" subtype="normal_part"/>\n    <part id="2" subtype="modifier_part"><metadata key="sparse_infill_density" value="80%"/></part>\n  </object>\n  <object id="4">\n    <part id="5" subtype="normal_part"/>\n  </object>\n` +
        `  <plate>\n    <metadata key="plater_id" value="1"/>\n    <model_instance><metadata key="object_id" value="3"/></model_instance>\n  </plate>\n  <plate>\n    <metadata key="plater_id" value="2"/>\n    <model_instance><metadata key="object_id" value="4"/></model_instance>\n  </plate>\n` +
        `  <assemble>\n   <assemble_item object_id="3" instance_id="0" transform="1 0 0 0 1 0 0 0 1 128 128 5" offset="0 0 0" />\n   <assemble_item object_id="4" instance_id="0" transform="1 0 0 0 1 0 0 0 1 435 128 10" offset="0 0 0" />\n  </assemble>\n</config>`,
    },
  );
