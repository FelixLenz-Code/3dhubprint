import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface Call {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Minimal Moonraker stand-in: JSON-RPC over /websocket plus the HTTP upload endpoint.
 * Records every call so tests can assert exactly what would have reached the printer.
 */
export class FakeMoonraker {
  calls: Call[] = [];
  uploads: { fields: Record<string, string>; filename: string; content: string }[] = [];
  status: Record<string, Record<string, unknown>> = {
    webhooks: { state: 'ready' },
    print_stats: { state: 'standby', filename: '', print_duration: 0, total_duration: 0, filament_used: 0, info: {} },
    virtual_sdcard: { progress: 0 },
    extruder: { temperature: 21, target: 0, power: 0 },
    heater_bed: { temperature: 20, target: 0, power: 0 },
    toolhead: { homed_axes: '', axis_maximum: [300, 300, 300, 0] },
    gcode_move: { speed_factor: 1, extrude_factor: 1, gcode_position: [0, 0, 0, 0] },
    fan: { speed: 0 },
    exclude_object: { objects: [], excluded_objects: [], current_object: null },
  };
  objects = [...Object.keys(this.status), 'gcode_macro START_PRINT', 'gcode_macro _HELPER', 'gcode_macro M600', 'gcode_macro PARK'];
  settings = { extruder: { min_temp: 0, max_temp: 270 }, heater_bed: { min_temp: 0, max_temp: 110 } };
  private server = http.createServer((req, res) => this.onHttp(req, res));
  private wss = new WebSocketServer({ server: this.server, path: '/websocket' });
  private sockets = new Set<WebSocket>();

  async start(): Promise<string> {
    this.wss.on('connection', (ws) => {
      this.sockets.add(ws);
      ws.on('close', () => this.sockets.delete(ws));
      ws.on('message', (data) => this.onRpc(ws, JSON.parse(data.toString())));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    for (const ws of this.sockets) ws.terminate();
    this.wss.close();
    await new Promise((r) => this.server.close(r));
  }

  /** Simulates Klipper pushing a status change. */
  update(patch: Record<string, Record<string, unknown>>) {
    for (const [k, v] of Object.entries(patch)) this.status[k] = { ...this.status[k], ...v };
    this.notify('notify_status_update', [patch, Date.now() / 1000]);
  }

  notify(method: string, params: unknown[]) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const ws of this.sockets) ws.send(msg);
  }

  callsOf(method: string) {
    return this.calls.filter((c) => c.method === method);
  }

  get scripts() {
    return this.callsOf('printer.gcode.script').map((c) => c.params?.script);
  }

  private onRpc(ws: WebSocket, msg: { id: number; method: string; params?: Record<string, unknown> }) {
    this.calls.push({ method: msg.method, params: msg.params });
    const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    switch (msg.method) {
      case 'server.connection.identify':
        return reply({ connection_id: 1 });
      case 'server.info':
        return reply({ klippy_state: 'ready', klippy_connected: true });
      case 'server.webcams.list':
        return reply({ webcams: [] });
      case 'printer.objects.list':
        return reply({ objects: this.objects });
      case 'printer.objects.subscribe':
        return reply({ status: structuredClone(this.status), eventtime: 1 });
      case 'printer.objects.query':
        return reply({ status: { configfile: { settings: this.settings } }, eventtime: 1 });
      case 'server.files.metadata':
        return reply({ filename: msg.params?.filename, estimated_time: 1000 });
      case 'server.files.get_directory':
        return reply({
          dirs: [{ dirname: '.thumbs', modified: 1 }, { dirname: 'parts', modified: 2 }],
          files: [
            { filename: 'old.gcode', modified: 10, size: 100 },
            {
              filename: 'new.gcode',
              modified: 20,
              size: 200,
              estimated_time: 600,
              thumbnails: [
                { width: 32, relative_path: '.thumbs/new-32x32.png' },
                { width: 300, relative_path: '.thumbs/new-300x300.png' },
              ],
            },
            { filename: 'notes.txt', modified: 30, size: 5 },
          ],
          disk_usage: { total: 1000, used: 400, free: 600 },
        });
      case 'server.history.list':
        return reply({
          count: 1,
          jobs: [{ job_id: '0001', filename: 'a.gcode', status: 'completed', start_time: 1, end_time: 2, print_duration: 60, total_duration: 70, filament_used: 500, exists: true }],
        });
      case 'server.history.totals':
        return reply({ job_totals: { total_jobs: 1, total_print_time: 60, total_filament_used: 500, longest_print: 60 } });
      case 'printer.gcode.script':
        // Klipper echoes responses to the console.
        this.notify('notify_gcode_response', [`// ran: ${String(msg.params?.script).split('\n')[0]}`]);
        return reply('ok');
      default:
        return reply('ok');
    }
  }

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method === 'POST' && req.url === '/server/files/upload') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const boundary = /boundary=(.+)$/.exec(req.headers['content-type'] ?? '')?.[1];
        const fields: Record<string, string> = {};
        let filename = '';
        let content = '';
        for (const part of body.split(`--${boundary}`)) {
          const m = /name="([^"]+)"(?:; filename="([^"]+)")?[\s\S]*?\r\n\r\n([\s\S]*)\r\n$/.exec(part);
          if (!m) continue;
          if (m[2]) {
            filename = m[2];
            content = m[3]!;
          } else fields[m[1]!] = m[3]!;
        }
        this.uploads.push({ fields, filename, content });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ result: { item: { path: filename, root: 'gcodes' }, action: 'create_file' } }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  }
}
