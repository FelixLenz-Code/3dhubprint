import type { FastifyInstance } from 'fastify';
import {
  changePasswordSchema,
  loginSchema,
  setupSchema,
  totpConfirmSchema,
  totpDisableSchema,
  type AuthState,
} from '@printhub/shared';
import { AuthError, type AuthService } from './service.js';
import { clearSessionCookie, requestMeta, setSessionCookie } from './plugin.js';

export async function authRoutes(app: FastifyInstance, { auth }: { auth: AuthService }) {
  const strictLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.get('/state', async (req): Promise<AuthState> => {
    if (auth.needsSetup()) return { state: 'setup_required' };
    if (!req.auth) return { state: 'anonymous' };
    return { state: 'authenticated', user: auth.toMe(req.auth.user) };
  });

  app.post('/setup', { config: strictLimit }, async (req, reply) => {
    const body = setupSchema.parse(req.body);
    const meta = requestMeta(req);
    const user = await auth.setup(body.username, body.password, meta);
    const session = auth.createSession(user.id, meta);
    setSessionCookie(reply, session.token, session.expiresAt);
    return { user: auth.toMe(user) };
  });

  app.post('/login', { config: strictLimit }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const meta = requestMeta(req);
    const user = await auth.login(body.username, body.password, body.code || undefined, meta);
    const session = auth.createSession(user.id, meta);
    setSessionCookie(reply, session.token, session.expiresAt);
    return { user: auth.toMe(user) };
  });

  app.post('/logout', async (req, reply) => {
    if (req.auth) auth.revokeSession(req.auth.sessionId, req.auth.user.id);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.register(async (priv) => {
    priv.addHook('preHandler', app.requireAuth);

    priv.post('/password', { config: strictLimit }, async (req) => {
      const body = changePasswordSchema.parse(req.body);
      const { user, sessionId } = req.auth!;
      await auth.changePassword(user, body.currentPassword, body.newPassword, sessionId, requestMeta(req));
      return { ok: true };
    });

    priv.get('/sessions', async (req) => auth.listSessions(req.auth!.user.id, req.auth!.sessionId));

    priv.delete<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
      if (!auth.revokeSession(req.params.id, req.auth!.user.id)) return reply.code(404).send({ error: 'not_found' });
      if (req.params.id === req.auth!.sessionId) clearSessionCookie(reply);
      return { ok: true };
    });

    priv.post('/sessions/revoke-others', async (req) => {
      auth.revokeOtherSessions(req.auth!.user.id, req.auth!.sessionId);
      return { ok: true };
    });

    priv.get('/totp', async (req) => ({
      enabled: req.auth!.user.totpEnabled,
      recoveryCodesLeft: auth.remainingRecoveryCodes(req.auth!.user.id),
    }));

    priv.post('/totp/setup', async (req) => auth.beginTotp(req.auth!.user));

    priv.post('/totp/confirm', { config: strictLimit }, async (req) => {
      const body = totpConfirmSchema.parse(req.body);
      return { recoveryCodes: auth.confirmTotp(req.auth!.user, body.code, requestMeta(req)) };
    });

    priv.post('/totp/disable', { config: strictLimit }, async (req) => {
      const body = totpDisableSchema.parse(req.body);
      await auth.disableTotp(req.auth!.user, body.password, body.code, requestMeta(req));
      return { ok: true };
    });
  });
}

export function isAuthError(err: unknown): err is AuthError {
  return err instanceof AuthError;
}
