import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { thingiverseImportSchema, thingiverseSearchSchema, thingiverseTokenSchema } from '@printhub/shared';
import type { AuthService } from '../auth/service.js';
import { requestMeta } from '../auth/plugin.js';
import type { ThingiverseService } from './service.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

export async function thingiverseRoutes(app: FastifyInstance, { tv, auth }: { tv: ThingiverseService; auth: AuthService }) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/status', async () => ({ configured: tv.configured }));

  app.get('/search', async (req) => {
    const q = thingiverseSearchSchema.parse(req.query);
    return tv.search(q.q, q.page, q.sort);
  });

  app.get('/things/:id', async (req) => tv.details(idParams.parse(req.params).id));

  app.get('/image', async (req, reply) => {
    const { url } = z.object({ url: z.string().max(1000) }).parse(req.query);
    const res = await tv.image(url);
    reply.header('content-type', res.headers.get('content-type')!).header('cache-control', 'private, max-age=86400');
    return reply.send(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream));
  });

  app.register(async (admin) => {
    admin.addHook('preHandler', app.requireAdmin);

    admin.put('/token', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const { token } = thingiverseTokenSchema.parse(req.body);
      await tv.setToken(token);
      auth.audit(req.auth!.user.id, 'thingiverse.token', 'set', requestMeta(req));
      return { configured: true };
    });

    admin.delete('/token', async (req) => {
      tv.removeToken();
      auth.audit(req.auth!.user.id, 'thingiverse.token', 'removed', requestMeta(req));
      return { configured: false };
    });

    admin.post('/things/:id/import', async (req) => {
      const { id } = idParams.parse(req.params);
      const { fileIds } = thingiverseImportSchema.parse(req.body);
      const models = await tv.import(id, fileIds);
      auth.audit(req.auth!.user.id, 'thingiverse.import', `thing:${id} files:${fileIds.join(',')}`, requestMeta(req));
      return models;
    });
  });
}
