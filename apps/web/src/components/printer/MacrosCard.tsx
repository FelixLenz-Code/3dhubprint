import type { PrinterSummary } from '@printhub/shared';
import { api } from '../../lib/api';
import { confirm, useAction } from '../../lib/feedback';
import { isActivePrint } from '../../lib/format';
import { Button, Card } from '../ui';

export function MacrosCard({ printer }: { printer: PrinterSummary }) {
  const { busy, run } = useAction();
  const macros = printer.capabilities?.macros ?? [];
  if (!macros.length) return null;
  const printing = isActivePrint(printer.status);

  const runMacro = async (name: string) => {
    const ok = await confirm({
      title: `Makro ${name} ausführen?`,
      body: printing ? 'Achtung: Es läuft gerade ein Druck.' : undefined,
      confirmLabel: 'Ausführen',
    });
    if (ok) void run(name, () => api(`/printers/${printer.id}/macro`, { body: { name } }), `${name} gestartet`);
  };

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="mb-4 font-semibold">Makros</h2>
      <div className="flex flex-wrap gap-2">
        {macros.map((m) => (
          <Button
            key={m}
            variant="secondary"
            onClick={() => runMacro(m)}
            loading={busy === m}
            disabled={printer.status.connection !== 'connected'}
            className="font-mono text-xs"
          >
            {m}
          </Button>
        ))}
      </div>
    </Card>
  );
}
