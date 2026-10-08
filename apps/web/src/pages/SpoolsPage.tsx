import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Pencil, Plus, RefreshCw, Search } from 'lucide-react';
import clsx from 'clsx';
import type { FilamentInfo, PrinterSpool, SpoolInfo } from '@printhub/shared';
import { api } from '../lib/api';
import { useIsAdmin } from '../lib/auth';
import { useLive } from '../lib/live';
import { formatMoney, formatWeight, useSpoolmanStatus } from '../lib/stats';
import { Badge, Button, Card, Input, Segmented, Spinner, Tile } from '../components/ui';
import { CreateSpoolDialog } from '../components/spools/CreateSpoolDialog';
import { EditSpoolDialog } from '../components/spools/EditSpoolDialog';
import { EditFilamentDialog } from '../components/spools/EditFilamentDialog';

const TABS = { spools: 'Spulen', filaments: 'Filamente' } as const;
type Tab = keyof typeof TABS;

const SORTS = { lastUsed: 'Zuletzt benutzt', remaining: 'Wenig übrig zuerst', newest: 'Neueste zuerst', name: 'Name' } as const;
type Sort = keyof typeof SORTS;

/** Below this a spool counts as almost empty. */
const LOW_G = 100;

const selectClass = 'min-h-10 rounded-lg border border-border bg-surface px-3 text-sm text-text';
const formatDate = (t: number | null) => (t ? new Date(t).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '–');
const label = (x: { vendor: string | null; name: string }) => `${x.vendor ? `${x.vendor} ` : ''}${x.name}`;

/** Spool and filament inventory in Spoolman, a lighter take on Spoolman's own pages. */
export function SpoolsPage() {
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const status = useSpoolmanStatus();
  const configured = !!status.data?.configured;
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'filaments' ? 'filaments' : 'spools';
  const spools = useQuery({ queryKey: ['spools'], queryFn: () => api<SpoolInfo[]>('/spoolman/spools'), enabled: configured });
  const filaments = useQuery({ queryKey: ['filaments'], queryFn: () => api<FilamentInfo[]>('/spoolman/filaments'), enabled: configured });
  // null: closed, undefined: no filament preselected.
  const [creating, setCreating] = useState<{ filamentId?: number } | null>(null);

  // Bypasses the server's short cache, e.g. after changes made in Spoolman itself.
  const refresh = async () => {
    qc.setQueryData(['spools'], await api<SpoolInfo[]>('/spoolman/spools?fresh=1'));
    await filaments.refetch();
  };

  if (status.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold">Spulen</h1>
        {configured && (
          <>
            <Button variant="ghost" className="px-3" onClick={() => void refresh()} loading={spools.isFetching || filaments.isFetching} title="Neu aus Spoolman laden" aria-label="Aktualisieren">
              {!(spools.isFetching || filaments.isFetching) && <RefreshCw className="size-4" />}
            </Button>
            {status.data?.webUrl && (
              <a href={status.data.webUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-text-2 hover:bg-surface-2 hover:text-text" aria-label="Spoolman öffnen" title="Spoolman öffnen">
                <span className="hidden sm:inline">Spoolman</span> <ExternalLink className="size-4 sm:size-3.5" />
              </a>
            )}
            {isAdmin && (
              <Button onClick={() => setCreating({})} className="px-3 sm:px-4">
                <Plus className="size-4" /> <span className="hidden sm:inline">Spule anlegen</span>
                <span className="sm:hidden">Neu</span>
              </Button>
            )}
          </>
        )}
      </header>

      {!configured ? (
        <Card className="space-y-2 p-5">
          <h2 className="font-semibold">Spoolman ist nicht verbunden</h2>
          <p className="text-sm text-text-2">Spulen und Filamente werden in Spoolman verwaltet. PrintHub zeigt hier den Bestand, legt Spulen an und bucht den Verbrauch nach jedem Druck.</p>
          {isAdmin && (
            <Link to="/settings/integrations" className="inline-block text-sm text-accent hover:underline">
              Spoolman einrichten
            </Link>
          )}
        </Card>
      ) : spools.error || filaments.error ? (
        <Card className="p-5 text-sm text-critical">{((spools.error ?? filaments.error) as Error).message}</Card>
      ) : !spools.data || !filaments.data ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <>
          <Summary spools={spools.data} />
          <Segmented value={tab} onChange={(t) => setParams(t === 'spools' ? {} : { tab: t }, { replace: true })} options={TABS} label="Ansicht" />
          {tab === 'spools' ? (
            <SpoolList spools={spools.data} editable={isAdmin} />
          ) : (
            <FilamentList filaments={filaments.data} spools={spools.data} editable={isAdmin} onCreate={(filamentId) => setCreating({ filamentId })} />
          )}
        </>
      )}

      {isAdmin && <CreateSpoolDialog open={creating !== null} onClose={() => setCreating(null)} filamentId={creating?.filamentId} />}
    </div>
  );
}

function Summary({ spools }: { spools: SpoolInfo[] }) {
  const active = spools.filter((s) => !s.archived);
  const remaining = active.reduce((sum, s) => sum + (s.remainingG ?? 0), 0);
  const value = active.reduce((sum, s) => sum + ((s.remainingG ?? 0) / 1000) * (s.pricePerKg ?? 0), 0);
  const low = active.filter((s) => s.remainingG !== null && s.remainingG < LOW_G).length;
  const materials = new Set(active.map((s) => s.material).filter(Boolean)).size;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile label="Spulen" value={active.length.toLocaleString('de-DE')} sub={`${spools.length - active.length} archiviert`} />
      <Tile label="Filament übrig" value={formatWeight(remaining)} sub={`${materials} ${materials === 1 ? 'Material' : 'Materialien'}`} />
      <Tile label="Restwert" value={formatMoney(value)} sub="nach Restgewicht" />
      <Tile label="Fast leer" value={low.toLocaleString('de-DE')} sub={`unter ${LOW_G} g`} />
    </div>
  );
}

/** Which printer each spool is loaded in. */
function useLoadedIn(): Map<number, string> {
  const printers = useLive((s) => s.printers);
  const results = useQueries({
    queries: printers.map((p) => ({ queryKey: ['printer-spool', p.id], queryFn: () => api<PrinterSpool>(`/printers/${p.id}/spool`), refetchInterval: 60_000 })),
  });
  const map = new Map<number, string>();
  results.forEach((r, i) => {
    const id = r.data?.spool?.id;
    if (id) map.set(id, map.has(id) ? `${map.get(id)}, ${printers[i]!.name}` : printers[i]!.name);
  });
  return map;
}

function SpoolList({ spools, editable }: { spools: SpoolInfo[]; editable: boolean }) {
  const loadedIn = useLoadedIn();
  const [query, setQuery] = useState('');
  const [material, setMaterial] = useState('');
  const [sort, setSort] = useState<Sort>('lastUsed');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<SpoolInfo | null>(null);

  const materials = useMemo(() => [...new Set(spools.map((s) => s.material).filter((m): m is string => !!m))].sort(), [spools]);
  const archivedCount = spools.filter((s) => s.archived).length;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = spools.filter(
      (s) =>
        (showArchived || !s.archived) &&
        (!material || s.material === material) &&
        (!q || [`#${s.id}`, s.name, s.vendor, s.material, s.location, s.comment].some((v) => v?.toLowerCase().includes(q))),
    );
    const by: Record<Sort, (a: SpoolInfo, b: SpoolInfo) => number> = {
      lastUsed: (a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || b.id - a.id,
      remaining: (a, b) => (a.remainingG ?? Infinity) - (b.remainingG ?? Infinity),
      newest: (a, b) => b.id - a.id,
      name: (a, b) => label(a).localeCompare(label(b)) || a.id - b.id,
    };
    // Archived spools always at the end.
    return list.sort((a, b) => Number(a.archived) - Number(b.archived) || by[sort](a, b));
  }, [spools, query, material, sort, showArchived]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-3" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Suchen" aria-label="Spulen durchsuchen" className="pl-9" />
        </div>
        {materials.length > 1 && (
          <select value={material} onChange={(e) => setMaterial(e.target.value)} aria-label="Material" className={selectClass}>
            <option value="">Alle Materialien</option>
            {materials.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        )}
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sortierung" className={selectClass}>
          {Object.entries(SORTS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        {archivedCount > 0 && (
          <label className="flex min-h-10 items-center gap-2 px-1 text-sm text-text-2">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="size-4 accent-[var(--accent)]" />
            Archivierte ({archivedCount})
          </label>
        )}
      </div>

      <Card className="overflow-hidden">
        {shown.length === 0 ? (
          <p className="p-5 text-sm text-text-3">{spools.length === 0 ? `Noch keine Spulen.${editable ? ' Mit „Spule anlegen“ die erste erfassen.' : ''}` : 'Keine Spule passt zur Suche.'}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="whitespace-nowrap border-b border-border text-left text-xs text-text-3">
              <tr>
                <th className="w-full px-4 py-2.5 font-medium">Spule</th>
                <th className="hidden px-3 py-2.5 font-medium md:table-cell">Material</th>
                <th className="min-w-28 px-3 py-2.5 font-medium sm:min-w-52">Übrig</th>
                <th className="hidden px-3 py-2.5 text-right font-medium lg:table-cell">Verbraucht</th>
                <th className="hidden px-3 py-2.5 font-medium md:table-cell">Lagerort</th>
                <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Zuletzt</th>
                {editable && <th className="w-12 px-2 py-2.5" aria-label="Aktionen" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border whitespace-nowrap">
              {shown.map((s) => (
                <SpoolRow key={s.id} spool={s} loadedIn={loadedIn.get(s.id)} onEdit={editable ? () => setEditing(s) : undefined} />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editable && <EditSpoolDialog spool={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SpoolRow({ spool: s, loadedIn, onEdit }: { spool: SpoolInfo; loadedIn?: string; onEdit?: () => void }) {
  const frac = s.remainingG !== null && s.initialG ? Math.max(0, Math.min(1, s.remainingG / s.initialG)) : null;
  const low = !s.archived && s.remainingG !== null && s.remainingG < LOW_G;
  return (
    <tr className={clsx(onEdit && 'cursor-pointer hover:bg-surface-2/50', s.archived && 'text-text-3')} onClick={onEdit}>
      <td className="max-w-0 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className={clsx('size-8 shrink-0 rounded-full border border-border', s.archived && 'opacity-50')} style={{ background: s.color ?? 'var(--surface-2)' }} aria-hidden />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{label(s)}</span>
              {loadedIn && <Badge tone="info">{loadedIn}</Badge>}
              {s.archived && <Badge tone="neutral">archiviert</Badge>}
            </div>
            <div className="truncate text-xs text-text-3">
              #{s.id}
              <span className="md:hidden">
                {s.material && ` · ${s.material}`}
                {s.location && ` · ${s.location}`}
              </span>
              {s.comment && ` · ${s.comment}`}
            </div>
          </div>
        </div>
      </td>
      <td className="hidden whitespace-nowrap px-3 py-2.5 md:table-cell">{s.material ?? '–'}</td>
      <td className="px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className={clsx('tabular font-medium', low && 'text-warning')}>{formatWeight(s.remainingG)}</span>
          {s.initialG !== null && <span className="tabular hidden text-xs text-text-3 sm:inline">von {formatWeight(s.initialG)}</span>}
        </div>
        {frac !== null && (
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className={clsx('h-full rounded-full', s.archived ? 'bg-text-3' : low ? 'bg-warning' : 'bg-accent')} style={{ width: `${frac * 100}%` }} />
          </div>
        )}
      </td>
      <td className="tabular hidden px-3 py-2.5 text-right lg:table-cell">{formatWeight(s.usedG)}</td>
      <td className="hidden max-w-40 truncate whitespace-nowrap px-3 py-2.5 md:table-cell">{s.location ?? '–'}</td>
      <td className="tabular hidden px-3 py-2.5 lg:table-cell">{formatDate(s.lastUsed)}</td>
      {onEdit && (
        <td className="px-2 py-2.5 text-right">
          <Button variant="ghost" className="min-h-9 px-2" onClick={(e) => { e.stopPropagation(); onEdit(); }} aria-label={`#${s.id} bearbeiten`} title="Bearbeiten">
            <Pencil className="size-4" />
          </Button>
        </td>
      )}
    </tr>
  );
}

function FilamentList({ filaments, spools, editable, onCreate }: { filaments: FilamentInfo[]; spools: SpoolInfo[]; editable: boolean; onCreate: (filamentId: number) => void }) {
  const [editing, setEditing] = useState<FilamentInfo | null>(null);
  const counts = useMemo(() => {
    const m = new Map<number, { active: number; all: number; remaining: number }>();
    for (const s of spools) {
      if (s.filamentId === null) continue;
      const c = m.get(s.filamentId) ?? { active: 0, all: 0, remaining: 0 };
      c.all++;
      if (!s.archived) {
        c.active++;
        c.remaining += s.remainingG ?? 0;
      }
      m.set(s.filamentId, c);
    }
    return m;
  }, [spools]);

  return (
    <Card className="overflow-hidden">
      {filaments.length === 0 ? (
        <p className="p-5 text-sm text-text-3">Noch keine Filamente. Sie entstehen beim Anlegen einer Spule.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="whitespace-nowrap border-b border-border text-left text-xs text-text-3">
            <tr>
              <th className="w-full px-4 py-2.5 font-medium">Filament</th>
              <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Material</th>
              <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell">Gewicht</th>
              <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell">Preis</th>
              <th className="hidden px-3 py-2.5 text-right font-medium lg:table-cell">Dichte · Ø</th>
              <th className="px-3 py-2.5 text-right font-medium">Bestand</th>
              {editable && <th className="w-24 px-2 py-2.5" aria-label="Aktionen" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border whitespace-nowrap">
            {filaments.map((f) => {
              const c = counts.get(f.id);
              return (
                <tr key={f.id} className={clsx(editable && 'cursor-pointer hover:bg-surface-2/50')} onClick={editable ? () => setEditing(f) : undefined}>
                  <td className="max-w-0 px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <span className="size-8 shrink-0 rounded-full border border-border" style={{ background: f.color ?? 'var(--surface-2)' }} aria-hidden />
                      <div className="min-w-0">
                        <div className="truncate font-medium">{label(f)}</div>
                        <div className="truncate text-xs text-text-3">
                          #{f.id}
                          <span className="sm:hidden">{f.material && ` · ${f.material}`}</span>
                          <span className="md:hidden">{f.price !== null && ` · ${formatMoney(f.price)}`}</span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-3 py-2.5 sm:table-cell">{f.material ?? '–'}</td>
                  <td className="tabular hidden px-3 py-2.5 text-right md:table-cell">{formatWeight(f.weight)}</td>
                  <td className="tabular hidden px-3 py-2.5 text-right md:table-cell">
                    {formatMoney(f.price)}
                    {f.price !== null && f.weight ? <div className="text-xs text-text-3">{formatMoney((f.price / f.weight) * 1000)}/kg</div> : null}
                  </td>
                  <td className="tabular hidden px-3 py-2.5 text-right lg:table-cell">
                    {f.density?.toLocaleString('de-DE') ?? '–'} · {f.diameter?.toLocaleString('de-DE') ?? '–'} mm
                  </td>
                  <td className="tabular px-3 py-2.5 text-right">
                    <div>
                      {c?.active ?? 0} {c?.active === 1 ? 'Spule' : 'Spulen'}
                    </div>
                    {c && c.active > 0 && <div className="text-xs text-text-3">{formatWeight(c.remaining)}</div>}
                  </td>
                  {editable && (
                    <td className="whitespace-nowrap px-2 py-2.5 text-right">
                      <Button variant="ghost" className="min-h-9 px-2" onClick={(e) => { e.stopPropagation(); onCreate(f.id); }} aria-label={`Spule ${f.name} anlegen`} title="Spule dieses Filaments anlegen">
                        <Plus className="size-4" />
                      </Button>
                      <Button variant="ghost" className="min-h-9 px-2" onClick={(e) => { e.stopPropagation(); setEditing(f); }} aria-label={`${f.name} bearbeiten`} title="Bearbeiten">
                        <Pencil className="size-4" />
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {editable && <EditFilamentDialog filament={editing} spoolCount={editing ? (counts.get(editing.id)?.all ?? 0) : 0} onClose={() => setEditing(null)} />}
    </Card>
  );
}
