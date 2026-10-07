import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  DEFAULT_COST_SETTINGS,
  MATERIAL_DENSITY,
  ZERO_COST,
  addCosts,
  costSettingsSchema,
  estimateCost,
  filamentGrams,
  spoolLabel,
  type CostSettings,
  type PrintOutcome,
  type PrintRecord,
  type PrintRecordPage,
  type PrintStats,
  type StatsBucket,
  type StatsGroup,
  type StatsRange,
} from '@printhub/shared';
import type { Db } from '../db/index.js';
import { appSettings, jobs, prints, slicerProfiles } from '../db/schema.js';
import type { PrinterManager } from '../printers/manager.js';
import type { PrintEvent } from '../printers/events.js';
import type { SpoolmanService } from '../spoolman/service.js';

const COSTS_KEY = 'costs';
const PAGE = 100;
/** Initial import: at most this many pages of Moonraker history per printer. */
const MAX_PAGES = 100;
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
/** "idle" fires often (every reconnect); don't re-read history more often than this. */
const IDLE_SYNC_MIN_MS = 2 * 60 * 1000;
/** Moonraker writes the history entry right after the print ends. */
const FINISH_SYNC_DELAY_MS = 3000;


type PrintRow = typeof prints.$inferSelect;

interface RawHistoryJob {
  job_id: string;
  filename: string;
  status: string;
  start_time: number;
  end_time?: number | null;
  print_duration: number;
  total_duration: number;
  filament_used: number;
  metadata?: Record<string, unknown>;
  auxiliary_data?: { provider?: string; name?: string; value?: unknown }[];
}

/** error, klippy_shutdown, klippy_disconnect, interrupted, server_exit, … count as failed. */
export function outcomeOf(status: string): PrintOutcome | 'in_progress' {
  return status === 'in_progress' || status === 'completed' || status === 'cancelled' ? status : 'failed';
}

export class StatsService {
  private syncing = new Map<number, Promise<void>>();
  private lastSync = new Map<number, number>();
  /** Spool active when a print started, to attribute the print (PrintHub-tracked spools). */
  private startSpools = new Map<number, { spoolId: number; at: number; filename?: string }>();
  private timer?: NodeJS.Timeout;
  private timeouts = new Set<NodeJS.Timeout>();

  constructor(
    private readonly db: Db,
    private readonly manager: PrinterManager,
    private readonly spoolman: SpoolmanService,
    private readonly log: FastifyBaseLogger,
  ) {
    manager.on('print', (e) => this.onPrintEvent(e));
  }

  start() {
    this.timer = setInterval(() => void this.syncAll(), SYNC_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.timer);
    for (const t of this.timeouts) clearTimeout(t);
    this.timeouts.clear();
  }

  // --- cost settings ----------------------------------------------------------

  costSettings(): CostSettings {
    const row = this.db.select().from(appSettings).where(eq(appSettings.key, COSTS_KEY)).get();
    if (!row) return DEFAULT_COST_SETTINGS;
    const parsed = costSettingsSchema.safeParse({ ...DEFAULT_COST_SETTINGS, ...JSON.parse(row.value) });
    return parsed.success ? parsed.data : DEFAULT_COST_SETTINGS;
  }

  setCostSettings(s: CostSettings): CostSettings {
    const value = JSON.stringify(costSettingsSchema.parse(s));
    this.db.insert(appSettings).values({ key: COSTS_KEY, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } }).run();
    return this.costSettings();
  }

  // --- sync ---------------------------------------------------------------------

  private onPrintEvent(e: PrintEvent) {
    if (e.type === 'started') {
      this.spoolman
        .activeSpoolId(e.printerId)
        .then((spoolId) => {
          if (spoolId) this.startSpools.set(e.printerId, { spoolId, at: Date.now(), filename: e.filename });
          else this.startSpools.delete(e.printerId);
        })
        .catch(() => this.startSpools.delete(e.printerId));
      this.later(() => this.sync(e.printerId), FINISH_SYNC_DELAY_MS);
    } else if (e.type === 'finished' || (e.type === 'klippy_error' && e.wasPrinting)) {
      this.later(() => this.sync(e.printerId), FINISH_SYNC_DELAY_MS);
    } else if (e.type === 'idle') {
      if (Date.now() - (this.lastSync.get(e.printerId) ?? 0) > IDLE_SYNC_MIN_MS) void this.sync(e.printerId);
    }
  }

  private later(fn: () => Promise<unknown>, ms: number) {
    const t = setTimeout(() => {
      this.timeouts.delete(t);
      void fn();
    }, ms);
    this.timeouts.add(t);
  }

  async syncAll(): Promise<void> {
    await Promise.all(this.manager.list().map((p) => this.sync(p.id)));
  }

  /** Mirrors new Moonraker history entries; one run per printer at a time. */
  sync(printerId: number): Promise<void> {
    const running = this.syncing.get(printerId);
    if (running) return running;
    const p = this.doSync(printerId)
      .catch((err) => this.log.warn({ printer: printerId, err: (err as Error).message }, 'history sync failed'))
      .finally(() => this.syncing.delete(printerId));
    this.syncing.set(printerId, p);
    return p;
  }

  private async doSync(printerId: number) {
    const client = this.manager.client(printerId);
    const conn = client?.status.connection;
    if (!client || (conn !== 'connected' && conn !== 'klippy_not_ready')) return;
    const known = new Map(
      this.db
        .select({ id: prints.moonrakerJobId, status: prints.status })
        .from(prints)
        .where(eq(prints.printerId, printerId))
        .all()
        .map((r) => [r.id, r.status]),
    );
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.request<{ jobs: RawHistoryJob[] }>('server.history.list', { start: page * PAGE, limit: PAGE, order: 'desc' });
      let reachedKnown = false;
      for (const j of res.jobs) {
        const status = known.get(j.job_id);
        // History is newest first and finished entries never change: stop at the first one we have.
        if (status !== undefined && status !== 'in_progress') {
          reachedKnown = true;
          break;
        }
        await this.upsert(printerId, j, status !== undefined);
      }
      if (reachedKnown || res.jobs.length < PAGE) break;
    }
    this.lastSync.set(printerId, Date.now());
  }

  private async upsert(printerId: number, j: RawHistoryJob, exists: boolean) {
    const meta = j.metadata ?? {};
    const startTime = Math.round(j.start_time * 1000);
    const filamentName = typeof meta.filament_name === 'string' ? meta.filament_name : null;
    const material = typeof meta.filament_type === 'string' ? meta.filament_type.split(';')[0]!.trim() || null : null;
    const colors = meta.filament_colors as unknown;
    const color = Array.isArray(colors) && typeof colors[0] === 'string' && /^#[0-9a-f]{6}$/i.test(colors[0]) ? colors[0] : null;

    const job = this.db
      .select({ id: jobs.id, filamentProfileId: jobs.filamentProfileId })
      .from(jobs)
      .where(and(eq(jobs.printerId, printerId), eq(jobs.printerPath, j.filename), lte(jobs.createdAt, startTime + 60_000)))
      .orderBy(desc(jobs.createdAt))
      .get();

    const auxSpool = j.auxiliary_data?.find((a) => a.provider === 'spoolman' && a.name === 'spool_ids')?.value;
    const remembered = this.startSpools.get(printerId);
    const spoolId =
      (Array.isArray(auxSpool) && typeof auxSpool[0] === 'number' ? auxSpool[0] : null) ??
      (remembered && (!remembered.filename || remembered.filename === j.filename) && Math.abs(remembered.at - startTime) < 5 * 60_000 ? remembered.spoolId : null);
    const spool = spoolId ? await this.spoolman.spool(spoolId).catch(() => null) : null;

    const profile = this.filamentProfile(job?.filamentProfileId, filamentName);
    const profileCost = Number(profile?.cost);
    const [pricePerKg, priceSource] =
      spool?.pricePerKg != null ? [spool.pricePerKg, 'spool' as const] : profileCost > 0 ? [profileCost, 'profile' as const] : [null, 'default' as const];

    // Grams: the slicer's weight/length ratio is exact for this file; otherwise from density.
    const wt = Number(meta.filament_weight_total);
    const len = Number(meta.filament_total);
    const mm = Math.max(0, j.filament_used || 0);
    const filamentG =
      wt > 0 && len > 0
        ? (mm * wt) / len
        : filamentGrams(
            mm,
            spool?.diameter ?? (Number(profile?.diameter) || 1.75),
            spool?.density ?? (Number(profile?.density) || MATERIAL_DENSITY[material?.toUpperCase() ?? ''] || 1.24),
          );

    const values = {
      printerId,
      printerName: this.manager.name(printerId),
      moonrakerJobId: j.job_id,
      filename: j.filename,
      status: j.status,
      startTime,
      endTime: j.end_time ? Math.round(j.end_time * 1000) : null,
      printDuration: j.print_duration || 0,
      totalDuration: j.total_duration || 0,
      filamentMm: mm,
      filamentG,
      material,
      filamentName,
      color,
      jobId: job?.id ?? null,
      spoolId: spool?.id ?? spoolId,
      spoolName: spool ? spoolLabel(spool) : null,
      pricePerKg,
      priceSource,
      syncedAt: Date.now(),
    };
    if (exists) {
      this.db
        .update(prints)
        .set(values)
        .where(and(eq(prints.printerId, printerId), eq(prints.moonrakerJobId, j.job_id)))
        .run();
    } else {
      this.db.insert(prints).values(values).run();
    }
  }

  /** Summary of the PrintHub job's filament profile, else the current profile of that name. */
  private filamentProfile(profileId: number | undefined, name: string | null): Record<string, unknown> | undefined {
    const row =
      (profileId !== undefined ? this.db.select().from(slicerProfiles).where(eq(slicerProfiles.id, profileId)).get() : undefined) ??
      (name
        ? this.db
            .select()
            .from(slicerProfiles)
            .where(and(eq(slicerProfiles.kind, 'filament'), eq(slicerProfiles.name, name), eq(slicerProfiles.current, true)))
            .get()
        : undefined);
    return row ? (JSON.parse(row.summary) as Record<string, unknown>) : undefined;
  }

  // --- queries ------------------------------------------------------------------

  private toRecord(r: PrintRow, s: CostSettings): PrintRecord {
    return {
      id: r.id,
      printerId: r.printerId,
      printerName: r.printerId ? this.manager.name(r.printerId) : r.printerName,
      filename: r.filename,
      status: r.status,
      outcome: outcomeOf(r.status),
      startTime: r.startTime,
      endTime: r.endTime,
      printDuration: r.printDuration,
      totalDuration: r.totalDuration,
      filamentMm: r.filamentMm,
      filamentG: r.filamentG,
      material: r.material,
      filamentName: r.filamentName,
      color: r.color,
      jobId: r.jobId,
      spool: r.spoolId ? { id: r.spoolId, name: r.spoolName ?? `#${r.spoolId}` } : null,
      priceSource: r.priceSource,
      cost: estimateCost(
        { grams: r.filamentG, pricePerKg: r.pricePerKg, seconds: r.totalDuration, printSeconds: r.printDuration, printerId: r.printerId },
        s,
      ),
    };
  }

  listPrints(q: { printerId?: number; offset: number; limit: number }): PrintRecordPage {
    const where = q.printerId ? eq(prints.printerId, q.printerId) : undefined;
    const s = this.costSettings();
    const rows = this.db.select().from(prints).where(where).orderBy(desc(prints.startTime)).limit(q.limit).offset(q.offset).all();
    const total = this.db.select({ n: sql<number>`count(*)` }).from(prints).where(where).get()?.n ?? 0;
    return { prints: rows.map((r) => this.toRecord(r, s)), total };
  }

  stats(range: StatsRange, printerId: number | undefined, tz: string, now = Date.now()): PrintStats {
    const zone = validZone(tz);
    const cal = new Calendar(zone);
    const today = cal.ymd(now);
    const bucket = range === '7d' || range === '30d' ? 'day' : range === '90d' ? 'week' : 'month';
    const firstDay: Ymd | null =
      range === '7d' ? addDays(today, -6) : range === '30d' ? addDays(today, -29) : range === '90d' ? addDays(today, -89) : range === '12m' ? addMonths([today[0], today[1], 1], -11) : null;
    const from = firstDay ? cal.midnight(firstDay) : null;

    const conds: SQL[] = [];
    if (from !== null) conds.push(gte(prints.startTime, from));
    if (printerId) conds.push(eq(prints.printerId, printerId));
    const s = this.costSettings();
    const records = this.db
      .select()
      .from(prints)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(prints.startTime)
      .all()
      .map((r) => this.toRecord(r, s))
      .filter((r) => r.outcome !== 'in_progress');

    const keyOf = (ymd: Ymd): Ymd => (bucket === 'day' ? ymd : bucket === 'week' ? weekStart(ymd) : [ymd[0], ymd[1], 1]);
    const next = (ymd: Ymd): Ymd => (bucket === 'day' ? addDays(ymd, 1) : bucket === 'week' ? addDays(ymd, 7) : addMonths(ymd, 1));
    const buckets = new Map<string, StatsBucket>();
    const start = firstDay ?? (records[0] ? cal.ymd(records[0].startTime) : today);
    const last = ymdKey(keyOf(today));
    for (let k = keyOf(start), guard = 0; guard < 1000; k = next(k), guard++) {
      buckets.set(ymdKey(k), { start: cal.midnight(k), prints: 0, completed: 0, printTime: 0, filamentG: 0, cost: 0 });
      if (ymdKey(k) === last) break;
    }

    const totals: PrintStats['totals'] = { prints: 0, completed: 0, cancelled: 0, failed: 0, printTime: 0, filamentG: 0, filamentMm: 0, cost: ZERO_COST, defaultPriced: 0 };
    const byPrinter = new Map<string, StatsGroup>();
    const byMaterial = new Map<string, StatsGroup>();
    const add = (g: { prints: number; completed: number; printTime: number; filamentG: number; cost: number }, r: PrintRecord) => {
      g.prints++;
      if (r.outcome === 'completed') g.completed++;
      g.printTime += r.printDuration;
      g.filamentG += r.filamentG ?? 0;
      g.cost += r.cost.total;
    };
    const group = (map: Map<string, StatsGroup>, key: string, label: string) => {
      let g = map.get(key);
      if (!g) map.set(key, (g = { key, label, prints: 0, completed: 0, printTime: 0, filamentG: 0, cost: 0 }));
      return g;
    };

    for (const r of records) {
      totals.prints++;
      totals[r.outcome as 'completed' | 'cancelled' | 'failed']++;
      totals.printTime += r.printDuration;
      totals.filamentG += r.filamentG ?? 0;
      totals.filamentMm += r.filamentMm;
      totals.cost = addCosts(totals.cost, r.cost);
      if (r.priceSource === 'default' && r.filamentMm > 0) totals.defaultPriced++;
      const b = buckets.get(ymdKey(keyOf(cal.ymd(r.startTime))));
      if (b) add(b, r);
      add(group(byPrinter, r.printerId ? String(r.printerId) : `name:${r.printerName}`, r.printerName), r);
      add(group(byMaterial, r.material ?? '', r.material ?? 'Unbekannt'), r);
    }

    const lastSync = this.db.select({ t: sql<number | null>`max(${prints.syncedAt})` }).from(prints).get()?.t ?? null;
    const sorted = (m: Map<string, StatsGroup>) => [...m.values()].sort((a, b) => b.filamentG - a.filamentG || b.prints - a.prints);
    return {
      range,
      bucket,
      from,
      to: now,
      totals,
      buckets: [...buckets.values()],
      byPrinter: sorted(byPrinter),
      byMaterial: sorted(byMaterial),
      lastSync: Math.max(lastSync ?? 0, ...this.lastSync.values()) || null,
    };
  }
}

// --- calendar helpers (local dates in the viewer's time zone) ----------------------

type Ymd = [number, number, number];

function validZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

const ymdKey = (d: Ymd) => d.join('-');
const fromUtc = (ms: number): Ymd => {
  const d = new Date(ms);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
};
const addDays = (d: Ymd, n: number): Ymd => fromUtc(Date.UTC(d[0], d[1] - 1, d[2] + n));
const addMonths = (d: Ymd, n: number): Ymd => fromUtc(Date.UTC(d[0], d[1] - 1 + n, 1));
/** Monday of the week. */
const weekStart = (d: Ymd): Ymd => addDays(d, -((new Date(Date.UTC(d[0], d[1] - 1, d[2])).getUTCDay() + 6) % 7));

class Calendar {
  private fmt: Intl.DateTimeFormat;
  constructor(zone: string) {
    this.fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  }

  private parts(ms: number) {
    const p = Object.fromEntries(this.fmt.formatToParts(ms).map((x) => [x.type, Number(x.value)]));
    return p as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  }

  ymd(ms: number): Ymd {
    const p = this.parts(ms);
    return [p.year, p.month, p.day];
  }

  /** Unix ms of 00:00 local time on that date. */
  midnight(d: Ymd): number {
    const guess = Date.UTC(d[0], d[1] - 1, d[2]);
    const offset = (ms: number) => {
      const p = this.parts(ms);
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
    };
    // Twice, so a DST change between the guess and local midnight is accounted for.
    const first = guess - offset(guess);
    return guess - offset(first);
  }
}
