import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { spoolLabel, type PrinterSpool, type PrinterSummary, type SpoolInfo } from '@printhub/shared';
import { api } from '../../lib/api';
import { useAction } from '../../lib/feedback';
import { isActivePrint } from '../../lib/format';
import { formatMoney, formatWeight, usePrinterSpool, useSpoolmanStatus } from '../../lib/stats';
import { Alert, Button, Card, Spinner } from '../ui';
import { CreateSpoolDialog } from '../spools/CreateSpoolDialog';

/** Active Spoolman spool of a printer; only shown when Spoolman is set up. */
export function SpoolCard({ printer, editable }: { printer: PrinterSummary; editable: boolean }) {
  const qc = useQueryClient();
  const status = useSpoolmanStatus();
  const configured = !!status.data?.configured;
  const current = usePrinterSpool(printer.id, configured);
  const spools = useQuery({ queryKey: ['spools'], queryFn: () => api<SpoolInfo[]>('/spoolman/spools'), enabled: configured && editable });
  const { busy, run } = useAction();
  const [creating, setCreating] = useState(false);

  if (!configured) return null;
  const spool = current.data?.spool ?? null;
  const s = printer.status;
  // Filament still needed by the running print, from the slicer's total weight.
  const needed = isActivePrint(s) && s.file?.filamentWeightTotal ? s.file.filamentWeightTotal * (1 - (s.progress ?? 0)) : undefined;

  const choose = (value: string) =>
    run('set', async () => {
      const next = await api<PrinterSpool>(`/printers/${printer.id}/spool`, { method: 'PUT', body: { spoolId: value ? Number(value) : null } });
      qc.setQueryData(['printer-spool', printer.id], next);
    });

  return (
    <Card className="space-y-3 p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">Filamentspule</h2>
        {(current.isFetching || busy) && <Spinner className="size-4" />}
        {editable && (
          <Button variant="ghost" className="ml-auto min-h-8 px-2 text-xs" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" /> Neue Spule
          </Button>
        )}
      </div>
      {current.error ? (
        <p className="text-sm text-critical">{(current.error as Error).message}</p>
      ) : spool ? (
        <div className="flex items-center gap-3">
          <span className="size-10 shrink-0 rounded-full border border-border" style={{ background: spool.color ?? 'var(--surface-2)' }} aria-hidden />
          <div className="min-w-0">
            <div className="truncate font-medium">{spoolLabel(spool)}</div>
            <div className="tabular text-sm text-text-2">
              {formatWeight(spool.remainingG)} übrig
              {spool.pricePerKg !== null && <span className="text-text-3"> · {formatMoney(spool.pricePerKg)}/kg</span>}
            </div>
          </div>
        </div>
      ) : (
        current.data && <p className="text-sm text-text-3">Keine Spule ausgewählt.</p>
      )}
      {spool && needed !== undefined && spool.remainingG !== null && spool.remainingG < needed && (
        <Alert tone="warning">Der laufende Druck braucht noch etwa {formatWeight(needed)}, auf der Spule sind nur {formatWeight(spool.remainingG)}.</Alert>
      )}
      {editable && (
        <select
          value={spool?.id ?? ''}
          onChange={(e) => void choose(e.target.value)}
          disabled={!!busy || !spools.data}
          aria-label="Aktive Spule"
          className="min-h-10 w-full min-w-0 rounded-lg border border-border bg-surface px-3 text-sm text-text"
        >
          <option value="">Keine Spule</option>
          {spools.data
            ?.filter((x) => !x.archived)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {spoolLabel(x)}
                {x.material ? ` (${x.material})` : ''} · {formatWeight(x.remainingG)}
              </option>
            ))}
        </select>
      )}
      {editable && <CreateSpoolDialog open={creating} onClose={() => setCreating(false)} printerId={printer.id} />}
      {current.data && (
        <p className="text-xs text-text-3">
          {current.data.tracking === 'moonraker' ? 'Moonraker bucht den Verbrauch in Spoolman.' : 'PrintHub bucht den Verbrauch nach jedem Druck in Spoolman.'}
        </p>
      )}
    </Card>
  );
}
