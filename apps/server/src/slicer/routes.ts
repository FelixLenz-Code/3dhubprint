import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assignmentSchema, bedClearSchema, createJobSchema, moveJobSchema, sendJobSchema } from '@printhub/shared';
import type { BedCheckService } from '../bedcheck/service.js';
import type { AuthService } from '../auth/service.js';
import { requestMeta } from '../auth/plugin.js';
import { SlicingError, type SlicingService } from './service.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const kindSchema = z.enum(['machine', 'process', 'filament']);

export async function slicerRoutes(
  app: FastifyInstance,
  {
    slicing,
    auth,
    tmpDir,
    maxModelBytes,
    bedCheck,
  }: { slicing: SlicingService; auth: AuthService; tmpDir: string; maxModelBytes: number; bedCheck?: BedCheckService },
) {
  app.addHook('preHandler', app.requireAuth);
  fs.mkdirSync(tmpDir, { recursive: true });

  const audit = (req: FastifyRequest, action: string, detail: string) =>
    auth.audit(req.auth!.user.id, action, detail, requestMeta(req));

  // --- read access -----------------------------------------------------------

  app.get('/slicer/status', async () => slicing.status());
  app.get('/slicer/profiles', async () => slicing.listProfiles());
  app.get('/printers/:id/profiles', async (req) => slicing.getAssignment(idParams.parse(req.params).id));
  app.get('/models', async () => slicing.listModels());
  app.get('/jobs', async () => slicing.listJobs());

  app.get('/jobs/:id', async (req) => {
    const job = slicing.getJob(idParams.parse(req.params).id);
    if (!job) throw new SlicingError('Auftrag nicht gefunden', 404);
    return job;
  });

  app.get('/jobs/:id/log', async (req) => {
    const j = slicing.jobRow(idParams.parse(req.params).id);
    if (!j) throw new SlicingError('Auftrag nicht gefunden', 404);
    return { log: j.log ?? '' };
  });

  app.get('/models/:id/thumbnail', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const file = slicing.thumbPath(id);
    if (!fs.existsSync(file)) throw new SlicingError('Kein Vorschaubild', 404);
    reply.header('content-type', 'image/png').header('cache-control', 'private, max-age=86400');
    return reply.send(fs.createReadStream(file));
  });

  /** Display mesh for the plate editor: little-endian float32, 9 per triangle (decimated). */
  app.get('/models/:id/mesh', async (req, reply) => {
    const file = await slicing.displayMesh(idParams.parse(req.params).id);
    reply.header('content-type', 'application/octet-stream').header('cache-control', 'private, max-age=86400');
    return reply.send(fs.createReadStream(file));
  });

  app.get('/jobs/:id/preview/:view', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { view } = z.object({ view: z.enum(['top', 'iso']) }).parse(req.params);
    const file = slicing.previewPath(id, view);
    if (!fs.existsSync(file)) throw new SlicingError('Keine Vorschau', 404);
    reply.header('content-type', 'image/png').header('cache-control', 'private, max-age=86400');
    return reply.send(fs.createReadStream(file));
  });

  /** Toolpaths for the 3D viewer, stored gzipped (browsers decode it transparently). */
  app.get('/jobs/:id/toolpaths', async (req, reply) => {
    const file = slicing.pathsFile(idParams.parse(req.params).id);
    if (!fs.existsSync(file)) throw new SlicingError('Keine Druckbahnen vorhanden', 404);
    reply.header('content-type', 'application/octet-stream').header('content-encoding', 'gzip').header('cache-control', 'private, max-age=86400');
    return reply.send(fs.createReadStream(file));
  });

  app.get('/models/:id/file', async (req, reply) => {
    const m = slicing.getModelRow(idParams.parse(req.params).id);
    if (!m) throw new SlicingError('Modell nicht gefunden', 404);
    reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(m.filename)}`);
    return reply.send(fs.createReadStream(m.storedPath));
  });

  app.get('/jobs/:id/gcode', async (req, reply) => {
    const j = slicing.jobRow(idParams.parse(req.params).id);
    if (!j?.gcodePath || !j.gcodeName || !fs.existsSync(j.gcodePath)) throw new SlicingError('Kein G-Code vorhanden', 404);
    reply
      .header('content-type', 'text/x-gcode')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(j.gcodeName)}`);
    return reply.send(fs.createReadStream(j.gcodePath));
  });

  // --- admin -----------------------------------------------------------------

  app.register(async (admin) => {
    admin.addHook('preHandler', app.requireAdmin);

    admin.post('/slicer/profiles/import', async (req) => {
      const files: { filename: string; buf: Buffer }[] = [];
      for await (const part of req.parts({ limits: { fileSize: 20 * 1024 * 1024, files: 50 } })) {
        if (part.type !== 'file') continue;
        const buf = await part.toBuffer();
        files.push({ filename: path.basename(part.filename), buf });
      }
      if (!files.length) throw new SlicingError('Keine Dateien übergeben');
      const result = slicing.importProfiles(files);
      audit(req, 'profiles.import', result.imported.map((i) => `${i.kind}:${i.name} v${i.version}`).join(', ') || '-');
      return result;
    });

    admin.delete('/slicer/profiles/:kind/:name', async (req) => {
      const { kind, name } = z.object({ kind: kindSchema, name: z.string().min(1) }).parse(req.params);
      if (!slicing.removeProfile(kind, name)) throw new SlicingError('Profil nicht gefunden', 404);
      audit(req, 'profiles.remove', `${kind}:${name}`);
      return { ok: true };
    });

    admin.put('/printers/:id/profiles', async (req) => {
      const { id } = idParams.parse(req.params);
      const result = slicing.setAssignment(id, assignmentSchema.parse(req.body));
      audit(req, 'profiles.assign', `#${id} ${JSON.stringify(result)}`);
      return result;
    });

    admin.post('/models', async (req, reply) => {
      let tmp: string | undefined;
      try {
        let filename: string | undefined;
        const fields: Record<string, string> = {};
        for await (const part of req.parts({ limits: { fileSize: maxModelBytes, files: 1, fields: 5 } })) {
          if (part.type === 'field') {
            fields[part.fieldname] = String(part.value);
            continue;
          }
          filename = path.basename(part.filename);
          tmp = path.join(tmpDir, `${randomUUID()}.model`);
          await pipeline(part.file, fs.createWriteStream(tmp));
          if (part.file.truncated) {
            throw new SlicingError(`Datei ist zu groß (max. ${Math.round(maxModelBytes / 1024 / 1024)} MB)`, 413);
          }
        }
        if (!tmp || !filename) throw new SlicingError('Keine Datei übergeben');
        const model = await slicing.addModel(filename, tmp, { name: fields.name?.trim() || undefined });
        audit(req, 'model.add', `#${model.id} ${model.filename}`);
        reply.code(201);
        return model;
      } finally {
        if (tmp) fs.rm(tmp, { force: true }, () => {});
      }
    });

    admin.delete('/models/:id', async (req) => {
      const { id } = idParams.parse(req.params);
      slicing.deleteModel(id);
      audit(req, 'model.delete', `#${id}`);
      return { ok: true };
    });

    admin.post('/jobs', async (req, reply) => {
      const job = slicing.createJob(createJobSchema.parse(req.body), req.auth!.user.id);
      audit(req, 'job.create', `#${job.id} ${job.model.name} -> ${job.printer?.name}`);
      reply.code(201);
      return job;
    });

    admin.post('/jobs/:id/send', async (req) => {
      const { id } = idParams.parse(req.params);
      const { print } = sendJobSchema.parse(req.body ?? {});
      const job = await slicing.sendJob(id, print);
      audit(req, print ? 'job.print' : 'job.send', `#${id} ${job.printerPath}`);
      return job;
    });

    admin.post('/jobs/:id/keep', async (req) => slicing.keepJob(idParams.parse(req.params).id));

    admin.post('/jobs/:id/retry', async (req) => slicing.retryJob(idParams.parse(req.params).id));

    admin.post('/jobs/:id/enqueue', async (req) => {
      const job = slicing.enqueue(idParams.parse(req.params).id);
      audit(req, 'job.enqueue', `#${job.id} -> ${job.printer?.name}`);
      return job;
    });

    admin.post('/jobs/:id/dequeue', async (req) => slicing.dequeue(idParams.parse(req.params).id));

    admin.post('/jobs/:id/move', async (req) => {
      const { direction } = moveJobSchema.parse(req.body);
      return slicing.moveInQueue(idParams.parse(req.params).id, direction);
    });

    admin.post('/printers/:id/bed-clear', async (req) => {
      const { id } = idParams.parse(req.params);
      const { start } = bedClearSchema.parse(req.body ?? {});
      // Before the next print moves the bed: the camera image is another example of an empty bed
      // (this is also how a false "occupied" from the camera gets overruled and corrected).
      await bedCheck?.learn(id);
      const started = await slicing.confirmBedClear(id, start);
      audit(req, 'printer.bed_clear', `#${id}${started ? ` start #${started.id}` : ''}`);
      return { ok: true, started: started ?? null };
    });

    admin.delete('/jobs/:id', async (req) => {
      const { id } = idParams.parse(req.params);
      slicing.deleteJob(id);
      audit(req, 'job.delete', `#${id}`);
      return { ok: true };
    });
  });
}
