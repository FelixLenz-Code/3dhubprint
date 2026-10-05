import { useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronsDown, ChevronsUp, Home } from 'lucide-react';
import clsx from 'clsx';
import type { PrinterSummary } from '@printhub/shared';
import { api } from '../../lib/api';
import { useAction } from '../../lib/feedback';
import { isActivePrint } from '../../lib/format';
import { Button, Card, Stat } from '../ui';

const STEPS = [0.1, 1, 10, 50];

export function MotionCard({ printer, editable }: { printer: PrinterSummary; editable: boolean }) {
  const s = printer.status;
  const [step, setStep] = useState(10);
  const { busy, run } = useAction();
  const printing = isActivePrint(s);
  const homed = s.homedAxes ?? '';
  const canMove = editable && !printing && s.connection === 'connected';

  const home = (axes: ('x' | 'y' | 'z')[]) =>
    run(`home-${axes.join('')}`, () => api(`/printers/${printer.id}/home`, { body: { axes } }));
  const move = (axis: 'x' | 'y' | 'z', dir: 1 | -1) =>
    run(`move-${axis}${dir}`, () => api(`/printers/${printer.id}/move`, { body: { axis, distance: dir * (axis === 'z' ? Math.min(step, 10) : step) } }));

  // Plain render helper (not a component) so buttons keep their identity and focus across renders.
  const jog = (axis: 'x' | 'y' | 'z', dir: 1 | -1, Icon: typeof ArrowUp, label: string) => (
    <Button
      key={`${axis}${dir}`}
      variant="secondary"
      className="size-12 px-0"
      disabled={!canMove || !homed.includes(axis)}
      loading={busy === `move-${axis}${dir}`}
      onClick={() => move(axis, dir)}
      aria-label={label}
      title={!homed.includes(axis) ? `${axis.toUpperCase()} zuerst referenzieren` : label}
    >
      <Icon className="size-5" />
    </Button>
  );

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="mb-4 font-semibold">Bewegen</h2>
      <div className="mb-4 grid grid-cols-3 gap-4">
        <Stat label="Position X / Y / Z" value={s.position ? s.position.slice(0, 3).map((v) => v.toFixed(1)).join(' / ') : '–'} />
        <Stat label="Referenziert" value={homed ? homed.toUpperCase() : 'nein'} />
        <Stat label="Bauraum" value={s.axisMaximum ? s.axisMaximum.slice(0, 3).map((v) => Math.round(v)).join('×') : '–'} />
      </div>

      {editable && (
        <>
          {printing && <p className="mb-3 text-xs text-text-3">Während eines Drucks gesperrt.</p>}
          <div className="flex flex-wrap items-start gap-6">
            {/* XY pad */}
            <div className="grid grid-cols-3 gap-1.5">
              <span />
              {jog('y', 1, ArrowUp, 'Y+')}
              <span />
              {jog('x', -1, ArrowLeft, 'X−')}
              <Button
                variant="secondary"
                className="size-12 px-0"
                disabled={!canMove}
                loading={busy === 'home-'}
                onClick={() => home([])}
                aria-label="Alle Achsen referenzieren"
                title="Alle Achsen referenzieren (G28)"
              >
                <Home className="size-5" />
              </Button>
              {jog('x', 1, ArrowRight, 'X+')}
              <span />
              {jog('y', -1, ArrowDown, 'Y−')}
              <span />
            </div>
            {/* Z */}
            <div className="grid gap-1.5">
              {jog('z', 1, ChevronsUp, 'Z+ (nach oben)')}
              <div className="flex h-12 items-center justify-center text-xs font-medium text-text-3">Z</div>
              {jog('z', -1, ChevronsDown, 'Z− (nach unten)')}
            </div>
            <div className="space-y-3">
              <div>
                <div className="mb-1.5 text-xs text-text-3">Schrittweite (mm)</div>
                <div className="flex overflow-hidden rounded-lg border border-border" role="radiogroup" aria-label="Schrittweite">
                  {STEPS.map((v) => (
                    <button
                      key={v}
                      role="radio"
                      aria-checked={step === v}
                      onClick={() => setStep(v)}
                      className={clsx(
                        'tabular min-h-10 px-3 text-sm',
                        step === v ? 'bg-accent text-accent-ink' : 'text-text-2 hover:bg-surface-2',
                      )}
                    >
                      {v}
                    </button>
                  ))}
                </div>
                {step > 10 && <div className="mt-1 text-xs text-text-3">Z bewegt sich max. 10 mm pro Schritt.</div>}
              </div>
              <div className="flex gap-1.5">
                {(['x', 'y', 'z'] as const).map((a) => (
                  <Button key={a} variant="secondary" disabled={!canMove} loading={busy === `home-${a}`} onClick={() => home([a])}>
                    <Home className="size-3.5" /> {a.toUpperCase()}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
