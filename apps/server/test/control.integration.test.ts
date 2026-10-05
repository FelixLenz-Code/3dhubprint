import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import { FakeMoonraker } from './fakeMoonraker.js';

let app: FastifyInstance;
let fake: FakeMoonraker;
let base: string;
let cookie: string;
let printerId: number;

async function api(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}) {
  const method = init.method ?? (init.body !== undefined || init.form ? 'POST' : 'GET');
  const res = await fetch(base + path, {
    method,
    headers: {
      cookie,
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
      ...(method !== 'GET' && { 'x-printhub-request': '1' }),
    },
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for condition');
}

const printer = async () => (await api(`/api/printers/${printerId}`)).body;

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
  await until(async () => (await printer()).capabilities !== undefined);
});

afterAll(async () => {
  await app.close();
  await fake.stop();
});

describe('capabilities', () => {
  it('reads heater limits from the Klipper config and hides internal macros', async () => {
    const caps = (await printer()).capabilities;
    expect(caps.heaters).toEqual([
      { name: 'extruder', label: 'Düse', minTemp: 0, maxTemp: 270 },
      { name: 'heater_bed', label: 'Bett', minTemp: 0, maxTemp: 110 },
    ]);
    expect(caps.macros).toEqual(['PARK', 'START_PRINT']);
  });
});

describe('temperature', () => {
  it('rejects targets above the configured maximum', async () => {
    const r = await api(`/api/printers/${printerId}/temperature`, { body: { heater: 'extruder', target: 300 } });
    expect(r.status).toBe(400);
    expect(fake.scripts).toHaveLength(0);
  });

  it('sends SET_HEATER_TEMPERATURE for valid targets', async () => {
    const r = await api(`/api/printers/${printerId}/temperature`, { body: { heater: 'heater_bed', target: 60 } });
    expect(r.status).toBe(200);
    expect(fake.scripts.at(-1)).toBe('SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=60');
  });

  it('rejects unknown heaters (no G-code injection via heater name)', async () => {
    const r = await api(`/api/printers/${printerId}/temperature`, { body: { heater: 'extruder\nM112', target: 0 } });
    expect(r.status).toBe(400);
  });
});

describe('motion', () => {
  it('refuses to move an axis that is not homed', async () => {
    const r = await api(`/api/printers/${printerId}/move`, { body: { axis: 'x', distance: 10 } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('not_homed');
  });

  it('homes and then moves relatively, restoring absolute mode', async () => {
    expect((await api(`/api/printers/${printerId}/home`, { body: { axes: ['x', 'y'] } })).status).toBe(200);
    expect(fake.scripts.at(-1)).toBe('G28 X Y');
    fake.update({ toolhead: { homed_axes: 'xyz' } });
    await until(async () => (await printer()).status.homedAxes === 'xyz');
    expect((await api(`/api/printers/${printerId}/move`, { body: { axis: 'z', distance: -0.5 } })).status).toBe(200);
    expect(fake.scripts.at(-1)).toBe('G91\nG1 Z-0.5 F600\nG90');
  });
});

describe('while printing', () => {
  it('blocks motion and new prints, allows pause, tuning and exclude object', async () => {
    fake.update({
      print_stats: { state: 'printing', filename: 'part.gcode' },
      exclude_object: { objects: [{ name: 'PART_A' }, { name: 'PART_B' }], excluded_objects: [], current_object: 'PART_A' },
    });
    await until(async () => (await printer()).status.printState === 'printing');

    expect((await api(`/api/printers/${printerId}/home`, { body: {} })).status).toBe(409);
    expect((await api(`/api/printers/${printerId}/move`, { body: { axis: 'x', distance: 1 } })).status).toBe(409);
    expect((await api(`/api/printers/${printerId}/files/print`, { body: { path: 'new.gcode' } })).status).toBe(409);
    expect((await api(`/api/printers/${printerId}/files?path=part.gcode`, { method: 'DELETE' })).status).toBe(409);

    expect((await api(`/api/printers/${printerId}/speed-factor`, { body: { percent: 120 } })).status).toBe(200);
    expect(fake.scripts.at(-1)).toBe('M220 S120');
    expect((await api(`/api/printers/${printerId}/fan`, { body: { percent: 50 } })).status).toBe(200);
    expect(fake.scripts.at(-1)).toBe('M106 S128');

    expect((await api(`/api/printers/${printerId}/exclude-object`, { body: { name: 'PART_X' } })).status).toBe(400);
    expect((await api(`/api/printers/${printerId}/exclude-object`, { body: { name: 'PART_B' } })).status).toBe(200);
    expect(fake.scripts.at(-1)).toBe('EXCLUDE_OBJECT NAME=PART_B');

    expect((await api(`/api/printers/${printerId}/action`, { body: { action: 'resume' } })).status).toBe(409);
    expect((await api(`/api/printers/${printerId}/action`, { body: { action: 'pause' } })).status).toBe(200);
    expect(fake.callsOf('printer.print.pause')).toHaveLength(1);

    fake.update({ print_stats: { state: 'standby', filename: '' } });
    await until(async () => (await printer()).status.printState === 'standby');
  });

  it('allows the emergency stop at any time', async () => {
    expect((await api(`/api/printers/${printerId}/action`, { body: { action: 'emergency_stop' } })).status).toBe(200);
    expect(fake.callsOf('printer.emergency_stop')).toHaveLength(1);
  });
});

describe('macros and console', () => {
  it('runs only known macros and mirrors commands and responses into the console', async () => {
    expect((await api(`/api/printers/${printerId}/macro`, { body: { name: '_HELPER' } })).status).toBe(400);
    expect((await api(`/api/printers/${printerId}/macro`, { body: { name: 'PARK' } })).status).toBe(200);
    expect(fake.scripts.at(-1)).toBe('PARK');
    await until(async () => (await api(`/api/printers/${printerId}/console`)).body.some((l: { text: string }) => l.text === '// ran: PARK'));
    const lines = (await api(`/api/printers/${printerId}/console`)).body as { text: string; kind: string }[];
    expect(lines).toContainEqual(expect.objectContaining({ text: 'PARK', kind: 'command' }));
  });
});

describe('files and history', () => {
  it('lists G-code files newest first, hides dot folders and resolves thumbnails', async () => {
    const r = await api(`/api/printers/${printerId}/files`);
    expect(r.body.dirs).toEqual([{ name: 'parts', path: 'parts', modified: 2 }]);
    expect(r.body.files.map((f: { name: string }) => f.name)).toEqual(['new.gcode', 'old.gcode']);
    expect(r.body.files[0].thumbnailPath).toBe('.thumbs/new-300x300.png');
    expect(r.body.diskFree).toBe(600);
  });

  it('rejects path traversal', async () => {
    expect((await api(`/api/printers/${printerId}/files?path=../config`)).status).toBe(400);
    expect((await api(`/api/printers/${printerId}/files/print`, { body: { path: '../printer.cfg' } })).status).toBe(400);
  });

  it('maps the print history', async () => {
    const r = await api(`/api/printers/${printerId}/history`);
    expect(r.body.jobs[0]).toMatchObject({ id: '0001', filename: 'a.gcode', status: 'completed', printDuration: 60 });
    expect(r.body.totals.jobs).toBe(1);
    expect(r.body.total).toBe(1);
  });

  it('forwards uploads to Moonraker and can start the print', async () => {
    const form = new FormData();
    form.append('path', 'parts');
    form.append('print', 'true');
    form.append('file', new Blob(['G28\nG1 X10\n']), 'bracket.gcode');
    const r = await api(`/api/printers/${printerId}/files/upload`, { form });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, path: 'parts/bracket.gcode', printStarted: true });
    expect(fake.uploads.at(-1)).toEqual({
      fields: { root: 'gcodes', path: 'parts', print: 'true' },
      filename: 'bracket.gcode',
      content: 'G28\nG1 X10\n',
    });
  });

  it('rejects non-G-code uploads', async () => {
    const form = new FormData();
    form.append('file', new Blob(['solid x']), 'model.stl');
    expect((await api(`/api/printers/${printerId}/files/upload`, { form })).status).toBe(400);
  });
});
