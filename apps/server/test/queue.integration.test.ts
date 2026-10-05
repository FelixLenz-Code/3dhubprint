import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { JobInfo, PrinterSummary } from '@printhub/shared';
import { buildApp } from '../src/app.js';
import { FakeMoonraker } from './fakeMoonraker.js';

const USER_FIX = path.resolve(import.meta.dirname, '../../../fixtures/orca-2.4.2/user/ender3s1plus');
let app: FastifyInstance;
let fake: FakeMoonraker;
let base: string;
let cookie: string;
let printerId: number;
let modelId: number;

async function api(p: string, init: { method?: string; body?: unknown; form?: FormData } = {}) {
  const method = init.method ?? (init.body !== undefined || init.form ? 'POST' : 'GET');
  const res = await fetch(base + p, {
    method,
    headers: { cookie, ...(init.body !== undefined && { 'content-type': 'application/json' }), ...(method !== 'GET' && { 'x-printhub-request': '1' }) },
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  return { status: res.status, body: await res.json() };
}

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
}

const job = async (id: number) => (await api(`/api/jobs/${id}`)).body as JobInfo;
const printer = async () => (await api(`/api/printers/${printerId}`)).body as PrinterSummary;

async function slicedJob(): Promise<number> {
  const r = await api('/api/jobs', { body: { items: [{ modelId }], printerId, process: 'Tuned (Claude) - 0.20mm Standard', filament: 'Tuned (Claude) - PLA' } });
  await until(async () => (await job(r.body.id)).status === 'sliced');
  return r.body.id;
}

/** Simulates Klipper finishing the file that is currently printing. */
async function finishPrint(result: 'complete' | 'cancelled' | 'error' = 'complete') {
  const file = String(fake.uploads.at(-1)?.filename);
  fake.update({ print_stats: { state: 'printing', filename: file } });
  await until(async () => (await printer()).status.printState === 'printing');
  fake.update({ print_stats: { state: result, filename: file } });
  await until(async () => (await printer()).status.printState === result);
}

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
  await until(async () => (await printer()).status.connection === 'connected');

  const form = new FormData();
  for (const k of ['machine', 'process', 'filament']) {
    for (const f of fs.readdirSync(path.join(USER_FIX, k))) form.append('files', new Blob([new Uint8Array(fs.readFileSync(path.join(USER_FIX, k, f)))]), f);
  }
  await api('/api/slicer/profiles/import', { form });
  await api(`/api/printers/${printerId}/profiles`, { method: 'PUT', body: { machine: 'Tuned (Claude) - Ender-3 S1 Plus 0.4', process: [], filament: [] } });
  const stl = Buffer.alloc(84 + 50);
  stl.writeUInt32LE(1, 80);
  [0, 0, 0, 10, 0, 0, 0, 10, 0].forEach((v, i) => stl.writeFloatLE(v, 84 + 12 + i * 4));
  const mf = new FormData();
  mf.append('file', new Blob([new Uint8Array(stl)]), 'dreieck.stl');
  modelId = (await api('/api/models', { form: mf })).body.id;
});

afterAll(async () => {
  await app.close();
  await fake.stop();
});

describe('print queue', () => {
  it('waits for the bed to be confirmed empty, then starts the next job', async () => {
    expect((await printer()).bedClear).toBe(false);
    const a = await slicedJob();
    const queued = (await api(`/api/jobs/${a}/enqueue`, { body: {} })).body as JobInfo;
    expect(queued).toMatchObject({ status: 'waiting', queuePosition: 1 });
    await new Promise((r) => setTimeout(r, 200));
    expect((await job(a)).status).toBe('waiting'); // bed not confirmed: nothing starts
    const uploadsBefore = fake.uploads.length;

    const r = await api(`/api/printers/${printerId}/bed-clear`, { body: { start: true } });
    expect(r.body.started).toMatchObject({ id: a, status: 'printing' });
    expect(fake.uploads.length).toBe(uploadsBefore + 1);
    expect(fake.uploads.at(-1)?.fields.print).toBe('true');
    expect((await printer()).bedClear).toBe(false);
  });

  it('marks the job done when the print completes and keeps the bed occupied', async () => {
    await finishPrint('complete');
    const done = await until(async () => {
      const list = (await api('/api/jobs')).body as JobInfo[];
      return list.find((j) => j.status === 'done');
    });
    expect(done.finishedAt).toBeTypeOf('number');
    expect((await printer()).bedClear).toBe(false);
  });

  it('keeps the order, can reorder and dequeue, and starts the head of the queue', async () => {
    const [b, c, d] = [await slicedJob(), await slicedJob(), await slicedJob()];
    for (const id of [b, c, d]) await api(`/api/jobs/${id}/enqueue`, { body: {} });
    await api(`/api/jobs/${d}/move`, { body: { direction: 'up' } });
    const order = async () =>
      ((await api('/api/jobs')).body as JobInfo[]).filter((j) => j.status === 'waiting').sort((x, y) => x.queuePosition! - y.queuePosition!).map((j) => j.id);
    expect(await order()).toEqual([b, d, c]);
    await api(`/api/jobs/${b}/dequeue`, { body: {} });
    expect(await order()).toEqual([d, c]);
    expect((await job(b)).status).toBe('sliced');

    const r = await api(`/api/printers/${printerId}/bed-clear`, { body: { start: true } });
    expect(r.body.started?.id).toBe(d);
    expect((await job(c)).queuePosition).toBe(1);
  });

  it('records a failed print and does not start the next job by itself', async () => {
    await finishPrint('error');
    const list = (await api('/api/jobs')).body as JobInfo[];
    expect(list.find((j) => j.status === 'print_failed')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 200));
    expect(list.find((j) => j.status === 'waiting')).toBeTruthy();
    expect(((await api('/api/jobs')).body as JobInfo[]).some((j) => j.status === 'printing')).toBe(false);
  });

  it('only confirms the bed when asked not to start', async () => {
    const r = await api(`/api/printers/${printerId}/bed-clear`, { body: { start: false } });
    expect(r.body.started).toBeNull();
    expect((await printer()).bedClear).toBe(true);
  });

  it('rejects enqueueing jobs that are not sliced', async () => {
    expect((await api('/api/jobs/99999/enqueue', { body: {} })).status).toBe(404);
  });
});
