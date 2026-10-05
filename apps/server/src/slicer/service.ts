import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type {
  BedType,
  CreateJobInput,
  JobInfo,
  JobModel,
  ModelTransform,
  SliceOverrides,
  ModelInfo,
  PrinterProfileAssignment,
  ProfileImportResult,
  ProfileKind,
  SlicerProfileInfo,
  SlicerStatus,
} from '@printhub/shared';
import { BED_TYPES, FALLBACK_BED_TYPE, bedTypeSchema, createJobSchema } from '@printhub/shared';
import type { Db } from '../db/index.js';
import { jobModels, jobs, models, printerProfiles, printers, slicerProfiles } from '../db/schema.js';
import type { PrinterManager } from '../printers/manager.js';
import type { PrintEvent } from '../printers/events.js';
import { uploadToPrinter } from '../printers/upload.js';
import {
  ProfileError,
  SystemProfiles,
  applyOverrides,
  cliProfiles,
  detectKind,
  isCompatible,
  readUpload,
  resolvePreset,
  summarize,
  type UploadedPreset,
} from './profiles.js';
import { MeshError, formatOf, layoutForPreview, meshInfo, parseModel, renderThumbnail, type Mesh } from './mesh.js';
import { SliceError, injectThumbnails, runOrca, thumbnailSizes } from './orca.js';
import { bedFromSettings, renderPlatePreviewOffThread } from './gcodePreview.js';
import { isIdentity, simplifyForDisplay, transformMesh, writeStl } from './transform.js';

export class SlicingError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

type ProfileRow = typeof slicerProfiles.$inferSelect;
type ModelRow = typeof models.$inferSelect;
type JobRow = typeof jobs.$inferSelect;

interface Events {
  job: [JobInfo];
  job_removed: [number];
  /** A queued job could not be started automatically. */
  queue_error: [JobInfo, string];
}

/** Jobs whose G-code exists and may be (re)sent to the printer. */
const SENDABLE = ['sliced', 'uploaded', 'waiting', 'printing', 'done', 'print_failed', 'print_cancelled'] as const;

export interface SlicingConfig {
  dataDir: string;
  orcaBin: string;
  orcaProfiles: string;
  orcaVersion: string;
  sliceTimeoutMs: number;
}

const KINDS: ProfileKind[] = ['machine', 'process', 'filament'];
const MODEL_THUMB_SIZE = 512;
/** Enough detail for orienting a part in the browser, small enough for phones. */
const DISPLAY_TRIANGLES = 150_000;
/** Unsaved wizard jobs are removed after this. */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export class SlicingService extends EventEmitter<Events> {
  private system?: SystemProfiles;
  private running: { jobId: number; abort: AbortController } | null = null;
  private wake?: () => void;
  private stopped = false;
  private loopDone?: Promise<void>;
  private starting = new Set<number>();
  private readonly dirs: Record<'models' | 'thumbs' | 'gcode' | 'work' | 'previews' | 'meshes', string>;

  constructor(
    private readonly db: Db,
    private readonly manager: PrinterManager,
    private readonly log: FastifyBaseLogger,
    private readonly cfg: SlicingConfig,
  ) {
    super();
    manager.on('print', (e) => void this.onPrintEvent(e));
    this.dirs = {
      models: path.join(cfg.dataDir, 'models'),
      thumbs: path.join(cfg.dataDir, 'thumbs'),
      gcode: path.join(cfg.dataDir, 'gcode'),
      work: path.join(cfg.dataDir, 'slicing'),
      previews: path.join(cfg.dataDir, 'previews'),
      meshes: path.join(cfg.dataDir, 'meshes'),
    };
    for (const d of Object.values(this.dirs)) fs.mkdirSync(d, { recursive: true });
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  private get systemProfiles(): SystemProfiles {
    this.system ??= new SystemProfiles(this.cfg.orcaProfiles);
    return this.system;
  }

  status(): SlicerStatus {
    const available = isExecutable(this.cfg.orcaBin);
    return {
      available,
      orcaVersion: this.cfg.orcaVersion,
      systemProfiles: this.systemProfiles.count,
      reason: available ? undefined : `OrcaSlicer nicht gefunden (${this.cfg.orcaBin})`,
    };
  }

  // ---------------------------------------------------------------------------
  // Profiles
  // ---------------------------------------------------------------------------

  listProfiles(): SlicerProfileInfo[] {
    return this.db
      .select()
      .from(slicerProfiles)
      .where(eq(slicerProfiles.current, true))
      .orderBy(slicerProfiles.kind, slicerProfiles.name)
      .all()
      .map(toProfileInfo);
  }

  /** Imports presets; unchanged presets are skipped, changed ones get a new version. */
  importProfiles(files: { filename: string; buf: Buffer }[]): ProfileImportResult {
    const result: ProfileImportResult = { imported: [], skipped: [] };
    const presets: (UploadedPreset & { kind: ProfileKind })[] = [];
    for (const f of files) {
      let list: UploadedPreset[];
      try {
        list = readUpload(f.filename, f.buf);
      } catch (err) {
        result.skipped.push({ file: f.filename, reason: (err as Error).message });
        continue;
      }
      for (const p of list) {
        const kind = detectKind(p.data);
        if (!kind) result.skipped.push({ file: p.file, reason: 'Typ nicht erkennbar (kein Drucker-, Prozess- oder Filamentprofil)' });
        else presets.push({ ...p, kind });
      }
    }
    const siblings = new Map(presets.map((p) => [`${p.kind}:${String(p.data.name)}`, p.data]));

    for (const p of presets) {
      let resolved;
      try {
        resolved = resolvePreset(p.kind, p.data, this.systemProfiles, siblings);
      } catch (err) {
        if (!(err instanceof ProfileError)) throw err;
        result.skipped.push({ file: p.file, reason: err.message });
        continue;
      }
      const settingsJson = JSON.stringify(resolved.settings);
      const current = this.currentProfile(p.kind, resolved.name);
      if (current && current.settings === settingsJson) {
        result.imported.push({ kind: p.kind, name: resolved.name, version: current.version, updated: false });
        continue;
      }
      const latest =
        this.db
          .select({ v: sql<number>`max(${slicerProfiles.version})` })
          .from(slicerProfiles)
          .where(and(eq(slicerProfiles.kind, p.kind), eq(slicerProfiles.name, resolved.name)))
          .get()?.v ?? 0;
      this.db.transaction((tx) => {
        tx.update(slicerProfiles)
          .set({ current: false })
          .where(and(eq(slicerProfiles.kind, p.kind), eq(slicerProfiles.name, resolved.name)))
          .run();
        tx.insert(slicerProfiles)
          .values({
            kind: p.kind,
            name: resolved.name,
            version: latest + 1,
            current: true,
            parent: resolved.parent ?? null,
            systemPrinter: resolved.systemPrinter ?? null,
            settings: settingsJson,
            summary: JSON.stringify(summarize(p.kind, resolved.settings)),
            sourceFile: p.file,
            createdAt: Date.now(),
          })
          .run();
      });
      result.imported.push({ kind: p.kind, name: resolved.name, version: latest + 1, updated: !!current });
    }
    return result;
  }

  /** Removes a profile from use. Old versions stay so existing jobs remain reproducible. */
  removeProfile(kind: ProfileKind, name: string): boolean {
    const res = this.db
      .update(slicerProfiles)
      .set({ current: false })
      .where(and(eq(slicerProfiles.kind, kind), eq(slicerProfiles.name, name), eq(slicerProfiles.current, true)))
      .run();
    this.db.delete(printerProfiles).where(and(eq(printerProfiles.kind, kind), eq(printerProfiles.profileName, name))).run();
    return res.changes > 0;
  }

  getAssignment(printerId: number): PrinterProfileAssignment {
    const rows = this.db.select().from(printerProfiles).where(eq(printerProfiles.printerId, printerId)).all();
    return {
      printerId,
      machine: rows.find((r) => r.kind === 'machine')?.profileName ?? null,
      process: rows.filter((r) => r.kind === 'process').map((r) => r.profileName).sort(),
      filament: rows.filter((r) => r.kind === 'filament').map((r) => r.profileName).sort(),
      bedType: this.printerBedType(printerId),
    };
  }

  private printerBedType(printerId: number): BedType | null {
    const raw = this.db.select({ b: printers.bedType }).from(printers).where(eq(printers.id, printerId)).get()?.b;
    return bedTypeSchema.safeParse(raw).success ? (raw as BedType) : null;
  }

  setAssignment(
    printerId: number,
    a: Omit<PrinterProfileAssignment, 'printerId' | 'bedType'> & { bedType?: BedType | null },
  ): PrinterProfileAssignment {
    if (!this.db.select({ id: printers.id }).from(printers).where(eq(printers.id, printerId)).get()) {
      throw new SlicingError('Drucker nicht gefunden', 404);
    }
    const check = (kind: ProfileKind, name: string) => {
      if (!this.currentProfile(kind, name)) throw new SlicingError(`Profil „${name}“ (${kind}) existiert nicht`);
    };
    if (a.machine) check('machine', a.machine);
    a.process.forEach((n) => check('process', n));
    a.filament.forEach((n) => check('filament', n));
    this.db.transaction((tx) => {
      tx.delete(printerProfiles).where(eq(printerProfiles.printerId, printerId)).run();
      const rows = [
        ...(a.machine ? [{ printerId, kind: 'machine' as const, profileName: a.machine }] : []),
        ...[...new Set(a.process)].map((profileName) => ({ printerId, kind: 'process' as const, profileName })),
        ...[...new Set(a.filament)].map((profileName) => ({ printerId, kind: 'filament' as const, profileName })),
      ];
      if (rows.length) tx.insert(printerProfiles).values(rows).run();
      if (a.bedType !== undefined) tx.update(printers).set({ bedType: a.bedType }).where(eq(printers.id, printerId)).run();
    });
    return this.getAssignment(printerId);
  }

  /** Summaries gain fields over time; recompute them from the stored settings. */
  private refreshSummaries() {
    for (const p of this.db.select().from(slicerProfiles).where(eq(slicerProfiles.current, true)).all()) {
      const summary = JSON.stringify(summarize(p.kind, JSON.parse(p.settings)));
      if (summary !== p.summary) this.db.update(slicerProfiles).set({ summary }).where(eq(slicerProfiles.id, p.id)).run();
    }
  }

  private currentProfile(kind: ProfileKind, name: string): ProfileRow | undefined {
    return this.db
      .select()
      .from(slicerProfiles)
      .where(and(eq(slicerProfiles.kind, kind), eq(slicerProfiles.name, name), eq(slicerProfiles.current, true)))
      .get();
  }

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------

  /** Stores an uploaded model (deduplicated by content) and renders its thumbnail. */
  async addModel(
    filename: string,
    tmpPath: string,
    meta: { name?: string; source?: string; sourceUrl?: string; license?: string; author?: string } = {},
  ): Promise<ModelInfo> {
    const format = formatOf(filename);
    if (!format) throw new SlicingError('Nur STL-, 3MF- und OBJ-Dateien werden unterstützt');
    const buf = await fs.promises.readFile(tmpPath);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const existing = this.db.select().from(models).where(eq(models.sha256, sha256)).get();
    if (existing) return this.toModelInfo(existing);

    let mesh;
    try {
      mesh = parseModel(format, buf);
    } catch (err) {
      if (err instanceof MeshError) throw new SlicingError(`${filename}: ${err.message}`);
      throw new SlicingError(`${filename}: Datei konnte nicht gelesen werden`);
    }
    const info = meshInfo(mesh);
    const storedPath = path.join(this.dirs.models, `${sha256}.${format}`);
    await fs.promises.copyFile(tmpPath, storedPath);
    const row = this.db
      .insert(models)
      .values({
        name: (meta.name ?? filename.replace(/\.[^.]+$/, '')).slice(0, 200),
        filename,
        format,
        storedPath,
        size: buf.length,
        sha256,
        triangles: info.triangles,
        sizeX: info.size[0],
        sizeY: info.size[1],
        sizeZ: info.size[2],
        source: meta.source ?? 'upload',
        sourceUrl: meta.sourceUrl ?? null,
        license: meta.license ?? null,
        author: meta.author ?? null,
        createdAt: Date.now(),
      })
      .returning()
      .get();
    await fs.promises.writeFile(this.thumbPath(row.id), renderThumbnail(mesh, MODEL_THUMB_SIZE));
    await this.writeDisplayMesh(row.id, mesh);
    return this.toModelInfo(row);
  }

  listModels(): ModelInfo[] {
    return this.db.select().from(models).orderBy(desc(models.createdAt)).all().map((m) => this.toModelInfo(m));
  }

  getModelRow(id: number): ModelRow | undefined {
    return this.db.select().from(models).where(eq(models.id, id)).get();
  }

  previewPath(jobId: number, view: 'top' | 'iso') {
    return path.join(this.dirs.previews, `job-${jobId}-${view}.png`);
  }

  /** Gzipped toolpaths of the sliced plate for the interactive 3D view. */
  pathsFile(jobId: number) {
    return path.join(this.dirs.previews, `job-${jobId}-paths.bin.gz`);
  }

  thumbPath(modelId: number) {
    return path.join(this.dirs.thumbs, `model-${modelId}.png`);
  }

  deleteModel(id: number) {
    const m = this.getModelRow(id);
    if (!m) throw new SlicingError('Modell nicht gefunden', 404);
    const used = this.db.select({ n: sql<number>`count(*)` }).from(jobModels).where(eq(jobModels.modelId, id)).get()?.n ?? 0;
    if (used) throw new SlicingError('Das Modell wird noch von Aufträgen verwendet. Bitte zuerst diese Aufträge löschen.', 409);
    this.db.delete(models).where(eq(models.id, id)).run();
    fs.rmSync(m.storedPath, { force: true });
    fs.rmSync(this.thumbPath(id), { force: true });
    fs.rmSync(this.meshPath(id), { force: true });
  }

  private meshPath(modelId: number) {
    return path.join(this.dirs.meshes, `model-${modelId}.bin`);
  }

  /** Decimated triangle soup for the browser's plate editor, cached on disk. */
  async displayMesh(modelId: number): Promise<string> {
    const file = this.meshPath(modelId);
    if (fs.existsSync(file)) return file;
    const m = this.getModelRow(modelId);
    if (!m) throw new SlicingError('Modell nicht gefunden', 404);
    await this.writeDisplayMesh(modelId, parseModel(m.format, await fs.promises.readFile(m.storedPath)));
    return file;
  }

  private async writeDisplayMesh(modelId: number, mesh: Mesh) {
    const t = simplifyForDisplay(mesh, DISPLAY_TRIANGLES).triangles;
    const file = this.meshPath(modelId);
    await fs.promises.writeFile(`${file}.tmp`, Buffer.from(t.buffer, t.byteOffset, t.byteLength));
    await fs.promises.rename(`${file}.tmp`, file);
  }

  private toModelInfo(m: ModelRow): ModelInfo {
    return {
      id: m.id,
      name: m.name,
      filename: m.filename,
      format: m.format,
      size: m.size,
      triangles: m.triangles,
      dimensions: [m.sizeX, m.sizeY, m.sizeZ],
      source: m.source,
      sourceUrl: m.sourceUrl,
      license: m.license,
      author: m.author,
      createdAt: m.createdAt,
      thumbnailUrl: `/api/models/${m.id}/thumbnail`,
    };
  }

  // ---------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------

  createJob(input: CreateJobInput, userId: number): JobInfo {
    const b = createJobSchema.parse(input);
    const items = b.items.map((it) => {
      const model = this.getModelRow(it.modelId);
      if (!model) throw new SlicingError(`Modell #${it.modelId} nicht gefunden`, 404);
      return { model, copies: it.copies, transform: it.transform };
    });
    const printer = this.db.select().from(printers).where(eq(printers.id, b.printerId)).get();
    if (!printer) throw new SlicingError('Drucker nicht gefunden', 404);

    const a = this.getAssignment(b.printerId);
    if (!a.machine) throw new SlicingError(`Für „${printer.name}“ ist noch kein Druckerprofil zugeordnet`);
    const machine = this.currentProfile('machine', a.machine);
    const proc = this.currentProfile('process', b.process);
    const fil = this.currentProfile('filament', b.filament);
    if (!machine || !proc || !fil) throw new SlicingError('Ein gewähltes Profil existiert nicht mehr');
    // An explicit allow-list wins; without one, only presets made for this machine are allowed.
    const permitted = (kind: 'process' | 'filament', row: ProfileRow) =>
      a[kind].length ? a[kind].includes(row.name) : isCompatible(JSON.parse(row.settings), machine);
    if (!permitted('process', proc)) throw new SlicingError(`Prozessprofil „${proc.name}“ ist für diesen Drucker nicht freigegeben`);
    if (!permitted('filament', fil)) throw new SlicingError(`Filamentprofil „${fil.name}“ ist für diesen Drucker nicht freigegeben`);
    const machineSettings = JSON.parse(machine.settings) as Record<string, unknown>;
    const bedType = b.bedType ?? a.bedType ?? defaultBedType(machineSettings);
    checkBedTemp(JSON.parse(fil.settings), fil.name, bedType);
    if (!b.arrange) checkPlacement(items, machineSettings);

    if (b.replaces !== undefined) {
      const orig = this.jobRow(b.replaces);
      if (!orig) throw new SlicingError('Der zu bearbeitende Auftrag existiert nicht mehr', 404);
      if (!editable(orig.status)) throw new SlicingError('Ein Auftrag, der gerade gedruckt oder übertragen wird, kann nicht bearbeitet werden', 409);
    }
    this.removeStaleDrafts();
    const now = Date.now();
    const row = this.db.transaction((tx) => {
      const job = tx
        .insert(jobs)
        .values({
          modelId: items[0]!.model.id,
          printerId: printer.id,
          machineProfileId: machine.id,
          processProfileId: proc.id,
          filamentProfileId: fil.id,
          copies: items.reduce((n, i) => n + i.copies, 0),
          autoOrient: b.autoOrient,
          // A draft is reviewed before anything goes to the printer.
          autoPrint: b.autoPrint && !b.draft,
          draft: b.draft,
          replaces: b.replaces ?? null,
          arrange: b.arrange,
          bedType,
          overrides: JSON.stringify(b.overrides),
          status: 'queued',
          note: b.note || null,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      tx.insert(jobModels)
        .values(
          items.map((i, position) => ({
            jobId: job.id,
            modelId: i.model.id,
            copies: i.copies,
            position,
            transform: i.transform ? JSON.stringify(i.transform) : null,
          })),
        )
        .run();
      return job;
    });
    const info = this.publish(row.id)!;
    this.wake?.();
    return info;
  }

  listJobs(limit = 100): JobInfo[] {
    return this.db
      .select()
      .from(jobs)
      .where(eq(jobs.draft, false))
      .orderBy(desc(jobs.createdAt))
      .limit(limit)
      .all()
      .map((j) => this.toJobInfo(j));
  }

  getJob(id: number): JobInfo | undefined {
    const j = this.jobRow(id);
    return j && this.toJobInfo(j);
  }

  jobRow(id: number): JobRow | undefined {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get();
  }

  deleteJob(id: number) {
    const j = this.jobRow(id);
    if (!j) throw new SlicingError('Auftrag nicht gefunden', 404);
    if (j.status === 'uploading') throw new SlicingError('Der Auftrag wird gerade übertragen', 409);
    if (this.running?.jobId === id) this.running.abort.abort();
    this.db.delete(jobs).where(eq(jobs.id, id)).run();
    if (j.gcodePath) fs.rmSync(j.gcodePath, { force: true });
    for (const v of ['top', 'iso'] as const) fs.rmSync(this.previewPath(id, v), { force: true });
    fs.rmSync(this.pathsFile(id), { force: true });
    this.emit('job_removed', id);
    if (j.status === 'waiting' && j.printerId) this.renumberQueue(j.printerId);
  }

  /** Saves a reviewed draft so it shows up in the job list. */
  keepJob(id: number): JobInfo {
    const j = this.jobRow(id);
    if (!j) throw new SlicingError('Auftrag nicht gefunden', 404);
    this.promoteDraft(j, true);
    return this.getJob(id)!;
  }

  /**
   * Turns a draft into a regular job. An edited job replaces its original; when saved (not
   * sent), it also takes over the original's place in the print queue.
   */
  private promoteDraft(j: JobRow, takeQueuePlace: boolean) {
    if (!j.draft) return;
    const orig = j.replaces ? this.jobRow(j.replaces) : undefined;
    const patch: Partial<JobRow> = { draft: false, replaces: null };
    if (orig && takeQueuePlace && orig.status === 'waiting' && orig.printerId === j.printerId && j.status === 'sliced') {
      Object.assign(patch, { status: 'waiting', queuePosition: orig.queuePosition });
    }
    this.update(j.id, patch);
    if (orig && editable(orig.status)) this.deleteJob(orig.id);
  }

  private removeStaleDrafts() {
    const stale = this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.draft, true), lt(jobs.updatedAt, Date.now() - DRAFT_TTL_MS)))
      .all();
    for (const { id } of stale) {
      try {
        this.deleteJob(id);
      } catch {
        /* uploading: try again later */
      }
    }
  }

  retryJob(id: number): JobInfo {
    const j = this.jobRow(id);
    if (!j) throw new SlicingError('Auftrag nicht gefunden', 404);
    if (j.status !== 'failed' && j.status !== 'cancelled') throw new SlicingError('Nur fehlgeschlagene Aufträge können wiederholt werden', 409);
    this.update(id, { status: 'queued', error: null, log: null });
    this.wake?.();
    return this.getJob(id)!;
  }

  /** Uploads the sliced G-code to the job's printer, optionally starting the print. */
  async sendJob(id: number, print: boolean): Promise<JobInfo> {
    const j = this.jobRow(id);
    if (!j) throw new SlicingError('Auftrag nicht gefunden', 404);
    if (!(SENDABLE as readonly string[]).includes(j.status) || !j.gcodePath || !j.gcodeName) {
      throw new SlicingError('Der Auftrag ist noch nicht fertig gesliced', 409);
    }
    if (!fs.existsSync(j.gcodePath)) throw new SlicingError('G-Code-Datei fehlt, bitte neu slicen', 409);
    const client = j.printerId ? this.manager.client(j.printerId) : undefined;
    if (!client || client.status.connection !== 'connected') throw new SlicingError('Drucker ist nicht verbunden', 409);
    const st = client.status.printState;
    if (print && (st === 'printing' || st === 'paused')) throw new SlicingError('Auf dem Drucker läuft bereits ein Druck', 409);

    this.promoteDraft(j, false);
    const before = j.status;
    this.update(id, { status: 'uploading', error: null });
    try {
      const printerPath = await uploadToPrinter(client, j.gcodePath, j.gcodeName, { print });
      this.update(id, {
        status: print ? 'printing' : 'uploaded',
        printerPath,
        finishedAt: null,
        ...(print || before === 'waiting' ? { queuePosition: null } : {}),
      });
      if (j.printerId && before === 'waiting') this.renumberQueue(j.printerId);
    } catch (err) {
      this.update(id, { status: before, error: (err as Error).message });
      throw new SlicingError((err as Error).message, 502);
    }
    return this.getJob(id)!;
  }

  // ---------------------------------------------------------------------------
  // Print queue
  // ---------------------------------------------------------------------------

  /** Appends a sliced job to its printer's queue and starts it if the printer is ready. */
  enqueue(id: number): JobInfo {
    let j = this.jobRow(id);
    if (!j) throw new SlicingError('Auftrag nicht gefunden', 404);
    // An edited job queued again takes the original's place.
    if (j.draft && (SENDABLE as readonly string[]).includes(j.status)) {
      this.promoteDraft(j, true);
      j = this.jobRow(id)!;
      if (j.status === 'waiting' && j.printerId) {
        this.renumberQueue(j.printerId);
        void this.tryStart(j.printerId);
        return this.getJob(id)!;
      }
    }
    if (!j.printerId) throw new SlicingError('Der Drucker des Auftrags existiert nicht mehr', 409);
    if (j.status === 'waiting') return this.getJob(id)!;
    if (!(SENDABLE as readonly string[]).includes(j.status) || j.status === 'printing' || !j.gcodePath) {
      throw new SlicingError('Nur fertig geslicte Aufträge können eingereiht werden', 409);
    }
    const max =
      this.db
        .select({ m: sql<number>`max(${jobs.queuePosition})` })
        .from(jobs)
        .where(and(eq(jobs.printerId, j.printerId), eq(jobs.status, 'waiting')))
        .get()?.m ?? 0;
    this.update(id, { status: 'waiting', queuePosition: max + 1, error: null });
    void this.tryStart(j.printerId);
    return this.getJob(id)!;
  }

  dequeue(id: number): JobInfo {
    const j = this.jobRow(id);
    if (!j || j.status !== 'waiting') throw new SlicingError('Auftrag ist nicht in der Warteschlange', 409);
    this.update(id, { status: 'sliced', queuePosition: null });
    if (j.printerId) this.renumberQueue(j.printerId);
    return this.getJob(id)!;
  }

  moveInQueue(id: number, direction: 'up' | 'down'): JobInfo[] {
    const j = this.jobRow(id);
    if (!j || j.status !== 'waiting' || !j.printerId) throw new SlicingError('Auftrag ist nicht in der Warteschlange', 409);
    const queue = this.queueOf(j.printerId);
    const idx = queue.findIndex((q) => q.id === id);
    const swap = queue[direction === 'up' ? idx - 1 : idx + 1];
    if (!swap) return queue.map((q) => this.toJobInfo(q));
    this.db.transaction((tx) => {
      tx.update(jobs).set({ queuePosition: swap.queuePosition }).where(eq(jobs.id, id)).run();
      tx.update(jobs).set({ queuePosition: j.queuePosition }).where(eq(jobs.id, swap.id)).run();
    });
    this.publish(id);
    this.publish(swap.id);
    return this.queueOf(j.printerId).map((q) => this.toJobInfo(q));
  }

  /** The user confirmed the bed is empty; optionally start the next queued job. */
  async confirmBedClear(printerId: number, start: boolean): Promise<JobInfo | undefined> {
    this.manager.setBedClear(printerId, true);
    return start ? this.tryStart(printerId) : undefined;
  }

  private queueOf(printerId: number): JobRow[] {
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.printerId, printerId), eq(jobs.status, 'waiting')))
      .orderBy(asc(jobs.queuePosition), asc(jobs.createdAt))
      .all();
  }

  private renumberQueue(printerId: number) {
    this.queueOf(printerId).forEach((q, i) => {
      if (q.queuePosition !== i + 1) {
        this.db.update(jobs).set({ queuePosition: i + 1 }).where(eq(jobs.id, q.id)).run();
        this.publish(q.id);
      }
    });
  }

  /** Starts the next queued job when the printer is idle and its bed was confirmed empty. */
  async tryStart(printerId: number): Promise<JobInfo | undefined> {
    if (this.starting.has(printerId)) return undefined;
    const client = this.manager.client(printerId);
    const st = client?.status;
    if (!st || st.connection !== 'connected' || st.printState === 'printing' || st.printState === 'paused') return undefined;
    if (!this.manager.isBedClear(printerId)) return undefined;
    const next = this.queueOf(printerId)[0];
    if (!next) return undefined;

    this.starting.add(printerId);
    try {
      // Occupied from now on, even before Klipper reports "printing".
      this.manager.setBedClear(printerId, false);
      return await this.sendJob(next.id, true);
    } catch (err) {
      // Take it out of the queue so a broken job can't block (or loop) the printer.
      this.update(next.id, { status: 'sliced', queuePosition: null, error: `Start aus der Warteschlange fehlgeschlagen: ${(err as Error).message}` });
      this.renumberQueue(printerId);
      this.manager.setBedClear(printerId, true);
      this.emit('queue_error', this.getJob(next.id)!, (err as Error).message);
      return undefined;
    } finally {
      this.starting.delete(printerId);
    }
  }

  /** Follows prints PrintHub started to their end, and keeps the queue moving. */
  private async onPrintEvent(e: PrintEvent) {
    const printing = () =>
      this.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.printerId, e.printerId), eq(jobs.status, 'printing'), isNotNull(jobs.printerPath)))
        .all();

    if (e.type === 'started') {
      // A different file started: earlier "printing" jobs ended without us noticing (e.g. PrintHub was down).
      for (const j of printing()) {
        if (j.printerPath !== e.filename) this.update(j.id, { status: 'done', finishedAt: Date.now(), error: 'Ende des Drucks nicht erfasst' });
      }
    } else if (e.type === 'finished' || (e.type === 'klippy_error' && e.wasPrinting)) {
      const status = e.type === 'klippy_error' || e.result === 'error' ? 'print_failed' : e.result === 'cancelled' ? 'print_cancelled' : 'done';
      const message = e.type === 'klippy_error' ? e.message : e.message;
      for (const j of printing()) {
        if (j.printerPath === e.filename) {
          this.update(j.id, { status, finishedAt: Date.now(), error: status === 'done' ? null : message || null });
        }
      }
    } else if (e.type === 'idle') {
      await this.tryStart(e.printerId);
    }
  }

  waitingCount(printerId: number): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(jobs)
        .where(and(eq(jobs.printerId, printerId), eq(jobs.status, 'waiting')))
        .get()?.n ?? 0
    );
  }

  // ---------------------------------------------------------------------------
  // Worker
  // ---------------------------------------------------------------------------

  start() {
    this.refreshSummaries();
    this.removeStaleDrafts();
    // Leftovers of slices interrupted by a crash or restart.
    for (const d of fs.readdirSync(this.dirs.work)) fs.rmSync(path.join(this.dirs.work, d), { recursive: true, force: true });
    // Interrupted by a restart: slice again / fall back to the sliced state.
    this.db.update(jobs).set({ status: 'queued' }).where(eq(jobs.status, 'slicing')).run();
    this.db.update(jobs).set({ status: 'sliced' }).where(eq(jobs.status, 'uploading')).run();
    this.loopDone = this.loop();
  }

  /** Stops the worker and waits until a running slice has been cleaned up. */
  async stop() {
    this.stopped = true;
    this.running?.abort.abort();
    this.wake?.();
    await this.loopDone;
  }

  private async loop() {
    while (!this.stopped) {
      const next = this.db.select().from(jobs).where(eq(jobs.status, 'queued')).orderBy(jobs.createdAt).limit(1).get();
      if (!next) {
        await new Promise<void>((r) => {
          const timer = setTimeout(r, 30_000);
          this.wake = () => {
            clearTimeout(timer);
            r();
          };
        });
        continue;
      }
      await this.process(next);
    }
  }

  private async process(job: JobRow) {
    const abort = new AbortController();
    this.running = { jobId: job.id, abort };
    const workDir = path.join(this.dirs.work, String(job.id));
    try {
      if (!isExecutable(this.cfg.orcaBin)) throw new SliceError(`OrcaSlicer ist nicht verfügbar (${this.cfg.orcaBin})`);
      const items = this.jobItems(job.id);
      const [machine, proc, fil] = [job.machineProfileId, job.processProfileId, job.filamentProfileId].map((pid) =>
        this.db.select().from(slicerProfiles).where(eq(slicerProfiles.id, pid)).get(),
      );
      if (!items.length || !machine || !proc || !fil) throw new SliceError('Modell oder Profil wurde gelöscht');

      this.update(job.id, { status: 'slicing', error: null });
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.mkdirSync(workDir, { recursive: true });
      const machineSettings = JSON.parse(machine.settings);
      const bedType = bedTypeSchema.safeParse(job.bedType).data ?? defaultBedType(machineSettings);
      checkBedTemp(JSON.parse(fil.settings), fil.name, bedType, SliceError);
      const cli = cliProfiles(
        { name: machine.name, settings: machineSettings, systemPrinter: machine.systemPrinter ?? machine.name },
        applyOverrides(JSON.parse(proc.settings), JSON.parse(job.overrides) as SliceOverrides),
        JSON.parse(fil.settings),
        bedType,
      );
      const started = Date.now();
      const out = await runOrca(
        this.cfg.orcaBin,
        {
          workDir,
          models: await this.prepareModels(items, job.arrange, workDir),
          autoOrient: job.autoOrient,
          arrange: job.arrange,
          ...cli,
        },
        this.cfg.sliceTimeoutMs,
        abort.signal,
      );

      // Orca embeds no previews for plain meshes: render the sliced plate from the G-code
      // (falls back to the models if that yields nothing).
      const sizes = thumbnailSizes(machineSettings);
      let thumbs: { size: number; png: Buffer }[] = [];
      try {
        const preview = await renderPlatePreviewOffThread(out.gcodePath, bedFromSettings(machineSettings), sizes);
        if (preview.segments > 0) {
          await fs.promises.writeFile(this.previewPath(job.id, 'top'), preview.top);
          await fs.promises.writeFile(this.previewPath(job.id, 'iso'), preview.iso);
          await fs.promises.writeFile(this.pathsFile(job.id), preview.paths);
          thumbs = sizes.map((size) => ({ size, png: preview.thumbnails.get(size)! }));
        }
      } catch (err) {
        this.log.warn({ err, job: job.id }, 'plate preview failed');
      }
      if (!thumbs.length) {
        const meshes = await Promise.all(
          items.map(async (i) => {
            const mesh = parseModel(i.model.format, await fs.promises.readFile(i.model.storedPath));
            return { mesh: i.transform ? transformMesh(mesh, i.transform) : mesh, copies: i.copies };
          }),
        );
        const mesh = layoutForPreview(meshes);
        thumbs = sizes.map((size) => ({ size, png: renderThumbnail(mesh, size) }));
      }
      await injectThumbnails(out.gcodePath, thumbs);

      const material = String((JSON.parse(fil.settings).filament_type as string[] | undefined)?.[0] ?? 'Filament');
      const gcodeName = gcodeFileName(
        items.map((i) => i.model.name),
        job.copies,
        material,
        out.stats.estimatedTime,
      );
      const gcodePath = path.join(this.dirs.gcode, `job-${job.id}.gcode`);
      await fs.promises.rename(out.gcodePath, gcodePath);
      this.log.info({ job: job.id, ms: Date.now() - started }, 'sliced');
      this.update(job.id, {
        status: 'sliced',
        gcodePath,
        gcodeName,
        estimatedTime: out.stats.estimatedTime ?? null,
        filamentMm: out.stats.filamentMm ?? null,
        filamentG: out.stats.filamentG ?? null,
        log: out.log.slice(-16 * 1024),
      });

      if (job.autoPrint) {
        try {
          await this.sendJob(job.id, true);
        } catch (err) {
          this.update(job.id, { error: `Automatischer Druckstart nicht möglich: ${(err as Error).message}` });
        }
      }
    } catch (err) {
      if (this.stopped) return; // shutting down: the job is re-queued on next start
      if (!this.jobRow(job.id)) return; // deleted while slicing
      const cancelled = abort.signal.aborted;
      this.update(job.id, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? 'Abgebrochen' : (err as Error).message,
        log: err instanceof SliceError ? err.log.slice(-16 * 1024) : String((err as Error).stack ?? err),
      });
      if (!(err instanceof SliceError)) this.log.error({ err, job: job.id }, 'slicing crashed');
    } finally {
      this.running = null;
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  private update(id: number, patch: Partial<JobRow>) {
    this.db.update(jobs).set({ ...patch, updatedAt: Date.now() }).where(eq(jobs.id, id)).run();
    this.publish(id);
  }

  private publish(id: number): JobInfo | undefined {
    const info = this.getJob(id);
    if (info) this.emit('job', info);
    return info;
  }

  /** Models of a job in plate order. */
  private jobItems(jobId: number) {
    return this.db
      .select({ model: models, copies: jobModels.copies, transform: jobModels.transform })
      .from(jobModels)
      .innerJoin(models, eq(models.id, jobModels.modelId))
      .where(eq(jobModels.jobId, jobId))
      .orderBy(jobModels.position)
      .all()
      .map((r) => ({ ...r, transform: r.transform ? (JSON.parse(r.transform) as ModelTransform) : null }));
  }

  /**
   * Input files for Orca. Rotation/scale are baked into a temporary STL; for a manually
   * arranged plate every copy gets its own STL at its bed position (Orca keeps the XY
   * coordinates of unarranged parts and only drops them onto the bed).
   */
  private async prepareModels(items: ReturnType<SlicingService['jobItems']>, arrange: boolean, workDir: string) {
    const out: { path: string; copies: number }[] = [];
    // Orca names objects after the file (Klipper shows them when skipping objects), so keep the model's name.
    const partFile = async (idx: number, copy: number, name: string, mesh: Mesh) => {
      const dir = path.join(workDir, 'parts', `${idx}-${copy}`);
      await fs.promises.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${name.replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 80) || 'modell'}.stl`);
      await writeStl(mesh, file);
      return file;
    };
    for (const [idx, i] of items.entries()) {
      const t = i.transform;
      if (arrange && (!t || isIdentity(t))) {
        out.push({ path: i.model.storedPath, copies: i.copies });
        continue;
      }
      const mesh = parseModel(i.model.format, await fs.promises.readFile(i.model.storedPath));
      const tr = t ?? { rotation: [0, 0, 0, 1] as ModelTransform['rotation'], scale: 1 };
      if (arrange) {
        out.push({ path: await partFile(idx, 0, i.model.name, transformMesh(mesh, tr)), copies: i.copies });
        continue;
      }
      const positions = t?.positions ?? [];
      if (positions.length < i.copies) throw new SliceError(`Für „${i.model.name}“ fehlen Positionen auf dem Druckbett`);
      for (const [c, pos] of positions.slice(0, i.copies).entries()) {
        out.push({ path: await partFile(idx, c, i.model.name, transformMesh(mesh, tr, pos)), copies: 1 });
      }
    }
    return out;
  }

  private toJobInfo(j: JobRow): JobInfo {
    const p = j.printerId ? this.db.select({ id: printers.id, name: printers.name }).from(printers).where(eq(printers.id, j.printerId)).get() : undefined;
    const profs = this.db
      .select({ id: slicerProfiles.id, kind: slicerProfiles.kind, name: slicerProfiles.name, version: slicerProfiles.version })
      .from(slicerProfiles)
      .where(inArray(slicerProfiles.id, [j.machineProfileId, j.processProfileId, j.filamentProfileId]))
      .all();
    const prof = (id: number) => {
      const r = profs.find((x) => x.id === id);
      return { id, name: r?.name ?? '?', version: r?.version ?? 0 };
    };
    const list: JobModel[] = this.jobItems(j.id).map(({ model: m, copies, transform }) => ({
      id: m.id,
      name: m.name,
      thumbnailUrl: `/api/models/${m.id}/thumbnail`,
      dimensions: [m.sizeX, m.sizeY, m.sizeZ],
      copies,
      transform,
    }));
    const fallback: JobModel = { id: j.modelId, name: 'gelöschtes Modell', thumbnailUrl: `/api/models/${j.modelId}/thumbnail`, dimensions: [0, 0, 0], copies: j.copies, transform: null };
    return {
      id: j.id,
      status: j.status,
      model: list[0] ?? fallback,
      models: list.length ? list : [fallback],
      overrides: JSON.parse(j.overrides) as SliceOverrides,
      preview: fs.existsSync(this.previewPath(j.id, 'top'))
        ? {
            top: `/api/jobs/${j.id}/preview/top?v=${j.updatedAt}`,
            iso: `/api/jobs/${j.id}/preview/iso?v=${j.updatedAt}`,
            paths: fs.existsSync(this.pathsFile(j.id)) ? `/api/jobs/${j.id}/toolpaths?v=${j.updatedAt}` : null,
          }
        : null,
      printer: p ?? null,
      profiles: { machine: prof(j.machineProfileId), process: prof(j.processProfileId), filament: prof(j.filamentProfileId) },
      copies: j.copies,
      autoOrient: j.autoOrient,
      autoPrint: j.autoPrint,
      arrange: j.arrange,
      draft: j.draft,
      replaces: j.replaces,
      bedType: bedTypeSchema.safeParse(j.bedType).data ?? null,
      error: j.error,
      gcodeName: j.gcodeName,
      printerPath: j.printerPath,
      estimatedTime: j.estimatedTime,
      filamentMm: j.filamentMm,
      filamentG: j.filamentG,
      note: j.note,
      queuePosition: j.status === 'waiting' ? j.queuePosition : null,
      finishedAt: j.finishedAt,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    };
  }
}

function toProfileInfo(r: ProfileRow): SlicerProfileInfo {
  const settings = JSON.parse(r.settings) as Record<string, unknown>;
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    version: r.version,
    parent: r.parent,
    systemPrinter: r.systemPrinter,
    summary: JSON.parse(r.summary),
    compatiblePrinters:
      r.kind !== 'machine' && Array.isArray(settings.compatible_printers) ? (settings.compatible_printers as string[]) : [],
    sourceFile: r.sourceFile,
    createdAt: r.createdAt,
  };
}

/** Jobs that may be edited (replaced): not while the printer is busy with them. */
function editable(status: JobRow['status']) {
  return status !== 'printing' && status !== 'uploading';
}

/** The plate a machine profile names (`default_bed_type`), else OrcaSlicer's usual default. */
export function defaultBedType(machine: Record<string, unknown>): BedType {
  return bedTypeSchema.safeParse(machine.default_bed_type).data ?? FALLBACK_BED_TYPE;
}

/** Orca refuses plates whose filament temperature is 0 ("not supported"); say so up front. */
function checkBedTemp(
  filament: Record<string, unknown>,
  name: string,
  bedType: BedType,
  Err: new (msg: string) => Error = SlicingError,
) {
  const raw = filament[BED_TYPES[bedType].temp];
  const temp = Number(Array.isArray(raw) ? raw[0] : raw);
  if (raw !== undefined && temp === 0) {
    throw new Err(`Filament „${name}“ ist für die Druckplatte „${BED_TYPES[bedType].label}“ nicht vorgesehen (Betttemperatur 0 °C im Profil)`);
  }
}

/** Manually placed parts must lie inside the bed (by their footprint's bounding box). */
function checkPlacement(items: { model: ModelRow; copies: number; transform?: ModelTransform }[], machine: Record<string, unknown>) {
  const bed = bedFromSettings(machine).bed;
  const [bx0, bx1] = [Math.min(...bed.map((p) => p[0])), Math.max(...bed.map((p) => p[0]))];
  const [by0, by1] = [Math.min(...bed.map((p) => p[1])), Math.max(...bed.map((p) => p[1]))];
  for (const i of items) {
    for (const [x, y] of i.transform?.positions ?? []) {
      if (x < bx0 || x > bx1 || y < by0 || y > by1) throw new SlicingError(`„${i.model.name}“ liegt außerhalb des Druckbetts`);
    }
  }
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** e.g. "Halter_x3_PLA_1h2m.gcode" or "Halter_+2_PLA_1h2m.gcode" for several models (like Orca's naming). */
export function gcodeFileName(names: string[], copies: number, material: string, seconds?: number): string {
  const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };
  const safe = (s: string) =>
    s
      .replace(/[äöüÄÖÜß]/g, (c) => UMLAUTS[c]!)
      .normalize('NFKD')
      .replace(/\p{M}/gu, '') // drop accents: é -> e
      .replace(/[^\w.-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  const dur = seconds === undefined ? '' : `_${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}h` : ''}${Math.round((seconds % 3600) / 60)}m`;
  const base = safe(names[0] ?? '').slice(0, 80) || 'modell';
  const suffix = names.length > 1 ? `_+${names.length - 1}` : copies > 1 ? `_x${copies}` : '';
  return `${base}${suffix}_${safe(material)}${dur}.gcode`;
}

export { KINDS };
