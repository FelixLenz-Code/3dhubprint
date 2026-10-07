import { Link } from 'react-router-dom';
import { Plus, Printer } from 'lucide-react';
import { useLive } from '../lib/live';
import { PrinterCard } from '../components/PrinterCard';
import { Button, Card, Spinner } from '../components/ui';
import { isActivePrint } from '../lib/format';

const MAX_LIVE_CAMS = 3;

export function DashboardPage() {
  const printers = useLive((s) => s.printers);
  const connection = useLive((s) => s.connection);
  // Live video for a few cameras. Each stream holds one of the browser's ~6 HTTP/1.1 connections
  // per host, so with more cameras refreshing stills keep the app responsive.
  const liveCams = printers.filter((p) => p.webcams.length > 0 && p.status.connection === 'connected').length <= MAX_LIVE_CAMS;
  const printing = printers.filter((p) => isActivePrint(p.status)).length;
  const online = printers.filter((p) => p.status.connection === 'connected').length;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Drucker</h1>
          {printers.length > 0 && (
            <p className="tabular text-sm text-text-2">
              {online} von {printers.length} online · {printing} {printing === 1 ? 'Druck' : 'Drucke'} aktiv
            </p>
          )}
        </div>
      </header>

      {connection === 'connecting' && printers.length === 0 ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : printers.length === 0 ? (
        <Card className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <Printer className="size-10 text-text-3" />
          <div>
            <h2 className="font-semibold">Noch keine Drucker</h2>
            <p className="text-sm text-text-2">Füge deinen ersten Klipper/Moonraker-Drucker hinzu.</p>
          </div>
          <Link to="/settings/printers">
            <Button>
              <Plus className="size-4" /> Drucker hinzufügen
            </Button>
          </Link>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {printers.map((p) => (
            <PrinterCard key={p.id} printer={p} camMode={liveCams ? 'stream' : 'snapshot'} />
          ))}
        </div>
      )}
    </div>
  );
}
