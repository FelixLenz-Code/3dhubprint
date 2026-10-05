import { Check } from 'lucide-react';
import clsx from 'clsx';
import type { SlicerProfileInfo } from '@printhub/shared';
import { Field } from '../ui';

export function ProfileSelect({
  label,
  profiles,
  value,
  onChange,
  describe,
}: {
  label: string;
  profiles: SlicerProfileInfo[];
  value: string;
  onChange: (v: string) => void;
  describe: (p: SlicerProfileInfo) => string;
}) {
  return (
    <Field label={label}>
      <div className="space-y-1.5">
        {profiles.length === 0 && <p className="text-sm text-text-3">Keine passenden Profile.</p>}
        {profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.name)}
            className={clsx(
              'flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left',
              value === p.name ? 'border-accent bg-accent/5' : 'border-border hover:border-text-3',
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="break-words text-sm font-medium">{p.name}</div>
              <div className="text-xs text-text-3">{describe(p)}</div>
            </div>
            {value === p.name && <Check className="size-4 shrink-0 text-accent" />}
          </button>
        ))}
      </div>
    </Field>
  );
}

export function describeProcess(p: SlicerProfileInfo) {
  const s = p.summary;
  return [s.layerHeight && `${s.layerHeight} mm`, s.walls && `${s.walls} Wände`, s.infill && `${s.infill} Infill`, s.support && 'Stützen', s.vase && 'Vase']
    .filter(Boolean)
    .join(' · ');
}

export function describeFilament(p: SlicerProfileInfo) {
  const s = p.summary;
  return [s.material, s.nozzleTemp && `${s.nozzleTemp} °C`, s.bedTemp && `Bett ${s.bedTemp} °C`, s.flow && `Flow ${s.flow}`].filter(Boolean).join(' · ');
}
