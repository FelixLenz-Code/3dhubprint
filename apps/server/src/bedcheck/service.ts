import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  DEFAULT_BED_CHECK,
  MAX_BED_REFERENCES,
  bedCheckSettingsSchema,
  type BedCheckInfo,
  type BedCheckResult,
  type BedCheckSettings,
  type BedCheckState,
  type BedCheckMethod,
  type BedReference,
} from '@printhub/shared';
import type { Db } from '../db/index.js';
import { bedReferences, printers } from '../db/schema.js';
import type { PrinterManager } from '../printers/manager.js';
import type { PrintEvent } from '../printers/events.js';
import { webcamUrl } from '../printers/routes.js';
import type { SlicingService } from '../slicer/service.js';
import { compare, decodeJpeg, extractFeatures, gridMask, renderOverlay, verdict, cellThreshold, type Features, type Region, type Rgba } from './analyze.js';
import { aiThreshold, compareAi, embed, modelAvailable, type PatchFeatures } from './ai.js';

export class BedCheckError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

const TICK_MS = 15_000;
/** Between checks while the bed counts as occupied. */
const CHECK_INTERVAL_MS = 60_000;
/** After a print ends, so the printer has parked and the camera sees the final state. */
const AFTER_PRINT_MS = 45_000;
/** auto mode releases the bed only after this many clear results in a row. */
const AUTO_CLEAR_STREAK = 2;
/** A rejected suggestion is not repeated for this long. */
const REJECT_PAUSE_MS = 10 * 60_000;
const SNAPSHOT_TIMEOUT_MS = 8_000;
/** A confirmed-empty image this close to a reference adds nothing new (per method). */
const DUPLICATE_SCORE: Record<BedCheckMethod, number> = { classic: 0.35, ai: 0.2 };

/** Per-cell differences from the empty bed, from whichever method ran. */
interface Analysis {
  method: BedCheckMethod;
  cols: number;
  rows: number;
  cells: Float32Array;
  threshold: number;
}

interface PrinterCheck {
  last: BedCheckResult | null;
  overlay?: Buffer;
  streak: number;
  suggestClear: boolean;
  notified: boolean;
  nextAt: number;
  rejectedUntil: number;
  running: boolean;
}

/**
 * Tells from the webcam whether the bed is empty, by comparing the bed region with images of
 * the empty bed. While the bed counts as occupied it checks every minute; in confirm mode a
 * clear result is offered to the user, in auto mode it releases the bed and the queue.
 */
export class BedCheckService {
  private readonly checks = new Map<number, PrinterCheck>();
  private readonly features = new Map<string, Features>();
  private readonly embeddings = new Map<string, PatchFeatures>();
  private timer?: NodeJS.Timeout;
  private readonly dir: string;
  /** Push messages; wired by the notification service. */
  onSuggest?: (printerId: number, auto: boolean, waiting: number) => void;
  /** A queued job was held back because the camera did not see an empty bed. */
  onBlocked?: (printerId: number, result: BedCheckResult) => void;

  constructor(
    private readonly db: Db,
    private readonly manager: PrinterManager,
    private readonly slicing: SlicingService,
    private readonly log: FastifyBaseLogger,
    dataDir: string,
  ) {
    this.dir = path.join(dataDir, 'bedcheck');
    fs.mkdirSync(this.dir, { recursive: true });
    manager.on('print', (e: PrintEvent) => this.onPrintEvent(e));
  }

  start() {
    this.removeOrphans();
    for (const p of this.manager.list()) this.publish(p.id);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  settings(printerId: number): BedCheckSettings {
    const row = this.db.select({ bedCheck: printers.bedCheck }).from(printers).where(eq(printers.id, printerId)).get();
    if (!row) throw new BedCheckError('Drucker nicht gefunden', 404);
    if (!row.bedCheck) return DEFAULT_BED_CHECK;
    const parsed = bedCheckSettingsSchema.safeParse(JSON.parse(row.bedCheck));
    return parsed.success ? parsed.data : DEFAULT_BED_CHECK;
  }

  setSettings(printerId: number, next: BedCheckSettings): BedCheckInfo {
    const before = this.settings(printerId);
    if (next.mode === 'auto' && !next.region) throw new BedCheckError('Für den Automatikmodus zuerst den Bereich des Druckbetts markieren');
    this.db.update(printers).set({ bedCheck: JSON.stringify(next) }).where(eq(printers.id, printerId)).run();
    // Images of another camera say nothing about this one.
    if (before.webcam !== next.webcam) for (const r of this.references(printerId)) this.removeReference(printerId, r.id);
    if (JSON.stringify(before.region) !== JSON.stringify(next.region)) this.forgetFeatures(this.references(printerId).map((r) => r.id));
    const c = this.check(printerId);
    c.streak = 0;
    c.suggestClear = false;
    c.nextAt = 0;
    this.publish(printerId);
    return this.info(printerId);
  }

  info(printerId: number): BedCheckInfo {
    return { settings: this.settings(printerId), references: this.references(printerId), state: this.state(printerId), aiAvailable: modelAvailable() };
  }

  references(printerId: number): BedReference[] {
    return this.db
      .select()
      .from(bedReferences)
      .where(eq(bedReferences.printerId, printerId))
      .orderBy(asc(bedReferences.createdAt))
      .all()
      .map((r) => ({ id: r.id, createdAt: r.createdAt, source: r.source }));
  }

  referenceImage(printerId: number, refId: number): Buffer {
    const row = this.db.select().from(bedReferences).where(and(eq(bedReferences.id, refId), eq(bedReferences.printerId, printerId))).get();
    if (!row) throw new BedCheckError('Referenzbild nicht gefunden', 404);
    return fs.readFileSync(this.file(row.id));
  }

  /** Saves the current camera image as an empty bed. */
  async addReference(printerId: number, source: BedReference['source'], image?: Buffer): Promise<BedReference> {
    const jpg = image ?? (await this.snapshot(printerId));
    decodeJpeg(jpg); // reject anything we couldn't compare later
    const row = this.db.insert(bedReferences).values({ printerId, createdAt: Date.now(), source }).returning().get();
    fs.writeFileSync(this.file(row.id), jpg);
    // Keep the newest; learned images go before the ones saved on purpose.
    const refs = this.references(printerId);
    const excess = refs.length - MAX_BED_REFERENCES;
    if (excess > 0) {
      const order = [...refs.filter((r) => r.source === 'confirmed'), ...refs.filter((r) => r.source === 'manual')];
      for (const r of order.filter((r) => r.id !== row.id).slice(0, excess)) this.removeReference(printerId, r.id);
    }
    this.publish(printerId);
    return { id: row.id, createdAt: row.createdAt, source: row.source };
  }

  removeReference(printerId: number, refId: number) {
    const res = this.db.delete(bedReferences).where(and(eq(bedReferences.id, refId), eq(bedReferences.printerId, printerId))).run();
    if (!res.changes) throw new BedCheckError('Referenzbild nicht gefunden', 404);
    fs.rmSync(this.file(refId), { force: true });
    this.forgetFeatures([refId]);
    this.publish(printerId);
  }

  private forgetFeatures(refIds: number[]) {
    const prefixes = refIds.map((id) => `${id}:`);
    for (const cache of [this.features, this.embeddings]) {
      for (const key of cache.keys()) if (prefixes.some((p) => key.startsWith(p))) cache.delete(key);
    }
  }

  /**
   * Someone confirmed the bed is empty: remember the current image as another example of an
   * empty bed, unless it looks just like one already known. Never throws.
   */
  async learn(printerId: number): Promise<void> {
    const s = this.settings(printerId);
    if (s.mode === 'off' || !s.region) return;
    try {
      const jpg = await this.snapshot(printerId);
      if (this.references(printerId).length) {
        const a = await this.analyze(printerId, s, decodeJpeg(jpg));
        if (a && verdict(a.cells, a.threshold).maxDiff < DUPLICATE_SCORE[a.method]) return;
      }
      await this.addReference(printerId, 'confirmed', jpg);
    } catch (err) {
      this.log.warn({ printer: printerId, err: (err as Error).message }, 'bed check: could not learn from confirmation');
    }
  }

  /** Runs a check now and returns its result (also used by the "test" button). */
  async run(printerId: number): Promise<BedCheckResult> {
    const s = this.settings(printerId);
    if (!s.region) throw new BedCheckError('Zuerst den Bereich des Druckbetts im Kamerabild markieren');
    if (!this.references(printerId).length) throw new BedCheckError('Zuerst ein Bild des leeren Druckbetts speichern');
    const c = this.check(printerId);
    if (c.running) return c.last ?? { verdict: 'error', at: Date.now(), error: 'Prüfung läuft bereits' };
    c.running = true;
    try {
      const img = decodeJpeg(await this.snapshot(printerId));
      return await this.evaluate(printerId, s, img);
    } catch (err) {
      c.last = { verdict: 'error', at: Date.now(), error: (err as Error).message };
      c.overlay = undefined;
      c.streak = 0;
      this.publish(printerId);
      return c.last;
    } finally {
      c.running = false;
      c.nextAt = Date.now() + CHECK_INTERVAL_MS;
    }
  }

  /**
   * Fresh look right before a queued print starts. Without a set-up check (off, no region or
   * reference) the start goes ahead; otherwise only a clear result lets it start.
   */
  async allowsStart(printerId: number): Promise<boolean> {
    const s = this.settings(printerId);
    if (s.mode === 'off' || !s.region || !this.references(printerId).length) return true;
    // A routine check may be under way; wait for it so this one uses a fresh image.
    const c = this.check(printerId);
    for (let i = 0; c.running && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
    const result = await this.run(printerId);
    if (result.verdict === 'clear') return true;
    this.log.info({ printer: printerId, verdict: result.verdict, error: result.error }, 'bed check: queued start held back');
    this.onBlocked?.(printerId, result);
    return false;
  }

  overlay(printerId: number): Buffer | undefined {
    return this.checks.get(printerId)?.overlay;
  }

  /** The user says the suggested empty bed is not empty. */
  reject(printerId: number) {
    const c = this.check(printerId);
    c.suggestClear = false;
    c.streak = 0;
    c.rejectedUntil = Date.now() + REJECT_PAUSE_MS;
    this.publish(printerId);
  }

  private async evaluate(printerId: number, s: BedCheckSettings, img: Rgba): Promise<BedCheckResult> {
    const c = this.check(printerId);
    const a = await this.analyze(printerId, s, img);
    if (!a) throw new BedCheckError('Referenzbilder passen nicht zum Kamerabild (andere Auflösung?)');
    const v = verdict(a.cells, a.threshold);
    c.last = { verdict: v.verdict, at: Date.now(), score: v.maxDiff / a.threshold, changed: v.changed.length, method: a.method };
    c.overlay = renderOverlay(img, s.region!, a, v.changed);
    c.streak = v.verdict === 'clear' ? c.streak + 1 : 0;
    this.decide(printerId, s);
    this.publish(printerId);
    return c.last;
  }

  /** What a clear result leads to, depending on the mode. */
  private decide(printerId: number, s: BedCheckSettings) {
    const c = this.check(printerId);
    if (c.streak === 0 || this.manager.isBedClear(printerId) || !this.idle(printerId)) {
      c.suggestClear = false;
      return;
    }
    if (s.mode === 'auto' && c.streak >= AUTO_CLEAR_STREAK) {
      this.log.info({ printer: printerId }, 'bed check: bed detected empty, releasing it');
      c.streak = 0;
      c.suggestClear = false;
      this.onSuggest?.(printerId, true, this.slicing.waitingCount(printerId));
      void this.slicing.confirmBedClear(printerId, true).catch((err) => this.log.error({ printer: printerId, err }, 'bed check: start failed'));
    } else if (s.mode === 'confirm' && Date.now() >= c.rejectedUntil) {
      c.suggestClear = true;
      if (!c.notified) {
        c.notified = true;
        this.onSuggest?.(printerId, false, this.slicing.waitingCount(printerId));
      }
    }
  }

  private async tick() {
    const now = Date.now();
    for (const p of this.manager.list()) {
      const c = this.check(p.id);
      if (p.bedClear || !this.idle(p.id)) {
        // Nothing to find out; start fresh after the next print.
        if (c.streak || c.suggestClear || c.notified) {
          c.streak = 0;
          c.suggestClear = false;
          c.notified = false;
          this.publish(p.id);
        }
        continue;
      }
      if (c.running || now < c.nextAt) continue;
      const s = this.settings(p.id);
      if (s.mode === 'off' || !s.region || !this.references(p.id).length) continue;
      await this.run(p.id);
    }
  }

  private onPrintEvent(e: PrintEvent) {
    const c = this.check(e.printerId);
    if (e.type === 'started') {
      c.streak = 0;
      c.suggestClear = false;
      c.notified = false;
      c.rejectedUntil = 0;
      this.publish(e.printerId);
    } else if (e.type === 'finished' || (e.type === 'klippy_error' && e.wasPrinting)) {
      c.nextAt = Date.now() + AFTER_PRINT_MS;
    }
  }

  private idle(printerId: number): boolean {
    const st = this.manager.client(printerId)?.status;
    return !!st && st.connection === 'connected' && st.printState !== 'printing' && st.printState !== 'paused';
  }

  private state(printerId: number): BedCheckState {
    const s = this.settings(printerId);
    const c = this.check(printerId);
    return {
      mode: s.mode,
      ready: !!s.region && this.references(printerId).length > 0,
      last: c.last,
      suggestClear: c.suggestClear,
    };
  }

  private publish(printerId: number) {
    try {
      const st = this.state(printerId);
      this.manager.setBedCheckState(printerId, st.mode === 'off' ? undefined : st);
    } catch {
      /* printer was removed */
    }
  }

  private check(printerId: number): PrinterCheck {
    let c = this.checks.get(printerId);
    if (!c) {
      c = { last: null, streak: 0, suggestClear: false, notified: false, nextAt: 0, rejectedUntil: 0, running: false };
      this.checks.set(printerId, c);
    }
    return c;
  }

  /**
   * Compares the image with the empty-bed images using the configured method. The AI method
   * falls back to the classic comparison when its model is missing or fails.
   */
  private async analyze(printerId: number, s: BedCheckSettings, img: Rgba): Promise<Analysis | undefined> {
    const region = s.region!;
    if (s.method === 'ai' && modelAvailable()) {
      try {
        const cur = await embed(img, region);
        const cmp = compareAi(cur, await this.referenceEmbeddings(printerId, region), gridMask(region, cur.cols, cur.rows));
        if (cmp) return { method: 'ai', cols: cmp.cols, rows: cmp.rows, cells: cmp.cells, threshold: aiThreshold(s.sensitivity) };
      } catch (err) {
        this.log.warn({ printer: printerId, err: (err as Error).message }, 'bed check: AI model failed, using the classic comparison');
      }
    }
    const cmp = compare(extractFeatures(img, region), this.referenceFeatures(printerId, region));
    return cmp && { method: 'classic', cols: cmp.cols, rows: cmp.rows, cells: cmp.cells, threshold: cellThreshold(s.sensitivity) };
  }

  private async referenceEmbeddings(printerId: number, region: Region): Promise<PatchFeatures[]> {
    const out: PatchFeatures[] = [];
    for (const r of this.references(printerId)) {
      const key = `${r.id}:${JSON.stringify(region)}`;
      let f = this.embeddings.get(key);
      if (!f) {
        let img: Rgba;
        try {
          img = decodeJpeg(fs.readFileSync(this.file(r.id)));
        } catch {
          continue;
        }
        f = await embed(img, region);
        this.embeddings.set(key, f);
      }
      out.push(f);
    }
    return out;
  }

  private referenceFeatures(printerId: number, region: Region): Features[] {
    const out: Features[] = [];
    for (const r of this.references(printerId)) {
      const key = `${r.id}:${JSON.stringify(region)}`;
      let f = this.features.get(key);
      if (!f) {
        try {
          f = extractFeatures(decodeJpeg(fs.readFileSync(this.file(r.id))), region);
        } catch {
          continue;
        }
        this.features.set(key, f);
      }
      out.push(f);
    }
    return out;
  }

  private async snapshot(printerId: number): Promise<Buffer> {
    const client = this.manager.client(printerId);
    if (!client || client.status.connection === 'offline' || client.status.connection === 'connecting') {
      throw new BedCheckError('Drucker nicht verbunden', 409);
    }
    const cam = client.webcams[this.settings(printerId).webcam];
    if (!cam) throw new BedCheckError('Kamera nicht gefunden', 404);
    let res: Response;
    try {
      res = await client.fetch(webcamUrl(client.baseUrl, cam.snapshot_url), { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
    } catch {
      throw new BedCheckError('Kamera nicht erreichbar', 502);
    }
    if (!res.ok) throw new BedCheckError(`Kamera antwortet mit ${res.status}`, 502);
    return Buffer.from(await res.arrayBuffer());
  }

  private file(refId: number) {
    return path.join(this.dir, `${refId}.jpg`);
  }

  /** Images whose printer was deleted (the rows go with it). */
  private removeOrphans() {
    const ids = new Set(this.db.select({ id: bedReferences.id }).from(bedReferences).all().map((r) => `${r.id}.jpg`));
    for (const f of fs.readdirSync(this.dir)) if (!ids.has(f)) fs.rmSync(path.join(this.dir, f), { force: true });
  }
}
