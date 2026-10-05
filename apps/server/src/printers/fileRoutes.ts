import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { printFileSchema, type DirectoryListing, type FileEntry, type HistoryJob, type HistoryPage } from '@printhub/shared';
import type { PrinterManager } from './manager.js';
import type { AuthService } from '../auth/service.js';
import { requestMeta } from '../auth/plugin.js';
import { PrinterControl } from './control.js';
import type { MoonrakerClient } from './moonraker.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const GCODE_EXT = /\.(gcode|gco|g|bgcode)$/i;
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

/** Validates a path relative to the gcodes root (no traversal, no absolute paths). */
export const relPath = z
  .string()
  .max(512)
  .refine((p) => p === '' || p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..'), 'Ungültiger Pfad');

export async function fileRoutes(
  app: FastifyInstance,
  { manager, auth, tmpDir }: { manager: PrinterManager; auth: AuthService; tmpDir: string },
) {
  app.addHook('preHandler', app.requireAuth);
  fs.mkdirSync(tmpDir, { recursive: true });

  const client = (req: FastifyRequest, reply: FastifyReply): { id: number; client: MoonrakerClient } | undefined => {
    const { id } = idParams.parse(req.params);
    const c = manager.client(id);
    if (!c) {
      reply.code(404).send({ error: 'not_found' });
      return undefined;
    }
    if (c.status.connection === 'offline' || c.status.connection === 'connecting') {
      reply.code(503).send({ error: 'printer_unavailable', message: 'Drucker nicht verbunden' });
      return undefined;
    }
    return { id, client: c };
  };

  const audit = (req: FastifyRequest, printerId: number, action: string, detail: string) =>
    auth.audit(req.auth!.user.id, `printer.${action}`, `#${printerId} ${detail}`, requestMeta(req));

  app.get('/:id/files', async (req, reply) => {
    const ctx = client(req, reply);
    if (!ctx) return;
    const dir = relPath.parse((req.query as { path?: string }).path ?? '');
    const res = await ctx.client.request<RawDirectory>('server.files.get_directory', {
      path: dir ? `gcodes/${dir}` : 'gcodes',
      extended: true,
    });
    return toListing(dir, res);
  });

  app.get('/:id/history', async (req, reply) => {
    const ctx = client(req, reply);
    if (!ctx) return;
    const q = z
      .object({ start: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(30) })
      .parse(req.query);
    const [list, totals] = await Promise.all([
      ctx.client.request<{ count: number; jobs: RawJob[] }>('server.history.list', { start: q.start, limit: q.limit, order: 'desc' }),
      ctx.client
        .request<{ job_totals: { total_jobs: number; total_print_time: number; total_filament_used: number; longest_print: number } }>(
          'server.history.totals',
        )
        .catch(() => undefined),
    ]);
    const page: HistoryPage = {
      jobs: list.jobs.map(toHistoryJob),
      // Moonraker's `count` is the size of this page; the overall number comes from the totals.
      total: totals?.job_totals.total_jobs ?? q.start + list.count,
      totals: totals && {
        jobs: totals.job_totals.total_jobs,
        printTime: totals.job_totals.total_print_time,
        filamentUsed: totals.job_totals.total_filament_used,
        longestPrint: totals.job_totals.longest_print,
      },
    };
    return page;
  });

  app.get('/:id/console', async (req) => {
    const { id } = idParams.parse(req.params);
    return manager.consoleHistory(id);
  });

  app.register(async (admin) => {
    admin.addHook('preHandler', app.requireAdmin);

    admin.post('/:id/files/print', async (req, reply) => {
      const ctx = client(req, reply);
      if (!ctx) return;
      const { path: file } = printFileSchema.extend({ path: relPath }).parse(req.body);
      await new PrinterControl(ctx.client).startPrint(file);
      audit(req, ctx.id, 'print_start', file);
      return { ok: true };
    });

    admin.delete('/:id/files', async (req, reply) => {
      const ctx = client(req, reply);
      if (!ctx) return;
      const file = relPath.parse((req.query as { path?: string }).path ?? '');
      if (!file) return reply.code(400).send({ error: 'validation', message: 'Pfad fehlt' });
      if (ctx.client.status.filename === file && ['printing', 'paused'].includes(ctx.client.status.printState ?? '')) {
        return reply.code(409).send({ error: 'printer_busy', message: 'Die Datei wird gerade gedruckt' });
      }
      await ctx.client.request('server.files.delete_file', { path: `gcodes/${file}` });
      audit(req, ctx.id, 'file_delete', file);
      return { ok: true };
    });

    /** Multipart upload: field "file" (+ optional "path" = target folder, "print" = "true"). */
    admin.post('/:id/files/upload', async (req, reply) => {
      const ctx = client(req, reply);
      if (!ctx) return;
      const fields: Record<string, string> = {};
      let tmp: string | undefined;
      let filename: string | undefined;
      try {
        for await (const part of req.parts({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } })) {
          if (part.type === 'field') {
            fields[part.fieldname] = String(part.value);
          } else if (part.fieldname === 'file') {
            filename = path.basename(part.filename);
            if (!GCODE_EXT.test(filename)) {
              part.file.resume();
              return reply.code(400).send({ error: 'validation', message: 'Nur G-Code-Dateien (.gcode, .bgcode) sind erlaubt' });
            }
            tmp = path.join(tmpDir, `${randomUUID()}.upload`);
            await pipeline(part.file, fs.createWriteStream(tmp));
            if (part.file.truncated) {
              return reply.code(413).send({ error: 'too_large', message: 'Datei ist zu groß (max. 1 GB)' });
            }
          } else {
            part.file.resume();
          }
        }
        if (!tmp || !filename) return reply.code(400).send({ error: 'validation', message: 'Keine Datei übergeben' });
        const folder = relPath.parse(fields.path ?? '');
        const print = fields.print === 'true';
        if (print) {
          const st = ctx.client.status;
          if (st.connection !== 'connected') return reply.code(409).send({ error: 'not_ready', message: 'Drucker ist nicht bereit' });
          if (st.printState === 'printing' || st.printState === 'paused') {
            return reply.code(409).send({ error: 'printer_busy', message: 'Es läuft bereits ein Druck' });
          }
        }

        const form = new FormData();
        form.append('file', await fs.openAsBlob(tmp), filename);
        form.append('root', 'gcodes');
        if (folder) form.append('path', folder);
        if (print) form.append('print', 'true');
        const res = await ctx.client.fetch('/server/files/upload', { method: 'POST', body: form });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          req.log.warn({ status: res.status, text: text.slice(0, 300) }, 'moonraker upload failed');
          return reply.code(502).send({ error: 'upload_failed', message: `Upload zum Drucker fehlgeschlagen (HTTP ${res.status})` });
        }
        const target = folder ? `${folder}/${filename}` : filename;
        audit(req, ctx.id, print ? 'upload_print' : 'upload', target);
        return { ok: true, path: target, printStarted: print };
      } finally {
        if (tmp) fs.rm(tmp, { force: true }, () => {});
      }
    });
  });
}

interface RawDirectory {
  dirs?: { dirname: string; modified: number }[];
  files?: (Record<string, unknown> & { filename: string; modified: number; size: number })[];
  disk_usage?: { total: number; used: number; free: number };
}

interface RawJob {
  job_id: string;
  filename: string;
  status: string;
  start_time: number;
  end_time?: number | null;
  print_duration: number;
  total_duration: number;
  filament_used: number;
  exists?: boolean;
  metadata?: { thumbnails?: { width: number; relative_path: string }[] };
}

function largestThumb(filePath: string, thumbs: unknown): string | undefined {
  const list = (thumbs as { width: number; relative_path: string }[] | undefined) ?? [];
  const best = [...list].sort((a, b) => b.width - a.width)[0];
  if (!best) return undefined;
  const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/') + 1) : '';
  return dir + best.relative_path;
}

export function toListing(dir: string, raw: RawDirectory): DirectoryListing {
  const prefix = dir ? `${dir}/` : '';
  const files: FileEntry[] = (raw.files ?? [])
    .filter((f) => GCODE_EXT.test(f.filename))
    .map((f) => {
      const p = prefix + f.filename;
      return {
        path: p,
        name: f.filename,
        size: f.size,
        modified: f.modified,
        estimatedTime: typeof f.estimated_time === 'number' ? f.estimated_time : undefined,
        filamentTotal: typeof f.filament_total === 'number' ? f.filament_total : undefined,
        thumbnailPath: largestThumb(p, f.thumbnails),
      };
    })
    .sort((a, b) => b.modified - a.modified);
  return {
    path: dir,
    // Hide Moonraker's internal thumbnail folders.
    dirs: (raw.dirs ?? [])
      .filter((d) => !d.dirname.startsWith('.'))
      .map((d) => ({ name: d.dirname, path: prefix + d.dirname, modified: d.modified }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    files,
    diskFree: raw.disk_usage?.free,
    diskTotal: raw.disk_usage?.total,
  };
}

export function toHistoryJob(j: RawJob): HistoryJob {
  return {
    id: j.job_id,
    filename: j.filename,
    status: j.status,
    startTime: j.start_time,
    endTime: j.end_time ?? undefined,
    printDuration: j.print_duration,
    totalDuration: j.total_duration,
    filamentUsed: j.filament_used,
    thumbnailPath: largestThumb(j.filename, j.metadata?.thumbnails),
    fileExists: j.exists !== false,
  };
}
