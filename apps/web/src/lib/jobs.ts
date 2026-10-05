import { useEffect } from 'react';
import type { JobInfo, JobStatus } from '@printhub/shared';
import { api } from './api';
import { live, useLive } from './live';
import type { Tone } from './format';

/** Live job list: loaded once per websocket session, then kept current by push messages. */
export function useJobs() {
  const jobs = useLive((s) => s.jobs);
  const connection = useLive((s) => s.connection);
  useEffect(() => {
    if (jobs === null && connection === 'open') {
      api<JobInfo[]>('/jobs')
        .then((list) => live.setJobs(list))
        .catch(() => {});
    }
  }, [jobs, connection]);
  return jobs;
}

export const JOB_STATUS: Record<JobStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Wartet', tone: 'neutral' },
  slicing: { label: 'Wird gesliced', tone: 'info' },
  sliced: { label: 'Bereit', tone: 'good' },
  uploading: { label: 'Wird übertragen', tone: 'info' },
  uploaded: { label: 'Auf dem Drucker', tone: 'good' },
  waiting: { label: 'In Warteschlange', tone: 'info' },
  printing: { label: 'Druckt', tone: 'info' },
  done: { label: 'Gedruckt', tone: 'good' },
  print_failed: { label: 'Druck fehlgeschlagen', tone: 'critical' },
  print_cancelled: { label: 'Druck abgebrochen', tone: 'warning' },
  failed: { label: 'Slicen fehlgeschlagen', tone: 'critical' },
  cancelled: { label: 'Abgebrochen', tone: 'warning' },
};

/** Jobs in a printer's print queue, in order. */
export function queueOf(jobs: JobInfo[] | null, printerId: number): JobInfo[] {
  return (jobs ?? []).filter((j) => j.status === 'waiting' && j.printer?.id === printerId).sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
}

/** Statuses with G-code that can be printed (again) or queued. */
export const PRINTABLE: JobStatus[] = ['sliced', 'uploaded', 'done', 'print_failed', 'print_cancelled'];

export const jobTitle = (j: JobInfo) => j.models.map((m) => (m.copies > 1 ? `${m.name} ×${m.copies}` : m.name)).join(', ');

export function formatDims(d: [number, number, number]) {
  return d.map((v) => (Math.round(v * 10) / 10).toString().replace('.', ',')).join(' × ') + ' mm';
}
