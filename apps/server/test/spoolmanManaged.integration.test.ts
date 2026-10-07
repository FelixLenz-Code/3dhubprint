import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { FakeSpoolman } from './fakeSpoolman.js';

let app: FastifyInstance;
let spoolman: FakeSpoolman;
let base: string;
let cookie: string;

const api = async (p: string, init: { method?: string; body?: unknown } = {}) => {
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
  const res = await fetch(base + p, {
    method,
    headers: { cookie, ...(init.body !== undefined && { 'content-type': 'application/json' }), ...(method !== 'GET' && { 'x-printhub-request': '1' }) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  spoolman = new FakeSpoolman();
  // As written by "printhub spoolman on": fixed internal address plus the LAN address for browsers.
  process.env.SPOOLMAN_URL = `${await spoolman.start()}/`;
  process.env.SPOOLMAN_WEB_URL = 'http://192.168.1.10:7912';
  const { buildApp } = await import('../src/app.js');
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const res = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-printhub-request': '1' },
    body: JSON.stringify({ username: 'admin', password: 'ein-sehr-langes-passwort' }),
  });
  cookie = res.headers.get('set-cookie')!.split(';')[0]!;
});

afterAll(async () => {
  await app.close();
  await spoolman.stop();
  delete process.env.SPOOLMAN_URL;
  delete process.env.SPOOLMAN_WEB_URL;
});

describe('Spoolman installed alongside PrintHub', () => {
  it('is connected without setup and its address cannot be changed', async () => {
    const status = (await api('/api/spoolman/status')).body;
    expect(status).toMatchObject({ configured: true, managed: true, reachable: true, webUrl: 'http://192.168.1.10:7912' });
    expect(status.url).not.toMatch(/\/$/);
    expect((await api('/api/spoolman/url', { method: 'PUT', body: { url: 'http://other:7912' } })).status).toBe(409);
    expect((await api('/api/spoolman/url', { method: 'DELETE' })).status).toBe(409);
    expect((await api('/api/spoolman/spools')).body).toHaveLength(2);
  });
});
