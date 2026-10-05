import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { zipSync } from 'fflate';
import type { ModelInfo, ThingDetails, ThingSearchPage } from '@printhub/shared';

const TOKEN = 'tv-token-1234567890';

function stl(size: number): Buffer {
  const b = Buffer.alloc(84 + 50);
  b.writeUInt32LE(1, 80);
  [0, 0, 0, size, 0, 0, 0, size, 0].forEach((v, i) => b.writeFloatLE(v, 84 + 12 + i * 4));
  return b;
}

/** Fake Thingiverse API + CDN. */
const cdnAuthHeaders: (string | undefined)[] = [];
let fakeBase = '';
const fake = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname.startsWith('/cdn/')) {
    cdnAuthHeaders.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end(url.pathname.endsWith('.zip') ? Buffer.from(zipSync({ 'teile/a.stl': new Uint8Array(stl(10)), 'teile/b.stl': new Uint8Array(stl(20)), 'liesmich.txt': new Uint8Array([65]) })) : stl(30));
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'Unauthorized' });
  if (url.pathname === '/featured/') {
    return json(200, [{ id: 7, name: 'Featured Ding', creator: { name: 'Ben' }, like_count: 1 }]);
  }
  // Suggestions: a search without a term only knows "popular"; "newest" falls back to /newest/.
  if (url.pathname === '/search/' && url.searchParams.get('sort') !== 'popular') return json(404, { error: 'not found' });
  if (url.pathname === '/newest/') return json(200, [{ id: 8, name: 'Neues Ding' }]);
  if (url.pathname.startsWith('/search/')) {
    return json(200, {
      total: 2,
      hits: [
        { id: 1, name: 'Halter', preview_image: 'https://cdn.thingiverse.com/renders/x.jpg', creator: { name: 'Anna' }, like_count: 5, download_count: 9 },
        { id: 2, name: 'Nope', is_nsfw: true },
      ],
    });
  }
  if (url.pathname === '/things/1') {
    return json(200, { id: 1, name: 'Halter', license: 'Creative Commons - Attribution', creator: { name: 'Anna', public_url: 'https://www.thingiverse.com/Anna' }, description: '<p>Ein <b>Halter</b></p>' });
  }
  if (url.pathname === '/things/1/files') {
    return json(200, [
      { id: 11, name: 'halter.stl', size: 134 },
      { id: 12, name: 'set.zip', size: 300 },
      { id: 13, name: 'anleitung.pdf', size: 10 },
    ]);
  }
  if (url.pathname === '/things/1/images') return json(200, [{ sizes: [{ type: 'display', size: 'large', url: 'https://cdn.thingiverse.com/a.jpg' }] }]);
  const dl = /^\/files\/(\d+)\/download$/.exec(url.pathname);
  if (dl) {
    res.writeHead(302, { location: `${fakeBase.replace('127.0.0.1', 'localhost')}/cdn/${dl[1] === '12' ? 'set.zip' : 'halter.stl'}` });
    return res.end();
  }
  json(404, { error: 'not found' });
});

let app: FastifyInstance;
let base: string;
let cookie: string;

async function api<T = any>(p: string, init: { method?: string; body?: unknown } = {}) {
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
  const res = await fetch(base + p, {
    method,
    headers: { cookie, ...(init.body !== undefined && { 'content-type': 'application/json' }), ...(method !== 'GET' && { 'x-printhub-request': '1' }) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.THINGIVERSE_API = fakeBase;
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
  fake.close();
});

describe('Thingiverse', () => {
  it('requires a valid token, verified before it is stored', async () => {
    expect((await api('/api/thingiverse/status')).body).toEqual({ configured: false });
    expect((await api('/api/thingiverse/search?q=halter')).status).toBe(409);
    const bad = await api('/api/thingiverse/token', { method: 'PUT', body: { token: 'falscher-token-123' } });
    expect(bad.status).toBe(400);
    expect((await api('/api/thingiverse/status')).body.configured).toBe(false);
    expect((await api('/api/thingiverse/token', { method: 'PUT', body: { token: TOKEN } })).status).toBe(200);
    expect((await api('/api/thingiverse/status')).body.configured).toBe(true);
  });

  it('searches, hides NSFW results and proxies images', async () => {
    const r = await api<ThingSearchPage>('/api/thingiverse/search?q=halter&sort=popular');
    expect(r.body.hits).toEqual([
      {
        id: 1,
        name: 'Halter',
        thumbnail: '/api/thingiverse/image?url=' + encodeURIComponent('https://cdn.thingiverse.com/renders/x.jpg'),
        creator: 'Anna',
        likes: 5,
        downloads: 9,
        url: 'https://www.thingiverse.com/thing:1',
      },
    ]);
  });

  it('suggests things without a search term, with fallback to the classic lists', async () => {
    const popular = await api<ThingSearchPage>('/api/thingiverse/suggestions?list=popular');
    expect(popular.status).toBe(200);
    expect(popular.body.hits.map((h) => h.name)).toEqual(['Halter']);
    const newest = await api<ThingSearchPage>('/api/thingiverse/suggestions?list=newest');
    expect(newest.body.hits.map((h) => h.name)).toEqual(['Neues Ding']);
    const featured = await api<ThingSearchPage>('/api/thingiverse/suggestions?list=featured&page=2');
    expect(featured.body).toMatchObject({ page: 2, total: 25, hits: [{ id: 7, name: 'Featured Ding', creator: 'Ben' }] });
    expect((await api('/api/thingiverse/suggestions?list=nonsense')).status).toBe(400);
  });

  it('shows details with license and marks importable files', async () => {
    const d = (await api<ThingDetails>('/api/thingiverse/things/1')).body;
    expect(d.license).toBe('Creative Commons - Attribution');
    expect(d.description).toBe('Ein Halter');
    expect(d.files.map((f) => [f.name, f.importable])).toEqual([
      ['halter.stl', true],
      ['set.zip', true],
      ['anleitung.pdf', false],
    ]);
  });

  it('imports files (zip unpacked) with source, license and author, without leaking the token to the CDN', async () => {
    const r = await api<ModelInfo[]>('/api/thingiverse/things/1/import', { body: { fileIds: [11, 12] } });
    expect(r.status).toBe(200);
    expect(r.body.map((m) => m.name)).toEqual(['halter', 'a', 'b']);
    expect(r.body[0]).toMatchObject({ source: 'thingiverse', sourceUrl: 'https://www.thingiverse.com/thing:1', license: 'Creative Commons - Attribution', author: 'Anna' });
    expect(cdnAuthHeaders).toEqual([undefined, undefined]);
    expect((await api('/api/thingiverse/things/1/import', { body: { fileIds: [13] } })).status).toBe(400);
  });

  it('only proxies https images from thingiverse.com', async () => {
    for (const url of ['https://evil.example/x.jpg', 'http://cdn.thingiverse.com/x.jpg', 'https://thingiverse.com.evil.example/x.jpg', 'file:///etc/passwd']) {
      expect((await api(`/api/thingiverse/image?url=${encodeURIComponent(url)}`)).status).toBe(400);
    }
  });
});
