import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from '../config.js';
import type {
  ConnectionState,
  FanInfo,
  FileMetadata,
  HeaterInfo,
  PrintState,
  PrinterCapabilities,
  PrinterStatus,
} from '@printhub/shared';

const REQUEST_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 20_000;
const KLIPPY_POLL_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;

type RawStatus = Record<string, Record<string, unknown>>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RawWebcam {
  name: string;
  service?: string;
  stream_url: string;
  snapshot_url: string;
  flip_horizontal?: boolean;
  flip_vertical?: boolean;
  rotation?: number;
  enabled?: boolean;
}

interface MoonrakerEvents {
  /** Throttled, for display. */
  status: [PrinterStatus];
  /** Unthrottled: emitted on every change of connection, Klipper state or print state. */
  lifecycle: [PrinterStatus];
  webcams: [RawWebcam[]];
  capabilities: [PrinterCapabilities];
  /** A line Klipper wrote to the G-code console. */
  gcode: [string];
  /** Moonraker's Spoolman integration switched the active spool. */
  spool: [number | null];
}

export class MoonrakerError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(message);
  }
}

/**
 * Persistent connection to one Moonraker instance. Keeps a merged copy of the subscribed
 * Klipper objects and emits a derived PrinterStatus whenever it changes (throttled).
 */
export class MoonrakerClient extends EventEmitter<MoonrakerEvents> {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private raw: RawStatus = {};
  private connection: ConnectionState = 'connecting';
  private klippyState?: string;
  private klippyMessage?: string;
  private file?: FileMetadata;
  private fileLoading?: string;
  private stopped = true;
  private backoff = 1000;
  private reconnectTimer?: NodeJS.Timeout;
  private klippyTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private emitTimer?: NodeJS.Timeout;
  private alive = false;
  private updatedAt?: number;
  private lifecycleKey = '';
  webcams: RawWebcam[] = [];
  capabilities?: PrinterCapabilities;
  /** Moonraker components (from server.info), e.g. "spoolman", "history". */
  components: string[] = [];

  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string | null,
    private readonly log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
  ) {
    super();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.klippyTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.emitTimer);
    this.failPending(new MoonrakerError('Client stopped'));
    this.ws?.removeAllListeners();
    this.ws?.on('error', () => {});
    this.ws?.terminate();
    this.ws = null;
  }

  get status(): PrinterStatus {
    return deriveStatus(this.raw, {
      connection: this.connection,
      klippyState: this.klippyState,
      klippyMessage: this.klippyMessage,
      file: this.file,
      updatedAt: this.updatedAt,
    });
  }

  /** JSON-RPC call over the websocket. */
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new MoonrakerError('Drucker nicht verbunden'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MoonrakerError(`Timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
    });
  }

  /** Plain HTTP request to Moonraker (for binary data like thumbnails). */
  fetch(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(pathOrUrl, this.baseUrl + '/');
    const headers = new Headers(init.headers);
    // Only send the API key to Moonraker itself, never to external webcam hosts.
    if (this.apiKey && url.origin === new URL(this.baseUrl).origin) headers.set('X-Api-Key', this.apiKey);
    return fetch(url, { ...init, headers });
  }

  private connect() {
    if (this.stopped) return;
    this.setConnection('connecting');
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/websocket';
    const ws = new WebSocket(wsUrl, {
      handshakeTimeout: 10_000,
      headers: this.apiKey ? { 'X-Api-Key': this.apiKey } : undefined,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = 1000;
      this.alive = true;
      this.pingTimer = setInterval(() => {
        if (!this.alive) {
          this.log.warn({ url: this.baseUrl }, 'moonraker ping timeout');
          ws.terminate();
          return;
        }
        this.alive = false;
        ws.ping();
      }, PING_INTERVAL_MS);
      void this.onOpen();
    });
    ws.on('pong', () => (this.alive = true));
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('error', (err) => this.log.warn({ url: this.baseUrl, err: err.message }, 'moonraker ws error'));
    ws.on('close', () => {
      clearInterval(this.pingTimer);
      clearTimeout(this.klippyTimer);
      this.failPending(new MoonrakerError('Verbindung getrennt'));
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      this.setConnection('offline');
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    });
  }

  private async onOpen() {
    try {
      await this.request('server.connection.identify', {
        client_name: 'PrintHub',
        version: config.APP_VERSION,
        type: 'other',
        url: 'https://github.com/FelixLenz-Code/3dhubprint',
        ...(this.apiKey ? { api_key: this.apiKey } : {}),
      });
      void this.loadWebcams();
      await this.checkKlippy();
    } catch (err) {
      this.log.warn({ url: this.baseUrl, err: (err as Error).message }, 'moonraker init failed');
      this.ws?.close();
    }
  }

  private async checkKlippy() {
    clearTimeout(this.klippyTimer);
    const info = await this.request<{ klippy_state: string; klippy_connected: boolean; components?: string[] }>('server.info');
    this.klippyState = info.klippy_state;
    this.components = info.components ?? [];
    if (info.klippy_state === 'ready') {
      await this.subscribe();
      return;
    }
    if (info.klippy_connected) {
      // startup/shutdown/error: Klipper's own message tells the user what's wrong.
      try {
        const pi = await this.request<{ state_message?: string }>('printer.info');
        this.klippyMessage = pi.state_message;
      } catch {
        /* klippy may not answer yet */
      }
    } else {
      this.klippyMessage = 'Klipper nicht mit Moonraker verbunden';
    }
    this.setConnection('klippy_not_ready');
    this.klippyTimer = setTimeout(() => void this.checkKlippy().catch(() => {}), KLIPPY_POLL_MS);
  }

  private async subscribe() {
    const { objects } = await this.request<{ objects: string[] }>('printer.objects.list');
    const wanted: Record<string, null> = {};
    const base = [
      'webhooks',
      'print_stats',
      'virtual_sdcard',
      'display_status',
      'extruder',
      'heater_bed',
      'toolhead',
      'fan',
      'gcode_move',
      'idle_timeout',
      'motion_report',
      'exclude_object',
    ];
    for (const o of objects) {
      if (base.includes(o) || /^(temperature_sensor|temperature_fan|heater_generic) /.test(o) || isFanObject(o)) wanted[o] = null;
    }
    const res = await this.request<{ status: RawStatus }>('printer.objects.subscribe', { objects: wanted });
    this.raw = res.status;
    await this.loadCapabilities(objects);
    this.klippyMessage = undefined;
    this.updatedAt = Date.now();
    this.setConnection('connected');
    void this.refreshFileMetadata();
  }

  private async loadCapabilities(objects: string[]) {
    let settings: Record<string, Record<string, unknown>> = {};
    try {
      const res = await this.request<{ status: { configfile?: { settings?: typeof settings } } }>('printer.objects.query', {
        objects: { configfile: ['settings'] },
      });
      settings = res.status.configfile?.settings ?? {};
    } catch {
      /* fall back to defaults below */
    }
    this.capabilities = deriveCapabilities(objects, settings);
    this.emit('capabilities', this.capabilities);
  }

  private async loadWebcams() {
    try {
      const res = await this.request<{ webcams: RawWebcam[] }>('server.webcams.list');
      this.webcams = res.webcams.filter((w) => w.enabled !== false);
      this.emit('webcams', this.webcams);
    } catch {
      /* older Moonraker without webcam API */
    }
  }

  private onMessage(text: string) {
    let msg: { id?: number; result?: unknown; error?: { code: number; message: string }; method?: string; params?: unknown[] };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new MoonrakerError(msg.error.message, msg.error.code));
      else p.resolve(msg.result);
      return;
    }
    switch (msg.method) {
      case 'notify_status_update': {
        const update = msg.params?.[0] as RawStatus | undefined;
        if (!update) return;
        for (const [obj, fields] of Object.entries(update)) {
          this.raw[obj] = { ...this.raw[obj], ...fields };
        }
        this.updatedAt = Date.now();
        if ('print_stats' in update && 'filename' in (update.print_stats ?? {})) void this.refreshFileMetadata();
        this.scheduleEmit();
        break;
      }
      case 'notify_klippy_ready':
        void this.checkKlippy().catch(() => {});
        break;
      case 'notify_klippy_shutdown':
      case 'notify_klippy_disconnected':
        this.klippyState = msg.method === 'notify_klippy_shutdown' ? 'shutdown' : 'disconnected';
        void this.checkKlippy().catch(() => {});
        break;
      case 'notify_gcode_response':
        for (const line of (msg.params as string[] | undefined) ?? []) this.emit('gcode', line);
        break;
      case 'notify_webcams_changed':
        void this.loadWebcams();
        break;
      case 'notify_active_spool_set':
        this.emit('spool', ((msg.params?.[0] as { spool_id?: number | null } | undefined)?.spool_id ?? null) || null);
        break;
      case 'notify_metadata_update':
        void this.refreshFileMetadata(true);
        break;
    }
  }

  private async refreshFileMetadata(force = false) {
    const filename = this.raw.print_stats?.filename as string | undefined;
    if (!filename) {
      if (this.file) {
        this.file = undefined;
        this.scheduleEmit();
      }
      return;
    }
    if (!force && (this.file?.filename === filename || this.fileLoading === filename)) return;
    this.fileLoading = filename;
    try {
      const meta = await this.request<Record<string, unknown>>('server.files.metadata', { filename });
      this.file = toFileMetadata(filename, meta);
    } catch {
      this.file = { filename };
    } finally {
      this.fileLoading = undefined;
    }
    this.scheduleEmit();
  }

  private setConnection(state: ConnectionState) {
    if (this.connection === state && state !== 'klippy_not_ready') return;
    this.connection = state;
    this.scheduleEmit(true);
  }

  private scheduleEmit(immediate = false) {
    this.emitLifecycle();
    if (immediate) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
      this.emit('status', this.status);
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emit('status', this.status);
    }, 250);
  }

  /** Print-state transitions must never be coalesced by the display throttle. */
  private emitLifecycle() {
    const s = this.status;
    const key = `${s.connection}|${s.klippyState ?? ''}|${s.printState ?? ''}|${s.filename ?? ''}`;
    if (key === this.lifecycleKey) return;
    this.lifecycleKey = key;
    this.emit('lifecycle', s);
  }

  private failPending(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

export function toFileMetadata(filename: string, meta: Record<string, unknown>): FileMetadata {
  const thumbs = (meta.thumbnails as { width: number; relative_path: string }[] | undefined) ?? [];
  const largest = [...thumbs].sort((a, b) => b.width - a.width)[0];
  const dir = filename.includes('/') ? filename.slice(0, filename.lastIndexOf('/') + 1) : '';
  return {
    filename,
    size: num(meta.size),
    modified: num(meta.modified),
    estimatedTime: num(meta.estimated_time),
    filamentTotal: num(meta.filament_total),
    filamentWeightTotal: num(meta.filament_weight_total),
    layerHeight: num(meta.layer_height),
    slicer: typeof meta.slicer === 'string' ? `${meta.slicer} ${meta.slicer_version ?? ''}`.trim() : undefined,
    thumbnailPath: largest ? dir + largest.relative_path : undefined,
  };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const PRINT_STATES: PrintState[] = ['standby', 'printing', 'paused', 'complete', 'cancelled', 'error'];

export function deriveStatus(
  raw: RawStatus,
  base: Pick<PrinterStatus, 'connection' | 'klippyState' | 'klippyMessage' | 'file' | 'updatedAt'>,
): PrinterStatus {
  if (base.connection !== 'connected') {
    return { ...base };
  }
  const ps = raw.print_stats ?? {};
  const sd = raw.virtual_sdcard ?? {};
  const ds = raw.display_status ?? {};
  const state = PRINT_STATES.includes(ps.state as PrintState) ? (ps.state as PrintState) : undefined;
  const progress = num(sd.progress) ?? num(ds.progress);
  const printDuration = num(ps.print_duration);

  let eta: number | undefined;
  if ((state === 'printing' || state === 'paused') && printDuration !== undefined) {
    const slicerEta = base.file?.estimatedTime ? Math.max(0, base.file.estimatedTime - printDuration) : undefined;
    const fileEta = progress && progress > 0.05 ? printDuration / progress - printDuration : undefined;
    eta = fileEta ?? slicerEta;
  }

  const heater = (o: Record<string, unknown> | undefined) =>
    o && num(o.temperature) !== undefined
      ? { temperature: num(o.temperature)!, target: num(o.target) ?? 0, power: num(o.power) }
      : undefined;

  const sensors: Record<string, { temperature: number; target: number }> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (/^(temperature_sensor|temperature_fan|heater_generic) /.test(key) && num(val.temperature) !== undefined) {
      sensors[key.slice(key.indexOf(' ') + 1)] = { temperature: num(val.temperature)!, target: num(val.target) ?? 0 };
    }
  }
  const fans: Record<string, number> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!isFanObject(key) && !key.startsWith('temperature_fan ')) continue;
    // Fans report "speed"; output_pin reports "value", already divided by its scale.
    const v = num(val.speed) ?? num(val.value);
    if (v !== undefined) fans[key] = v;
  }
  const info = ps.info as { current_layer?: number | null; total_layer?: number | null } | undefined;
  const gm = raw.gcode_move ?? {};
  const th = raw.toolhead ?? {};

  return {
    ...base,
    printState: state,
    filename: (ps.filename as string) || undefined,
    progress,
    printDuration,
    totalDuration: num(ps.total_duration),
    eta,
    filamentUsed: num(ps.filament_used),
    currentLayer: info?.current_layer ?? null,
    totalLayers: info?.total_layer ?? null,
    message: (ps.message as string) || (ds.message as string) || undefined,
    extruder: heater(raw.extruder),
    heaterBed: heater(raw.heater_bed),
    sensors,
    fanSpeed: num(raw.fan?.speed),
    fans,
    speedFactor: num(gm.speed_factor),
    extrudeFactor: num(gm.extrude_factor),
    position: (gm.gcode_position as PrinterStatus['position']) ?? undefined,
    homedAxes: th.homed_axes as string | undefined,
    axisMaximum: th.axis_maximum as PrinterStatus['axisMaximum'],
    excludeObject: raw.exclude_object
      ? {
          objects: (raw.exclude_object.objects as NonNullable<PrinterStatus['excludeObject']>['objects']) ?? [],
          excluded: (raw.exclude_object.excluded_objects as string[]) ?? [],
          current: (raw.exclude_object.current_object as string | null) ?? null,
        }
      : undefined,
  };
}

const HEATER_LABELS: Record<string, string> = { extruder: 'Düse', heater_bed: 'Bett' };

/** Fan objects besides temperature_fan (that one is listed with the sensors too). */
const isFanObject = (o: string) => o === 'fan' || /^(fan_generic|heater_fan|controller_fan) /.test(o) || /^output_pin \S*fan/i.test(o);

// Stock Creality K1 firmware drives its fans as output pins.
const FAN_LABELS: Record<string, string> = {
  fan: 'Bauteillüfter',
  'output_pin fan0': 'Bauteillüfter',
  'output_pin fan1': 'Zusatzlüfter',
  'output_pin fan2': 'Gehäuselüfter',
};
const FAN_WORDS: [RegExp, string][] = [
  [/\b(hotend|heatbreak|extruder)\b/, 'Hotend'],
  [/\b(chamber|case)\b/, 'Gehäuse'],
  [/\b(aux|auxiliary|side)\b/, 'Zusatz'],
  [/\b(exhaust)\b/, 'Abluft'],
  [/\b(controller|mcu|board|electronics?)\b/, 'Elektronik'],
  [/\b(nevermore|filter)\b/, 'Filter'],
  [/\b(part|model|print)\b/, 'Bauteil'],
];

function fanLabel(o: string): string {
  if (FAN_LABELS[o]) return FAN_LABELS[o];
  const short = o.slice(o.indexOf(' ') + 1).toLowerCase().replace(/_/g, ' ');
  const word = FAN_WORDS.find(([re]) => re.test(short))?.[1];
  if (word) return `${word}lüfter`;
  if (o.startsWith('controller_fan ')) return 'Elektroniklüfter';
  const pretty = short.replace(/\bfan\b/g, '').trim() || short;
  return `Lüfter ${pretty}`;
}

export function deriveFans(objects: string[], settings: Record<string, Record<string, unknown>>): FanInfo[] {
  const fans: FanInfo[] = [];
  for (const o of objects) {
    if (o.startsWith('temperature_fan ')) {
      fans.push({ name: o, label: fanLabel(o), controllable: false });
    } else if (o.startsWith('output_pin ')) {
      if (!isFanObject(o)) continue;
      const cfg = settings[o.toLowerCase()] ?? {};
      // Only PWM pins can run at partial speed.
      if (cfg.pwm === false || cfg.pwm === 'False') continue;
      fans.push({ name: o, label: fanLabel(o), controllable: true, scale: num(cfg.scale) ?? 1 });
    } else if (isFanObject(o)) {
      fans.push({ name: o, label: fanLabel(o), controllable: o === 'fan' || o.startsWith('fan_generic ') });
    }
  }
  const rank = (f: FanInfo) => (f.name === 'fan' || f.name === 'output_pin fan0' ? 0 : f.controllable ? 1 : 2);
  return fans.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Heaters with their configured limits and the user-facing macros. */
export function deriveCapabilities(
  objects: string[],
  settings: Record<string, Record<string, unknown>>,
): PrinterCapabilities {
  const heaters: HeaterInfo[] = [];
  for (const o of objects) {
    if (!/^(extruder\d*|heater_bed|heater_generic .+)$/.test(o)) continue;
    const cfg = settings[o] ?? {};
    const label =
      HEATER_LABELS[o] ?? (o.startsWith('extruder') ? `Düse ${o.slice(8)}` : o.slice(o.indexOf(' ') + 1).replace(/_/g, ' '));
    heaters.push({
      name: o,
      label,
      minTemp: num(cfg.min_temp) ?? 0,
      // Without config, fall back to conservative limits.
      maxTemp: num(cfg.max_temp) ?? (o === 'heater_bed' ? 120 : 280),
    });
  }
  // Hotends first, then the bed, then everything else.
  const rank = (h: HeaterInfo) => (h.name.startsWith('extruder') ? 0 : h.name === 'heater_bed' ? 1 : 2);
  heaters.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const macros = objects
    .filter((o) => o.startsWith('gcode_macro '))
    .map((o) => o.slice('gcode_macro '.length))
    .filter((m) => !m.startsWith('_') && !/^[GM]\d+$/i.test(m))
    .sort((a, b) => a.localeCompare(b));
  return {
    heaters,
    macros,
    fans: deriveFans(objects, settings),
    hasExcludeObject: objects.includes('exclude_object'),
  };
}
