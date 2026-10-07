import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import type { SpoolmanStatus, ThingiverseStatus } from '@printhub/shared';
import { api } from '../../lib/api';
import { confirm, useAction } from '../../lib/feedback';
import { Alert, Badge, Button, Card, Field, Input } from '../../components/ui';
import { useSpoolmanStatus } from '../../lib/stats';

export function IntegrationSettings() {
  return (
    <div className="space-y-4">
      <ThingiverseCard />
      <SpoolmanCard />
    </div>
  );
}

function ThingiverseCard() {
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

function SpoolmanCard() {
  const qc = useQueryClient();
  const status = useSpoolmanStatus();
  const [url, setUrl] = useState('');
  const { busy, run } = useAction();
  const s = status.data;

  const refresh = async (next: SpoolmanStatus) => {
    qc.setQueryData(['spoolman-status'], next);
    await qc.invalidateQueries({ queryKey: ['spools'] });
    await qc.invalidateQueries({ queryKey: ['printer-spool'] });
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(
      'save',
      async () => {
        await refresh(await api<SpoolmanStatus>('/spoolman/url', { method: 'PUT', body: { url: url.trim() } }));
        setUrl('');
      },
      'Spoolman verbunden',
    );
  };

  const remove = async () => {
    if (await confirm({ title: 'Spoolman trennen?', body: 'PrintHub vergisst die Adresse. Die Daten in Spoolman bleiben unverändert.', confirmLabel: 'Trennen', danger: true })) {
      await run('remove', async () => refresh(await api<SpoolmanStatus>('/spoolman/url', { method: 'DELETE' })));
    }
  };

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Spoolman</h2>
        {s && <Badge tone={!s.configured ? 'neutral' : s.reachable ? 'good' : 'critical'}>{!s.configured ? 'Nicht verbunden' : s.reachable ? `Verbunden${s.version ? ` (v${s.version})` : ''}` : 'Nicht erreichbar'}</Badge>}
      </div>
      <p className="text-sm text-text-2">
        Filamentspulen aus{' '}
        <a href="https://github.com/Donkie/Spoolman" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
          Spoolman <ExternalLink className="size-3" />
        </a>
        : aktive Spule pro Drucker, Restmenge vor dem Druck prüfen, Spulenpreis für die Kostenberechnung und Bestand in der Statistik.
      </p>
      <p className="text-sm text-text-2">
        Ist Spoolman auch in der <code className="rounded bg-surface-2 px-1 text-xs">moonraker.conf</code> eines Druckers eingetragen (<code className="rounded bg-surface-2 px-1 text-xs">[spoolman]</code>), bucht Moonraker den Verbrauch selbst. Sonst übernimmt das
        PrintHub nach jedem Druck.
      </p>
      {s?.configured && (
        <div className="space-y-1 text-sm">
          {s.managed ? (
            <div className="text-text-2">Mit PrintHub installiert und automatisch verbunden. Entfernen auf dem Server mit <code className="rounded bg-surface-2 px-1 text-xs">printhub spoolman off</code>.</div>
          ) : (
            <div>
              <span className="text-text-3">Adresse: </span>
              <span className="break-all font-mono">{s.url}</span>
            </div>
          )}
          {s.webUrl && (
            <a href={s.webUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              Spoolman öffnen ({s.webUrl}) <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}
      {s?.configured && !s.reachable && s.error && <Alert>{s.error}</Alert>}
      {!s?.managed && (
      <form onSubmit={save} className="space-y-3">
        <Field label={s?.configured ? 'Neue Adresse' : 'Adresse des Spoolman-Servers'} hint="z. B. http://192.168.1.20:7912. PrintHub prüft die Verbindung vor dem Speichern.">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false} placeholder="http://…:7912" inputMode="url" />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!/^https?:\/\/.+/.test(url.trim())} loading={busy === 'save'}>
            Speichern
          </Button>
          {s?.configured && (
            <Button type="button" variant="ghost" onClick={remove} loading={busy === 'remove'}>
              Trennen
            </Button>
          )}
        </div>
      </form>
      )}
      {!s?.configured && (
        <p className="text-xs text-text-3">
          Noch kein Spoolman? Auf dem PrintHub-Server mit <code className="rounded bg-surface-2 px-1">sudo printhub spoolman on</code> mitinstallieren, dann ist er automatisch verbunden.
        </p>
      )}
    </Card>
  );
}
