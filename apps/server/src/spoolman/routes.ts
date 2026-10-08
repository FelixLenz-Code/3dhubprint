import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createSpoolSchema, newFilamentSchema, setSpoolSchema, spoolmanUrlSchema, updateSpoolSchema } from '@printhub/shared';
import type { AuthService } from '../auth/service.js';
import { requestMeta } from '../auth/plugin.js';
import type { PrinterManager } from '../printers/manager.js';
import { SpoolmanError, type SpoolmanService } from './service.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

export async function spoolmanRoutes(
  app: FastifyInstance,
  { spoolman, manager, auth }: { spoolman: SpoolmanService; manager: PrinterManager; auth: AuthService },
) {
  app.addHook('preHandler', app.requireAuth);

  const printer = (params: unknown) => {
    const { id } = idParams.parse(params);
    if (!manager.get(id)) throw new SpoolmanError('Drucker nicht gefunden', 404);
    return id;
  };

  app.get('/spoolman/status', async () => spoolman.status());
  app.get('/spoolman/spools', async (req) => spoolman.spools((req.query as { fresh?: string }).fresh === '1'));
  app.get('/spoolman/filaments', async () => spoolman.filaments());
  app.get('/printers/:id/spool', async (req) => spoolman.printerSpool(printer(req.params)));

  app.register(async (admin) => {
    admin.addHook('preHandler', app.requireAdmin);

    admin.put('/spoolman/url', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const { url } = spoolmanUrlSchema.parse(req.body);
      const status = await spoolman.setUrl(url);
      auth.audit(req.auth!.user.id, 'spoolman.url', url, requestMeta(req));
      return status;
    });

    admin.delete('/spoolman/url', async (req) => {
      spoolman.remove();
      auth.audit(req.auth!.user.id, 'spoolman.url', 'removed', requestMeta(req));
      return { configured: false, url: null };
    });

    admin.post('/spoolman/spools', async (req, reply) => {
      const spools = await spoolman.createSpools(createSpoolSchema.parse(req.body));
      auth.audit(req.auth!.user.id, 'spoolman.spool_create', spools.map((s) => `#${s.id}`).join(','), requestMeta(req));
      reply.code(201);
      return spools;
    });

    admin.patch('/spoolman/spools/:id', async (req) => {
      const { id } = idParams.parse(req.params);
      return spoolman.updateSpool(id, updateSpoolSchema.parse(req.body));
    });

    admin.delete('/spoolman/spools/:id', async (req) => {
      const { id } = idParams.parse(req.params);
      await spoolman.deleteSpool(id);
      auth.audit(req.auth!.user.id, 'spoolman.spool_delete', `#${id}`, requestMeta(req));
      return { ok: true };
    });

    admin.post('/spoolman/filaments', async (req, reply) => {
      const filament = await spoolman.createFilament(newFilamentSchema.parse(req.body));
      auth.audit(req.auth!.user.id, 'spoolman.filament_create', `#${filament.id}`, requestMeta(req));
      reply.code(201);
      return filament;
    });

    admin.patch('/spoolman/filaments/:id', async (req) => {
      const { id } = idParams.parse(req.params);
      return spoolman.updateFilament(id, newFilamentSchema.parse(req.body));
    });

    admin.delete('/spoolman/filaments/:id', async (req) => {
      const { id } = idParams.parse(req.params);
      await spoolman.deleteFilament(id);
      auth.audit(req.auth!.user.id, 'spoolman.filament_delete', `#${id}`, requestMeta(req));
      return { ok: true };
    });

    admin.put('/printers/:id/spool', async (req) => {
      const id = printer(req.params);
      const { spoolId } = setSpoolSchema.parse(req.body);
      return spoolman.setActiveSpool(id, spoolId);
    });
  });
}
