import { useEffect, useState, type FormEvent } from 'react';
import { Flame, Minus, Plus, Power } from 'lucide-react';
import clsx from 'clsx';
import type { HeaterInfo, HeaterState } from '@printhub/shared';
import { api } from '../../lib/api';
import { useAction } from '../../lib/feedback';
import { formatTemp } from '../../lib/format';
import { Button, Input } from '../ui';

const PRESETS: Record<'extruder' | 'heater_bed', { label: string; value: number }[]> = {
  extruder: [
    { label: 'PLA', value: 210 },
    { label: 'PETG', value: 240 },
    { label: 'ABS', value: 250 },
  ],
  heater_bed: [
    { label: 'PLA', value: 60 },
    { label: 'PETG', value: 80 },
    { label: 'ABS', value: 100 },
  ],
};

/**
 * One heater: current temperature and, for admins, a visible target input with ±5 steps,
 * material presets and an off button.
 */
export function HeaterControl({
  printerId,
  info,
  state,
  editable,
}: {
  printerId: number;
  info: HeaterInfo;
  state?: HeaterState;
  editable: boolean;
}) {
  const target = state?.target ?? 0;
  const [value, setValue] = useState(target ? String(target) : '');
  const [dirty, setDirty] = useState(false);
  const { busy, run } = useAction();
  const heating = target > 0;
  const presets = (PRESETS[info.name as keyof typeof PRESETS] ?? (info.name.startsWith('extruder') ? PRESETS.extruder : [])).filter(
    (p) => p.value <= info.maxTemp,
  );

  // Follow the printer while the user isn't typing.
  useEffect(() => {
    if (!dirty) setValue(target ? String(target) : '');
  }, [target, dirty]);

  const set = async (t: number) => {
    const clamped = t <= 0 ? 0 : Math.min(info.maxTemp, Math.max(info.minTemp, Math.round(t)));
    const ok = await run('set', () => api(`/printers/${printerId}/temperature`, { body: { heater: info.name, target: clamped } }));
    if (ok) {
      setDirty(false);
      setValue(clamped ? String(clamped) : '');
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value.replace(',', '.'));
    if (value.trim() === '' || !Number.isFinite(n)) return;
    void set(n);
  };

  return (
    <div className="rounded-xl bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-24">
          <div className="flex items-center gap-1 text-xs text-text-3">
            {heating && <Flame className="size-3 text-accent" aria-label="heizt" />}
            {info.label}
          </div>
          <div className="tabular text-xl font-semibold leading-tight">{formatTemp(state?.temperature)}</div>
          <div className="tabular text-xs text-text-3">
            {heating ? `Ziel ${target}°` : 'aus'}
            {heating && state?.power !== undefined && ` · ${Math.round(state.power * 100)} %`}
          </div>
        </div>

        {editable && (
          <form onSubmit={submit} className="flex flex-1 flex-wrap items-center gap-1.5">
            <Button type="button" variant="secondary" className="size-10 px-0" onClick={() => set(Math.max(target, info.minTemp) - 5)} disabled={!heating} aria-label={`${info.label} 5 Grad kälter`}>
              <Minus className="size-4" />
            </Button>
            <label className="relative">
              <span className="sr-only">Zieltemperatur {info.label}</span>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={info.maxTemp}
                value={value}
                placeholder="Ziel"
                onChange={(e) => {
                  setValue(e.target.value);
                  setDirty(true);
                }}
                onBlur={() => !value && setDirty(false)}
                className="tabular w-24 bg-surface pr-7"
              />
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-text-3">°C</span>
            </label>
            <Button type="button" variant="secondary" className="size-10 px-0" onClick={() => set((heating ? target : info.minTemp) + 5)} aria-label={`${info.label} 5 Grad wärmer`}>
              <Plus className="size-4" />
            </Button>
            {dirty && (
              <Button type="submit" loading={busy === 'set'}>
                Setzen
              </Button>
            )}
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => set(p.value)}
                  className={clsx(
                    'min-h-10 rounded-lg border px-2.5 text-xs font-medium',
                    target === p.value ? 'border-accent bg-accent/10 text-text' : 'border-border bg-surface text-text-2 hover:border-text-3',
                  )}
                >
                  {p.label} {p.value}°
                </button>
              ))}
              <button
                type="button"
                onClick={() => set(0)}
                disabled={!heating}
                className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-text-2 hover:border-text-3 disabled:opacity-40"
              >
                <Power className="size-3.5" /> Aus
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
