import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  excludeObjectSchema,
  factorSchema,
  fanSchema,
  gcodeSchema,
  homeSchema,
  macroSchema,
  moveSchema,
  printerActionSchema,
  temperatureSchema,
} from '@printhub/shared';
import type { PrinterManager } from './manager.js';
import type { AuthService } from '../auth/service.js';
import { requestMeta } from '../auth/plugin.js';
import { PrinterControl } from './control.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

/** Everything that changes printer state. Admin only, every call is audited. */
export async function controlRoutes(app: FastifyInstance, { manager, auth }: { manager: PrinterManager; auth: AuthService }) {
  app.addHook('preHandler', app.requireAdmin);

  const control = (req: FastifyRequest) => {
    const { id } = idParams.parse(req.params);
    const client = manager.client(id);
    if (!client) throw Object.assign(new Error('Drucker nicht gefunden'), { statusCode: 404, code: 'not_found' });
    return { id, control: new PrinterControl(client) };
  };

  const audit = (req: FastifyRequest, printerId: number, action: string, detail?: string) =>
    auth.audit(req.auth!.user.id, `printer.${action}`, `#${printerId}${detail ? ` ${detail}` : ''}`, requestMeta(req));

  /** Runs a G-code producing command, records it in the shared console and the audit log. */
  const run = async (req: FastifyRequest, action: string, fn: (c: PrinterControl) => Promise<string>) => {
    const { id, control: c } = control(req);
    const script = await fn(c);
    manager.recordCommand(id, script);
    audit(req, id, action, script.replace(/\n/g, ' | '));
    return { ok: true };
  };

  app.post('/:id/action', async (req) => {
    const { action } = z.object({ action: printerActionSchema }).parse(req.body);
    const { id, control: c } = control(req);
    await c.action(action);
    audit(req, id, action);
    return { ok: true };
  });

  app.post('/:id/temperature', (req) => {
    const b = temperatureSchema.parse(req.body);
    return run(req, 'temperature', (c) => c.setTemperature(b.heater, b.target));
  });

  app.post('/:id/home', (req) => {
    const b = homeSchema.parse(req.body ?? {});
    return run(req, 'home', (c) => c.home(b.axes));
  });

  app.post('/:id/move', (req) => {
    const b = moveSchema.parse(req.body);
    return run(req, 'move', (c) => c.move(b.axis, b.distance, b.speed));
  });

  app.post('/:id/speed-factor', (req) => {
    const b = factorSchema.parse(req.body);
    return run(req, 'speed_factor', (c) => c.speedFactor(b.percent));
  });

  app.post('/:id/flow-factor', (req) => {
    const b = factorSchema.parse(req.body);
    return run(req, 'flow_factor', (c) => c.flowFactor(b.percent));
  });

  app.post('/:id/fan', (req) => {
    const b = fanSchema.parse(req.body);
    return run(req, 'fan', (c) => c.fan(b.percent));
  });

  app.post('/:id/macro', (req) => {
    const b = macroSchema.parse(req.body);
    return run(req, 'macro', (c) => c.macro(b.name));
  });

  app.post('/:id/exclude-object', (req) => {
    const b = excludeObjectSchema.parse(req.body);
    return run(req, 'exclude_object', (c) => c.excludeObject(b.name));
  });

  app.post('/:id/gcode', (req) => {
    const b = gcodeSchema.parse(req.body);
    return run(req, 'gcode', (c) => c.gcode(b.script));
  });
}
