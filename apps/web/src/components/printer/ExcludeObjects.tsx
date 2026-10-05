import { Ban } from 'lucide-react';
import clsx from 'clsx';
import type { PrinterSummary } from '@printhub/shared';
import { api } from '../../lib/api';
import { confirm, useAction } from '../../lib/feedback';
import { Button } from '../ui';

/** Lets the user skip a failed object in a multi-object print. */
export function ExcludeObjects({ printer, editable }: { printer: PrinterSummary; editable: boolean }) {
  const ex = printer.status.excludeObject;
  const { busy, run } = useAction();
  if (!ex || ex.objects.length < 2) return null;

  const exclude = async (name: string) => {
    if (
      await confirm({
        title: 'Objekt ausschließen?',
        body: `„${name}“ wird für den Rest des Drucks übersprungen.`,
        confirmLabel: 'Ausschließen',
        danger: true,
      })
    )
      void run(name, () => api(`/printers/${printer.id}/exclude-object`, { body: { name } }), `${name} ausgeschlossen`);
  };

  return (
    <div className="space-y-2">
      <div className="text-xs text-text-3">Objekte ({ex.objects.length})</div>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {ex.objects.map((o) => {
          const excluded = ex.excluded.includes(o.name);
          return (
            <li key={o.name} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className={clsx('min-w-0 flex-1 truncate', excluded && 'text-text-3 line-through')} title={o.name}>
                {o.name}
              </span>
              {ex.current === o.name && !excluded && <span className="text-xs text-info">druckt</span>}
              {editable && !excluded && (
                <Button variant="ghost" className="min-h-8 px-2" onClick={() => exclude(o.name)} loading={busy === o.name} aria-label={`${o.name} ausschließen`}>
                  <Ban className="size-4" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
