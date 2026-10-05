import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { config } from './config.js';
import { openDb } from './db/index.js';
import { SecretBox } from './crypto.js';
import { AuthError, AuthService } from './auth/service.js';
import { authPlugin } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { PrinterManager } from './printers/manager.js';
import { printerRoutes } from './printers/routes.js';
import { controlRoutes } from './printers/controlRoutes.js';
import { fileRoutes } from './printers/fileRoutes.js';
import { ControlError } from './printers/control.js';
import { MoonrakerError } from './printers/moonraker.js';
import { wsHub } from './ws/hub.js';
import { SlicingError, SlicingService } from './slicer/service.js';
import { slicerRoutes } from './slicer/routes.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport: config.isProd ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
      redact: ['req.headers.cookie', 'req.headers["x-api-key"]'],
    },
    trustProxy: config.trustedProxies.length ? config.trustedProxies : false,
    bodyLimit: 1024 * 1024,
  });

  const { db, sqlite } = openDb(config.dataDir);
  const box = new SecretBox(config.APP_SECRET);
  const issuer = config.PUBLIC_URL ? `PrintHub (${new URL(config.PUBLIC_URL).hostname})` : 'PrintHub';
  const auth = new AuthService(db, box, config.sessionTtlMs, issuer);
  const manager = new PrinterManager(db, box, app.log);
  const slicing = new SlicingService(db, manager, app.log.child({ module: 'slicer' }), {
    dataDir: config.dataDir,
    orcaBin: config.ORCA_BIN,
    orcaProfiles: config.ORCA_PROFILES,
    orcaVersion: config.ORCA_VERSION,
    sliceTimeoutMs: config.SLICE_TIMEOUT_MIN * 60 * 1000,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(multipart);
  await app.register(authPlugin, { auth });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation',
        message: err.issues.map((i) => `${i.path.join('.') || 'Eingabe'}: ${i.message}`).join(', '),
        issues: err.issues,
      });
    }
    if (err instanceof AuthError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof SlicingError) return reply.code(err.status).send({ error: 'slicing', message: err.message });
    if (err instanceof ControlError) {
      return reply.code(err.code === 'invalid' ? 400 : 409).send({ error: err.code, message: err.message });
    }
    if (err instanceof MoonrakerError) return reply.code(502).send({ error: 'moonraker', message: err.message });
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.code ?? 'error', message: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Interner Fehler' });
  });

  app.get('/api/health', async () => ({ ok: true, version: config.APP_VERSION }));
  await app.register(authRoutes, { prefix: '/api/auth', auth });
  await app.register(printerRoutes, { prefix: '/api/printers', manager });
  await app.register(controlRoutes, { prefix: '/api/printers', manager, auth });
  await app.register(fileRoutes, { prefix: '/api/printers', manager, auth, tmpDir: path.join(config.dataDir, 'tmp') });
  await app.register(slicerRoutes, {
    prefix: '/api',
    slicing,
    auth,
    tmpDir: path.join(config.dataDir, 'tmp'),
    maxModelBytes: config.MAX_MODEL_MB * 1024 * 1024,
  });
  await app.register(wsHub, { prefix: '/api', manager, auth, slicing });

  const webDist = config.WEB_DIST ?? path.resolve(import.meta.dirname, '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      setHeaders(res, filePath) {
        // Hashed assets never change; everything else (index.html, sw.js, manifest) must revalidate.
        res.setHeader(
          'cache-control',
          filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
    app.setNotFoundHandler((req, reply) => {
      // SPA fallback for client routes only; a missing asset must stay a 404, not HTML.
      const pathname = req.url.split('?')[0]!;
      if (req.method === 'GET' && !pathname.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(pathname)) {
        return reply.header('cache-control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  } else {
    app.log.warn({ webDist }, 'web build not found, serving API only');
  }

  const purge = setInterval(() => auth.purgeExpiredSessions(), 60 * 60 * 1000);
  app.addHook('onReady', async () => {
    manager.start();
    slicing.start();
  });
  app.addHook('onClose', async () => {
    clearInterval(purge);
    manager.stop();
    await slicing.stop();
    sqlite.close();
  });

  return app;
}
