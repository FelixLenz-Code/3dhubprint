import { and, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { recoveryCodes, sessions, users, auditLog } from '../db/schema.js';
import { SecretBox, randomToken, sha256 } from '../crypto.js';
import { hashPassword, verifyPassword, burnPasswordCheck } from './password.js';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  totpProvisioning,
  verifyTotp,
} from './totp.js';
import type { Me, SessionInfo } from '@printhub/shared';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

export class AuthError extends Error {
  constructor(
    public readonly code:
      | 'invalid_credentials'
      | 'totp_required'
      | 'invalid_code'
      | 'locked'
      | 'setup_done'
      | 'totp_not_pending'
      | 'totp_already_enabled'
      | 'totp_not_enabled',
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

type UserRow = typeof users.$inferSelect;

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly sessionTtlMs: number,
    private readonly issuer: string,
  ) {}

  needsSetup(): boolean {
    const row = this.db.select({ n: sql<number>`count(*)` }).from(users).get();
    return (row?.n ?? 0) === 0;
  }

  async setup(username: string, password: string, meta: RequestMeta): Promise<UserRow> {
    const passwordHash = await hashPassword(password);
    // Re-check inside a transaction so two concurrent setup requests can't both win.
    const user = this.db.transaction((tx) => {
      const count = tx.select({ n: sql<number>`count(*)` }).from(users).get()?.n ?? 0;
      if (count > 0) throw new AuthError('setup_done', 'Einrichtung bereits abgeschlossen', 409);
      return tx
        .insert(users)
        .values({ username, passwordHash, role: 'admin', createdAt: Date.now() })
        .returning()
        .get();
    });
    this.audit(user.id, 'setup', null, meta);
    return user;
  }

  /** Verifies credentials (+ 2FA) and returns the user. Throws AuthError otherwise. */
  async login(username: string, password: string, code: string | undefined, meta: RequestMeta) {
    const user = this.findByUsername(username);
    if (!user) {
      await burnPasswordCheck(password);
      this.audit(null, 'login_failed', `unknown user ${username}`, meta);
      throw new AuthError('invalid_credentials', 'Benutzername oder Passwort falsch', 401);
    }

    const now = Date.now();
    if (user.lockedUntil && user.lockedUntil > now) {
      throw new AuthError('locked', 'Konto vorübergehend gesperrt. Bitte später erneut versuchen.', 429);
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      this.registerFailure(user, meta, 'bad password');
      throw new AuthError('invalid_credentials', 'Benutzername oder Passwort falsch', 401);
    }

    if (user.totpEnabled) {
      if (!code) throw new AuthError('totp_required', 'Bestätigungscode erforderlich', 401);
      if (!this.checkSecondFactor(user, code)) {
        this.registerFailure(user, meta, 'bad 2fa code');
        throw new AuthError('invalid_code', 'Code ungültig', 401);
      }
    }

    this.db.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, user.id)).run();
    this.audit(user.id, 'login', null, meta);
    return user;
  }

  createSession(userId: number, meta: RequestMeta): { token: string; expiresAt: number } {
    const token = randomToken(32);
    const now = Date.now();
    const expiresAt = now + this.sessionTtlMs;
    this.db
      .insert(sessions)
      .values({
        id: sha256(token),
        userId,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
        userAgent: meta.userAgent?.slice(0, 256) ?? null,
        ip: meta.ip,
      })
      .run();
    return { token, expiresAt };
  }

  /** Returns the session's user, sliding the expiry forward. */
  validateSession(token: string): { user: UserRow; sessionId: string } | null {
    const id = sha256(token);
    const now = Date.now();
    const row = this.db
      .select()
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now)))
      .get();
    if (!row) return null;
    if (now - row.sessions.lastSeenAt > SESSION_TOUCH_INTERVAL_MS) {
      this.db
        .update(sessions)
        .set({ lastSeenAt: now, expiresAt: now + this.sessionTtlMs })
        .where(eq(sessions.id, id))
        .run();
    }
    return { user: row.users, sessionId: id };
  }

  revokeSession(sessionId: string, userId: number): boolean {
    const res = this.db
      .delete(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .run();
    return res.changes > 0;
  }

  revokeOtherSessions(userId: number, keepSessionId: string): void {
    this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
      .run();
  }

  listSessions(userId: number, currentSessionId: string): SessionInfo[] {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, Date.now())))
      .all()
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((s) => ({
        // The id is the token's hash: enough to address a session, useless as a credential.
        id: s.id,
        current: s.id === currentSessionId,
        userAgent: s.userAgent,
        ip: s.ip,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
      }));
  }

  purgeExpiredSessions(): void {
    this.db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
  }

  async changePassword(user: UserRow, current: string, next: string, keepSessionId: string, meta: RequestMeta) {
    if (!(await verifyPassword(user.passwordHash, current))) {
      throw new AuthError('invalid_credentials', 'Aktuelles Passwort falsch', 401);
    }
    const passwordHash = await hashPassword(next);
    this.db.update(users).set({ passwordHash }).where(eq(users.id, user.id)).run();
    this.revokeOtherSessions(user.id, keepSessionId);
    this.audit(user.id, 'password_changed', null, meta);
  }

  /** Starts TOTP enrollment. Not active until confirmed with a valid code. */
  async beginTotp(user: UserRow) {
    if (user.totpEnabled) throw new AuthError('totp_already_enabled', '2FA ist bereits aktiv', 409);
    const secret = generateTotpSecret();
    this.db.update(users).set({ totpSecret: this.box.encrypt(secret) }).where(eq(users.id, user.id)).run();
    return totpProvisioning(secret, user.username, this.issuer);
  }

  confirmTotp(user: UserRow, code: string, meta: RequestMeta): string[] {
    if (user.totpEnabled) throw new AuthError('totp_already_enabled', '2FA ist bereits aktiv', 409);
    if (!user.totpSecret) throw new AuthError('totp_not_pending', 'Keine 2FA-Einrichtung gestartet', 409);
    const step = verifyTotp(this.box.decrypt(user.totpSecret), code);
    if (step === null) throw new AuthError('invalid_code', 'Code ungültig', 400);

    const codes = generateRecoveryCodes();
    this.db.transaction((tx) => {
      tx.update(users).set({ totpEnabled: true, totpLastStep: step }).where(eq(users.id, user.id)).run();
      tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id)).run();
      tx.insert(recoveryCodes)
        .values(codes.map((c) => ({ userId: user.id, codeHash: sha256(c) })))
        .run();
    });
    this.audit(user.id, 'totp_enabled', null, meta);
    return codes;
  }

  async disableTotp(user: UserRow, password: string, code: string, meta: RequestMeta) {
    if (!user.totpEnabled) throw new AuthError('totp_not_enabled', '2FA ist nicht aktiv', 409);
    if (!(await verifyPassword(user.passwordHash, password))) {
      throw new AuthError('invalid_credentials', 'Passwort falsch', 401);
    }
    if (!this.checkSecondFactor(user, code)) throw new AuthError('invalid_code', 'Code ungültig', 400);
    this.db.transaction((tx) => {
      tx.update(users)
        .set({ totpEnabled: false, totpSecret: null, totpLastStep: null })
        .where(eq(users.id, user.id))
        .run();
      tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id)).run();
    });
    this.audit(user.id, 'totp_disabled', null, meta);
  }

  remainingRecoveryCodes(userId: number): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(recoveryCodes)
        .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
        .get()?.n ?? 0
    );
  }

  toMe(user: UserRow): Me {
    return { id: user.id, username: user.username, role: user.role, totpEnabled: user.totpEnabled };
  }

  audit(userId: number | null, action: string, detail: string | null, meta: RequestMeta) {
    this.db.insert(auditLog).values({ at: Date.now(), userId, action, detail, ip: meta.ip }).run();
  }

  private findByUsername(username: string): UserRow | undefined {
    return this.db
      .select()
      .from(users)
      .where(sql`${users.username} = ${username} COLLATE NOCASE`)
      .get();
  }

  /** Accepts a TOTP code or an unused recovery code (consumed on success). */
  private checkSecondFactor(user: UserRow, code: string): boolean {
    const trimmed = code.replace(/\s/g, '');
    const secret = user.totpSecret ? this.tryDecrypt(user.totpSecret) : null;
    if (/^\d{6}$/.test(trimmed) && secret) {
      const step = verifyTotp(secret, trimmed);
      if (step === null || (user.totpLastStep !== null && step <= user.totpLastStep)) return false;
      this.db.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id)).run();
      return true;
    }
    const hash = sha256(normalizeRecoveryCode(code));
    const res = this.db
      .update(recoveryCodes)
      .set({ usedAt: Date.now() })
      .where(
        and(eq(recoveryCodes.userId, user.id), eq(recoveryCodes.codeHash, hash), isNull(recoveryCodes.usedAt)),
      )
      .run();
    return res.changes > 0;
  }

  /** A changed APP_SECRET must not lock users out: recovery codes (hashed, not encrypted) still work. */
  private tryDecrypt(box: string): string | null {
    try {
      return this.box.decrypt(box);
    } catch {
      return null;
    }
  }

  private registerFailure(user: UserRow, meta: RequestMeta, reason: string) {
    const failed = user.failedLogins + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    this.db
      .update(users)
      .set({ failedLogins: lock ? 0 : failed, lockedUntil: lock ? Date.now() + LOCKOUT_MS : user.lockedUntil })
      .where(eq(users.id, user.id))
      .run();
    this.audit(user.id, lock ? 'account_locked' : 'login_failed', reason, meta);
  }
}
