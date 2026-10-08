import { MATERIAL_DENSITY, type FilamentInfo, type NewFilamentInput } from '@printhub/shared';
import { Field, Input } from '../ui';

const MATERIALS = Object.keys(MATERIAL_DENSITY);

/** "12,5" → 12.5; empty → undefined; invalid → NaN. */
export const num = (s: string) => (s.trim() === '' ? undefined : Number(s.replace(',', '.')));
export const str = (n: number | null | undefined) => (n == null ? '' : String(n).replace('.', ','));
/** Empty or a number ≥ 0. */
export const validNumber = (s: string) => s.trim() === '' || Number(s.replace(',', '.')) >= 0;

export type FilamentForm = Record<'vendor' | 'name' | 'material' | 'color' | 'density' | 'diameter' | 'weight' | 'spoolWeight' | 'price', string>;

export const EMPTY_FILAMENT: FilamentForm = { vendor: '', name: '', material: 'PLA', color: '#808080', density: '1,24', diameter: '1,75', weight: '1000', spoolWeight: '', price: '' };

export const filamentForm = (f: FilamentInfo): FilamentForm => ({
  vendor: f.vendor ?? '',
  name: f.name,
  material: f.material ?? '',
  color: f.color ?? '#808080',
  density: str(f.density),
  diameter: str(f.diameter),
  weight: str(f.weight),
  spoolWeight: str(f.spoolWeight),
  price: str(f.price),
});

/** Request body, or null while required fields are missing. */
export function filamentInput(f: FilamentForm): NewFilamentInput | null {
  const density = num(f.density);
  const diameter = num(f.diameter);
  const weight = num(f.weight);
  if (!f.name.trim() || !f.material.trim() || !density || !diameter || !weight) return null;
  return { vendor: f.vendor, name: f.name, material: f.material, color: f.color, density, diameter, weight, spoolWeight: num(f.spoolWeight), price: num(f.price) };
}

export const filamentFormValid = (f: FilamentForm) => [f.density, f.diameter, f.weight, f.spoolWeight, f.price].every(validNumber);

export function FilamentFields({ value: f, onChange }: { value: FilamentForm; onChange: (f: FilamentForm) => void }) {
  const set = (patch: Partial<FilamentForm>) => onChange({ ...f, ...patch });
  // Known materials bring their density along.
  const setMaterial = (material: string) => {
    const density = MATERIAL_DENSITY[material.toUpperCase()];
    set({ material, ...(density && { density: str(density) }) });
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Hersteller">
        <Input value={f.vendor} onChange={(e) => set({ vendor: e.target.value })} placeholder="z. B. Bambu Lab" />
      </Field>
      <Field label="Name">
        <Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="z. B. PLA Basic Orange" required />
      </Field>
      <Field label="Material">
        <Input value={f.material} onChange={(e) => setMaterial(e.target.value)} list="spool-materials" required />
        <datalist id="spool-materials">
          {MATERIALS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </Field>
      <Field label="Farbe">
        <div className="flex items-center gap-2">
          <input type="color" value={f.color} onChange={(e) => set({ color: e.target.value })} className="h-10 w-14 shrink-0 cursor-pointer rounded-lg border border-border bg-surface" aria-label="Farbe wählen" />
          <span className="font-mono text-sm text-text-2">{f.color}</span>
        </div>
      </Field>
      <Field label="Filament pro Spule (g)" hint="Nettogewicht, meist 1000">
        <Input inputMode="decimal" value={f.weight} onChange={(e) => set({ weight: e.target.value })} />
      </Field>
      <Field label="Preis pro Spule (€)">
        <Input inputMode="decimal" value={f.price} onChange={(e) => set({ price: e.target.value })} placeholder="z. B. 19,99" />
      </Field>
      <Field label="Leere Spule (g)" hint="Zum Nachwiegen, optional">
        <Input inputMode="decimal" value={f.spoolWeight} onChange={(e) => set({ spoolWeight: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Dichte (g/cm³)">
          <Input inputMode="decimal" value={f.density} onChange={(e) => set({ density: e.target.value })} />
        </Field>
        <Field label="Durchmesser (mm)">
          <Input inputMode="decimal" value={f.diameter} onChange={(e) => set({ diameter: e.target.value })} />
        </Field>
      </div>
    </div>
  );
}
