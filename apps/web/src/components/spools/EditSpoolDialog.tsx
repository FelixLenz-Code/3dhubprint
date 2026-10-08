import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { spoolLabel, type SpoolInfo, type UpdateSpoolInput } from '@printhub/shared';
import { api } from '../../lib/api';
import { confirm, toast, useAction } from '../../lib/feedback';
import { formatWeight } from '../../lib/stats';
import { Modal } from '../Modal';
import { Button, Field, Input, Segmented } from '../ui';
import { num, str, validNumber } from './FilamentFields';

type WeightMode = 'remaining' | 'used' | 'measured';
const WEIGHT_MODES: Record<WeightMode, string> = { remaining: 'Restgewicht', used: 'Verbraucht', measured: 'Gewogen' };

export function EditSpoolDialog({ spool, onClose }: { spool: SpoolInfo | null; onClose: () => void }) {
  return (
    <Modal open={!!spool} onClose={onClose} title={spool ? `Spule ${spoolLabel(spool)}` : ''}>
      {spool && <EditSpoolForm key={spool.id} spool={spool} onDone={onClose} />}
    </Modal>
  );
}

/** Invalidate everything that shows spools. */
export const refreshSpools = (qc: ReturnType<typeof useQueryClient>) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: ['spools'] }),
    qc.invalidateQueries({ queryKey: ['filaments'] }),
    qc.invalidateQueries({ queryKey: ['printer-spool'] }),
  ]);

function EditSpoolForm({ spool: s, onDone }: { spool: SpoolInfo; onDone: () => void }) {
  const qc = useQueryClient();
  const { busy, run } = useAction();
  const [mode, setMode] = useState<WeightMode>('remaining');
  const [weight, setWeight] = useState(str(s.remainingG === null ? null : Math.round(s.remainingG * 10) / 10));
  const [weightTouched, setWeightTouched] = useState(false);
  const [initial, setInitial] = useState(str(s.initialG));
  const [spoolWeight, setSpoolWeight] = useState(str(s.spoolWeight));
  const [price, setPrice] = useState(str(s.price));
  const [location, setLocation] = useState(s.location ?? '');
  const [comment, setComment] = useState(s.comment ?? '');

  const initialG = num(initial) ?? s.initialG ?? undefined;
  const emptyG = num(spoolWeight);
  const w = num(weight);
  // What the entered weight means for the remaining filament.
  const remaining = w === undefined ? undefined : mode === 'remaining' ? w : mode === 'used' ? (initialG !== undefined ? initialG - w : undefined) : emptyG !== undefined ? w - emptyG : undefined;
  const needsEmpty = mode === 'measured' && emptyG === undefined;
  const invalid = ![weight, initial, spoolWeight, price].every(validNumber) || (remaining !== undefined && remaining < 0) || (weightTouched && needsEmpty);

  const switchMode = (m: WeightMode) => {
    setMode(m);
    setWeightTouched(false);
    const value = m === 'remaining' ? s.remainingG : m === 'used' ? s.usedG : s.remainingG !== null && emptyG !== undefined ? s.remainingG + emptyG : null;
    setWeight(str(value === null ? null : Math.round(value * 10) / 10));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: UpdateSpoolInput = {};
    if (num(initial) !== undefined && num(initial) !== s.initialG) body.initialWeight = num(initial);
    if ((num(spoolWeight) ?? null) !== s.spoolWeight) body.spoolWeight = num(spoolWeight) ?? null;
    if ((num(price) ?? null) !== s.price) body.price = num(price) ?? null;
    if ((location.trim() || null) !== s.location) body.location = location;
    if ((comment.trim() || null) !== s.comment) body.comment = comment;
    if (weightTouched && w !== undefined) {
      if (mode === 'used') body.usedWeight = w;
      else if (remaining !== undefined) body.remainingWeight = remaining;
    }
    if (Object.keys(body).length === 0) return onDone();
    void run('save', async () => {
      await api(`/spoolman/spools/${s.id}`, { method: 'PATCH', body });
      await refreshSpools(qc);
      toast('Spule gespeichert');
      onDone();
    });
  };

  const toggleArchive = () =>
    run('archive', async () => {
      await api(`/spoolman/spools/${s.id}`, { method: 'PATCH', body: { archived: !s.archived } });
      await refreshSpools(qc);
      toast(s.archived ? 'Spule wiederhergestellt' : 'Spule archiviert');
      onDone();
    });

  const remove = async () => {
    const ok = await confirm({
      title: 'Spule löschen?',
      body: `${spoolLabel(s)} wird endgültig aus Spoolman gelöscht. Leere Spulen besser archivieren, dann bleibt der Verbrauch nachvollziehbar.`,
      confirmLabel: 'Löschen',
      danger: true,
    });
    if (!ok) return;
    void run('delete', async () => {
      await api(`/spoolman/spools/${s.id}`, { method: 'DELETE' });
      await refreshSpools(qc);
      toast('Spule gelöscht');
      onDone();
    });
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto text-sm font-medium text-text-2">Filament auf der Spule</span>
          <Segmented value={mode} onChange={switchMode} options={WEIGHT_MODES} label="Gewicht angeben als" />
        </div>
        <Input
          inputMode="decimal"
          value={weight}
          onChange={(e) => {
            setWeight(e.target.value);
            setWeightTouched(true);
          }}
          aria-label={WEIGHT_MODES[mode]}
        />
        <p className="text-xs text-text-3">
          {mode === 'measured' && (needsEmpty ? 'Dafür unten das Gewicht der leeren Spule eintragen. ' : 'Spule samt Filament wiegen und das Gewicht eintragen. ')}
          {remaining !== undefined && initialG !== undefined ? (
            remaining < 0 ? (
              <span className="text-critical">Ergibt weniger als 0 g Rest.</span>
            ) : (
              `Rest ${formatWeight(remaining)}, verbraucht ${formatWeight(initialG - remaining)} von ${formatWeight(initialG)}`
            )
          ) : null}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Volle Spule (g)" hint="Filament netto">
          <Input inputMode="decimal" value={initial} onChange={(e) => setInitial(e.target.value)} />
        </Field>
        <Field label="Leere Spule (g)" hint="Für „Gewogen“">
          <Input inputMode="decimal" value={spoolWeight} onChange={(e) => setSpoolWeight(e.target.value)} />
        </Field>
        <Field label="Preis (€)" hint="Leer = Filamentpreis">
          <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Lagerort">
          <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="z. B. Regal" maxLength={64} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Notiz">
            <Input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1024} />
          </Field>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button type="button" variant="ghost" className="px-3 text-critical hover:text-critical" onClick={remove} loading={busy === 'delete'}>
          <Trash2 className="size-4" /> Löschen
        </Button>
        <Button type="button" variant="ghost" className="px-3" onClick={toggleArchive} loading={busy === 'archive'}>
          {s.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
          {s.archived ? 'Wiederherstellen' : 'Archivieren'}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {invalid && <span className="text-sm text-critical">Bitte gültige Zahlen eingeben.</span>}
          <Button type="button" variant="ghost" onClick={onDone}>
            Abbrechen
          </Button>
          <Button type="submit" disabled={invalid} loading={busy === 'save'}>
            Speichern
          </Button>
        </div>
      </div>
    </form>
  );
}
