import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { AuthService, RequestMeta } from './service.js';
import type { users } from '../db/schema.js';
import { config } from '../config.js';

type UserRow = typeof users.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    auth: { user: UserRow; sessionId: string } | null;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// __Host- prefix pins the cookie to this exact origin, but browsers only accept it with Secure.
export const SESSION_COOKIE = config.cookieSecure ? '__Host-ph_session' : 'ph_session';
export const CSRF_HEADER = 'x-printhub-request';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requestMeta(req: FastifyRequest): RequestMeta {
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: number) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/', secure: config.cookieSecure, sameSite: 'strict' });
}

export const authPlugin = fp(async (app: FastifyInstance, opts: { auth: AuthService }) => {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req, reply) => {
    // CSRF: state-changing API calls must carry a custom header (forces a CORS preflight,
    // which we never grant) and, if the browser sends an Origin, it must be ours.
    if (req.url.startsWith('/api/') && !SAFE_METHODS.has(req.method)) {
      if (req.headers[CSRF_HEADER] !== '1' || !originAllowed(req)) {
        return reply.code(403).send({ error: 'csrf', message: 'Ungültige Anfrage-Herkunft' });
      }
    }

    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      req.auth = opts.auth.validateSession(token);
      if (!req.auth) clearSessionCookie(reply);
    }
  });

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized', message: 'Nicht angemeldet' });
  });

  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized', message: 'Nicht angemeldet' });
    if (req.auth.user.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden', message: 'Keine Berechtigung' });
    }
  });
});

function originAllowed(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.PUBLIC_URL && origin === new URL(config.PUBLIC_URL).origin) return true;
  // Same-origin via whatever host the client used. With trustProxy, Fastify derives
  // protocol/host from X-Forwarded-* only when the request came from a trusted proxy.
  return origin === `${req.protocol}://${req.host}`;
}
