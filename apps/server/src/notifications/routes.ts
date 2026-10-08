import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pushSubscribeSchema, pushUpdateSchema } from '@printhub/shared';
import type { NotificationService } from './service.js';

export async function pushRoutes(app: FastifyInstance, { push }: { push: NotificationService }) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/key', async () => ({ publicKey: push.publicKey }));
  app.get('/devices', async (req) => push.devices(req.auth!.user.id));

  app.post('/subscribe', async (req) => {
    const b = pushSubscribeSchema.parse(req.body);
    push.subscribe(req.auth!.user.id, b.subscription, b.events, req.headers['user-agent'] ?? null);
    return { ok: true };
  });

  app.put('/subscription', async (req, reply) => {
    const b = pushUpdateSchema.parse(req.body);
    return push.updateEvents(req.auth!.user.id, b.endpoint, b.events) ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  app.delete('/subscription', async (req) => {
    const { endpoint } = z.object({ endpoint: z.string().url() }).parse(req.body);
    push.unsubscribe(req.auth!.user.id, endpoint);
    return { ok: true };
  });

  app.delete('/devices/:id', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    return push.removeDevice(req.auth!.user.id, id) ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  app.post('/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { endpoint } = z.object({ endpoint: z.string().url() }).parse(req.body);
    const sent = await push.send('test', { title: '🔔 PrintHub', body: 'Benachrichtigungen funktionieren.', url: '/settings/notifications', tag: 'test' }, { endpoint, userId: req.auth!.user.id });
    return { sent };
  });
}
