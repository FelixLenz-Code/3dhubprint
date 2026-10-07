import { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createSpoolSchema, type CreateSpoolInput, type FilamentInfo, type PrinterSpool, type SpoolInfo, type SpoolmanStatus } from '@printhub/shared';
import type { Db } from '../db/index.js';
import { appSettings } from '../db/schema.js';
import type { PrinterManager } from '../printers/manager.js';
import type { PrintEvent } from '../printers/events.js';

export class SpoolmanError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
  }
}

const SETTINGS_KEY = 'spoolman';
const CACHE_MS = 30_000;

interface Events {
  /** Active spool of a printer changed (from PrintHub or Moonraker). */
  spool: [number];
}

type Json = Record<string, unknown>;

/**
 * Optional connection to a Spoolman server. Printers whose Moonraker has its own `[spoolman]`
 * section track usage there; for all others PrintHub remembers the active spool and books the
 * used filament after each print. Never both, so nothing is counted twice.
 */
export class SpoolmanService extends EventEmitter<Events> {
  private cache?: { at: number; spools: SpoolInfo[] };

  constructor(
    private readonly db: Db,
    private readonly manager: PrinterManager,
    private readonly log: FastifyBaseLogger,
    /** Spoolman installed alongside PrintHub: its address is fixed and cannot be changed here. */
    private readonly managed: { url?: string; webUrl?: string } = {},
  ) {
    super();
    manager.on('print', (e) => void this.onPrintEvent(e));
    manager.on('spool', (printerId) => {
      this.cache = undefined;
      this.emit('spool', printerId);
    });
  }

  // --- configuration --------------------------------------------------------

  get url(): string | null {
    if (this.managed.url) return this.managed.url.replace(/\/+$/, '');
    const row = this.db.select().from(appSettings).where(eq(appSettings.key, SETTINGS_KEY)).get();
    return row ? ((JSON.parse(row.value) as { url: string }).url ?? null) : null;
  }

  get configured() {
    return this.url !== null;
  }

  async status(): Promise<SpoolmanStatus> {
    const url = this.url;
    if (!url) return { configured: false, url: null };
    const base = { configured: true, url, managed: !!this.managed.url, webUrl: this.managed.url ? (this.managed.webUrl ?? null) : url };
    try {
      const info = await this.request<{ version?: string }>('/api/v1/info', {}, url);
      return { ...base, reachable: true, version: info.version };
    } catch (err) {
      return { ...base, reachable: false, error: (err as Error).message };
    }
  }

  private assertNotManaged() {
    if (this.managed.url) throw new SpoolmanError('Spoolman wurde mit PrintHub installiert, die Adresse ist fest (printhub spoolman off zum Entfernen)', 409);
  }

  /** Checks the server before storing its address. */
  async setUrl(url: string): Promise<SpoolmanStatus> {
    this.assertNotManaged();
    const info = await this.request<{ version?: string }>('/api/v1/info', {}, url);
    const value = JSON.stringify({ url });
    this.db.insert(appSettings).values({ key: SETTINGS_KEY, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } }).run();
    this.cache = undefined;
    return { configured: true, url, managed: false, webUrl: url, reachable: true, version: info.version };
  }

  remove() {
    this.assertNotManaged();
    this.db.delete(appSettings).where(eq(appSettings.key, SETTINGS_KEY)).run();
    this.cache = undefined;
  }

  // --- spools ---------------------------------------------------------------

  async spools(fresh = false): Promise<SpoolInfo[]> {
    if (!this.configured) return [];
    if (!fresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.spools;
    const raw = await this.request<Json[]>('/api/v1/spool');
    const spools = raw.map(toSpoolInfo).sort((a, b) => Number(a.archived) - Number(b.archived) || (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || a.id - b.id);
    this.cache = { at: Date.now(), spools };
    return spools;
  }

  async spool(id: number): Promise<SpoolInfo | null> {
    const cached = this.cache?.spools.find((s) => s.id === id);
    if (cached && Date.now() - this.cache!.at < CACHE_MS) return cached;
    try {
      return toSpoolInfo(await this.request<Json>(`/api/v1/spool/${id}`));
    } catch (err) {
      if (err instanceof SpoolmanError && err.status === 404) return null;
      throw err;
    }
  }

  async filaments(): Promise<FilamentInfo[]> {
    const raw = await this.request<Json[]>('/api/v1/filament');
    return raw.map(toFilamentInfo).sort((a, b) => (a.vendor ?? '').localeCompare(b.vendor ?? '') || a.name.localeCompare(b.name));
  }

  /** Creates spools of an existing or a new filament (and its vendor, if new). */
  async createSpools(input: CreateSpoolInput): Promise<SpoolInfo[]> {
    const b = createSpoolSchema.parse(input);
    if (b.printerId !== undefined && !this.manager.get(b.printerId)) throw new SpoolmanError('Drucker nicht gefunden', 404);
    let filament: FilamentInfo;
    if (b.filamentId !== undefined) {
      const f = await this.request<Json>(`/api/v1/filament/${b.filamentId}`).catch((err) => {
        throw err instanceof SpoolmanError && err.status === 404 ? new SpoolmanError(`Filament #${b.filamentId} gibt es in Spoolman nicht`, 404) : err;
      });
      filament = toFilamentInfo(f);
    } else {
      const f = b.filament!;
      let vendorId: number | undefined;
      if (f.vendor) {
        const vendors = await this.request<Json[]>('/api/v1/vendor');
        const found = vendors.find((v) => String(v.name).toLowerCase() === f.vendor!.toLowerCase());
        vendorId = Number((found ?? (await this.request<Json>('/api/v1/vendor', { method: 'POST', body: JSON.stringify({ name: f.vendor }) }))).id);
      }
      filament = toFilamentInfo(
        await this.request<Json>('/api/v1/filament', {
          method: 'POST',
          body: JSON.stringify({
            name: f.name,
            vendor_id: vendorId,
            material: f.material,
            color_hex: f.color,
            density: f.density,
            diameter: f.diameter,
            weight: f.weight,
            spool_weight: f.spoolWeight,
            price: f.price,
          }),
        }),
      );
    }
    const created: SpoolInfo[] = [];
    for (let i = 0; i < b.count; i++) {
      const spool = await this.request<Json>('/api/v1/spool', {
        method: 'POST',
        body: JSON.stringify({
          filament_id: filament.id,
          initial_weight: b.initialWeight ?? filament.weight ?? undefined,
          spool_weight: filament.spoolWeight ?? undefined,
          price: b.price ?? filament.price ?? undefined,
          location: b.location,
        }),
      });
      created.push(toSpoolInfo(spool));
    }
    this.cache = undefined;
    if (b.printerId !== undefined) await this.setActiveSpool(b.printerId, created[0]!.id);
    return created;
  }

  /** Corrects the remaining weight (weighed) and/or archives a spool. */
  async updateSpool(id: number, patch: { remainingWeight?: number; archived?: boolean }): Promise<SpoolInfo> {
    const spool = toSpoolInfo(
      await this.request<Json>(`/api/v1/spool/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ remaining_weight: patch.remainingWeight, archived: patch.archived }),
      }),
    );
    this.cache = undefined;
    // An archived spool should not stay active on a printer PrintHub tracks.
    if (patch.archived) {
      for (const p of this.manager.list()) if (this.manager.spoolId(p.id) === id) this.manager.setSpoolId(p.id, null);
    }
    return spool;
  }

  /** Whether the printer's Moonraker talks to Spoolman itself. */
  private moonrakerTracks(printerId: number): boolean {
    return this.manager.client(printerId)?.components.includes('spoolman') ?? false;
  }

  async activeSpoolId(printerId: number): Promise<number | null> {
    if (this.moonrakerTracks(printerId)) {
      const res = await this.manager.client(printerId)!.request<{ spool_id: number | null }>('server.spoolman.get_spool_id');
      return res.spool_id || null;
    }
    return this.manager.spoolId(printerId);
  }

  async printerSpool(printerId: number): Promise<PrinterSpool> {
    const tracking = this.moonrakerTracks(printerId) ? 'moonraker' : 'printhub';
    if (!this.configured) return { printerId, spool: null, tracking };
    const id = await this.activeSpoolId(printerId);
    return { printerId, spool: id ? await this.spool(id) : null, tracking };
  }

  async setActiveSpool(printerId: number, spoolId: number | null): Promise<PrinterSpool> {
    if (!this.configured) throw new SpoolmanError('Spoolman ist nicht eingerichtet (Einstellungen → Integrationen)', 409);
    if (spoolId !== null && !(await this.spool(spoolId))) throw new SpoolmanError(`Spule #${spoolId} gibt es in Spoolman nicht`, 404);
    if (this.moonrakerTracks(printerId)) {
      await this.manager.client(printerId)!.request('server.spoolman.post_spool_id', { spool_id: spoolId });
    } else {
      this.manager.setSpoolId(printerId, spoolId);
    }
    this.emit('spool', printerId);
    return this.printerSpool(printerId);
  }

  /** Books filament used by a finished print on the printer's spool (PrintHub tracking only). */
  private async onPrintEvent(e: PrintEvent) {
    if (e.type !== 'finished' || !this.configured || this.moonrakerTracks(e.printerId)) return;
    const spoolId = this.manager.spoolId(e.printerId);
    if (!spoolId || !e.filamentUsed || e.filamentUsed <= 0) return;
    try {
      await this.request(`/api/v1/spool/${spoolId}/use`, { method: 'PUT', body: JSON.stringify({ use_length: e.filamentUsed }) });
      this.cache = undefined;
      this.emit('spool', e.printerId);
    } catch (err) {
      this.log.warn({ err: (err as Error).message, spoolId, printer: e.printerId }, 'spoolman: booking filament usage failed');
    }
  }

  // --- HTTP -----------------------------------------------------------------

  private async request<T>(pathname: string, init: RequestInit = {}, base = this.url): Promise<T> {
    if (!base) throw new SpoolmanError('Spoolman ist nicht eingerichtet (Einstellungen → Integrationen)', 409);
    let res: Response;
    try {
      res = await fetch(new URL(pathname, base + '/'), {
        ...init,
        headers: { Accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new SpoolmanError(`Spoolman ist unter ${base} nicht erreichbar`);
    }
    if (res.status === 404) throw new SpoolmanError('Bei Spoolman nicht gefunden', 404);
    if (res.status === 422 || res.status === 400) {
      const detail = await res.json().catch(() => null);
      throw new SpoolmanError(`Spoolman lehnt die Eingabe ab${detail?.message ? `: ${detail.message}` : ''}`, 400);
    }
    if (!res.ok) throw new SpoolmanError(`Spoolman-Fehler (HTTP ${res.status})`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new SpoolmanError(`${base} antwortet nicht wie ein Spoolman-Server`);
    }
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const time = (v: unknown) => {
  const t = typeof v === 'string' ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`) : NaN;
  return Number.isFinite(t) ? t : null;
};

export function toSpoolInfo(s: Json): SpoolInfo {
  const f = (s.filament ?? {}) as Json;
  const vendor = (f.vendor ?? {}) as Json;
  const initialG = num(s.initial_weight) ?? num(f.weight);
  // Spool price is for the whole spool; the filament price for its net weight.
  const spoolPrice = num(s.price);
  const filamentPrice = num(f.price);
  const pricePerKg =
    spoolPrice !== null && initialG ? (spoolPrice / initialG) * 1000 : filamentPrice !== null && num(f.weight) ? (filamentPrice / num(f.weight)!) * 1000 : null;
  const hex = str(f.color_hex) ?? str(f.multi_color_hexes)?.split(',')[0] ?? null;
  return {
    id: Number(s.id),
    name: str(f.name) ?? `Spule ${String(s.id)}`,
    vendor: str(vendor.name),
    material: str(f.material),
    color: hex ? `#${hex.replace(/^#/, '').slice(0, 6)}` : null,
    remainingG: num(s.remaining_weight),
    initialG,
    usedG: num(s.used_weight) ?? 0,
    pricePerKg,
    density: num(f.density),
    diameter: num(f.diameter),
    location: str(s.location),
    lastUsed: time(s.last_used),
    archived: s.archived === true,
  };
}

export function toFilamentInfo(f: Json): FilamentInfo {
  const vendor = (f.vendor ?? {}) as Json;
  const hex = str(f.color_hex) ?? str(f.multi_color_hexes)?.split(',')[0] ?? null;
  return {
    id: Number(f.id),
    name: str(f.name) ?? `Filament ${String(f.id)}`,
    vendor: str(vendor.name),
    material: str(f.material),
    color: hex ? `#${hex.replace(/^#/, '').slice(0, 6)}` : null,
    density: num(f.density),
    diameter: num(f.diameter),
    weight: num(f.weight),
    spoolWeight: num(f.spool_weight),
    price: num(f.price),
  };
}
