import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import type { FilamentInfo } from '@printhub/shared';
import { api } from '../../lib/api';
import { confirm, toast, useAction } from '../../lib/feedback';
import { Modal } from '../Modal';
import { Button } from '../ui';
import { refreshSpools } from './EditSpoolDialog';
import { EMPTY_FILAMENT, FilamentFields, filamentForm, filamentFormValid, filamentInput } from './FilamentFields';

/**
 * Creates a filament (without a spool) or edits one. A filament can only be deleted once no spool,
 * not even an archived one, uses it.
 */
export function FilamentDialog({
  open,
  filament,
  spoolCount = 0,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** Edit this filament; without it a new one is created. */
  filament?: FilamentInfo | null;
  spoolCount?: number;
  onClose: () => void;
  onCreated?: (filament: FilamentInfo) => void;
}) {
  const title = filament ? `Filament ${filament.vendor ? `${filament.vendor} ` : ''}${filament.name}` : 'Filament anlegen';
  return (
    <Modal open={open} onClose={onClose} title={title}>
      {open && <FilamentForm key={filament?.id ?? 'new'} filament={filament ?? undefined} spoolCount={spoolCount} onDone={onClose} onCreated={onCreated} />}
    </Modal>
  );
}

function FilamentForm({ filament, spoolCount, onDone, onCreated }: { filament?: FilamentInfo; spoolCount: number; onDone: () => void; onCreated?: (f: FilamentInfo) => void }) {
  const qc = useQueryClient();
  const { busy, run } = useAction();
  const [f, setF] = useState(() => (filament ? filamentForm(filament) : EMPTY_FILAMENT));
  const body = filamentInput(f);
  const valid = !!body && filamentFormValid(f);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // A nested dialog's form must not submit the form of the dialog below it.
    e.stopPropagation();
    if (!valid) return;
    void run('save', async () => {
      if (filament) {
        await api(`/spoolman/filaments/${filament.id}`, { method: 'PATCH', body });
        await refreshSpools(qc);
        toast('Filament gespeichert');
      } else {
        const created = await api<FilamentInfo>('/spoolman/filaments', { body });
        await refreshSpools(qc);
        toast(`Filament ${created.name} angelegt`);
        onCreated?.(created);
      }
      onDone();
    });
  };

  const remove = async () => {
    if (!filament) return;
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
        {filament && (
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
        )}
        <div className="ml-auto flex items-center gap-2">
          {!filamentFormValid(f) && <span className="text-sm text-critical">Bitte gültige Zahlen eingeben.</span>}
          <Button type="button" variant="ghost" onClick={onDone}>
            Abbrechen
          </Button>
          <Button type="submit" disabled={!valid} loading={busy === 'save'}>
            {filament ? 'Speichern' : 'Anlegen'}
          </Button>
        </div>
      </div>
    </form>
  );
}
