import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import type { ThingiverseStatus } from '@printhub/shared';
import { api } from '../../lib/api';
import { confirm, useAction } from '../../lib/feedback';
import { Badge, Button, Card, Field, Input } from '../../components/ui';

export function IntegrationSettings() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['thingiverse-status'], queryFn: () => api<ThingiverseStatus>('/thingiverse/status') });
  const [token, setToken] = useState('');
  const { busy, run } = useAction();

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(
      'save',
      async () => {
        await api('/thingiverse/token', { method: 'PUT', body: { token: token.trim() } });
        setToken('');
        await qc.invalidateQueries({ queryKey: ['thingiverse-status'] });
      },
      'Thingiverse verbunden',
    );
  };

  const remove = async () => {
    if (await confirm({ title: 'Thingiverse trennen?', body: 'Der gespeicherte Token wird gelöscht. Bereits übernommene Modelle bleiben.', confirmLabel: 'Trennen', danger: true })) {
      await run('remove', async () => {
        await api('/thingiverse/token', { method: 'DELETE' });
        await qc.invalidateQueries({ queryKey: ['thingiverse-status'] });
      });
    }
  };

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Thingiverse</h2>
        {status.data && <Badge tone={status.data.configured ? 'good' : 'neutral'}>{status.data.configured ? 'Verbunden' : 'Nicht verbunden'}</Badge>}
      </div>
      <p className="text-sm text-text-2">
        Ermöglicht die Suche auf Thingiverse und das direkte Übernehmen von Modellen in die Bibliothek, inklusive Lizenz und Urheber.
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-text-2">
        <li>
          Auf{' '}
          <a href="https://www.thingiverse.com/developers" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
            thingiverse.com/developers <ExternalLink className="size-3" />
          </a>{' '}
          mit deinem Thingiverse-Konto anmelden.
        </li>
        <li>Eine neue App anlegen (Name z. B. „PrintHub“).</li>
        <li>Den angezeigten <b>App Token</b> kopieren und hier einfügen.</li>
      </ol>
      <form onSubmit={save} className="space-y-3">
        <Field label={status.data?.configured ? 'Neuen App-Token setzen' : 'App-Token'} hint="Wird vor dem Speichern bei Thingiverse geprüft und verschlüsselt abgelegt.">
          <Input value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} placeholder="z. B. 3f2a…" className="font-mono" />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={token.trim().length < 10} loading={busy === 'save'}>
            Speichern
          </Button>
          {status.data?.configured && (
            <Button type="button" variant="ghost" onClick={remove} loading={busy === 'remove'}>
              Trennen
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
