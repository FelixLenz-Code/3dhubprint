import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import type { FilamentInfo } from '@printhub/shared';
import { api } from '../../lib/api';
import { confirm, toast, useAction } from '../../lib/feedback';
import { Modal } from '../Modal';
import { Button } from '../ui';
import { refreshSpools } from './EditSpoolDialog';
import { FilamentFields, filamentForm, filamentFormValid, filamentInput } from './FilamentFields';

/** Edits a filament; it can only be deleted once no spool (not even an archived one) uses it. */
export function EditFilamentDialog({ filament, spoolCount, onClose }: { filament: FilamentInfo | null; spoolCount: number; onClose: () => void }) {
  return (
    <Modal open={!!filament} onClose={onClose} title={filament ? `Filament ${filament.vendor ? `${filament.vendor} ` : ''}${filament.name}` : ''}>
      {filament && <EditFilamentForm key={filament.id} filament={filament} spoolCount={spoolCount} onDone={onClose} />}
    </Modal>
  );
}

function EditFilamentForm({ filament, spoolCount, onDone }: { filament: FilamentInfo; spoolCount: number; onDone: () => void }) {
  const qc = useQueryClient();
  const { busy, run } = useAction();
  const [f, setF] = useState(() => filamentForm(filament));
  const body = filamentInput(f);
  const valid = !!body && filamentFormValid(f);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    void run('save', async () => {
      await api(`/spoolman/filaments/${filament.id}`, { method: 'PATCH', body });
      await refreshSpools(qc);
      toast('Filament gespeichert');
      onDone();
    });
  };

  const remove = async () => {
    if (!(await confirm({ title: 'Filament löschen?', body: `${filament.name} wird aus Spoolman gelöscht.`, confirmLabel: 'Löschen', danger: true }))) return;
    void run('delete', async () => {
      await api(`/spoolman/filaments/${filament.id}`, { method: 'DELETE' });
      await refreshSpools(qc);
      toast('Filament gelöscht');
      onDone();
    });
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <FilamentFields value={f} onChange={setF} />
      {spoolCount > 0 && <p className="text-xs text-text-3">Änderungen gelten für alle {spoolCount} Spulen dieses Filaments.</p>}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="ghost"
          className="px-3 text-critical hover:text-critical"
          onClick={remove}
          loading={busy === 'delete'}
          disabled={spoolCount > 0}
          title={spoolCount > 0 ? 'Erst alle Spulen dieses Filaments löschen' : undefined}
        >
          <Trash2 className="size-4" /> Löschen
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {!filamentFormValid(f) && <span className="text-sm text-critical">Bitte gültige Zahlen eingeben.</span>}
          <Button type="button" variant="ghost" onClick={onDone}>
            Abbrechen
          </Button>
          <Button type="submit" disabled={!valid} loading={busy === 'save'}>
            Speichern
          </Button>
        </div>
      </div>
    </form>
  );
}
