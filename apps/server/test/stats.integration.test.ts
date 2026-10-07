import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { CostSettings, PrintRecordPage, PrintStats, PrinterSpool, PrinterSummary, SlicerProfileInfo, SpoolInfo } from '@printhub/shared';
import { buildApp } from '../src/app.js';
import { FakeMoonraker } from './fakeMoonraker.js';
import { FakeSpoolman } from './fakeSpoolman.js';

const USER_FIX = path.resolve(import.meta.dirname, '../../../fixtures/orca-2.4.2/user/ender3s1plus');
const DAY = 24 * 3600 * 1000;
let app: FastifyInstance;
let fake: FakeMoonraker;
let spoolman: FakeSpoolman;
let spoolmanUrl: string;
let base: string;
let cookie: string;
let printerId: number;

async function api<T = any>(p: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<{ status: number; body: T }> {
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

const sec = (ms: number) => ms / 1000;
const historyJob = (id: string, startMs: number, extra: Record<string, unknown> = {}) => ({
  job_id: id,
  filename: `${id}.gcode`,
  status: 'completed',
  start_time: sec(startMs),
  end_time: sec(startMs + 3600_000),
  print_duration: 3000,
  total_duration: 3600,
  filament_used: 10_000,
  exists: true,
  metadata: { filament_type: 'PLA', filament_name: 'Tuned (Claude) - PLA', filament_total: 10_000, filament_weight_total: 30, filament_colors: ['#26A69A'] },
  auxiliary_data: [],
  ...extra,
});

const printer = async () => (await api<PrinterSummary>(`/api/printers/${printerId}`)).body;
const stats = async (q = 'range=30d&tz=Europe/Berlin') => (await api<PrintStats>(`/api/stats?${q}`)).body;

beforeAll(async () => {
  fake = new FakeMoonraker();
  const now = Date.now();
  fake.history = [
    historyJob('0004', now - 2 * 3600_000, { status: 'in_progress', end_time: null }),
    historyJob('0003', now - 1 * DAY, { status: 'cancelled', filament_used: 5000 }),
    // Printed elsewhere, no slicer weight: grams from density; unknown filament → default price.
    historyJob('0002', now - 3 * DAY, { metadata: { filament_type: 'PETG' } }),
    historyJob('0001', now - 400 * DAY),
  ];
  const fakeUrl = await fake.start();
  spoolman = new FakeSpoolman();
  spoolmanUrl = await spoolman.start();
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const res = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-printhub-request': '1' },
    body: JSON.stringify({ username: 'admin', password: 'ein-sehr-langes-passwort' }),
  });
  cookie = res.headers.get('set-cookie')!.split(';')[0]!;

  const form = new FormData();
  for (const f of fs.readdirSync(path.join(USER_FIX, 'filament'))) form.append('files', new Blob([new Uint8Array(fs.readFileSync(path.join(USER_FIX, 'filament', f)))]), f);
  await api('/api/slicer/profiles/import', { form });

  printerId = (await api('/api/printers', { body: { name: 'Fake', url: fakeUrl } })).body.id;
  await until(async () => (await printer()).status.connection === 'connected');
});

afterAll(async () => {
  await app.close();
  await fake.stop();
  await spoolman.stop();
});

describe('print history and statistics', () => {
  it('mirrors the Moonraker history once the printer is idle', async () => {
    const page = await until(async () => {
      const r = (await api<PrintRecordPage>('/api/stats/prints')).body;
      return r.total === 4 && r;
    });
    const [running, cancelled, petg, old] = page.prints;
    expect(running).toMatchObject({ outcome: 'in_progress', printerName: 'Fake' });
    expect(cancelled).toMatchObject({ outcome: 'cancelled', filamentG: 15, color: '#26A69A' }); // 5000 mm × 30 g / 10000 mm
    expect(petg!.filamentG).toBeCloseTo(Math.PI * 0.875 ** 2 * 10_000 * 1.27 / 1000, 3);
    expect(petg!.priceSource).toBe('default');
    expect(old!.outcome).toBe('completed');
  });

  it('prices material from the filament profile, electricity from the settings', async () => {
    const pla = (await api<SlicerProfileInfo[]>('/api/slicer/profiles')).body.find((p) => p.name === 'Tuned (Claude) - PLA')!;
    const page = (await api<PrintRecordPage>('/api/stats/prints')).body;
    const cancelled = page.prints[1]!;
    const perKg = Number(pla.summary.cost);
    expect(cancelled.priceSource).toBe(perKg > 0 ? 'profile' : 'default');
    expect(cancelled.cost.material).toBeCloseTo(0.015 * (perKg > 0 ? perKg : 20), 6);
    // Defaults: 120 W, 0.35 €/kWh, one hour busy.
    expect(cancelled.cost.energy).toBeCloseTo(0.12 * 0.35, 6);
    expect(cancelled.cost.wear).toBe(0);
  });

  it('aggregates a range in local days and leaves out running prints', async () => {
    const s = await stats();
    expect(s.bucket).toBe('day');
    expect(s.buckets).toHaveLength(30);
    expect(s.totals).toMatchObject({ prints: 2, completed: 1, cancelled: 1, failed: 0, defaultPriced: 1 });
    expect(s.totals.printTime).toBe(6000);
    expect(s.byMaterial.map((m) => m.label).sort()).toEqual(['PETG', 'PLA']);
    expect(s.byPrinter).toEqual([expect.objectContaining({ label: 'Fake', prints: 2 })]);
    expect(s.buckets.reduce((n, b) => n + b.prints, 0)).toBe(2);

    const all = await stats('range=all&tz=Europe/Berlin');
    expect(all.bucket).toBe('month');
    expect(all.totals.prints).toBe(3);
    expect(all.buckets.length).toBeGreaterThanOrEqual(13);
    expect((await stats('range=7d&tz=Nowhere/Invalid')).buckets).toHaveLength(7);
  });

  it('recomputes costs when the settings change', async () => {
    const settings: CostSettings = { electricityPrice: 0.5, filamentPrice: 40, defaultPowerW: 100, printers: { [printerId]: { powerW: 200, hourlyCost: 1 } } };
    expect((await api('/api/costs', { method: 'PUT', body: settings })).body).toEqual(settings);
    const petg = (await api<PrintRecordPage>('/api/stats/prints')).body.prints[2]!;
    expect(petg.cost.energy).toBeCloseTo(0.2 * 0.5, 6);
    expect(petg.cost.wear).toBeCloseTo(3000 / 3600, 6);
    expect(petg.cost.material).toBeCloseTo((petg.filamentG! / 1000) * 40, 6);
    expect((await api('/api/costs', { method: 'PUT', body: { ...settings, electricityPrice: -1 } })).status).toBe(400);
  });

  it('picks up new history entries after a print finishes', async () => {
    fake.history.unshift(historyJob('0005', Date.now()));
    fake.update({ print_stats: { state: 'printing', filename: '0005.gcode' } });
    await until(async () => (await printer()).status.printState === 'printing');
    fake.history[0] = { ...fake.history[0]!, filament_used: 2000 };
    fake.history[1] = { ...fake.history[1]!, status: 'completed' }; // the earlier in_progress entry ended meanwhile
    fake.update({ print_stats: { state: 'complete', filename: '0005.gcode', filament_used: 2000 } });
    const page = await until(
      async () => {
        const r = (await api<PrintRecordPage>('/api/stats/prints')).body;
        return r.total === 5 && r.prints[1]?.outcome === 'completed' && r;
      },
      8000,
    );
    expect(page.prints[0]).toMatchObject({ filename: '0005.gcode', filamentMm: 2000 });
  });
});

describe('Spoolman', () => {
  it('rejects addresses that are not a Spoolman server', async () => {
    expect((await api('/api/spoolman/url', { method: 'PUT', body: { url: 'http://127.0.0.1:1' } })).status).toBe(502);
    expect((await api('/api/spoolman/status')).body).toEqual({ configured: false, url: null });
    expect((await api(`/api/printers/${printerId}/spool`, { method: 'PUT', body: { spoolId: 1 } })).status).toBe(409);
  });

  it('connects and lists spools with price per kg', async () => {
    expect((await api('/api/spoolman/url', { method: 'PUT', body: { url: `${spoolmanUrl}/` } })).body).toMatchObject({ reachable: true, version: '0.22.1', url: spoolmanUrl });
    const spools = (await api<SpoolInfo[]>('/api/spoolman/spools')).body;
    expect(spools[0]).toMatchObject({ id: 1, name: 'PLA Basic', vendor: 'Bambu', color: '#ff8800', remainingG: 820, pricePerKg: 30, location: 'Regal' });
    expect(spools[1]).toMatchObject({ id: 2, vendor: null, pricePerKg: 25 });
  });

  it('remembers the active spool and books usage after a print (PrintHub tracking)', async () => {
    const set = (await api<PrinterSpool>(`/api/printers/${printerId}/spool`, { method: 'PUT', body: { spoolId: 1 } })).body;
    expect(set).toMatchObject({ tracking: 'printhub', spool: { id: 1 } });
    expect((await api(`/api/printers/${printerId}/spool`, { method: 'PUT', body: { spoolId: 99 } })).status).toBe(404);

    fake.history.unshift(historyJob('0006', Date.now(), { status: 'in_progress', end_time: null }));
    fake.update({ print_stats: { state: 'printing', filename: '0006.gcode', filament_used: 0 } });
    await until(async () => (await printer()).status.printState === 'printing');
    fake.history[0] = { ...fake.history[0]!, status: 'completed', filament_used: 1234 };
    fake.update({ print_stats: { state: 'complete', filament_used: 1234 } });

    await until(async () => spoolman.uses.length === 1);
    expect(spoolman.uses[0]).toEqual({ id: 1, body: { use_length: 1234 } });
    const p = await until(
      async () => {
        const r = (await api<PrintRecordPage>('/api/stats/prints')).body.prints[0];
        return r?.filename === '0006.gcode' && r.outcome === 'completed' && r;
      },
      8000,
    );
    expect(p).toMatchObject({ spool: { id: 1, name: '#1 Bambu PLA Basic' }, priceSource: 'spool' });
    expect(p.cost.material).toBeCloseTo((p.filamentG! / 1000) * 30, 6);
  });

  it('creates spools of a new filament (reusing the vendor) and makes the first one active', async () => {
    const r = await api<SpoolInfo[]>('/api/spoolman/spools', {
      body: {
        filament: { vendor: 'bambu', name: 'PLA Matte Weiß', material: 'PLA', color: '#FFFFFF', density: 1.24, weight: 1000, spoolWeight: 250, price: 22 },
        count: 2,
        location: 'Regal 2',
        printerId,
      },
    });
    expect(r.status).toBe(201);
    expect(r.body).toHaveLength(2);
    expect(r.body[0]).toMatchObject({ name: 'PLA Matte Weiß', vendor: 'Bambu', color: '#ffffff', remainingG: 1000, pricePerKg: 22, location: 'Regal 2' });
    expect(spoolman.vendors).toHaveLength(1); // "bambu" matched the existing "Bambu"
    expect((await api<PrinterSpool>(`/api/printers/${printerId}/spool`)).body.spool?.id).toBe(r.body[0]!.id);

    const filaments = (await api('/api/spoolman/filaments')).body;
    expect(filaments).toEqual([expect.objectContaining({ name: 'PLA Matte Weiß', vendor: 'Bambu', weight: 1000, spoolWeight: 250, price: 22 })]);
    const more = (await api<SpoolInfo[]>('/api/spoolman/spools', { body: { filamentId: filaments[0].id, initialWeight: 500 } })).body;
    expect(more[0]).toMatchObject({ remainingG: 500, initialG: 500 });

    expect((await api('/api/spoolman/spools', { body: { filamentId: 1, filament: { name: 'x', material: 'PLA', density: 1 } } })).status).toBe(400);
    expect((await api('/api/spoolman/spools', { body: { filamentId: 99 } })).status).toBe(404);
  });

  it('records a weighed remaining weight and archives spools', async () => {
    const id = spoolman.spools.length;
    expect((await api<SpoolInfo>(`/api/spoolman/spools/${id}`, { method: 'PATCH', body: { remainingWeight: 321 } })).body).toMatchObject({ remainingG: 321, usedG: 179 });
    const active = (await api<PrinterSpool>(`/api/printers/${printerId}/spool`)).body.spool!.id;
    expect((await api<SpoolInfo>(`/api/spoolman/spools/${active}`, { method: 'PATCH', body: { archived: true } })).body.archived).toBe(true);
    expect((await api<PrinterSpool>(`/api/printers/${printerId}/spool`)).body.spool).toBeNull(); // no longer active
    expect((await api(`/api/spoolman/spools/${id}`, { method: 'PATCH', body: {} })).status).toBe(400);
  });

  it('leaves tracking to Moonraker when it has its own Spoolman integration', async () => {
    fake.components = ['history', 'spoolman'];
    await api(`/api/printers/${printerId}`, { method: 'PUT', body: { name: 'Fake', url: (await printer()).url } }); // reconnect
    await until(async () => (await printer()).status.connection === 'connected');
    const set = (await api<PrinterSpool>(`/api/printers/${printerId}/spool`, { method: 'PUT', body: { spoolId: 2 } })).body;
    expect(set).toMatchObject({ tracking: 'moonraker', spool: { id: 2 } });
    expect(fake.spoolId).toBe(2);
    expect(fake.callsOf('server.spoolman.post_spool_id').at(-1)?.params).toEqual({ spool_id: 2 });

    const before = spoolman.uses.length;
    fake.update({ print_stats: { state: 'printing', filename: 'x.gcode' } });
    await until(async () => (await printer()).status.printState === 'printing');
    fake.update({ print_stats: { state: 'complete', filament_used: 500 } });
    await until(async () => (await printer()).status.printState === 'complete');
    await new Promise((r) => setTimeout(r, 200));
    expect(spoolman.uses.length).toBe(before);
  });
});
