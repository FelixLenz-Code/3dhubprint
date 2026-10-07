import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, Check, Cog, Download, ExternalLink, Heart, Search, Trash2, Upload } from 'lucide-react';
import clsx from 'clsx';
import {
  THINGIVERSE_SORTS,
  THINGIVERSE_SUGGESTIONS,
  type ModelInfo,
  type ThingDetails,
  type ThingSearchPage,
  type ThingiverseSort,
  type ThingiverseSuggestion,
  type ThingiverseStatus,
} from '@printhub/shared';
import { api } from '../lib/api';
import { useIsAdmin } from '../lib/auth';
import { confirm, toast, useAction } from '../lib/feedback';
import { formatDims } from '../lib/jobs';
import { formatBytes } from '../lib/files';
import { Alert, Badge, Button, Card, Input, Spinner } from '../components/ui';
import { Modal } from '../components/Modal';
import { ModelPicker } from '../components/slicing/ModelPicker';

export function ModelsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'thingiverse' ? 'thingiverse' : 'library';
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Modelle</h1>
        <p className="text-sm text-text-2">Deine Modell-Bibliothek und Modelle von Thingiverse</p>
      </header>
      <nav className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border" role="tablist">
        {(
          [
            ['library', 'Bibliothek'],
            ['thingiverse', 'Thingiverse'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setParams(id === 'library' ? {} : { tab: id }, { replace: true })}
            className={clsx(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
              tab === id ? 'border-accent text-text' : 'border-transparent text-text-2 hover:text-text',
            )}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'library' ? <Library /> : <ThingiverseSearch />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

function Library() {
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const models = useQuery({ queryKey: ['models'], queryFn: () => api<ModelInfo[]>('/models') });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState('');
  const [upload, setUpload] = useState(false);
  const { run } = useAction();

  const toggle = (id: number) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const shown = (models.data ?? []).filter((m) => !filter || m.name.toLowerCase().includes(filter.toLowerCase()));

  const remove = async (m: ModelInfo) => {
    if (await confirm({ title: 'Modell löschen?', body: `„${m.name}“ wird aus der Bibliothek entfernt.`, confirmLabel: 'Löschen', danger: true })) {
      if (await run('del', () => api(`/models/${m.id}`, { method: 'DELETE' }))) {
        qc.setQueryData<ModelInfo[]>(['models'], (old) => old?.filter((x) => x.id !== m.id));
        setSelected((s) => new Set([...s].filter((x) => x !== m.id)));
      }
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Bibliothek durchsuchen…" className="pl-8" />
        </div>
        {isAdmin && (
          <Button variant="secondary" onClick={() => setUpload(true)}>
            <Upload className="size-4" /> Hochladen
          </Button>
        )}
        {isAdmin && selected.size > 0 && (
          <Button onClick={() => navigate(`/jobs/new?models=${[...selected].join(',')}`)}>
            Auftrag mit {selected.size} {selected.size === 1 ? 'Modell' : 'Modellen'} anlegen
          </Button>
        )}
      </div>

      {models.isLoading ? (
        <Spinner />
      ) : !models.data?.length ? (
        <Card className="flex flex-col items-center gap-3 px-6 py-14 text-center">
          <Box className="size-10 text-text-3" />
          <p className="text-sm text-text-2">Noch keine Modelle. Lade STL-, 3MF- oder OBJ-Dateien hoch oder übernimm welche von Thingiverse.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((m) => (
            <Card key={m.id} className={clsx('group relative overflow-hidden transition-colors hover:border-text-3', selected.has(m.id) && 'border-accent')}>
              <button onClick={() => toggle(m.id)} className="block h-full w-full text-left" aria-pressed={selected.has(m.id)}>
                {/* Same frame as the Thingiverse results; the render has a transparent background. */}
                <img src={m.thumbnailUrl} alt="" loading="lazy" className="aspect-[4/3] w-full bg-surface-2 object-contain p-2" />
                <div className="space-y-0.5 p-3">
                  <div className="truncate text-sm font-medium" title={m.name}>
                    {m.name}
                  </div>
                  <div className="tabular truncate text-xs text-text-3">
                    {formatDims(m.dimensions)} · {formatBytes(m.size)}
                  </div>
                  {m.source === 'thingiverse' && (
                    <div className="truncate text-xs text-text-3" title={m.license ?? undefined}>
                      Thingiverse{m.author && ` · ${m.author}`}
                      {m.license && ` · ${shortLicense(m.license)}`}
                    </div>
                  )}
                </div>
              </button>
              {selected.has(m.id) && <Check className="pointer-events-none absolute right-3 top-3 size-5 rounded-full bg-accent p-0.5 text-accent-ink" />}
              <div className="absolute left-3 top-3 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <a href={`/api/models/${m.id}/file`} className="rounded-md bg-surface/90 p-1 text-text-3 hover:text-text" aria-label={`${m.name} herunterladen`}>
                  <Download className="size-4" />
                </a>
                {m.sourceUrl && (
                  <a href={m.sourceUrl} target="_blank" rel="noreferrer" className="rounded-md bg-surface/90 p-1 text-text-3 hover:text-text" aria-label="Quelle öffnen">
                    <ExternalLink className="size-4" />
                  </a>
                )}
                {isAdmin && (
                  <button onClick={() => remove(m)} className="rounded-md bg-surface/90 p-1 text-text-3 hover:text-critical" aria-label={`${m.name} löschen`}>
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={upload} onClose={() => setUpload(false)} title="Modelle hochladen">
        <UploadOnly onDone={() => setUpload(false)} />
      </Modal>
    </div>
  );
}

function UploadOnly({ onDone }: { onDone: () => void }) {
  const [items, setItems] = useState<{ modelId: number; copies: number }[]>([]);
  return (
    <div className="space-y-4">
      <ModelPicker value={items} onChange={setItems} library="collapsed" />
      {items.length > 0 && (
        <div className="flex justify-end">
          <Button onClick={onDone}>Fertig</Button>
        </div>
      )}
    </div>
  );
}

/** "Creative Commons - Attribution - Non-Commercial" -> "CC BY-NC" */
export function shortLicense(l: string): string {
  if (!/creative commons/i.test(l)) return l;
  if (/public domain/i.test(l)) return 'CC0 / Public Domain';
  const parts = ['BY'];
  if (/non-?commercial/i.test(l)) parts.push('NC');
  if (/no derivatives/i.test(l)) parts.push('ND');
  if (/share ?alike/i.test(l)) parts.push('SA');
  return `CC ${parts.join('-')}`;
}

// ---------------------------------------------------------------------------
// Thingiverse
// ---------------------------------------------------------------------------

function ThingiverseSearch() {
  const isAdmin = useIsAdmin();
  const status = useQuery({ queryKey: ['thingiverse-status'], queryFn: () => api<ThingiverseStatus>('/thingiverse/status') });
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ThingiverseSort>('relevant');
  const [suggest, setSuggest] = useState<ThingiverseSuggestion>('popular');
  const [open, setOpen] = useState<number>();

  // Without a search term, show suggestions (popular, newest, featured).
  const results = useInfiniteQuery({
    queryKey: query ? ['thingiverse', query, sort] : ['thingiverse-suggest', suggest],
    queryFn: ({ pageParam }) =>
      api<ThingSearchPage>(
        query
          ? `/thingiverse/search?q=${encodeURIComponent(query)}&sort=${sort}&page=${pageParam}`
          : `/thingiverse/suggestions?list=${suggest}&page=${pageParam}`,
      ),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => (pages.reduce((n, p) => n + p.hits.length, 0) < last.total && last.hits.length ? last.page + 1 : undefined),
    enabled: !!status.data?.configured,
    staleTime: 5 * 60_000,
  });

  if (status.isLoading) return <Spinner />;
  if (!status.data?.configured) {
    return (
      <Alert tone="neutral">
        Für die Thingiverse-Suche wird ein kostenloser App-Token benötigt.{' '}
        {isAdmin ? (
          <Link to="/settings/integrations" className="underline">
            Jetzt in den Einstellungen hinterlegen
          </Link>
        ) : (
          'Ein Administrator muss ihn in den Einstellungen hinterlegen.'
        )}
      </Alert>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQuery(input.trim());
  };
  const hits = results.data?.pages.flatMap((p) => p.hits) ?? [];

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3" />
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Auf Thingiverse suchen, z. B. Kabelhalter" className="pl-8" autoFocus />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as ThingiverseSort)}
          className="min-h-10 rounded-lg border border-border bg-surface px-3 text-sm text-text"
          aria-label="Sortierung"
        >
          {Object.entries(THINGIVERSE_SORTS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={!input.trim() && !query}>
          Suchen
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-sm text-text-2">{query ? 'Oder stöbern:' : 'Vorschläge:'}</span>
        {(Object.keys(THINGIVERSE_SUGGESTIONS) as ThingiverseSuggestion[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setSuggest(k);
              setQuery('');
              setInput('');
            }}
            className={clsx(
              'rounded-full border px-3 py-1 text-sm',
              !query && suggest === k ? 'border-accent bg-accent/10 text-text' : 'border-border text-text-2 hover:border-text-3',
            )}
          >
            {THINGIVERSE_SUGGESTIONS[k]}
          </button>
        ))}
      </div>

      {results.error && <Alert>{(results.error as Error).message}</Alert>}
      {results.isLoading && <Spinner />}
      {results.data && !hits.length && <p className="text-sm text-text-3">Keine Treffer.</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {hits.map((t) => (
          <button key={t.id} onClick={() => setOpen(t.id)} className="text-left">
            <Card className="h-full overflow-hidden transition-colors hover:border-text-3">
              {t.thumbnail ? (
                <img src={t.thumbnail} alt="" loading="lazy" className="aspect-[4/3] w-full bg-surface-2 object-cover" />
              ) : (
                <div className="flex aspect-[4/3] items-center justify-center bg-surface-2">
                  <Box className="size-8 text-text-3" />
                </div>
              )}
              <div className="space-y-0.5 p-3">
                <div className="line-clamp-2 text-sm font-medium">{t.name}</div>
                <div className="flex items-center gap-2 text-xs text-text-3">
                  <span className="truncate">{t.creator}</span>
                  <span className="ml-auto inline-flex shrink-0 items-center gap-1">
                    <Heart className="size-3" /> {t.likes.toLocaleString('de-DE')}
                  </span>
                </div>
              </div>
            </Card>
          </button>
        ))}
      </div>

      {results.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => results.fetchNextPage()} loading={results.isFetchingNextPage}>
            Mehr laden
          </Button>
        </div>
      )}
      <p className="text-xs text-text-3">Modelle und Bilder von Thingiverse unterliegen der jeweiligen Lizenz ihrer Urheber.</p>

      <Modal open={open !== undefined} onClose={() => setOpen(undefined)} title="Thingiverse">
        {open !== undefined && <ThingDetailsView id={open} />}
      </Modal>
    </div>
  );
}

function ThingDetailsView({ id }: { id: number }) {
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const thing = useQuery({ queryKey: ['thing', id], queryFn: () => api<ThingDetails>(`/thingiverse/things/${id}`) });
  const [image, setImage] = useState(0);
  const [chosen, setChosen] = useState<Set<number> | null>(null);
  const [imported, setImported] = useState<ModelInfo[]>();
  const { busy, run } = useAction();

  if (thing.isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  if (thing.error || !thing.data) return <Alert>{(thing.error as Error)?.message ?? 'Nicht gefunden'}</Alert>;
  const t = thing.data;
  const importable = t.files.filter((f) => f.importable);
  // With several files, nothing is preselected: pick what you need.
  const sel = chosen ?? new Set(importable.length === 1 ? [importable[0]!.id] : []);
  const toggle = (fid: number) => setChosen(new Set(sel.has(fid) ? [...sel].filter((x) => x !== fid) : [...sel, fid]));

  /** Downloads the files into the library; `slice` continues straight to a new job. */
  const doImport = (fileIds: number[], slice: boolean, key: string) =>
    run(key, async () => {
      const models = await api<ModelInfo[]>(`/thingiverse/things/${id}/import`, { body: { fileIds } });
      await qc.invalidateQueries({ queryKey: ['models'] });
      if (slice) {
        navigate(`/jobs/new?models=${models.map((m) => m.id).join(',')}`);
        return;
      }
      setImported(models);
      toast(`${models.length} ${models.length === 1 ? 'Modell' : 'Modelle'} in die Bibliothek übernommen`);
    });

  return (
    <div className="space-y-4">
      {t.images.length > 0 && (
        <div className="space-y-2">
          <img src={t.images[image]} alt="" className="aspect-[4/3] w-full rounded-xl bg-surface-2 object-contain" />
          {t.images.length > 1 && (
            <div className="flex gap-2 overflow-x-auto">
              {t.images.map((src, i) => (
                <button key={src} onClick={() => setImage(i)} className={clsx('shrink-0 overflow-hidden rounded-lg border-2', i === image ? 'border-accent' : 'border-transparent')}>
                  <img src={src} alt="" className="size-16 bg-surface-2 object-cover" loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="space-y-1">
        <h3 className="text-lg font-semibold">{t.name}</h3>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-2">
          {t.creator && (
            <span>
              von{' '}
              {t.creatorUrl ? (
                <a href={t.creatorUrl} target="_blank" rel="noreferrer" className="underline">
                  {t.creator}
                </a>
              ) : (
                t.creator
              )}
            </span>
          )}
          <a href={t.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
            Auf Thingiverse <ExternalLink className="size-3.5" />
          </a>
        </div>
        {t.license && (
          <div className="pt-1">
            <Badge tone="info">{t.license}</Badge>
          </div>
        )}
      </div>

      {t.description && <p className="line-clamp-6 whitespace-pre-line text-sm text-text-2">{t.description}</p>}

      <div className="space-y-2">
        <div className="text-sm font-medium">Dateien</div>
        <ul className="divide-y divide-border rounded-xl border border-border">
          {t.files.map((f) => (
            <li key={f.id} className={clsx('flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2', !f.importable && 'opacity-50')}>
              <label className="flex min-w-0 flex-1 items-center gap-3">
                <input type="checkbox" disabled={!f.importable || !isAdmin} checked={f.importable && sel.has(f.id)} onChange={() => toggle(f.id)} className="accent-[var(--accent)]" />
                {f.thumbnail ? (
                  <img src={f.thumbnail} alt="" loading="lazy" className="size-12 shrink-0 rounded-md bg-surface-2 object-contain" />
                ) : (
                  <span className="flex size-12 shrink-0 items-center justify-center rounded-md bg-surface-2">
                    <Box className="size-5 text-text-3" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm" title={f.name}>
                    {f.name}
                  </span>
                  <span className="tabular block text-xs text-text-3">{f.importable ? formatBytes(f.size) : 'nicht unterstützt'}</span>
                </span>
              </label>
              {isAdmin && f.importable && (
                <div className="ml-auto flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    className="h-8 min-h-8 px-2 text-xs"
                    onClick={() => doImport([f.id], false, `lib-${f.id}`)}
                    loading={busy === `lib-${f.id}`}
                    disabled={!!busy}
                    title="In die Bibliothek übernehmen"
                  >
                    <Download className="size-3.5" /> Bibliothek
                  </Button>
                  <Button
                    variant="secondary"
                    className="h-8 min-h-8 px-2 text-xs"
                    onClick={() => doImport([f.id], true, `slice-${f.id}`)}
                    loading={busy === `slice-${f.id}`}
                    disabled={!!busy}
                    title="Übernehmen und direkt einen Auftrag anlegen"
                  >
                    <Cog className="size-3.5" /> Slicen
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {imported ? (
        <div className="space-y-3">
          <Alert tone="good">{imported.map((m) => m.name).join(', ')} in der Bibliothek.</Alert>
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => navigate(`/jobs/new?models=${imported.map((m) => m.id).join(',')}`)}>Auftrag anlegen</Button>
          </div>
        </div>
      ) : (
        isAdmin && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {importable.length > 1 && (
              <button
                type="button"
                className="mr-auto text-sm text-accent hover:underline"
                onClick={() => setChosen(sel.size === importable.length ? new Set() : new Set(importable.map((f) => f.id)))}
              >
                {sel.size === importable.length ? 'Auswahl aufheben' : 'Alle auswählen'}
              </button>
            )}
            <Button variant="secondary" onClick={() => doImport([...sel], false, 'import')} disabled={!sel.size || !!busy} loading={busy === 'import'}>
              <Download className="size-4" /> {sel.size > 1 ? `${sel.size} Dateien` : 'Auswahl'} in die Bibliothek
            </Button>
            <Button onClick={() => doImport([...sel], true, 'slice')} disabled={!sel.size || !!busy} loading={busy === 'slice'}>
              <Cog className="size-4" /> {sel.size > 1 ? `${sel.size} Dateien` : 'Auswahl'} slicen
            </Button>
          </div>
        )
      )}
    </div>
  );
}
