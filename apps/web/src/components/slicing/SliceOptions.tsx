import { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import type { SliceOverrides, SlicerProfileInfo } from '@printhub/shared';
import { Alert, Input } from '../ui';

type Tab = 'support' | 'adhesion' | 'vase';

const BRIM_LABEL = { none: 'Kein Brim', outer: 'Nur außen', auto: 'Automatisch', ears: 'Mouse Ears' } as const;

/**
 * Per-job overrides on top of the chosen process profile. Each section starts at
 * "wie Profil" (no override) and shows the profile's value for orientation.
 */
export function SliceOptions({
  value,
  onChange,
  process,
  objectCount,
}: {
  value: SliceOverrides;
  onChange: (v: SliceOverrides) => void;
  process?: SlicerProfileInfo;
  objectCount: number;
}) {
  const [tab, setTab] = useState<Tab>('support');
  const p = process?.summary ?? {};
  const set = (patch: Partial<SliceOverrides>) => {
    const next = { ...value, ...patch };
    for (const k of Object.keys(next) as (keyof SliceOverrides)[]) if (next[k] === undefined) delete next[k];
    onChange(next);
  };
  const changed = { support: !!value.support, adhesion: !!value.brim || !!value.skirt, vase: !!value.vase };

  return (
    <div className="rounded-xl border border-border">
      <div className="flex overflow-x-auto overflow-y-hidden border-b border-border" role="tablist">
        {(
          [
            ['support', 'Stützen'],
            ['adhesion', 'Brim & Skirt'],
            ['vase', 'Vasenmodus'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={clsx(
              '-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium',
              tab === id ? 'border-accent text-text' : 'border-transparent text-text-2 hover:text-text',
            )}
          >
            {label}
            {changed[id] && <span className="size-1.5 rounded-full bg-accent" aria-label="geändert" />}
          </button>
        ))}
      </div>

      <div className="space-y-4 p-4">
        {tab === 'support' && (
          <>
            <Choice
              label="Stützen"
              profileHint={p.support ? `an (${p.supportType === 'tree' ? 'Baum' : 'Normal'})` : 'aus'}
              value={value.support ? (value.support.enabled ? 'on' : 'off') : 'profile'}
              options={[
                ['profile', 'Wie Profil'],
                ['off', 'Keine'],
                ['on', 'Stützen erzeugen'],
              ]}
              onChange={(v) =>
                set({
                  support:
                    v === 'profile'
                      ? undefined
                      : {
                          enabled: v === 'on',
                          type: value.support?.type ?? (p.supportType === 'normal' ? 'normal' : 'tree'),
                          buildPlateOnly: value.support?.buildPlateOnly ?? !!p.supportBuildPlateOnly,
                          angle: value.support?.angle,
                        },
                })
              }
            />
            {value.support?.enabled && (
              <div className="grid gap-4 sm:grid-cols-3">
                <Labeled label="Art">
                  <Segmented
                    value={value.support.type}
                    options={[
                      ['tree', 'Baum'],
                      ['normal', 'Normal'],
                    ]}
                    onChange={(type) => set({ support: { ...value.support!, type } })}
                  />
                </Labeled>
                <Labeled label="Überhang ab (°)" hint={`Profil: ${String(p.supportAngle ?? 30)}°`}>
                  <Input
                    type="number"
                    min={0}
                    max={90}
                    value={value.support.angle ?? ''}
                    placeholder={String(p.supportAngle ?? 30)}
                    onChange={(e) => set({ support: { ...value.support!, angle: e.target.value === '' ? undefined : clamp(Number(e.target.value), 0, 90) } })}
                  />
                </Labeled>
                <label className="flex items-center gap-2 self-end pb-2 text-sm text-text-2">
                  <input
                    type="checkbox"
                    checked={value.support.buildPlateOnly}
                    onChange={(e) => set({ support: { ...value.support!, buildPlateOnly: e.target.checked } })}
                    className="accent-[var(--accent)]"
                  />
                  Nur auf dem Druckbett
                </label>
              </div>
            )}
          </>
        )}

        {tab === 'adhesion' && (
          <>
            <Choice
              label="Brim"
              profileHint={`${BRIM_LABEL[(p.brimType as keyof typeof BRIM_LABEL) ?? 'auto'] ?? 'Automatisch'}${p.brimType !== 'none' && p.brimWidth ? `, ${String(p.brimWidth)} mm` : ''}`}
              value={value.brim?.type ?? 'profile'}
              options={[['profile', 'Wie Profil'], ...(Object.entries(BRIM_LABEL) as [keyof typeof BRIM_LABEL, string][])]}
              onChange={(v) => set({ brim: v === 'profile' ? undefined : { type: v, width: value.brim?.width } })}
            />
            {value.brim && value.brim.type !== 'none' && (
              <Labeled label="Breite (mm)" hint={`Profil: ${String(p.brimWidth ?? 5)} mm`} className="max-w-48">
                <Input
                  type="number"
                  min={0}
                  max={50}
                  step={0.5}
                  value={value.brim.width ?? ''}
                  placeholder={String(p.brimWidth ?? 5)}
                  onChange={(e) => set({ brim: { ...value.brim!, width: e.target.value === '' ? undefined : clamp(Number(e.target.value), 0, 50) } })}
                />
              </Labeled>
            )}
            <div className="border-t border-border pt-4">
              <Choice
                label="Skirt"
                profileHint={p.skirtLoops ? `${String(p.skirtLoops)} Linie(n), ${String(p.skirtDistance ?? 2)} mm Abstand` : 'aus'}
                value={value.skirt ? (value.skirt.loops === 0 ? 'off' : 'on') : 'profile'}
                options={[
                  ['profile', 'Wie Profil'],
                  ['off', 'Kein Skirt'],
                  ['on', 'Eigene Werte'],
                ]}
                onChange={(v) =>
                  set({
                    skirt:
                      v === 'profile'
                        ? undefined
                        : v === 'off'
                          ? { loops: 0 }
                          : { loops: Math.max(1, Number(p.skirtLoops) || 1), distance: value.skirt?.distance },
                  })
                }
              />
              {value.skirt && value.skirt.loops > 0 && (
                <div className="mt-4 grid max-w-md gap-4 sm:grid-cols-2">
                  <Labeled label="Linien">
                    <Input
                      type="number"
                      min={1}
                      max={20}
                      value={value.skirt.loops}
                      onChange={(e) => set({ skirt: { ...value.skirt!, loops: clamp(Number(e.target.value) || 1, 1, 20) } })}
                    />
                  </Labeled>
                  <Labeled label="Abstand (mm)" hint={`Profil: ${String(p.skirtDistance ?? 2)} mm`}>
                    <Input
                      type="number"
                      min={0}
                      max={50}
                      step={0.5}
                      value={value.skirt.distance ?? ''}
                      placeholder={String(p.skirtDistance ?? 2)}
                      onChange={(e) => set({ skirt: { ...value.skirt!, distance: e.target.value === '' ? undefined : clamp(Number(e.target.value), 0, 50) } })}
                    />
                  </Labeled>
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'vase' && (
          <>
            <label className={clsx('flex items-start gap-3', objectCount !== 1 && 'opacity-60')}>
              <input
                type="checkbox"
                checked={!!value.vase}
                disabled={objectCount !== 1}
                onChange={(e) => set({ vase: e.target.checked || undefined })}
                className="mt-1 accent-[var(--accent)]"
              />
              <span className="text-sm">
                <span className="font-medium text-text">Vasenmodus (Spiral Vase)</span>
                <span className="block text-text-2">
                  Druckt die Außenwand als durchgehende Spirale: eine Wand, keine Deckschichten, kein Infill, keine Stützen. Ideal für Vasen,
                  Becher und Lampenschirme.
                </span>
              </span>
            </label>
            {objectCount !== 1 && <Alert tone="neutral">Nur mit genau einem Objekt (ein Modell, eine Kopie) möglich.</Alert>}
            {value.vase && (value.support?.enabled || p.support) && (
              <Alert tone="warning">Stützen werden im Vasenmodus automatisch deaktiviert.</Alert>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

function Choice<T extends string>({
  label,
  profileHint,
  value,
  options,
  onChange,
}: {
  label: string;
  profileHint: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-text-3">Profil: {profileHint}</span>
      </div>
      <Segmented value={value} options={options} onChange={onChange} />
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={clsx(
            'min-h-9 rounded-lg border px-3 text-sm',
            value === v ? 'border-accent bg-accent/10 text-text' : 'border-border text-text-2 hover:border-text-3',
          )}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

function Labeled({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <label className={clsx('block space-y-1.5', className)}>
      <span className="text-xs text-text-3">{label}</span>
      {children}
      {hint && <span className="block text-xs text-text-3">{hint}</span>}
    </label>
  );
}

/** Short labels for job lists, e.g. ["Stützen: Baum", "Brim außen 8 mm"]. */
export function describeOverrides(o: SliceOverrides): string[] {
  const out: string[] = [];
  if (o.vase) out.push('Vasenmodus');
  if (o.support) out.push(o.support.enabled ? `Stützen: ${o.support.type === 'tree' ? 'Baum' : 'Normal'}${o.support.buildPlateOnly ? ' (nur Bett)' : ''}` : 'Keine Stützen');
  if (o.brim) out.push(o.brim.type === 'none' ? 'Kein Brim' : `Brim ${BRIM_LABEL[o.brim.type].toLowerCase()}${o.brim.width !== undefined ? ` ${o.brim.width} mm` : ''}`);
  if (o.skirt) out.push(o.skirt.loops === 0 ? 'Kein Skirt' : `Skirt ${o.skirt.loops}×`);
  return out;
}
