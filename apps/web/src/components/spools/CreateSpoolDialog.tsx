import { useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import clsx from 'clsx';
import type { CreateSpoolInput, FilamentInfo, SpoolInfo } from '@printhub/shared';
import { api } from '../../lib/api';
import { toast, useAction } from '../../lib/feedback';
import { formatMoney, formatWeight } from '../../lib/stats';
import { Modal } from '../Modal';
import { Alert, Button, Field, Input, Spinner } from '../ui';
import { EMPTY_FILAMENT, FilamentFields, filamentFormValid, filamentInput, num, str, validNumber } from './FilamentFields';

/** New spool(s) in Spoolman: of a filament already there, or of a new one. */
export function CreateSpoolDialog({ open, onClose, printerId, filamentId }: { open: boolean; onClose: () => void; printerId?: number; filamentId?: number }) {
  return (
    <Modal open={open} onClose={onClose} title="Spule anlegen">
      <CreateSpoolForm onDone={onClose} printerId={printerId} initialFilamentId={filamentId} />
    </Modal>
  );
}

function CreateSpoolForm({ onDone, printerId, initialFilamentId }: { onDone: () => void; printerId?: number; initialFilamentId?: number }) {
  const qc = useQueryClient();
  const filaments = useQuery({ queryKey: ['filaments'], queryFn: () => api<FilamentInfo[]>('/spoolman/filaments') });
  const [mode, setMode] = useState<'existing' | 'new'>();
  const [filamentId, setFilamentId] = useState(initialFilamentId);
  const [f, setF] = useState(EMPTY_FILAMENT);
  const [count, setCount] = useState('1');
  const [initialWeight, setInitialWeight] = useState('');
  const [usedWeight, setUsedWeight] = useState('');
  const [price, setPrice] = useState('');
  const [location, setLocation] = useState('');
  const [comment, setComment] = useState('');
  const [activate, setActivate] = useState(printerId !== undefined);
  const { busy, run } = useAction();

  // With no filaments in Spoolman yet, start with a new one.
  const effectiveMode = mode ?? (filaments.data && filaments.data.length === 0 ? 'new' : 'existing');
  const selected = filaments.data?.find((x) => x.id === filamentId);

  // Full spool weight: entered, else the filament's net weight.
  const fullWeight = num(initialWeight) ?? (effectiveMode === 'existing' ? selected?.weight : num(f.weight)) ?? undefined;
  const used = num(usedWeight);
  const tooMuchUsed = used !== undefined && fullWeight !== undefined && used > fullWeight;

  const body = useMemo((): CreateSpoolInput | null => {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 20) return null;
    const common = {
      count: n,
      initialWeight: num(initialWeight),
      usedWeight: num(usedWeight) || undefined,
      price: num(price),
      location: location.trim() || undefined,
      comment: comment.trim() || undefined,
      printerId: activate ? printerId : undefined,
    };
    if (effectiveMode === 'existing') return filamentId ? { ...common, filamentId } : null;
    const filament = filamentInput(f);
    return filament && { ...common, filament };
  }, [count, initialWeight, usedWeight, price, location, comment, activate, printerId, effectiveMode, filamentId, f]);

  const invalidNumber = ![count, initialWeight, usedWeight, price].every(validNumber) || (effectiveMode === 'new' && !filamentFormValid(f));

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
        <FilamentFields value={f} onChange={setF} />
      )}

      <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-3">
        <Field label="Anzahl Spulen">
          <Input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <Field label="Gewicht (g)" hint="Volle Spule, leer = Filamentgewicht">
          <Input inputMode="decimal" value={initialWeight} onChange={(e) => setInitialWeight(e.target.value)} placeholder={str(selected?.weight ?? num(f.weight))} />
        </Field>
        <Field
          label="Bereits verbraucht (g)"
          hint={
            tooMuchUsed ? (
              <span className="text-critical">Mehr als auf der Spule ist ({formatWeight(fullWeight)})</span>
            ) : used && fullWeight !== undefined ? (
              `Noch ${formatWeight(fullWeight - used)} drauf`
            ) : (
              'Für angebrochene Spulen'
            )
          }
        >
          <Input inputMode="decimal" value={usedWeight} onChange={(e) => setUsedWeight(e.target.value)} placeholder="0" />
        </Field>
        <Field label="Preis (€)" hint="Leer = Filamentpreis">
          <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={str(effectiveMode === 'existing' ? selected?.price : num(f.price))} />
        </Field>
        <Field label="Lagerort">
          <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="z. B. Regal" />
        </Field>
        <Field label="Notiz">
          <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="optional" maxLength={1024} />
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
        <Button type="submit" disabled={!body || invalidNumber || tooMuchUsed} loading={busy === 'create'}>
          Anlegen
        </Button>
      </div>
    </form>
  );
}
