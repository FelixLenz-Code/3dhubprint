import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authenticator } from 'otplib';
import { openDb } from '../src/db/index.js';
import { SecretBox } from '../src/crypto.js';
import { AuthService } from '../src/auth/service.js';
import { normalizeRecoveryCode } from '../src/auth/totp.js';

const meta = { ip: '127.0.0.1', userAgent: 'test' };
const PW = 'ein-sehr-langes-passwort';

let auth: AuthService;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'printhub-test-'));
  const { db } = openDb(dir);
  auth = new AuthService(db, new SecretBox('x'.repeat(32)), 60_000, 'PrintHub');
});

describe('SecretBox', () => {
  it('round-trips and rejects tampering', () => {
    const box = new SecretBox('y'.repeat(32));
    const enc = box.encrypt('geheim');
    expect(box.decrypt(enc)).toBe('geheim');
    const parts = enc.split(':');
    parts[3] = Buffer.from('anders').toString('base64');
    expect(() => box.decrypt(parts.join(':'))).toThrow();
    expect(() => new SecretBox('z'.repeat(32)).decrypt(enc)).toThrow();
  });
});

describe('AuthService', () => {
  it('allows setup only once', async () => {
    expect(auth.needsSetup()).toBe(true);
    await auth.setup('admin', PW, meta);
    expect(auth.needsSetup()).toBe(false);
    await expect(auth.setup('other', PW, meta)).rejects.toMatchObject({ code: 'setup_done' });
  });

  it('creates and validates sessions, revocation ends them', async () => {
    const user = await auth.setup('admin', PW, meta);
    const { token } = auth.createSession(user.id, meta);
    const s = auth.validateSession(token);
    expect(s?.user.id).toBe(user.id);
    expect(auth.validateSession(token + 'x')).toBeNull();
    auth.revokeSession(s!.sessionId, user.id);
    expect(auth.validateSession(token)).toBeNull();
  });

  it('locks the account after 5 failed attempts', async () => {
    await auth.setup('admin', PW, meta);
    for (let i = 0; i < 5; i++) {
      await expect(auth.login('admin', 'falsch', undefined, meta)).rejects.toMatchObject({ code: 'invalid_credentials' });
    }
    await expect(auth.login('admin', PW, undefined, meta)).rejects.toMatchObject({ code: 'locked' });
  });

  it('enforces TOTP with replay protection and single-use recovery codes', async () => {
    let user = await auth.setup('admin', PW, meta);
    const { secret } = await auth.beginTotp(user);
    user = (await auth.login('admin', PW, undefined, meta));
    const code = authenticator.generate(secret);
    const recovery = auth.confirmTotp(user, code, meta);
    expect(recovery).toHaveLength(10);

    await expect(auth.login('admin', PW, undefined, meta)).rejects.toMatchObject({ code: 'totp_required' });
    // Same code again is a replay of the step used during confirmation.
    await expect(auth.login('admin', PW, code, meta)).rejects.toMatchObject({ code: 'invalid_code' });

    const rc = recovery[0]!;
    await expect(auth.login('Admin', PW, rc.toUpperCase().replace(/-/g, ' '), meta)).resolves.toBeTruthy();
    await expect(auth.login('admin', PW, rc, meta)).rejects.toMatchObject({ code: 'invalid_code' });
    expect(auth.remainingRecoveryCodes(user.id)).toBe(9);
  });
});

describe('changed APP_SECRET', () => {
  it('still accepts recovery codes when the TOTP secret can no longer be decrypted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'printhub-test-'));
    const { db } = openDb(dir);
    const before = new AuthService(db, new SecretBox('a'.repeat(32)), 60_000, 'PrintHub');
    const user = await before.setup('admin', PW, meta);
    const { secret } = await before.beginTotp(user);
    const codes = before.confirmTotp((await before.login('admin', PW, undefined, meta)), authenticator.generate(secret), meta);

    const after = new AuthService(db, new SecretBox('b'.repeat(32)), 60_000, 'PrintHub');
    await expect(after.login('admin', PW, '123456', meta)).rejects.toMatchObject({ code: 'invalid_code' });
    await expect(after.login('admin', PW, codes[0]!, meta)).resolves.toBeTruthy();
  });
});

describe('normalizeRecoveryCode', () => {
  it('accepts different spellings', () => {
    expect(normalizeRecoveryCode(' ABCD efgh-JKMN ')).toBe('abcd-efgh-jkmn');
  });
});
