import { useState, type FormEvent } from 'react';
import { Flame } from 'lucide-react';
import clsx from 'clsx';
import type { HeaterInfo, HeaterState } from '@printhub/shared';
import { api } from '../../lib/api';
import { useAction } from '../../lib/feedback';
import { formatTemp } from '../../lib/format';
import { Button, Input } from '../ui';

const PRESETS: Record<string, { label: string; value: number }[]> = {
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

/** Temperature tile; admins can tap it to set a new target. */
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
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const { busy, run } = useAction();
  const heating = !!state?.target;
  const presets = (PRESETS[info.name] ?? PRESETS[info.name.startsWith('extruder') ? 'extruder' : ''] ?? []).filter(
    (p) => p.value <= info.maxTemp,
  );

  const set = async (target: number) => {
    const ok = await run('set', () => api(`/printers/${printerId}/temperature`, { body: { heater: info.name, target } }));
    if (ok) setOpen(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value.replace(',', '.'));
    if (Number.isFinite(n)) void set(n);
  };

  return (
    <div className={clsx('rounded-xl bg-surface-2', open && 'col-span-2 sm:col-span-4')}>
      <button
        type="button"
        disabled={!editable}
        onClick={() => {
          setValue(state?.target ? String(state.target) : '');
          setOpen((o) => !o);
        }}
        className="w-full rounded-xl px-3 py-2.5 text-left enabled:hover:ring-1 enabled:hover:ring-border disabled:cursor-default"
        aria-expanded={open}
      >
        <div className="flex items-center gap-1 truncate text-xs text-text-3">
          {heating && <Flame className="size-3 text-accent" aria-label="heizt" />}
          {info.label}
        </div>
        <div className="tabular text-lg font-semibold">{formatTemp(state?.temperature)}</div>
        <div className="tabular text-xs text-text-3">
          {heating ? `Ziel ${state!.target}°` : 'aus'}
          {heating && state?.power !== undefined && ` · ${Math.round(state.power * 100)} %`}
        </div>
      </button>

      {open && (
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-3">
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            max={info.maxTemp}
            step="1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`0–${info.maxTemp}`}
            className="tabular w-24"
            aria-label={`Zieltemperatur ${info.label}`}
            autoFocus
          />
          <Button type="submit" loading={busy === 'set'}>
            Setzen
          </Button>
          {presets.map((p) => (
            <Button key={p.label} type="button" variant="secondary" onClick={() => set(p.value)}>
              {p.label} {p.value}°
            </Button>
          ))}
          <Button type="button" variant="ghost" onClick={() => set(0)}>
            Aus
          </Button>
        </form>
      )}
    </div>
  );
}
