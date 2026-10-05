import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import type { ModelInfo, ThingDetails, ThingFile, ThingSearchPage, ThingSummary, ThingiverseSort } from '@printhub/shared';
import type { Db } from '../db/index.js';
import { appSettings } from '../db/schema.js';
import type { SecretBox } from '../crypto.js';
import type { SlicingService } from '../slicer/service.js';
import { formatOf } from '../slicer/mesh.js';

export class ThingiverseError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
  }
}

const SETTINGS_KEY = 'thingiverse';
const CACHE_MS = 5 * 60 * 1000;
const PER_PAGE = 24;
/** Images are proxied (our CSP only allows same-origin images), but only from Thingiverse. */
const IMAGE_HOSTS = /(^|\.)thingiverse\.com$/i;

type Json = Record<string, unknown>;

export class ThingiverseService {
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly slicing: SlicingService,
    private readonly cfg: { apiBase: string; tmpDir: string; maxModelBytes: number },
  ) {}

  // --- token ----------------------------------------------------------------

  private token(): string | null {
    const row = this.db.select().from(appSettings).where(eq(appSettings.key, SETTINGS_KEY)).get();
    if (!row) return null;
    try {
      return this.box.decrypt((JSON.parse(row.value) as { token: string }).token);
    } catch {
      return null;
    }
  }

  get configured() {
    return this.token() !== null;
  }

  /** Verifies the token with a tiny search before storing it encrypted. */
  async setToken(token: string) {
    await this.request('/search/benchy/', { type: 'things', per_page: '1' }, token, false);
    const value = JSON.stringify({ token: this.box.encrypt(token) });
    this.db.insert(appSettings).values({ key: SETTINGS_KEY, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } }).run();
    this.cache.clear();
  }

  removeToken() {
    this.db.delete(appSettings).where(eq(appSettings.key, SETTINGS_KEY)).run();
    this.cache.clear();
  }

  // --- API ------------------------------------------------------------------

  private async request<T = Json>(pathname: string, params: Record<string, string> = {}, token = this.token(), useCache = true): Promise<T> {
    if (!token) throw new ThingiverseError('Kein Thingiverse-Token hinterlegt (Einstellungen → Integrationen)', 409);
    const url = new URL(pathname, this.cfg.apiBase);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const key = url.toString();
    const hit = this.cache.get(key);
    if (useCache && hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;

    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new ThingiverseError('Thingiverse ist nicht erreichbar');
    }
    if (res.status === 401 || res.status === 403) throw new ThingiverseError('Thingiverse hat den Token abgelehnt', 400);
    if (res.status === 404) throw new ThingiverseError('Bei Thingiverse nicht gefunden', 404);
    if (res.status === 429) throw new ThingiverseError('Zu viele Anfragen an Thingiverse, bitte kurz warten', 429);
    if (!res.ok) throw new ThingiverseError(`Thingiverse-Fehler (HTTP ${res.status})`);
    const value = (await res.json()) as T;
    if (useCache) {
      this.cache.set(key, { at: Date.now(), value });
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    }
    return value;
  }

  async search(q: string, page: number, sort: ThingiverseSort): Promise<ThingSearchPage> {
    const res = await this.request<{ hits?: Json[]; total?: number }>(`/search/${encodeURIComponent(q)}/`, {
      type: 'things',
      page: String(page),
      per_page: String(PER_PAGE),
      sort,
    });
    return {
      total: res.total ?? 0,
      page,
      hits: (res.hits ?? []).filter((h) => !h.is_nsfw).map((h) => this.summary(h)),
    };
  }

  async details(id: number): Promise<ThingDetails> {
    const [thing, files, images] = await Promise.all([
      this.request<Json>(`/things/${id}`),
      this.request<Json[]>(`/things/${id}/files`),
      this.request<Json[]>(`/things/${id}/images`).catch(() => [] as Json[]),
    ]);
    if (thing.is_nsfw) throw new ThingiverseError('Nicht verfügbar', 404);
    const creator = (thing.creator as Json | null) ?? null;
    return {
      ...this.summary(thing),
      license: str(thing.license),
      creatorUrl: str(creator?.public_url),
      description: plain(str(thing.description) ?? '').slice(0, 1500),
      images: images
        .map((img) => {
          const sizes = (img.sizes as { type: string; size: string; url: string }[] | undefined) ?? [];
          const best = sizes.find((s) => s.type === 'display' && s.size === 'large') ?? sizes.find((s) => s.type === 'display') ?? sizes[0];
          return best ? this.proxied(best.url) : null;
        })
        .filter((u): u is string => !!u)
        .slice(0, 8),
      files: files.map((f) => this.file(f)),
    };
  }

  /** Downloads the chosen files into the model library (zip archives are unpacked). */
  async import(thingId: number, fileIds: number[]): Promise<ModelInfo[]> {
    const thing = await this.details(thingId);
    const meta = {
      source: 'thingiverse',
      sourceUrl: thing.url,
      license: thing.license ?? undefined,
      author: thing.creator ?? undefined,
    };
    const out: ModelInfo[] = [];
    for (const fileId of fileIds) {
      const file = thing.files.find((f) => f.id === fileId);
      if (!file) throw new ThingiverseError(`Datei ${fileId} gehört nicht zu diesem Thing`, 400);
      if (!file.importable) throw new ThingiverseError(`${file.name}: nur STL, 3MF, OBJ oder ZIP können übernommen werden`, 400);
      const buf = await this.download(fileId);
      let entries: [string, Uint8Array][];
      if (/\.zip$/i.test(file.name)) {
        try {
          entries = Object.entries(unzipSync(new Uint8Array(buf))).filter(([n]) => formatOf(n) && !n.startsWith('__MACOSX/'));
        } catch {
          throw new ThingiverseError(`${file.name} ist kein gültiges ZIP-Archiv`, 400);
        }
      } else {
        entries = [[file.name, new Uint8Array(buf)]];
      }
      if (!entries.length) throw new ThingiverseError(`${file.name} enthält keine STL-, 3MF- oder OBJ-Dateien`, 400);
      for (const [name, data] of entries.slice(0, 30)) {
        const tmp = path.join(this.cfg.tmpDir, `${randomUUID()}.model`);
        try {
          fs.mkdirSync(this.cfg.tmpDir, { recursive: true });
          await fs.promises.writeFile(tmp, data);
          const base = path.basename(name);
          const model = await this.slicing.addModel(base, tmp, { ...meta, name: base.replace(/\.[^.]+$/, '') });
          // Identical files are stored once (content hash); report each model only once.
          if (!out.some((m) => m.id === model.id)) out.push(model);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      }
    }
    return out;
  }

  private async download(fileId: number): Promise<Buffer> {
    const token = this.token();
    if (!token) throw new ThingiverseError('Kein Thingiverse-Token hinterlegt', 409);
    // The API redirects to the CDN; fetch drops the Authorization header on cross-origin redirects.
    let res: Response;
    try {
      res = await fetch(new URL(`/files/${fileId}/download`, this.cfg.apiBase), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new ThingiverseError('Download von Thingiverse fehlgeschlagen');
    }
    if (!res.ok || !res.body) throw new ThingiverseError(`Download fehlgeschlagen (HTTP ${res.status})`);
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > this.cfg.maxModelBytes) throw new ThingiverseError('Datei ist zu groß', 413);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > this.cfg.maxModelBytes) throw new ThingiverseError('Datei ist zu groß', 413);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /** Fetches a Thingiverse image; only https URLs on thingiverse.com hosts. */
  async image(url: string): Promise<Response> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ThingiverseError('Ungültige Bild-URL', 400);
    }
    if (u.protocol !== 'https:' || !IMAGE_HOSTS.test(u.hostname)) throw new ThingiverseError('Bildquelle nicht erlaubt', 400);
    let res: Response;
    try {
      res = await fetch(u, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    } catch {
      throw new ThingiverseError('Bild nicht erreichbar');
    }
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !res.body || !type.startsWith('image/')) throw new ThingiverseError('Bild nicht verfügbar', 404);
    return res;
  }

  private proxied(url: unknown): string | null {
    const s = str(url);
    return s ? `/api/thingiverse/image?url=${encodeURIComponent(s)}` : null;
  }

  private summary(t: Json): ThingSummary {
    const creator = (t.creator as Json | null) ?? null;
    return {
      id: Number(t.id),
      name: str(t.name) ?? `Thing ${String(t.id)}`,
      thumbnail: this.proxied(t.preview_image ?? t.thumbnail),
      creator: str(creator?.name),
      likes: Number(t.like_count ?? 0),
      downloads: Number(t.download_count ?? 0),
      url: `https://www.thingiverse.com/thing:${String(t.id)}`,
    };
  }

  private file(f: Json): ThingFile {
    const name = str(f.name) ?? `Datei ${String(f.id)}`;
    return {
      id: Number(f.id),
      name,
      size: Number(f.size ?? 0),
      thumbnail: this.proxied(f.thumbnail),
      importable: !!formatOf(name) || /\.zip$/i.test(name),
    };
  }
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Thingiverse descriptions are HTML/Markdown; show plain text. */
function plain(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
