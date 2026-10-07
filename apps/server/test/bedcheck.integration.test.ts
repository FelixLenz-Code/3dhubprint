import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import jpeg from 'jpeg-js';
import type { BedCheckInfo, BedCheckResult, PrinterSummary } from '@printhub/shared';
import { buildApp } from '../src/app.js';
import { FakeMoonraker } from './fakeMoonraker.js';

let app: FastifyInstance;
let fake: FakeMoonraker;
let cam: http.Server;
let base: string;
let cookie: string;
let printerId: number;

/** A textured blue-gray bed below a light wall, optionally with a part on it. */
function scene({ part, brightness = 1 }: { part?: [number, number, number]; brightness?: number } = {}): Buffer {
  const w = 320, h = 240;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let c = y < 120 ? [200, 190, 170] : [70 + ((x * 7 + y * 13) % 11), 95 + ((x * 3 + y * 5) % 9), 120];
      if (part && x >= 150 && x < 175 && y >= 170 && y < 190) c = part;
      for (let k = 0; k < 3; k++) data[o + k] = Math.min(255, c[k]! * brightness);
      data[o + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

let frame = scene();

async function api<T = any>(p: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
  const res = await fetch(base + p, {
    method,
    headers: { cookie, ...(init.body !== undefined && { 'content-type': 'application/json' }), ...(method !== 'GET' && { 'x-printhub-request': '1' }) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : (text as T) };
}

const printer = async () => (await api<PrinterSummary>(`/api/printers/${printerId}`)).body;
const run = async () => (await api<BedCheckResult>(`/api/printers/${printerId}/bed-check/run`, { body: {} })).body;
const region = { x0: 0.05, y0: 0.55, x1: 0.95, y1: 0.95 };

beforeAll(async () => {
  cam = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(frame);
  });
  await new Promise<void>((r) => cam.listen(0, '127.0.0.1', r));
  fake = new FakeMoonraker();
  fake.webcams = [{ name: 'cam', enabled: true, stream_url: '/stream', snapshot_url: `http://127.0.0.1:${(cam.address() as AddressInfo).port}/snap` }];
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
  const start = Date.now();
  while ((await printer()).webcams.length === 0 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
});

afterAll(async () => {
  await app.close();
  await fake.stop();
  cam.close();
});

describe('bed check', () => {
  it('needs a region and a picture of the empty bed', async () => {
    expect((await api(`/api/printers/${printerId}/bed-check`, { method: 'PUT', body: { mode: 'auto', region: null } })).status).toBe(400);
    const info = await api<BedCheckInfo>(`/api/printers/${printerId}/bed-check`, { method: 'PUT', body: { mode: 'confirm', region } });
    expect(info.body.state).toMatchObject({ mode: 'confirm', ready: false });
    expect((await api(`/api/printers/${printerId}/bed-check/run`, { body: {} })).status).toBe(400);

    expect((await api(`/api/printers/${printerId}/bed-check/references`, { body: {} })).status).toBe(201);
    const after = (await api<BedCheckInfo>(`/api/printers/${printerId}/bed-check`)).body;
    expect(after.references).toHaveLength(1);
    expect(after.state.ready).toBe(true);
    const img = await fetch(`${base}/api/printers/${printerId}/bed-check/references/${after.references[0]!.id}`, { headers: { cookie } });
    expect(img.headers.get('content-type')).toBe('image/jpeg');
  });

  it('tells an empty bed (also in other light) from one with a part, and asks in confirm mode', async () => {
    frame = scene({ brightness: 0.8 });
    expect((await run()).verdict).toBe('clear');
    expect((await printer()).bedCheck).toMatchObject({ mode: 'confirm', suggestClear: true });

    // "No, still occupied" stops asking for a while.
    await api(`/api/printers/${printerId}/bed-check/reject`, { body: {} });
    expect((await printer()).bedCheck?.suggestClear).toBe(false);

    frame = scene({ part: [230, 110, 30] });
    const busy = await run();
    expect(busy.verdict).toBe('occupied');
    expect(busy.changed).toBeGreaterThan(0);
    const overlay = await fetch(`${base}/api/printers/${printerId}/bed-check/overlay`, { headers: { cookie } });
    expect(overlay.headers.get('content-type')).toBe('image/png');
    expect((await printer()).bedClear).toBe(false);
  });

  it('a confirmed empty bed overrules the camera and is learned', async () => {
    // The camera is wrong: something it takes for a part belongs to the empty bed.
    frame = scene({ part: [60, 60, 60] });
    expect((await run()).verdict).not.toBe('clear');
    expect((await api(`/api/printers/${printerId}/bed-clear`, { body: { start: false } })).status).toBe(200);
    const info = (await api<BedCheckInfo>(`/api/printers/${printerId}/bed-check`)).body;
    expect(info.references.map((r) => r.source)).toEqual(['manual', 'confirmed']);
    // A second confirmation of the same picture adds nothing.
    await api(`/api/printers/${printerId}/bed-clear`, { body: { start: false } });
    expect((await api<BedCheckInfo>(`/api/printers/${printerId}/bed-check`)).body.references).toHaveLength(2);
  });

  it('auto mode releases the bed after two clear checks in a row', async () => {
    // A print occupies the bed again.
    fake.update({ print_stats: { state: 'printing', filename: 'a.gcode' } });
    const until = async (ok: (p: PrinterSummary) => boolean) => {
      const end = Date.now() + 3000;
      while (!ok(await printer())) {
        if (Date.now() > end) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await until((p) => p.status.printState === 'printing');
    fake.update({ print_stats: { state: 'complete', filename: 'a.gcode' } });
    await until((p) => p.status.printState === 'complete' && !p.bedClear);

    await api(`/api/printers/${printerId}/bed-check`, { method: 'PUT', body: { mode: 'auto', region } });
    frame = scene({ part: [230, 110, 30] });
    expect((await run()).verdict).toBe('occupied');
    frame = scene();
    expect((await run()).verdict).toBe('clear');
    expect((await printer()).bedClear).toBe(false);
    expect((await run()).verdict).toBe('clear');
    await until((p) => p.bedClear);
    // Learned images come only from people, not from the automatic release.
    expect((await api<BedCheckInfo>(`/api/printers/${printerId}/bed-check`)).body.references).toHaveLength(2);
  });

  it('switching the camera drops the pictures of the old one', async () => {
    const info = await api<BedCheckInfo>(`/api/printers/${printerId}/bed-check`, { method: 'PUT', body: { mode: 'confirm', region, webcam: 1 } });
    expect(info.body.references).toHaveLength(0);
    expect(info.body.state.ready).toBe(false);
  });
});
