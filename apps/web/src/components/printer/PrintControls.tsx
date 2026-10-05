import { OctagonX, Pause, Play, RotateCcw, Square } from 'lucide-react';
import type { PrinterAction, PrinterSummary } from '@printhub/shared';
import { api } from '../../lib/api';
import { confirm, useAction } from '../../lib/feedback';
import { fileLabel } from '../../lib/format';
import { Button } from '../ui';

/** Print job buttons and the always-available emergency stop. */
export function PrintControls({ printer }: { printer: PrinterSummary }) {
  const { busy, run } = useAction();
  const s = printer.status;
  const act = (action: PrinterAction, success?: string) =>
    run(action, () => api(`/printers/${printer.id}/action`, { body: { action } }), success);

  const cancel = async () => {
    if (
      await confirm({
        title: 'Druck abbrechen?',
        body: `„${fileLabel(s.filename)}“ wird abgebrochen. Das lässt sich nicht rückgängig machen.`,
        confirmLabel: 'Druck abbrechen',
        danger: true,
      })
    )
      void act('cancel', 'Druck abgebrochen');
  };

  const estop = async () => {
    if (
      await confirm({
        title: 'Not-Aus auslösen?',
        body: 'Klipper stoppt sofort alle Motoren und Heizungen. Danach ist ein Firmware-Neustart nötig.',
        confirmLabel: 'Not-Aus',
        danger: true,
      })
    )
      void act('emergency_stop', 'Not-Aus ausgelöst');
  };

  const restart = async (action: 'firmware_restart' | 'restart') => {
    if (
      await confirm({
        title: action === 'firmware_restart' ? 'Firmware neu starten?' : 'Klipper neu starten?',
        body: 'Ein laufender Druck würde dabei abgebrochen.',
        confirmLabel: 'Neu starten',
      })
    )
      void act(action, 'Neustart ausgelöst');
  };

  const connected = s.connection === 'connected';
  const reachable = connected || s.connection === 'klippy_not_ready';

  return (
    <div className="flex flex-wrap items-center gap-2">
      {connected && s.printState === 'printing' && (
        <Button variant="secondary" onClick={() => act('pause', 'Druck pausiert')} loading={busy === 'pause'}>
          <Pause className="size-4" /> Pause
        </Button>
      )}
      {connected && s.printState === 'paused' && (
        <Button onClick={() => act('resume', 'Druck fortgesetzt')} loading={busy === 'resume'}>
          <Play className="size-4" /> Fortsetzen
        </Button>
      )}
      {connected && (s.printState === 'printing' || s.printState === 'paused') && (
        <Button variant="secondary" onClick={cancel} loading={busy === 'cancel'}>
          <Square className="size-4" /> Abbrechen
        </Button>
      )}
      {s.connection === 'klippy_not_ready' && (
        <>
          <Button variant="secondary" onClick={() => restart('firmware_restart')} loading={busy === 'firmware_restart'}>
            <RotateCcw className="size-4" /> Firmware-Neustart
          </Button>
          <Button variant="ghost" onClick={() => restart('restart')} loading={busy === 'restart'}>
            Klipper-Neustart
          </Button>
        </>
      )}
      {reachable && (
        <Button variant="danger" onClick={estop} loading={busy === 'emergency_stop'} title="Not-Aus">
          <OctagonX className="size-4" /> <span className="hidden sm:inline">Not-Aus</span>
        </Button>
      )}
    </div>
  );
}
