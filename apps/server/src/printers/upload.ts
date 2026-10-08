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

export interface UploadResult {
  /** Path below the gcodes root. */
  path: string;
  /** Print requested and actually started by Moonraker. */
  printStarted: boolean;
  /** Print requested, but Moonraker put the file into its own job queue instead. */
  printQueued: boolean;
}

/** Sends a local G-code file to Moonraker's gcodes root (optionally into a folder, optionally printing it). */
export async function uploadToPrinter(
  client: MoonrakerClient,
  filePath: string,
  filename: string,
  opts: { folder?: string; print?: boolean } = {},
): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', await fs.openAsBlob(filePath), filename);
  form.append('root', 'gcodes');
  if (opts.folder) form.append('path', opts.folder);
  if (opts.print) form.append('print', 'true');
  const res = await client.fetch('/server/files/upload', { method: 'POST', body: form });
  if (!res.ok) {
    throw new UploadError(`Upload zum Drucker fehlgeschlagen (HTTP ${res.status})`, res.status);
  }
  const body = (await res.json().catch(() => null)) as { result?: UploadResponse } & UploadResponse | null;
  const r = body?.result ?? body ?? {};
  // Moonraker without these fields (very old versions) starts the print right away.
  const printStarted = !!opts.print && (r.print_started ?? true);
  return {
    path: opts.folder ? `${opts.folder}/${filename}` : filename,
    printStarted,
    printQueued: !!opts.print && !printStarted && !!r.print_queued,
  };
}

interface UploadResponse {
  print_started?: boolean;
  print_queued?: boolean;
}

/** Why a requested print did not start, for the user. */
export function notStartedReason(r: UploadResult): string {
  return r.printQueued
    ? 'Datei übertragen, Moonraker hat den Druck aber in seine eigene Warteschlange (job_queue) gestellt statt ihn zu starten'
    : 'Datei übertragen, Moonraker hat den Druck aber nicht gestartet';
}
