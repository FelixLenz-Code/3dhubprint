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
  printing: { label: 'Gestartet', tone: 'info' },
  failed: { label: 'Fehlgeschlagen', tone: 'critical' },
  cancelled: { label: 'Abgebrochen', tone: 'warning' },
};

export function formatDims(d: [number, number, number]) {
  return d.map((v) => (Math.round(v * 10) / 10).toString().replace('.', ',')).join(' × ') + ' mm';
}
