import fs from 'node:fs';
import type { MoonrakerClient } from './moonraker.js';

export class UploadError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** Sends a local G-code file to Moonraker's gcodes root (optionally into a folder, optionally printing it). */
export async function uploadToPrinter(
  client: MoonrakerClient,
  filePath: string,
  filename: string,
  opts: { folder?: string; print?: boolean } = {},
): Promise<string> {
  const form = new FormData();
  form.append('file', await fs.openAsBlob(filePath), filename);
  form.append('root', 'gcodes');
  if (opts.folder) form.append('path', opts.folder);
  if (opts.print) form.append('print', 'true');
  const res = await client.fetch('/server/files/upload', { method: 'POST', body: form });
  if (!res.ok) {
    throw new UploadError(`Upload zum Drucker fehlgeschlagen (HTTP ${res.status})`, res.status);
  }
  return opts.folder ? `${opts.folder}/${filename}` : filename;
}
