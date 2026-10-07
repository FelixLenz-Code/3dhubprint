import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bedCheckSettingsSchema } from '@printhub/shared';
import type { AuthService } from '../auth/service.js';
import { requestMeta } from '../auth/plugin.js';
import type { PrinterManager } from '../printers/manager.js';
import { BedCheckError, type BedCheckService } from './service.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const refParams = idParams.extend({ ref: z.coerce.number().int().positive() });

export async function bedCheckRoutes(
  app: FastifyInstance,
  { bedCheck, manager, auth }: { bedCheck: BedCheckService; manager: PrinterManager; auth: AuthService },
) {
  app.addHook('preHandler', app.requireAuth);

  const printer = (params: unknown) => {
    const { id } = idParams.parse(params);
    if (!manager.get(id)) throw new BedCheckError('Drucker nicht gefunden', 404);
    return id;
  };

  app.get('/printers/:id/bed-check', async (req) => bedCheck.info(printer(req.params)));

  app.get('/printers/:id/bed-check/overlay', async (req, reply) => {
    const png = bedCheck.overlay(printer(req.params));
    if (!png) return reply.code(404).send({ error: 'not_found' });
    return reply.header('content-type', 'image/png').header('cache-control', 'no-store').send(png);
  });

  app.get('/printers/:id/bed-check/references/:ref', async (req, reply) => {
    const { id, ref } = refParams.parse(req.params);
    printer(req.params);
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=86400').send(bedCheck.referenceImage(id, ref));
  });

  app.register(async (admin) => {
    admin.addHook('preHandler', app.requireAdmin);

    admin.put('/printers/:id/bed-check', async (req) => {
      const id = printer(req.params);
      const settings = bedCheckSettingsSchema.parse(req.body);
      const info = bedCheck.setSettings(id, settings);
      auth.audit(req.auth!.user.id, 'printer.bed_check', `#${id} ${settings.mode}`, requestMeta(req));
      return info;
    });

    admin.post('/printers/:id/bed-check/references', async (req, reply) => {
      const id = printer(req.params);
      const ref = await bedCheck.addReference(id, 'manual');
      auth.audit(req.auth!.user.id, 'printer.bed_reference', `#${id} +${ref.id}`, requestMeta(req));
      return reply.code(201).send(ref);
    });

    admin.delete('/printers/:id/bed-check/references/:ref', async (req) => {
      const { ref } = refParams.parse(req.params);
      bedCheck.removeReference(printer(req.params), ref);
      return { ok: true };
    });

    admin.post('/printers/:id/bed-check/run', async (req) => bedCheck.run(printer(req.params)));

    admin.post('/printers/:id/bed-check/reject', async (req) => {
      bedCheck.reject(printer(req.params));
      return { ok: true };
    });
  });
}
