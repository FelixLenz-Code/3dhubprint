import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { JobInfo } from '@printhub/shared';
import { buildApp } from '../src/app.js';
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
    expect(r.body).toMatchObject({ name: 'Würfel 20mm', format: 'stl', triangles: 12, dimensions: [20, 20, 20] });
    modelId = r.body.id;
    expect((await api('/api/models', { form: form() })).body.id).toBe(modelId);
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
      body: { modelId, printerId, process: 'Tuned (Claude) - 0.20mm Standard', filament: 'Generic PLA K1' },
    });
    expect(r.status).toBe(400);
  });

  it('only allows profiles released for the printer', async () => {
    const r = await api('/api/jobs', {
      body: { modelId, printerId, process: 'Tuned (Claude) - Gridfinity', filament: 'Tuned (Claude) - PLA' },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('nicht freigegeben');
  });

  it('slices a job with copies, embeds thumbnails and sends it to the printer', async () => {
    const created = await api('/api/jobs', {
      body: { modelId, printerId, process: 'Tuned (Claude) - 0.20mm Standard', filament: 'Tuned (Claude) - PLA', copies: 3 },
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
    const id = (await api('/api/jobs', { body: { modelId, printerId, process: 'FAIL', filament: 'Tuned (Claude) - PLA' } })).body.id;
    const job = await until(async () => {
      const j = (await api(`/api/jobs/${id}`)).body as JobInfo;
      return j.status === 'failed' ? j : undefined;
    });
    expect(job.error).toContain('not compatible');
    expect((await api(`/api/jobs/${id}/send`, { body: { print: false } })).status).toBe(409);
    expect((await api(`/api/jobs/${id}/retry`, { body: {} })).body.status).toBe('queued');
  });

  it('protects models that are still used by jobs', async () => {
    expect((await api(`/api/models/${modelId}`, { method: 'DELETE' })).status).toBe(409);
  });
});
