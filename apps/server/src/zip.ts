import { unzip, unzipSync, type UnzipFileInfo } from 'fflate';

export class ZipLimitError extends Error {}

export interface ZipLimits {
  /** Sum of the unpacked sizes. */
  maxBytes: number;
  /** Further entries are skipped, not an error. */
  maxFiles?: number;
  accept?: (name: string) => boolean;
}

/**
 * Archives come from other people (Thingiverse, shared profiles): a few KB can claim gigabytes.
 * fflate never inflates an entry past the size its header declares, so limiting the declared
 * sizes bounds the memory used.
 */
function limiter(l: ZipLimits) {
  let total = 0;
  let files = 0;
  let over = false;
  return {
    filter(f: UnzipFileInfo) {
      if (over || (l.accept && !l.accept(f.name))) return false;
      if (l.maxFiles !== undefined && files >= l.maxFiles) return false;
      files++;
      total += f.originalSize;
      if (total > l.maxBytes) over = true;
      return !over;
    },
    check() {
      if (over) throw new ZipLimitError(`Archiv ist entpackt zu groß (max. ${Math.round(l.maxBytes / 1024 / 1024)} MB)`);
    },
  };
}

export function unzipLimitedSync(buf: Uint8Array, limits: ZipLimits): Record<string, Uint8Array> {
  const lim = limiter(limits);
  const out = unzipSync(buf, { filter: (f) => lim.filter(f) });
  lim.check();
  return out;
}

/** Inflates in worker threads, so a large archive doesn't stall the server. */
export function unzipLimited(buf: Uint8Array, limits: ZipLimits): Promise<Record<string, Uint8Array>> {
  const lim = limiter(limits);
  return new Promise((resolve, reject) => {
    unzip(buf, { filter: (f) => lim.filter(f) }, (err, data) => {
      if (err) return reject(err);
      try {
        lim.check();
        resolve(data);
      } catch (e) {
        reject(e);
      }
    });
  });
}
