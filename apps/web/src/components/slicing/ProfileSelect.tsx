import { Check } from 'lucide-react';
import clsx from 'clsx';
import { BED_TYPES, type BedType, type SlicerProfileInfo } from '@printhub/shared';
import { plateTemp } from '../../lib/profiles';
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

export function describeFilament(p: SlicerProfileInfo, bedType?: BedType) {
  const s = p.summary;
  const bed = bedType ? plateTemp(p, bedType) ?? s.bedTemp : s.bedTemp;
  const bedText = bed === 0 ? 'nicht für diese Platte' : bed && `Bett ${bed} °C`;
  return [s.material, s.nozzleTemp && `${s.nozzleTemp} °C`, bedText, s.flow && `Flow ${s.flow}`].filter(Boolean).join(' · ');
}

/** Plate choice (OrcaSlicer's bed type); decides which bed temperature the filament uses. */
export function BedTypeSelect({ value, onChange, label = 'Druckplatte', className }: { value: BedType; onChange: (v: BedType) => void; label?: string; className?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as BedType)}
      aria-label={label}
      className={clsx('min-h-10 w-full min-w-0 rounded-lg border border-border bg-surface px-3 text-sm text-text', className)}
    >
      {(Object.keys(BED_TYPES) as BedType[]).map((b) => (
        <option key={b} value={b}>
          {BED_TYPES[b].label}
        </option>
      ))}
    </select>
  );
}
