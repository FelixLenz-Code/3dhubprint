import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { printerInputSchema, type TempSample } from '@printhub/shared';
import type { PrinterManager } from './manager.js';
import type { MoonrakerClient } from './moonraker.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const webcamParams = idParams.extend({ index: z.coerce.number().int().min(0) });

export async function printerRoutes(app: FastifyInstance, { manager }: { manager: PrinterManager }) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async () => manager.list());

  app.get('/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return manager.get(id) ?? reply.code(404).send({ error: 'not_found' });
  });

  app.post('/', { preHandler: app.requireAdmin }, async (req, reply) => {
    const input = printerInputSchema.parse(req.body);
    reply.code(201);
    return manager.create(input);
  });

  app.put('/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const input = printerInputSchema.parse(req.body);
    return manager.update(id, input) ?? reply.code(404).send({ error: 'not_found' });
  });

  app.delete('/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return manager.remove(id) ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  /** Checks that a Moonraker instance is reachable before saving it. Read-only. */
  app.post('/test', { preHandler: app.requireAdmin }, async (req) => {
    const input = printerInputSchema.pick({ url: true, apiKey: true }).parse(req.body);
    try {
      const res = await fetch(`${input.url}/server/info`, {
        headers: input.apiKey ? { 'X-Api-Key': input.apiKey } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: 'Moonraker verlangt Authentifizierung: API-Key angeben oder Server in trusted_clients eintragen' };
      }
      if (!res.ok) return { ok: false, message: `Moonraker antwortete mit HTTP ${res.status}` };
      const { result } = (await res.json()) as {
        result: { moonraker_version: string; klippy_state: string };
      };
      return { ok: true, moonrakerVersion: result.moonraker_version, klippyState: result.klippy_state };
    } catch (err) {
      return { ok: false, message: `Nicht erreichbar: ${(err as Error).message}` };
    }
  });

  app.get('/:id/temperature-store', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const client = connectedClient(manager, id, reply);
    if (!client) return;
    const store = await client.request<Record<string, { temperatures?: number[]; targets?: number[] }>>(
      'server.temperature_store',
    );
    // Moonraker keeps one sample per second, newest last.
    const ext = store.extruder;
    const bed = store.heater_bed;
    const len = Math.max(ext?.temperatures?.length ?? 0, bed?.temperatures?.length ?? 0);
    const now = Date.now();
    const samples: TempSample[] = [];
    for (let i = 0; i < len; i++) {
      samples.push({
        t: now - (len - 1 - i) * 1000,
        extruder: ext?.temperatures?.[i],
        extruderTarget: ext?.targets?.[i],
        bed: bed?.temperatures?.[i],
        bedTarget: bed?.targets?.[i],
      });
    }
    return samples;
  });

  app.get('/:id/files/thumbnail', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { path } = z.object({ path: z.string().min(1).max(512) }).parse(req.query);
    if (path.split('/').some((seg) => seg === '..' || seg === '')) return reply.code(400).send({ error: 'bad_path' });
    const client = connectedClient(manager, id, reply, false);
    if (!client) return;
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return proxy(req, reply, client, `/server/files/gcodes/${encoded}`, 'private, max-age=3600');
  });

  app.get('/:id/webcams/:index/:kind', async (req, reply) => {
    const { id, index } = webcamParams.parse(req.params);
    const { kind } = z.object({ kind: z.enum(['stream', 'snapshot']) }).parse(req.params);
    const client = connectedClient(manager, id, reply, false);
    if (!client) return;
    const cam = client.webcams[index];
    if (!cam) return reply.code(404).send({ error: 'not_found' });
    const target = webcamUrl(client.baseUrl, kind === 'stream' ? cam.stream_url : cam.snapshot_url);
    return proxy(req, reply, client, target, 'no-store');
  });
}

function connectedClient(manager: PrinterManager, id: number, reply: FastifyReply, needKlippy = true) {
  const client = manager.client(id);
  if (!client) {
    reply.code(404).send({ error: 'not_found' });
    return undefined;
  }
  const conn = client.status.connection;
  if (conn === 'offline' || conn === 'connecting' || (needKlippy && conn !== 'connected')) {
    reply.code(503).send({ error: 'printer_unavailable', message: 'Drucker nicht verbunden' });
    return undefined;
  }
  return client;
}

/**
 * Webcam URLs from Moonraker are usually relative to the web UI (Fluidd/Mainsail on port 80),
 * not to Moonraker's own port, so a configured :7125 must be dropped for relative paths.
 */
export function webcamUrl(baseUrl: string, camUrl: string): string {
  if (/^https?:\/\//.test(camUrl)) return camUrl;
  const base = new URL(baseUrl);
  if (base.port === '7125') base.port = '';
  return new URL(camUrl, base.origin + '/').toString();
}

async function proxy(req: FastifyRequest, reply: FastifyReply, client: MoonrakerClient, target: string, cache: string) {
  const ac = new AbortController();
  req.raw.on('close', () => ac.abort());
  let res: Response;
  try {
    res = await client.fetch(target, { signal: ac.signal });
  } catch {
    return reply.code(502).send({ error: 'upstream_unreachable' });
  }
  if (!res.ok || !res.body) {
    return reply.code(res.status === 404 ? 404 : 502).send({ error: 'upstream_error', status: res.status });
  }
  reply.header('content-type', res.headers.get('content-type') ?? 'application/octet-stream');
  reply.header('cache-control', cache);
  // Disable proxy buffering so MJPEG frames flow through nginx immediately.
  reply.header('x-accel-buffering', 'no');
  return reply.send(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream));
}
