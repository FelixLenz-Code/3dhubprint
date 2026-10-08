import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { STATS_RANGES, type PrintRecord, type PrintRecordPage, type PrintStats, type StatsGroup, type StatsRange } from '@printhub/shared';
import { api } from '../lib/api';
import { useIsAdmin } from '../lib/auth';
import { useAction } from '../lib/feedback';
import { useLive } from '../lib/live';
import { fileLabel, formatDuration, type Tone } from '../lib/format';
import { formatHours, formatMoney, formatWeight } from '../lib/stats';
import { Badge, Button, Card, Segmented, Spinner, Tile } from '../components/ui';
import { ColumnChart, type Column } from '../components/stats/ColumnChart';

const METRICS = {
  filamentG: { label: 'Filament', format: formatWeight, integer: false },
  prints: { label: 'Drucke', format: (v: number) => v.toLocaleString('de-DE'), integer: true },
  printTime: { label: 'Druckzeit', format: formatHours, integer: false },
  cost: { label: 'Kosten', format: formatMoney, integer: false },
} as const;
type Metric = keyof typeof METRICS;

const OUTCOME: Record<PrintRecord['outcome'], { label: string; tone: Tone }> = {
  completed: { label: 'Fertig', tone: 'good' },
  cancelled: { label: 'Abgebrochen', tone: 'warning' },
  failed: { label: 'Fehlgeschlagen', tone: 'critical' },
  in_progress: { label: 'Läuft', tone: 'info' },
};

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PAGE = 30;

export function StatsPage() {
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const printers = useLive((s) => s.printers);
  const [range, setRange] = useState<StatsRange>('30d');
  const [printerId, setPrinterId] = useState<number | undefined>();
  const [metric, setMetric] = useState<Metric>('filamentG');
  const { busy, run } = useAction();
  const filter = printerId ? `&printerId=${printerId}` : '';

  const stats = useQuery({
    queryKey: ['stats', range, printerId],
    queryFn: () => api<PrintStats>(`/stats?range=${range}&tz=${encodeURIComponent(TZ)}${filter}`),
    placeholderData: (prev) => prev,
  });

  const sync = () =>
    run('sync', async () => {
      await api('/stats/sync', { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['stats'] });
      await qc.invalidateQueries({ queryKey: ['prints'] });
    });

  const s = stats.data;
  const m = METRICS[metric];
  const columns = useMemo<Column[]>(
    () =>
      (s?.buckets ?? []).map((b) => ({
        key: String(b.start),
        label: bucketLabel(b.start, s!.bucket, s!.range),
        title: bucketTitle(b.start, s!.bucket),
        value: b[metric],
        detail: metric === 'prints' ? (b.prints ? `${b.completed} fertig` : undefined) : `${b.prints} ${b.prints === 1 ? 'Druck' : 'Drucke'}`,
      })),
    [s, metric],
  );

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-2xl font-semibold">Statistik</h1>
        <span className="text-xs text-text-3">{s?.lastSync ? `Stand ${new Date(s.lastSync).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}` : ''}</span>
        {isAdmin && (
          <Button variant="ghost" className="ml-auto" onClick={sync} loading={busy === 'sync'} title="Verlauf aller Drucker neu einlesen">
            <RefreshCw className="size-4" /> <span className="hidden sm:inline">Aktualisieren</span>
          </Button>
        )}
      </header>

      {/* Filters scope everything below. */}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={range} onChange={setRange} options={STATS_RANGES} label="Zeitraum" />
        {printers.length > 1 && (
          <select
            value={printerId ?? ''}
            onChange={(e) => setPrinterId(e.target.value ? Number(e.target.value) : undefined)}
            aria-label="Drucker"
            className="min-h-9 rounded-lg border border-border bg-surface px-3 text-sm text-text"
          >
            <option value="">Alle Drucker</option>
            {printers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {!s ? (
        <div className="flex justify-center py-16">{stats.error ? <p className="text-sm text-critical">{(stats.error as Error).message}</p> : <Spinner />}</div>
      ) : (
        <div className={clsx('space-y-5 transition-opacity', stats.isPlaceholderData && 'opacity-60')}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Drucke" value={s.totals.prints.toLocaleString('de-DE')} sub={s.totals.prints ? `${Math.round((s.totals.completed / s.totals.prints) * 100)} % erfolgreich` : 'keine im Zeitraum'} />
            <Tile label="Druckzeit" value={formatHours(s.totals.printTime)} sub={s.totals.prints ? `Ø ${formatDuration(s.totals.printTime / s.totals.prints)}` : undefined} />
            <Tile label="Filament" value={formatWeight(s.totals.filamentG)} sub={`${(s.totals.filamentMm / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} m`} />
            <Tile
              label="Kosten"
              value={formatMoney(s.totals.cost.total)}
              sub={`Material ${formatMoney(s.totals.cost.material)} · Strom ${formatMoney(s.totals.cost.energy)}${s.totals.cost.wear ? ` · Verschleiß ${formatMoney(s.totals.cost.wear)}` : ''}`}
            />
          </div>

          {s.totals.prints > 0 && (s.totals.failed > 0 || s.totals.cancelled > 0 || s.totals.defaultPriced > 0) && (
            <p className="text-xs text-text-3">
              {[
                s.totals.failed > 0 && `${s.totals.failed} fehlgeschlagen`,
                s.totals.cancelled > 0 && `${s.totals.cancelled} abgebrochen`,
                s.totals.defaultPriced > 0 && `${s.totals.defaultPriced} ${s.totals.defaultPriced === 1 ? 'Druck' : 'Drucke'} mit dem Standard-Filamentpreis bewertet (kein Preis in Spule oder Filamentprofil)`,
              ]
                .filter(Boolean)
                .join(' · ')}
              {isAdmin && s.totals.defaultPriced > 0 && (
                <>
                  {' · '}
                  <Link to="/settings/costs" className="text-accent hover:underline">
                    Preise einstellen
                  </Link>
                </>
              )}
            </p>
          )}

          <Card className="space-y-3 p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="mr-auto font-semibold">
                {m.label} je {s.bucket === 'day' ? 'Tag' : s.bucket === 'week' ? 'Woche' : 'Monat'}
              </h2>
              <Segmented value={metric} onChange={setMetric} options={Object.fromEntries(Object.entries(METRICS).map(([k, v]) => [k, v.label])) as Record<Metric, string>} label="Kennzahl" />
            </div>
            <ColumnChart columns={columns} format={m.format} title={m.label} integer={m.integer} />
          </Card>

          <div className="grid gap-5 md:grid-cols-2">
            <Ranking title="Nach Drucker" groups={s.byPrinter} metric={metric} />
            <Ranking title="Nach Material" groups={s.byMaterial} metric={metric} />
          </div>
        </div>
      )}

      <RecentPrints printerId={printerId} />
    </div>
  );
}

/** Ranked bars (one hue) for the selected metric. */
function Ranking({ title, groups, metric }: { title: string; groups: StatsGroup[]; metric: Metric }) {
  const m = METRICS[metric];
  const sorted = [...groups].sort((a, b) => b[metric] - a[metric]);
  const max = Math.max(0, ...sorted.map((g) => g[metric]));
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="mb-3 font-semibold">{title}</h2>
      {sorted.length === 0 ? (
        <p className="text-sm text-text-3">Keine Drucke im Zeitraum.</p>
      ) : (
        <ul className="space-y-3">
          {sorted.map((g) => (
            <li key={g.key} title={`${g.label}: ${m.format(g[metric])}`}>
              <div className="flex items-baseline gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{g.label}</span>
                <span className="tabular font-medium">{m.format(g[metric])}</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-r bg-transparent">
                <div className="h-full rounded-r" style={{ width: `${max ? (g[metric] / max) * 100 : 0}%`, minWidth: g[metric] > 0 ? 2 : 0, background: 'var(--series-1)' }} />
              </div>
              <div className="tabular mt-0.5 text-xs text-text-3">
                {g.prints} {g.prints === 1 ? 'Druck' : 'Drucke'} · {Math.round((g.completed / g.prints) * 100)} % erfolgreich
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecentPrints({ printerId }: { printerId?: number }) {
  const list = useInfiniteQuery({
    queryKey: ['prints', printerId],
    queryFn: ({ pageParam }) => api<PrintRecordPage>(`/stats/prints?offset=${pageParam}&limit=${PAGE}${printerId ? `&printerId=${printerId}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.prints.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const prints = list.data?.pages.flatMap((p) => p.prints) ?? [];

  return (
    <Card className="overflow-hidden">
      <h2 className="px-4 pb-2 pt-4 font-semibold sm:px-5">Alle Drucke</h2>
      {list.isLoading ? (
        <div className="p-5">
          <Spinner />
        </div>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {prints.map((p) => (
            <PrintRow key={p.id} print={p} />
          ))}
          {!prints.length && <li className="p-5 text-sm text-text-3">Noch keine Drucke erfasst. PrintHub liest den Verlauf der Drucker automatisch ein, sobald sie verbunden sind.</li>}
        </ul>
      )}
      {list.hasNextPage && (
        <div className="flex justify-center border-t border-border p-3">
          <Button variant="secondary" onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>
            Mehr laden
          </Button>
        </div>
      )}
    </Card>
  );
}

function PrintRow({ print: p }: { print: PrintRecord }) {
  const o = OUTCOME[p.outcome];
  const costTitle = `Material ${formatMoney(p.cost.material)}${p.priceSource === 'default' ? ' (Standardpreis)' : p.priceSource === 'spool' ? ' (Spulenpreis)' : ' (Filamentprofil)'} · Strom ${formatMoney(p.cost.energy)} · Verschleiß ${formatMoney(p.cost.wear)}`;
  return (
    <li className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
      <span className="size-3 shrink-0 rounded-full border border-border" style={{ background: p.color ?? 'transparent' }} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium" title={p.filename}>
            {fileLabel(p.filename)}
          </span>
          <Badge tone={o.tone}>{o.label}</Badge>
        </div>
        <div className="tabular truncate text-xs text-text-3">
          {[
            new Date(p.startTime).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }),
            p.printerName,
            formatDuration(p.printDuration),
            formatWeight(p.filamentG),
            p.material,
            p.spool?.name,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      <span className="tabular shrink-0 text-sm" title={costTitle}>
        {formatMoney(p.cost.total)}
      </span>
    </li>
  );
}

function bucketLabel(ms: number, bucket: PrintStats['bucket'], range: StatsRange): string {
  const d = new Date(ms);
  if (bucket === 'month') return d.toLocaleDateString('de-DE', range === 'all' ? { month: 'short', year: '2-digit' } : { month: 'short' });
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });
}

function bucketTitle(ms: number, bucket: PrintStats['bucket']): string {
  const d = new Date(ms);
  if (bucket === 'month') return d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  if (bucket === 'week') return `Woche ab ${d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
}
