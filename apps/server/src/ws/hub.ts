import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { ServerMessage } from '@printhub/shared';
import type { PrinterManager } from '../printers/manager.js';
import type { AuthService } from '../auth/service.js';
import type { SlicingService } from '../slicer/service.js';
import { SESSION_COOKIE, originAllowed } from '../auth/plugin.js';

const REVALIDATE_MS = 60_000;
const PING_MS = 25_000;

/** Pushes live printer state to authenticated browsers over /api/ws. */
export async function wsHub(
  app: FastifyInstance,
  { manager, auth, slicing }: { manager: PrinterManager; auth: AuthService; slicing: SlicingService },
) {
  const clients = new Set<WebSocket>();

  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
  };

  manager.on('status', (printerId, status) => broadcast({ type: 'status', printerId, status }));
  manager.on('temps', (printerId, sample) => broadcast({ type: 'temps', printerId, sample }));
  manager.on('console', (printerId, lines) => broadcast({ type: 'console', printerId, lines }));
  slicing.on('job', (job) => broadcast({ type: 'job', job }));
  slicing.on('job_removed', (id) => broadcast({ type: 'job_removed', id }));
  manager.on('changed', () => broadcast({ type: 'snapshot', printers: manager.list() }));

  // Browsers send their Origin with every websocket handshake; pages of other sites get nothing.
  const sameOrigin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.headers.origin || !originAllowed(req)) return reply.code(403).send({ error: 'csrf', message: 'Ungültige Anfrage-Herkunft' });
  };

  app.get('/ws', { websocket: true, preValidation: [sameOrigin, app.requireAuth] }, (socket, req) => {
    const token = req.cookies[SESSION_COOKIE]!;
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'snapshot', printers: manager.list() } satisfies ServerMessage));

    let alive = true;
    socket.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, PING_MS);
    // Drop the socket once its session is logged out or revoked elsewhere.
    const revalidate = setInterval(() => {
      if (!auth.validateSession(token)) socket.close(4401, 'session ended');
    }, REVALIDATE_MS);

    socket.on('close', () => {
      clearInterval(ping);
      clearInterval(revalidate);
      clients.delete(socket);
    });
    // Browsers only listen; ignore anything they send.
    socket.on('message', () => {});
  });
}
