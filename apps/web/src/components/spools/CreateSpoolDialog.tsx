import { useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import clsx from 'clsx';
import { MATERIAL_DENSITY, type CreateSpoolInput, type FilamentInfo, type SpoolInfo } from '@printhub/shared';
import { api } from '../../lib/api';
import { toast, useAction } from '../../lib/feedback';
import { formatMoney, formatWeight } from '../../lib/stats';
import { Modal } from '../Modal';
import { Alert, Button, Field, Input, Spinner } from '../ui';

const MATERIALS = Object.keys(MATERIAL_DENSITY);
const num = (s: string) => (s.trim() === '' ? undefined : Number(s.replace(',', '.')));
const str = (n: number | null | undefined) => (n == null ? '' : String(n).replace('.', ','));

/** New spool(s) in Spoolman: of a filament already there, or of a new one. */
export function CreateSpoolDialog({ open, onClose, printerId }: { open: boolean; onClose: () => void; printerId?: number }) {
  return (
    <Modal open={open} onClose={onClose} title="Spule anlegen">
      <CreateSpoolForm onDone={onClose} printerId={printerId} />
    </Modal>
  );
}

function CreateSpoolForm({ onDone, printerId }: { onDone: () => void; printerId?: number }) {
  const qc = useQueryClient();
  const filaments = useQuery({ queryKey: ['filaments'], queryFn: () => api<FilamentInfo[]>('/spoolman/filaments') });
  const [mode, setMode] = useState<'existing' | 'new'>();
  const [filamentId, setFilamentId] = useState<number>();
  const [f, setF] = useState({ vendor: '', name: '', material: 'PLA', color: '#808080', density: '1,24', diameter: '1,75', weight: '1000', spoolWeight: '', price: '' });
  const [count, setCount] = useState('1');
  const [initialWeight, setInitialWeight] = useState('');
  const [price, setPrice] = useState('');
  const [location, setLocation] = useState('');
  const [activate, setActivate] = useState(printerId !== undefined);
  const { busy, run } = useAction();

  // With no filaments in Spoolman yet, start with a new one.
  const effectiveMode = mode ?? (filaments.data && filaments.data.length === 0 ? 'new' : 'existing');
  const selected = filaments.data?.find((x) => x.id === filamentId);

  const body = useMemo((): CreateSpoolInput | null => {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 20) return null;
    const common = { count: n, initialWeight: num(initialWeight), price: num(price), location: location.trim() || undefined, printerId: activate ? printerId : undefined };
    if (effectiveMode === 'existing') return filamentId ? { ...common, filamentId } : null;
    const density = num(f.density);
    const diameter = num(f.diameter);
    const weight = num(f.weight);
    if (!f.name.trim() || !f.material.trim() || !density || !diameter || !weight) return null;
    return {
      ...common,
      filament: { vendor: f.vendor, name: f.name, material: f.material, color: f.color, density, diameter, weight, spoolWeight: num(f.spoolWeight), price: num(f.price) },
    };
  }, [count, initialWeight, price, location, activate, printerId, effectiveMode, filamentId, f]);

  const invalidNumber = [count, initialWeight, price, f.density, f.diameter, f.weight, f.spoolWeight, f.price].some((v) => v.trim() !== '' && !(Number(v.replace(',', '.')) >= 0));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!body) return;
    void run('create', async () => {
      const spools = await api<SpoolInfo[]>('/spoolman/spools', { body });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['spools'] }),
        qc.invalidateQueries({ queryKey: ['filaments'] }),
        qc.invalidateQueries({ queryKey: ['printer-spool'] }),
      ]);
      toast(spools.length === 1 ? `Spule #${spools[0]!.id} angelegt` : `${spools.length} Spulen angelegt (#${spools.map((s) => s.id).join(', #')})`);
      onDone();
    });
  };

  const setMaterial = (material: string) => setF({ ...f, material, density: MATERIAL_DENSITY[material.toUpperCase()] ? str(MATERIAL_DENSITY[material.toUpperCase()]) : f.density });

  return (
    <form onSubmit={submit} className="space-y-5">
      <div role="radiogroup" aria-label="Filament" className="inline-flex rounded-lg border border-border bg-surface p-0.5">
        {(['existing', 'new'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={effectiveMode === m}
            onClick={() => setMode(m)}
            className={clsx('min-h-8 rounded-md px-3 text-sm', effectiveMode === m ? 'bg-surface-2 font-medium text-text' : 'text-text-2 hover:text-text')}
          >
            {m === 'existing' ? 'Vorhandenes Filament' : 'Neues Filament'}
          </button>
        ))}
      </div>

      {effectiveMode === 'existing' ? (
        filaments.isLoading ? (
          <Spinner />
        ) : filaments.error ? (
          <Alert>{(filaments.error as Error).message}</Alert>
        ) : (
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            {filaments.data?.map((x) => (
              <button
                key={x.id}
                type="button"
                onClick={() => setFilamentId(x.id)}
                className={clsx('flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left', filamentId === x.id ? 'border-accent bg-accent/5' : 'border-border hover:border-text-3')}
              >
                <span className="size-6 shrink-0 rounded-full border border-border" style={{ background: x.color ?? 'transparent' }} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {x.vendor ? `${x.vendor} ` : ''}
                    {x.name}
                  </div>
                  <div className="text-xs text-text-3">{[x.material, x.weight && formatWeight(x.weight), x.price !== null && formatMoney(x.price)].filter(Boolean).join(' · ')}</div>
                </div>
                {filamentId === x.id && <Check className="size-4 shrink-0 text-accent" />}
              </button>
            ))}
          </div>
        )
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Hersteller">
            <Input value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} placeholder="z. B. Bambu Lab" />
          </Field>
          <Field label="Name">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. PLA Basic Orange" required />
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
              <input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} className="h-10 w-14 shrink-0 cursor-pointer rounded-lg border border-border bg-surface" aria-label="Farbe wählen" />
              <span className="font-mono text-sm text-text-2">{f.color}</span>
            </div>
          </Field>
          <Field label="Filament pro Spule (g)" hint="Nettogewicht, meist 1000">
            <Input inputMode="decimal" value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} />
          </Field>
          <Field label="Preis pro Spule (€)">
            <Input inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} placeholder="z. B. 19,99" />
          </Field>
          <Field label="Leere Spule (g)" hint="Zum Nachwiegen, optional">
            <Input inputMode="decimal" value={f.spoolWeight} onChange={(e) => setF({ ...f, spoolWeight: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Dichte (g/cm³)">
              <Input inputMode="decimal" value={f.density} onChange={(e) => setF({ ...f, density: e.target.value })} />
            </Field>
            <Field label="Durchmesser (mm)">
              <Input inputMode="decimal" value={f.diameter} onChange={(e) => setF({ ...f, diameter: e.target.value })} />
            </Field>
          </div>
        </div>
      )}

      <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-4">
        <Field label="Anzahl Spulen">
          <Input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <Field label="Gewicht (g)" hint="Leer = voll">
          <Input inputMode="decimal" value={initialWeight} onChange={(e) => setInitialWeight(e.target.value)} placeholder={str(selected?.weight ?? num(f.weight))} />
        </Field>
        <Field label="Preis (€)" hint="Leer = Filamentpreis">
          <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={str(effectiveMode === 'existing' ? selected?.price : num(f.price))} />
        </Field>
        <Field label="Lagerort">
          <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="z. B. Regal" />
        </Field>
      </div>

      {printerId !== undefined && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} className="size-4 accent-[var(--accent)]" />
          Als aktive Spule in diesen Drucker einlegen
        </label>
      )}

      <div className="flex items-center justify-end gap-3">
        {invalidNumber && <span className="text-sm text-critical">Bitte gültige Zahlen eingeben.</span>}
        <Button type="button" variant="ghost" onClick={onDone}>
          Abbrechen
        </Button>
        <Button type="submit" disabled={!body || invalidNumber} loading={busy === 'create'}>
          Anlegen
        </Button>
      </div>
    </form>
  );
}
