import { EventEmitter } from 'node:events';
import { asc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { ConsoleLine, PrinterInput, PrinterStatus, PrinterSummary, TempSample, Webcam } from '@printhub/shared';
import type { Db } from '../db/index.js';
import { printers } from '../db/schema.js';
import type { SecretBox } from '../crypto.js';
import { MoonrakerClient, type RawWebcam } from './moonraker.js';

type PrinterRow = typeof printers.$inferSelect;

interface ManagerEvents {
  status: [number, PrinterStatus];
  temps: [number, TempSample];
  console: [number, ConsoleLine[]];
  changed: [];
}

const TEMP_SAMPLE_MS = 1000;
const CONSOLE_LINES = 300;
// Klipper echoes these periodically; they only clutter the console.
const CONSOLE_NOISE = /^(B:|T\d?:|ok$|\/\/ Klipper state: Ready)/;

/** Owns one MoonrakerClient per enabled printer and relays their events. */
export class PrinterManager extends EventEmitter<ManagerEvents> {
  private clients = new Map<number, MoonrakerClient>();
  private rows = new Map<number, PrinterRow>();
  private consoles = new Map<number, ConsoleLine[]>();
  private sampleTimer?: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly log: FastifyBaseLogger,
  ) {
    super();
  }

  start() {
    for (const row of this.db.select().from(printers).orderBy(asc(printers.sortOrder), asc(printers.id)).all()) {
      this.rows.set(row.id, row);
      if (row.enabled) this.startClient(row);
    }
    this.sampleTimer = setInterval(() => this.emitTempSamples(), TEMP_SAMPLE_MS);
  }

  stop() {
    clearInterval(this.sampleTimer);
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
  }

  list(): PrinterSummary[] {
    return [...this.rows.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
      .map((r) => this.summary(r));
  }

  get(id: number): PrinterSummary | undefined {
    const row = this.rows.get(id);
    return row && this.summary(row);
  }

  client(id: number): MoonrakerClient | undefined {
    return this.clients.get(id);
  }

  create(input: PrinterInput & { url: string }): PrinterSummary {
    const row = this.db
      .insert(printers)
      .values({
        name: input.name,
        url: input.url,
        apiKey: input.apiKey ? this.box.encrypt(input.apiKey) : null,
        enabled: input.enabled ?? true,
        sortOrder: this.rows.size,
        createdAt: Date.now(),
      })
      .returning()
      .get();
    this.rows.set(row.id, row);
    if (row.enabled) this.startClient(row);
    this.emit('changed');
    return this.summary(row);
  }

  update(id: number, input: PrinterInput & { url: string }): PrinterSummary | undefined {
    if (!this.rows.has(id)) return undefined;
    const apiKey =
      input.apiKey === undefined ? undefined : input.apiKey === '' ? null : this.box.encrypt(input.apiKey);
    const row = this.db
      .update(printers)
      .set({ name: input.name, url: input.url, enabled: input.enabled ?? true, ...(apiKey !== undefined && { apiKey }) })
      .where(eq(printers.id, id))
      .returning()
      .get();
    this.rows.set(id, row);
    this.stopClient(id);
    if (row.enabled) this.startClient(row);
    this.emit('changed');
    return this.summary(row);
  }

  remove(id: number): boolean {
    if (!this.rows.has(id)) return false;
    this.stopClient(id);
    this.db.delete(printers).where(eq(printers.id, id)).run();
    this.rows.delete(id);
    this.emit('changed');
    return true;
  }

  private summary(row: PrinterRow): PrinterSummary {
    const client = this.clients.get(row.id);
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      hasApiKey: row.apiKey !== null,
      enabled: row.enabled,
      webcams: client ? client.webcams.map((w, i) => toWebcam(row.id, i, w)) : [],
      status: client ? client.status : { connection: 'disabled' },
      capabilities: client?.capabilities,
    };
  }

  consoleHistory(id: number): ConsoleLine[] {
    return this.consoles.get(id) ?? [];
  }

  /** Records a command sent by a user so it shows up in everyone's console. */
  recordCommand(id: number, script: string) {
    this.pushConsole(id, script.split('\n').map((text) => ({ t: Date.now(), text, kind: 'command' as const })));
  }

  private pushConsole(id: number, lines: ConsoleLine[]) {
    if (!lines.length) return;
    const buf = [...(this.consoles.get(id) ?? []), ...lines].slice(-CONSOLE_LINES);
    this.consoles.set(id, buf);
    this.emit('console', id, lines);
  }

  private startClient(row: PrinterRow) {
    let apiKey: string | null = null;
    if (row.apiKey) {
      try {
        apiKey = this.box.decrypt(row.apiKey);
      } catch {
        this.log.error({ printer: row.id }, 'cannot decrypt printer API key (APP_SECRET changed?)');
      }
    }
    const client = new MoonrakerClient(row.url, apiKey, this.log.child({ printer: row.id }));
    client.on('status', (s) => this.emit('status', row.id, s));
    client.on('webcams', () => this.emit('changed'));
    client.on('capabilities', () => this.emit('changed'));
    client.on('gcode', (text) => {
      if (!CONSOLE_NOISE.test(text)) this.pushConsole(row.id, [{ t: Date.now(), text, kind: 'response' }]);
    });
    this.clients.set(row.id, client);
    client.start();
  }

  private stopClient(id: number) {
    this.clients.get(id)?.stop();
    this.clients.delete(id);
    this.consoles.delete(id);
  }

  private emitTempSamples() {
    const t = Date.now();
    for (const [id, client] of this.clients) {
      const s = client.status;
      if (s.connection !== 'connected') continue;
      this.emit('temps', id, {
        t,
        extruder: s.extruder?.temperature,
        extruderTarget: s.extruder?.target,
        bed: s.heaterBed?.temperature,
        bedTarget: s.heaterBed?.target,
      });
    }
  }
}

function toWebcam(printerId: number, index: number, w: RawWebcam): Webcam {
  return {
    name: w.name,
    streamUrl: `/api/printers/${printerId}/webcams/${index}/stream`,
    snapshotUrl: `/api/printers/${printerId}/webcams/${index}/snapshot`,
    flipH: !!w.flip_horizontal,
    flipV: !!w.flip_vertical,
    rotation: w.rotation ?? 0,
  };
}
