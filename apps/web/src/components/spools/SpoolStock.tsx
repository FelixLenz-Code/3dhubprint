import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ExternalLink, Plus, Scale } from 'lucide-react';
import clsx from 'clsx';
import type { SpoolInfo } from '@printhub/shared';
import { api } from '../../lib/api';
import { confirm, useAction } from '../../lib/feedback';
import { formatMoney, formatWeight, useSpoolmanStatus } from '../../lib/stats';
import { Button, Card, Input, Spinner } from '../ui';
import { CreateSpoolDialog } from './CreateSpoolDialog';

/** Spools in Spoolman with remaining weight; admins can add, weigh and archive spools. */
export function SpoolStock({ editable }: { editable: boolean }) {
  const status = useSpoolmanStatus();
  const spools = useQuery({ queryKey: ['spools'], queryFn: () => api<SpoolInfo[]>('/spoolman/spools'), enabled: !!status.data?.configured });
  const [creating, setCreating] = useState(false);
  if (!status.data?.configured) return null;
  const active = spools.data?.filter((s) => !s.archived) ?? [];
  const webUrl = status.data.webUrl;

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-semibold">Filamentbestand</h2>
        {webUrl && (
          <a href={webUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm text-text-2 hover:bg-surface-2 hover:text-text">
            Spoolman <ExternalLink className="size-3.5" />
          </a>
        )}
        {editable && (
          <Button variant="secondary" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Spule anlegen
          </Button>
        )}
      </div>
      {spools.error ? (
        <p className="text-sm text-critical">{(spools.error as Error).message}</p>
      ) : !spools.data ? (
        <Spinner />
      ) : active.length === 0 ? (
        <p className="text-sm text-text-3">Noch keine Spulen. {editable && 'Mit „Spule anlegen“ die erste erfassen.'}</p>
      ) : (
        <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {active.map((s) => (
            <SpoolRow key={s.id} spool={s} editable={editable} />
          ))}
        </ul>
      )}
      {editable && <CreateSpoolDialog open={creating} onClose={() => setCreating(false)} />}
    </Card>
  );
}

function SpoolRow({ spool: s, editable }: { spool: SpoolInfo; editable: boolean }) {
  const qc = useQueryClient();
  const [weighing, setWeighing] = useState(false);
  const [weight, setWeight] = useState('');
  const { busy, run } = useAction();
  const frac = s.remainingG !== null && s.initialG ? Math.max(0, Math.min(1, s.remainingG / s.initialG)) : null;
  const low = s.remainingG !== null && s.remainingG < 100;

  const patch = (key: string, body: object, done?: string) =>
    run(
      key,
      async () => {
        await api(`/spoolman/spools/${s.id}`, { method: 'PATCH', body });
        await qc.invalidateQueries({ queryKey: ['spools'] });
        await qc.invalidateQueries({ queryKey: ['printer-spool'] });
      },
      done,
    );

  const saveWeight = (e: FormEvent) => {
    e.preventDefault();
    const g = Number(weight.replace(',', '.'));
    if (!(g >= 0)) return;
    void patch('weigh', { remainingWeight: g }, 'Restgewicht gespeichert').then(() => setWeighing(false));
  };

  const archive = async () => {
    if (await confirm({ title: 'Spule archivieren?', body: `#${s.id} ${s.name} ist leer oder wird nicht mehr genutzt. Sie verschwindet aus den Listen, bleibt aber in Spoolman erhalten.`, confirmLabel: 'Archivieren' })) {
      void patch('archive', { archived: true }, 'Archiviert');
    }
  };

  return (
    <li className="flex items-center gap-3 py-1.5">
      <span className="size-8 shrink-0 rounded-full border border-border" style={{ background: s.color ?? 'var(--surface-2)' }} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate font-medium">
            {s.vendor ? `${s.vendor} ` : ''}
            {s.name}
          </span>
          <span className="tabular shrink-0">{formatWeight(s.remainingG)}</span>
        </div>
        {frac !== null && (
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className={clsx('h-full rounded-full', low ? 'bg-warning' : 'bg-accent')} style={{ width: `${frac * 100}%` }} />
          </div>
        )}
        {weighing ? (
          <form onSubmit={saveWeight} className="mt-1.5 flex items-center gap-2">
            <Input autoFocus inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="Rest in g (ohne Spule)" className="min-h-8 text-xs" aria-label="Restgewicht in Gramm" />
            <Button type="submit" className="min-h-8 px-3" loading={busy === 'weigh'} disabled={!(Number(weight.replace(',', '.')) >= 0) || weight.trim() === ''}>
              OK
            </Button>
            <Button type="button" variant="ghost" className="min-h-8 px-2" onClick={() => setWeighing(false)}>
              Abbrechen
            </Button>
          </form>
        ) : (
          <div className="truncate text-xs text-text-3">
            {[`#${s.id}`, s.material, s.pricePerKg !== null && `${formatMoney(s.pricePerKg)}/kg`, s.location, low && 'fast leer'].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
      {editable && !weighing && (
        <div className="flex shrink-0">
          <Button variant="ghost" className="min-h-9 px-2" onClick={() => { setWeight(s.remainingG !== null ? String(Math.round(s.remainingG)) : ''); setWeighing(true); }} title="Nachgewogen: Restgewicht eintragen" aria-label={`Restgewicht von #${s.id} eintragen`}>
            <Scale className="size-4" />
          </Button>
          <Button variant="ghost" className="min-h-9 px-2" onClick={archive} loading={busy === 'archive'} title="Archivieren (leer)" aria-label={`#${s.id} archivieren`}>
            <Archive className="size-4" />
          </Button>
        </div>
      )}
    </li>
  );
}
