import { useState, type FormEvent } from 'react';
import { Pencil, Plus, Trash2, Plug } from 'lucide-react';
import type { PrinterSummary } from '@printhub/shared';
import { api } from '../../lib/api';
import { useLive } from '../../lib/live';
import { statusBadge } from '../../lib/format';
import { Alert, Badge, Button, Card, Field, Input } from '../../components/ui';

type TestResult = { ok: true; moonrakerVersion: string; klippyState: string } | { ok: false; message: string };

export function PrinterSettings() {
  const printers = useLive((s) => s.printers);
  const [editing, setEditing] = useState<PrinterSummary | 'new' | null>(null);

  return (
    <div className="space-y-4">
      {editing ? (
        <PrinterForm printer={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />
      ) : (
        <div className="flex justify-end">
          <Button onClick={() => setEditing('new')}>
            <Plus className="size-4" /> Drucker hinzufügen
          </Button>
        </div>
      )}

      <Card className="divide-y divide-border">
        {printers.length === 0 && <p className="p-5 text-sm text-text-3">Noch keine Drucker angelegt.</p>}
        {printers.map((p) => {
          const badge = statusBadge(p.status);
          return (
            <div key={p.id} className="flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                </div>
                <div className="truncate text-xs text-text-3">
                  {p.url}
                  {p.hasApiKey && ' · API-Key hinterlegt'}
                </div>
              </div>
              <Button variant="ghost" onClick={() => setEditing(p)} aria-label={`${p.name} bearbeiten`}>
                <Pencil className="size-4" />
              </Button>
              <DeleteButton printer={p} />
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function DeleteButton({ printer }: { printer: PrinterSummary }) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm) {
    return (
      <Button variant="ghost" onClick={() => setConfirm(true)} aria-label={`${printer.name} löschen`}>
        <Trash2 className="size-4" />
      </Button>
    );
  }
  return (
    <div className="flex gap-1">
      <Button variant="danger" onClick={() => api(`/printers/${printer.id}`, { method: 'DELETE' })}>
        Löschen
      </Button>
      <Button variant="ghost" onClick={() => setConfirm(false)}>
        Abbrechen
      </Button>
    </div>
  );
}

function PrinterForm({ printer, onDone }: { printer?: PrinterSummary; onDone: () => void }) {
  const [name, setName] = useState(printer?.name ?? '');
  const [url, setUrl] = useState(printer?.url ?? 'http://');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [enabled, setEnabled] = useState(printer?.enabled ?? true);
  const [error, setError] = useState<string>();
  const [test, setTest] = useState<TestResult>();
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);

  // undefined keeps the stored key, '' removes it.
  const keyPayload = clearKey ? '' : apiKey || undefined;

  const runTest = async () => {
    setBusy('test');
    setTest(undefined);
    try {
      setTest(await api<TestResult>('/printers/test', { body: { name: name || 'test', url, apiKey: apiKey || undefined } }));
    } catch (err) {
      setTest({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setError(undefined);
    try {
      const body = { name, url, apiKey: keyPayload, enabled };
      if (printer) await api(`/printers/${printer.id}`, { method: 'PUT', body });
      else await api('/printers', { body });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="mb-4 font-semibold">{printer ? `${printer.name} bearbeiten` : 'Neuer Drucker'}</h2>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Ender 3 S1 Plus" required autoFocus />
        </Field>
        <Field label="Moonraker-Adresse" hint="Adresse von Fluidd/Mainsail, z. B. http://192.168.1.112 (oder mit :7125)">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} type="url" required />
        </Field>
        <Field
          label="API-Key (optional)"
          hint={
            printer?.hasApiKey
              ? 'Ein Key ist gespeichert. Leer lassen, um ihn zu behalten.'
              : 'Nur nötig, wenn PrintHub nicht in den trusted_clients von Moonraker steht.'
          }
        >
          <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" disabled={clearKey} />
        </Field>
        {printer?.hasApiKey && (
          <label className="flex items-center gap-2 text-sm text-text-2">
            <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} className="accent-[var(--accent)]" />
            Gespeicherten API-Key entfernen
          </label>
        )}
        <label className="flex items-center gap-2 text-sm text-text-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-[var(--accent)]" />
          Verbindung aktiv (deaktivieren, um den Drucker vorübergehend nicht zu überwachen)
        </label>

        {test &&
          (test.ok ? (
            <Alert tone="good">
              Verbunden: Moonraker {test.moonrakerVersion}, Klipper {test.klippyState}
            </Alert>
          ) : (
            <Alert>{test.message}</Alert>
          ))}
        {error && <Alert>{error}</Alert>}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy === 'save'}>
            Speichern
          </Button>
          <Button type="button" variant="secondary" onClick={runTest} loading={busy === 'test'}>
            <Plug className="size-4" /> Verbindung testen
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Abbrechen
          </Button>
        </div>
      </form>
    </Card>
  );
}
