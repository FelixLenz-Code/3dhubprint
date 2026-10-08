import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { JobInfo } from '@printhub/shared';
import { buildApp } from '../src/app.js';
import { bambuProject, plainTwoParts } from './threemfFixtures.js';
import { FakeMoonraker } from './fakeMoonraker.js';

const USER_FIX = path.resolve(import.meta.dirname, '../../../fixtures/orca-2.4.2/user/ender3s1plus');

let app: FastifyInstance;
let fake: FakeMoonraker;
let base: string;
let cookie: string;
let printerId: number;

async function api(p: string, init: { method?: string; body?: unknown; form?: FormData } = {}) {
  const method = init.method ?? (init.body !== undefined || init.form ? 'POST' : 'GET');
  const res = await fetch(base + p, {
    method,
    headers: {
      cookie,
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
      ...(method !== 'GET' && { 'x-printhub-request': '1' }),
    },
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
}

function cubeStl(size = 20): Buffer {
  const v = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]].map((p) => p.map((c) => c * size));
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const buf = Buffer.alloc(84 + f.length * 50);
  buf.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => t.forEach((vi, k) => v[vi]!.forEach((c, j) => buf.writeFloatLE(c, 84 + i * 50 + 12 + k * 12 + j * 4))));
  return buf;
}

function boxStl(x: number, y: number, z: number): Buffer {
  const buf = cubeStl(1);
  for (let i = 0; i < 12 * 9; i++) {
    const o = 84 + Math.floor(i / 9) * 50 + 12 + (i % 9) * 4;
    buf.writeFloatLE(buf.readFloatLE(o) * [x, y, z][i % 3]!, o);
  }
  return buf;
}

const profileForm = (files: string[]) => {
  const form = new FormData();
  for (const f of files) form.append('files', new Blob([new Uint8Array(fs.readFileSync(f))]), path.basename(f));
  return form;
};
const userFiles = ['machine', 'process', 'filament'].flatMap((k) => fs.readdirSync(path.join(USER_FIX, k)).map((f) => path.join(USER_FIX, k, f)));

beforeAll(async () => {
  fake = new FakeMoonraker();
  const fakeUrl = await fake.start();
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const res = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-printhub-request': '1' },
    body: JSON.stringify({ username: 'admin', password: 'ein-sehr-langes-passwort' }),
  });
  cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  printerId = (await api('/api/printers', { body: { name: 'Fake', url: fakeUrl } })).body.id;
  await until(async () => (await api(`/api/printers/${printerId}`)).body.status.connection === 'connected');
});

afterAll(async () => {
  await app.close();
  await fake.stop();
});

describe('slicer status', () => {
  it('finds the (fake) CLI and the system profiles', async () => {
    const s = (await api('/api/slicer/status')).body;
    expect(s.available).toBe(true);
    expect(s.systemProfiles).toBeGreaterThan(500);
  });
});

describe('profiles', () => {
  it('imports user presets, skips unchanged ones and versions changes', async () => {
    const r1 = (await api('/api/slicer/profiles/import', { form: profileForm(userFiles) })).body;
    expect(r1.skipped).toEqual([]);
    expect(r1.imported).toHaveLength(8);
    expect(r1.imported.every((i: { version: number }) => i.version === 1)).toBe(true);

    const r2 = (await api('/api/slicer/profiles/import', { form: profileForm(userFiles) })).body;
    expect(r2.imported.every((i: { updated: boolean; version: number }) => !i.updated && i.version === 1)).toBe(true);

    const pla = JSON.parse(fs.readFileSync(path.join(USER_FIX, 'filament/Tuned (Claude) - PLA.json'), 'utf8'));
    pla.nozzle_temperature = ['215'];
    const form = new FormData();
    form.append('files', new Blob([JSON.stringify(pla)]), 'pla.json');
    const r3 = (await api('/api/slicer/profiles/import', { form })).body;
    expect(r3.imported).toEqual([{ kind: 'filament', name: 'Tuned (Claude) - PLA', version: 2, updated: true }]);

    const list = (await api('/api/slicer/profiles')).body as { kind: string; name: string; version: number; summary: Record<string, unknown> }[];
    expect(list).toHaveLength(8);
    expect(list.find((p) => p.name === 'Tuned (Claude) - PLA')).toMatchObject({ version: 2, summary: { nozzleTemp: 215, material: 'PLA' } });
  });

  it('reports files it cannot use', async () => {
    const form = new FormData();
    form.append('files', new Blob(['{"name":"x"}']), 'x.json');
    form.append('files', new Blob(['kein json']), 'y.json');
    const r = (await api('/api/slicer/profiles/import', { form })).body;
    expect(r.imported).toEqual([]);
    expect(r.skipped).toHaveLength(2);
  });

  it('validates printer assignments', async () => {
    expect((await api(`/api/printers/${printerId}/profiles`, { method: 'PUT', body: { machine: 'gibt es nicht', process: [], filament: [] } })).status).toBe(400);
    const a = await api(`/api/printers/${printerId}/profiles`, {
      method: 'PUT',
      body: {
        machine: 'Tuned (Claude) - Ender-3 S1 Plus 0.4',
        process: ['Tuned (Claude) - 0.20mm Standard', 'Tuned (Claude) - 0.28mm Entwurf'],
        filament: [],
      },
    });
    expect(a.status).toBe(200);
    expect(a.body.process).toHaveLength(2);
  });
});

describe('models and jobs', () => {
  let modelId: number;

  it('stores models once, with dimensions and a thumbnail', async () => {
    const form = () => {
      const f = new FormData();
      f.append('file', new Blob([new Uint8Array(cubeStl())]), 'Würfel 20mm.stl');
      return f;
    };
    const r = await api('/api/models', { form: form() });
    expect(r.status).toBe(201);
    expect(r.body).toEqual([expect.objectContaining({ name: 'Würfel 20mm', format: 'stl', triangles: 12, dimensions: [20, 20, 20] })]);
    modelId = r.body[0].id;
    expect((await api('/api/models', { form: form() })).body[0].id).toBe(modelId);
    const thumb = await api(`/api/models/${modelId}/thumbnail`);
    expect(thumb.type).toBe('image/png');
    expect((thumb.body as Buffer).subarray(1, 4).toString()).toBe('PNG');
  });

  it('rejects unsupported model files', async () => {
    const f = new FormData();
    f.append('file', new Blob(['hallo']), 'notiz.txt');
    expect((await api('/api/models', { form: f })).status).toBe(400);
  });

  it('without an allow-list, only offers presets made for the machine', async () => {
    const k1 = fs.readFileSync(path.resolve(USER_FIX, '../k1/filament/Generic PLA K1.json'));
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(k1)]), 'k1.json');
    await api('/api/slicer/profiles/import', { form });
    const list = (await api('/api/slicer/profiles')).body as { name: string; compatiblePrinters: string[] }[];
    expect(list.find((p) => p.name === 'Generic PLA K1')?.compatiblePrinters).toEqual(['Creality K1 (0.4 nozzle)']);
    const r = await api('/api/jobs', {
      body: { items: [{ modelId }], printerId, process: 'Tuned (Claude) - 0.20mm Standard', filament: 'Generic PLA K1' },
    });
    expect(r.status).toBe(400);
  });

  it('only allows profiles released for the printer', async () => {
    const r = await api('/api/jobs', {
      body: { items: [{ modelId }], printerId, process: 'Tuned (Claude) - Gridfinity', filament: 'Tuned (Claude) - PLA' },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('nicht freigegeben');
  });

  it('slices a job with copies, embeds thumbnails and sends it to the printer', async () => {
    const created = await api('/api/jobs', {
      body: { items: [{ modelId, copies: 3 }], printerId, process: 'Tuned (Claude) - 0.20mm Standard', filament: 'Tuned (Claude) - PLA' },
    });
    expect(created.status).toBe(201);
    expect(created.body.profiles.filament).toMatchObject({ name: 'Tuned (Claude) - PLA', version: 2 });
    const id = created.body.id;

    const job = await until(async () => {
      const j = (await api(`/api/jobs/${id}`)).body as JobInfo;
      return j.status === 'sliced' || j.status === 'failed' ? j : undefined;
    });
    expect(job.error).toBeNull();
    expect(job).toMatchObject({ status: 'sliced', estimatedTime: 3723, filamentG: 3.7, filamentMm: 1234.5, gcodeName: 'Wuerfel_20mm_x3_PLA_1h2m.gcode' });

    const gcode = (await api(`/api/jobs/${id}/gcode`)).body.toString();
    expect(gcode).toContain('; copies = 3');
    expect(job.preview).not.toBeNull();
    const top = await api(job.preview!.top);
    expect(top.type).toBe('image/png');
    expect(gcode).toMatch(/; thumbnail begin 32x32 \d+/);
    expect(gcode).toMatch(/; thumbnail begin 300x300 \d+/);
    // thumbnails go right after Orca's header block
    expect(gcode.indexOf('; HEADER_BLOCK_END')).toBeLessThan(gcode.indexOf('; thumbnail begin'));

    const sent = await api(`/api/jobs/${id}/send`, { body: { print: true } });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: 'printing', printerPath: 'Wuerfel_20mm_x3_PLA_1h2m.gcode' });
    expect(fake.uploads.at(-1)).toMatchObject({ filename: 'Wuerfel_20mm_x3_PLA_1h2m.gcode', fields: { print: 'true', root: 'gcodes' } });
  });

  it('marks failed slices with Orca\'s error message and allows a retry', async () => {
    const fail = JSON.parse(fs.readFileSync(path.join(USER_FIX, 'process/Tuned (Claude) - 0.20mm Standard.json'), 'utf8'));
    fail.name = 'FAIL';
    fail.print_settings_id = 'FAIL';
    const form = new FormData();
    form.append('files', new Blob([JSON.stringify(fail)]), 'fail.json');
    await api('/api/slicer/profiles/import', { form });
    await api(`/api/printers/${printerId}/profiles`, {
      method: 'PUT',
      body: { machine: 'Tuned (Claude) - Ender-3 S1 Plus 0.4', process: [], filament: [] },
    });
    const id = (await api('/api/jobs', { body: { items: [{ modelId }], printerId, process: 'FAIL', filament: 'Tuned (Claude) - PLA' } })).body.id;
    const job = await until(async () => {
      const j = (await api(`/api/jobs/${id}`)).body as JobInfo;
      return j.status === 'failed' ? j : undefined;
    });
    expect(job.error).toContain('not compatible');
    expect((await api(`/api/jobs/${id}/send`, { body: { print: false } })).status).toBe(409);
    expect((await api(`/api/jobs/${id}/retry`, { body: {} })).body.status).toBe('queued');
  });

  it('puts several models with overrides on one plate', async () => {
    const f = new FormData();
    f.append('file', new Blob([new Uint8Array(cubeStl(10))]), 'Klein.stl');
    const small = (await api('/api/models', { form: f })).body[0].id;
    await api(`/api/printers/${printerId}/profiles`, {
      method: 'PUT',
      body: { machine: 'Tuned (Claude) - Ender-3 S1 Plus 0.4', process: [], filament: [] },
    });
    const r = await api('/api/jobs', {
      body: {
        items: [{ modelId, copies: 2 }, { modelId: small, copies: 3 }],
        printerId,
        process: 'Tuned (Claude) - 0.20mm Standard',
        filament: 'Tuned (Claude) - PLA',
        overrides: {
          support: { enabled: true, type: 'tree', buildPlateOnly: true },
          brim: { type: 'outer', width: 8 },
          skirt: { loops: 2 },
          infill: { density: 35, pattern: 'gyroid' },
        },
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.copies).toBe(5);
    expect(r.body.models.map((m: { name: string; copies: number }) => [m.name, m.copies])).toEqual([['Würfel 20mm', 2], ['Klein', 3]]);
    const job = await until(async () => {
      const j = (await api(`/api/jobs/${r.body.id}`)).body as JobInfo;
      return j.status === 'sliced' || j.status === 'failed' ? j : undefined;
    });
    expect(job.status).toBe('sliced');
    expect(job.gcodeName).toBe('Wuerfel_20mm_+1_PLA_1h2m.gcode');
    const gcode = (await api(`/api/jobs/${job.id}/gcode`)).body.toString();
    expect(gcode).toContain('; copies = 5');
    expect(gcode).toContain('; enable_support = 1');
    expect(gcode).toContain('; support_type = tree(auto)');
    expect(gcode).toContain('; brim_type = outer_only');
    expect(gcode).toContain('; brim_width = 8');
    expect(gcode).toContain('; skirt_loops = 2');
    expect(gcode).toContain('; sparse_infill_density = 35%');
    expect(gcode).toContain('; sparse_infill_pattern = gyroid');
  });

  it('keeps plain 3MF parts together and hands slicer projects to Orca as 3MF, one model per plate', async () => {
    const upload = async (data: Uint8Array, name: string) => {
      const f = new FormData();
      f.append('file', new Blob([new Uint8Array(data)]), name);
      const r = await api('/api/models', { form: f });
      expect(r.status).toBe(201);
      return r.body as { id: number; name: string; dimensions: number[] }[];
    };
    const slice = async (modelId: number) => {
      const r = await api('/api/jobs', { body: { items: [{ modelId }], printerId, process: 'Tuned (Claude) - 0.20mm Standard', filament: 'Tuned (Claude) - PLA' } });
      const job = await until(async () => {
        const j = (await api(`/api/jobs/${r.body.id}`)).body as JobInfo;
        return j.status === 'sliced' || j.status === 'failed' ? j : undefined;
      }, 15_000);
      expect(job.status).toBe('sliced');
      return (await api(`/api/jobs/${job.id}/gcode`)).body.toString() as string;
    };

    // A lever inside its frame: Orca would arrange the two build items apart.
    const [pip, ...rest] = await upload(plainTwoParts(), 'PIP-Schalter.3mf');
    expect(rest).toEqual([]);
    expect(pip!.dimensions).toEqual([32, 32, 10]);
    const plain = await slice(pip!.id);
    expect(plain).toContain('; models = PIP-Schalter.stl\n');
    expect(plain).toContain('; bounds = -16,-16,0,16,16,10\n');

    const plates = await upload(bambuProject(), 'Projekt.3mf');
    expect(plates.map((m) => [m.name, m.dimensions])).toEqual([
      ['Projekt – Platte 1', [10, 10, 10]], // without the modifier
      ['Projekt – Platte 2', [20, 20, 20]],
    ]);
    expect((await upload(bambuProject(), 'Projekt.3mf')).map((m) => m.id)).toEqual(plates.map((m) => m.id));
    expect(await slice(plates[1]!.id)).toContain('; models = Projekt _ Platte 2.3mf\n');
  }, 20_000);

  it('enables vase mode with the settings Orca requires, for a single object only', async () => {
    const base = { printerId, process: 'Tuned (Claude) - 0.20mm Standard', filament: 'Tuned (Claude) - PLA', overrides: { vase: true } };
    const bad = await api('/api/jobs', { body: { ...base, items: [{ modelId, copies: 2 }] } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('Vasenmodus');
    const r = await api('/api/jobs', { body: { ...base, items: [{ modelId }] } });
    const job = await until(async () => {
      const j = (await api(`/api/jobs/${r.body.id}`)).body as JobInfo;
      return j.status === 'sliced' || j.status === 'failed' ? j : undefined;
    });
    const gcode = (await api(`/api/jobs/${job.id}/gcode`)).body.toString();
    for (const line of ['; spiral_mode = 1', '; wall_loops = 1', '; sparse_infill_density = 0%', '; enable_support = 0']) expect(gcode).toContain(line);
  });

  it('slices for the printer\'s plate (bed type) and rejects plates the filament does not support', async () => {
    const body = { items: [{ modelId }], printerId, process: 'Tuned (Claude) - 0.20mm Standard', filament: 'Tuned (Claude) - PLA' };
    const slice = async (extra: object = {}) => {
      const r = await api('/api/jobs', { body: { ...body, ...extra } });
      expect(r.status).toBe(201);
      const job = await until(async () => {
        const j = (await api(`/api/jobs/${r.body.id}`)).body as JobInfo;
        return j.status === 'sliced' || j.status === 'failed' ? j : undefined;
      });
      return { job, gcode: (await api(`/api/jobs/${job.id}/gcode`)).body.toString() as string };
    };
    // Without a printer setting: OrcaSlicer's usual High Temp Plate, never the CLI's Cool Plate default.
    let res = await slice();
    expect(res.job.bedType).toBe('High Temp Plate');
    expect(res.gcode).toContain('; curr_bed_type = High Temp Plate / High Temp Plate');

    const set = await api(`/api/printers/${printerId}/profiles`, {
      method: 'PUT',
      body: { machine: 'Tuned (Claude) - Ender-3 S1 Plus 0.4', process: [], filament: [], bedType: 'Textured PEI Plate' },
    });
    expect(set.body.bedType).toBe('Textured PEI Plate');
    res = await slice();
    expect(res.gcode).toContain('; curr_bed_type = Textured PEI Plate');
    res = await slice({ bedType: 'Cool Plate' });
    expect(res.gcode).toContain('; curr_bed_type = Cool Plate');

    // The PETG profile has eng_plate_temp = 0, i.e. not for the Engineering Plate.
    const bad = await api('/api/jobs', { body: { ...body, filament: 'Tuned (Claude) - PETG', bedType: 'Engineering Plate' } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('Engineering Plate');
  });

  it('bakes manual orientation, scale and bed positions into the parts', async () => {
    const f = new FormData();
    f.append('file', new Blob([new Uint8Array(boxStl(30, 10, 5))]), 'Leiste.stl');
    const bar = (await api('/api/models', { form: f })).body[0].id;
    const mesh = await api(`/api/models/${bar}/mesh`);
    expect(mesh.body.length).toBe(12 * 9 * 4);

    const zQuarter = [0, 0, Math.SQRT1_2, Math.SQRT1_2]; // 90° about Z
    const body = { printerId, process: 'Tuned (Claude) - 0.20mm Standard', filament: 'Tuned (Claude) - PLA' };
    const outside = await api('/api/jobs', {
      body: { ...body, arrange: false, items: [{ modelId: bar, copies: 1, transform: { rotation: zQuarter, scale: 2, positions: [[-50, 20]] } }] },
    });
    expect(outside.status).toBe(400);
    const missing = await api('/api/jobs', { body: { ...body, arrange: false, items: [{ modelId: bar, copies: 2, transform: { positions: [[50, 50]] } }] } });
    expect(missing.status).toBe(400);

    const r = await api('/api/jobs', {
      body: { ...body, arrange: false, items: [{ modelId: bar, copies: 2, transform: { rotation: zQuarter, scale: 2, positions: [[50, 60], [200, 210]] } }] },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ arrange: false });
    expect(r.body.models[0].transform).toMatchObject({ scale: 2, positions: [[50, 60], [200, 210]] });
    const job = await until(async () => {
      const j = (await api(`/api/jobs/${r.body.id}`)).body as JobInfo;
      return j.status === 'sliced' || j.status === 'failed' ? j : undefined;
    });
    expect(job.error).toBeNull();
    const gcode = (await api(`/api/jobs/${job.id}/gcode`)).body.toString();
    expect(gcode).toContain('; arrange = 0');
    // 30×10×5 scaled ×2 and turned 90°: 20×60×10, centered at the given positions, on the bed.
    expect(gcode).toContain('; bounds = 40,30,0,60,90,10 | 190,180,0,210,240,10');

    // Auto-arranged: rotation/scale are baked in, Orca places the part.
    const auto = await api('/api/jobs', { body: { ...body, items: [{ modelId: bar, transform: { rotation: zQuarter, scale: 1 } }] } });
    const job2 = await until(async () => {
      const j = (await api(`/api/jobs/${auto.body.id}`)).body as JobInfo;
      return j.status === 'sliced' || j.status === 'failed' ? j : undefined;
    });
    const gcode2 = (await api(`/api/jobs/${job2.id}/gcode`)).body.toString();
    expect(gcode2).toContain('; arrange = 1');
    expect(gcode2).toContain('; bounds = -5,-15,0,5,15,5');
  });

  it('keeps wizard drafts out of the job list until saved or sent', async () => {
    const r = await api('/api/jobs', {
      body: { items: [{ modelId }], printerId, process: 'Tuned (Claude) - 0.20mm Standard', filament: 'Tuned (Claude) - PLA', draft: true, autoPrint: true },
    });
    expect(r.body).toMatchObject({ draft: true, autoPrint: false });
    const job = await until(async () => {
      const j = (await api(`/api/jobs/${r.body.id}`)).body as JobInfo;
      return j.status === 'sliced' ? j : undefined;
    });
    expect(job.draft).toBe(true);
    const listed = () => api('/api/jobs').then((x) => (x.body as JobInfo[]).some((j) => j.id === job.id));
    expect(await listed()).toBe(false);
    expect((await api(`/api/jobs/${job.id}/keep`, { body: {} })).body.draft).toBe(false);
    expect(await listed()).toBe(true);

    // Sending a draft saves it as well.
    const r2 = await api('/api/jobs', {
      body: { items: [{ modelId }], printerId, process: 'Tuned (Claude) - 0.20mm Standard', filament: 'Tuned (Claude) - PLA', draft: true },
    });
    await until(async () => ((await api(`/api/jobs/${r2.body.id}`)).body.status === 'sliced' ? true : undefined));
    const sent = await api(`/api/jobs/${r2.body.id}/send`, { body: { print: false } });
    expect(sent.body).toMatchObject({ status: 'uploaded', draft: false });
  });

  it('edits a job: the saved draft replaces the original and keeps its queue place', async () => {
    const body = { items: [{ modelId }], printerId, process: 'Tuned (Claude) - 0.20mm Standard', filament: 'Tuned (Claude) - PLA' };
    const sliced = async (id: number) =>
      until(async () => {
        const j = (await api(`/api/jobs/${id}`)).body as JobInfo;
        return j.status === 'sliced' || j.status === 'failed' ? j : undefined;
      });
    // Keep the queue from starting: the printer's bed is not confirmed empty.
    const orig = (await api('/api/jobs', { body })).body.id as number;
    await sliced(orig);
    const queued = (await api(`/api/jobs/${orig}/enqueue`, { body: {} })).body as JobInfo;
    expect(queued.status).toBe('waiting');

    const edit = await api('/api/jobs', { body: { ...body, items: [{ modelId, copies: 2 }], draft: true, replaces: orig } });
    expect(edit.body).toMatchObject({ draft: true, replaces: orig });
    const draft = await sliced(edit.body.id);
    // Interactive 3D view: gzipped toolpaths.
    expect(draft.preview?.paths).toBeTruthy();
    const paths = await api(draft.preview!.paths!);
    const buf = paths.body as Buffer;
    expect(buf.readUInt32LE(0)).toBeGreaterThan(0);
    expect(buf.length).toBeGreaterThan(16);

    const kept = (await api(`/api/jobs/${draft.id}/keep`, { body: {} })).body as JobInfo;
    expect(kept).toMatchObject({ draft: false, status: 'waiting', queuePosition: queued.queuePosition, copies: 2 });
    expect((await api(`/api/jobs/${orig}`)).status).toBe(404);
    expect((await api('/api/jobs', { body: { ...body, draft: true, replaces: 999999 } })).status).toBe(404);
  });

  it('protects models that are still used by jobs', async () => {
    expect((await api(`/api/models/${modelId}`, { method: 'DELETE' })).status).toBe(409);
  });

  it('deletes several jobs at once and reports the ones it could not', async () => {
    const before = (await api('/api/jobs')).body as JobInfo[];
    expect(before.length).toBeGreaterThanOrEqual(2);
    const ids = before.slice(0, 2).map((j) => j.id);
    const r = await api('/api/jobs/delete', { body: { ids: [...ids, 999999] } });
    expect(r.status).toBe(200);
    expect(r.body.deleted).toEqual(ids);
    expect(r.body.skipped).toEqual([{ id: 999999, reason: 'Auftrag nicht gefunden' }]);
    const after = ((await api('/api/jobs')).body as JobInfo[]).map((j) => j.id);
    for (const id of ids) expect(after).not.toContain(id);
    expect((await api('/api/jobs/delete', { body: { ids: [] } })).status).toBe(400);
  });
});
