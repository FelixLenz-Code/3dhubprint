import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export class SliceError extends Error {
  constructor(
    message: string,
    public readonly log = '',
  ) {
    super(message);
  }
}

export interface SliceInput {
  workDir: string;
  /** Models placed on one plate; Orca arranges all instances. */
  models: { path: string; copies: number }[];
  autoOrient: boolean;
  /** false: keep the parts' XY positions from the input files. */
  arrange?: boolean;
  machine: Record<string, unknown>;
  process: Record<string, unknown>;
  filament: Record<string, unknown>;
}

export interface SliceOutput {
  gcodePath: string;
  log: string;
  stats: GcodeStats;
}

export interface GcodeStats {
  estimatedTime?: number;
  filamentMm?: number;
  filamentG?: number;
  layers?: number;
}

const LOG_LIMIT = 64 * 1024;

/** Runs the OrcaSlicer CLI on one plate of models (auto-arranged unless `arrange` is false). */
export async function runOrca(bin: string, input: SliceInput, timeoutMs: number, signal?: AbortSignal): Promise<SliceOutput> {
  const { workDir } = input;
  const outDir = path.join(workDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, data] of [['machine', input.machine], ['process', input.process], ['filament', input.filament]] as const) {
    fs.writeFileSync(path.join(workDir, `${name}.json`), JSON.stringify(data));
  }

  const args = [
    '--slice', '0',
    '--arrange', input.arrange === false ? '0' : '1',
    '--orient', input.autoOrient ? '1' : '0',
    '--load-settings', 'machine.json;process.json',
    '--load-filaments', 'filament.json',
    '--outputdir', 'out',
    ...input.models.flatMap((m) => Array.from({ length: m.copies }, () => m.path)),
  ];

  let log = '';
  const append = (chunk: Buffer) => {
    log = (log + chunk.toString('utf8')).slice(-LOG_LIMIT);
  };

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: workDir,
      // Orca writes caches/config into $HOME; keep that inside the job directory.
      env: { ...process.env, HOME: workDir, LC_ALL: 'C' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      if (child.pid) os.setPriority(child.pid, 10); // slicing must not starve the web server
    } catch {
      /* not permitted: ignore */
    }
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      append(Buffer.from(`\n[PrintHub] Zeitlimit von ${Math.round(timeoutMs / 60000)} min überschritten, abgebrochen\n`));
      kill();
    }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new SliceError(`OrcaSlicer konnte nicht gestartet werden: ${err.message}`));
    });
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });

  if (signal?.aborted) throw new SliceError('Abgebrochen', log);

  let result: { return_code?: number; error_string?: string } = {};
  try {
    result = JSON.parse(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8'));
  } catch {
    /* no result file: Orca crashed before writing it */
  }
  const gcodePath = path.join(outDir, 'plate_1.gcode');
  if (code !== 0 || (result.return_code ?? 0) !== 0 || !fs.existsSync(gcodePath)) {
    const reason = result.error_string && result.error_string !== 'Success.' ? explain(result.error_string) : `Exit-Code ${code}`;
    throw new SliceError(`Slicen fehlgeschlagen: ${reason}`, log);
  }
  return { gcodePath, log, stats: await readGcodeStats(gcodePath) };
}

/** Orca's messages are written for its GUI and 3MF projects; say what they mean here. */
function explain(error: string): string {
  if (/G-code conflicts detected/i.test(error)) return 'Teile kommen sich beim Drucken in die Quere (Überlappung). Bitte weiter auseinander platzieren.';
  if (/outside|exceed.*(plate|bed)|beyond the plate/i.test(error)) return `Ein Teil liegt außerhalb des Druckbereichs (${error})`;
  return error;
}

/** Parses Orca's summary comments from the start and end of the G-code. */
export async function readGcodeStats(file: string): Promise<GcodeStats> {
  const fd = await fs.promises.open(file, 'r');
  try {
    const { size } = await fd.stat();
    const read = async (pos: number, len: number) => {
      const buf = Buffer.alloc(Math.max(0, Math.min(len, size - pos)));
      await fd.read(buf, 0, buf.length, pos);
      return buf.toString('utf8');
    };
    const text = (await read(0, 64 * 1024)) + '\n' + (await read(Math.max(0, size - 512 * 1024), 512 * 1024));
    const get = (re: RegExp) => re.exec(text)?.[1];
    const time = get(/^; estimated printing time \(normal mode\) = (.+)$/m);
    return {
      estimatedTime: time ? parseDuration(time) : undefined,
      filamentMm: num(get(/^; filament used \[mm\] = ([\d.]+)/m)),
      filamentG: num(get(/^; total filament used \[g\] = ([\d.]+)/m)) ?? num(get(/^; filament used \[g\] = ([\d.]+)/m)),
      layers: num(get(/^; total layers count = (\d+)/m)),
    };
  } finally {
    await fd.close();
  }
}

const num = (s: string | undefined) => (s !== undefined && Number.isFinite(Number(s)) ? Number(s) : undefined);

/** "1d 2h 3m 4s" -> seconds */
export function parseDuration(s: string): number {
  let total = 0;
  for (const [, n, unit] of s.matchAll(/(\d+)\s*([dhms])/g)) total += Number(n) * { d: 86400, h: 3600, m: 60, s: 1 }[unit as 'd']!;
  return total;
}

/** Sizes from the machine's `thumbnails` setting ("96x96/PNG, 300x300/PNG"), else 32 + 300 px. */
export function thumbnailSizes(machine: Record<string, unknown>): number[] {
  const raw = machine.thumbnails;
  const items = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;]/) : []).map(String);
  const sizes = items
    .map((t) => /^(\d+)x(\d+)/.exec(t.trim()))
    .filter((m): m is RegExpExecArray => !!m && m[1] === m[2])
    .map((m) => Math.min(600, Number(m[1])));
  return sizes.length ? [...new Set(sizes)] : [32, 300];
}

/**
 * Inserts PNG thumbnails as "; thumbnail begin WxH LEN" blocks (the format Moonraker,
 * Fluidd and Mainsail read) right after Orca's header block.
 */
export async function injectThumbnails(gcodePath: string, pngs: { size: number; png: Buffer }[]): Promise<void> {
  if (!pngs.length) return;
  const block = pngs
    .map(({ size, png }) => {
      const b64 = png.toString('base64');
      const lines = b64.match(/.{1,78}/g) ?? [];
      return [`;`, `; thumbnail begin ${size}x${size} ${b64.length}`, ...lines.map((l) => `; ${l}`), `; thumbnail end`, `;`].join('\n');
    })
    .join('\n');

  const fd = await fs.promises.open(gcodePath, 'r');
  const head = Buffer.alloc(64 * 1024);
  const { bytesRead } = await fd.read(head, 0, head.length, 0);
  await fd.close();
  const marker = '; HEADER_BLOCK_END\n';
  const idx = head.subarray(0, bytesRead).indexOf(marker);
  const splitAt = idx >= 0 ? idx + marker.length : 0;

  const tmp = `${gcodePath}.tmp`;
  const out = fs.createWriteStream(tmp);
  out.write(head.subarray(0, splitAt));
  out.write(block + '\n');
  await pipeline(fs.createReadStream(gcodePath, { start: splitAt }), out);
  await fs.promises.rename(tmp, gcodePath);
}
