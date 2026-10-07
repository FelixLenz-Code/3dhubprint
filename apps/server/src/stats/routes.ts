import type { FastifyInstance } from 'fastify';
import { costSettingsSchema, printListQuerySchema, statsQuerySchema } from '@printhub/shared';
import type { AuthService } from '../auth/service.js';
import { requestMeta } from '../auth/plugin.js';
import type { StatsService } from './service.js';

export async function statsRoutes(app: FastifyInstance, { stats, auth }: { stats: StatsService; auth: AuthService }) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/stats', async (req) => {
    const q = statsQuerySchema.parse(req.query);
    return stats.stats(q.range, q.printerId, q.tz);
  });

  app.get('/stats/prints', async (req) => stats.listPrints(printListQuerySchema.parse(req.query)));

  app.get('/costs', async () => stats.costSettings());

  app.register(async (admin) => {
    admin.addHook('preHandler', app.requireAdmin);

    /** Reads new entries from every printer's Moonraker history now. */
    admin.post('/stats/sync', async () => {
      await stats.syncAll();
      return { ok: true };
    });

    admin.put('/costs', async (req) => {
      const s = stats.setCostSettings(costSettingsSchema.parse(req.body));
      auth.audit(req.auth!.user.id, 'costs.update', null, requestMeta(req));
      return s;
    });
  });
}
