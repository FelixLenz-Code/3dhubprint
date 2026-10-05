import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import type { JobInfo } from '@printhub/shared';
import { api } from '../lib/api';
import { Alert, Spinner } from '../components/ui';
import { JobWizard, initialFromJob } from '../components/slicing/JobWizard';

function Header({ title }: { title: string }) {
  return (
    <header className="flex items-center gap-3">
      <Link to="/jobs" className="rounded-lg p-2 text-text-2 hover:bg-surface-2 hover:text-text" aria-label="Zurück">
        <ArrowLeft className="size-5" />
      </Link>
      <h1 className="text-2xl font-semibold">{title}</h1>
    </header>
  );
}

/** /jobs/new?models=1,2 preselects models (from the library or a Thingiverse import). */
export function NewJobPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const items = [...new Set((params.get('models') ?? '').split(',').map(Number))]
    .filter((n) => Number.isInteger(n) && n > 0)
    .map((modelId) => ({ modelId, copies: 1 }));
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <Header title="Neuer Auftrag" />
      <JobWizard initial={{ items }} onFinish={(to, job) => navigate(to === 'printer' && job.printer ? `/printers/${job.printer.id}` : '/jobs')} />
    </div>
  );
}

/** Opens a job in the wizard; saving replaces it with the newly sliced result. */
export function EditJobPage() {
  const navigate = useNavigate();
  const id = Number(useParams().id);
  const job = useQuery({ queryKey: ['job-edit', id], queryFn: () => api<JobInfo>(`/jobs/${id}`), staleTime: Infinity, gcTime: 0 });
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <Header title="Auftrag bearbeiten" />
      {job.isLoading && <Spinner />}
      {job.error && <Alert>{(job.error as Error).message}</Alert>}
      {job.data && (job.data.status === 'printing' || job.data.status === 'uploading') && (
        <Alert tone="warning">Dieser Auftrag wird gerade gedruckt oder übertragen und kann nicht bearbeitet werden.</Alert>
      )}
      {job.data && job.data.status !== 'printing' && job.data.status !== 'uploading' && (
        <>
          <p className="text-sm text-text-2">
            Änderungen werden neu geslict. Erst beim Speichern ersetzt das Ergebnis den bisherigen Auftrag
            {job.data.status === 'waiting' && ' und übernimmt dessen Platz in der Warteschlange'}.
          </p>
          <JobWizard
            initial={initialFromJob(job.data)}
            replaces={id}
            startStep={job.data.printer ? 1 : 0}
            onFinish={(to, j) => navigate(to === 'printer' && j.printer ? `/printers/${j.printer.id}` : '/jobs')}
          />
        </>
      )}
    </div>
  );
}
