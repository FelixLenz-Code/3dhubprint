import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, ShieldCheck, ShieldOff, Copy, Check } from 'lucide-react';
import type { SessionInfo } from '@printhub/shared';
import { api } from '../../lib/api';
import { useRefreshAuth } from '../../lib/auth';
import { Alert, Badge, Button, Card, Field, Input } from '../../components/ui';

export function SecuritySettings() {
  return (
    <div className="space-y-6">
      <TotpCard />
      <PasswordCard />
      <SessionsCard />
    </div>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setMsg({ ok: false, text: 'Neue Passwörter stimmen nicht überein' });
    setBusy(true);
    setMsg(undefined);
    try {
      await api('/auth/password', { body: { currentPassword: current, newPassword: next } });
      setMsg({ ok: true, text: 'Passwort geändert. Alle anderen Sitzungen wurden abgemeldet.' });
      setCurrent('');
      setNext('');
      setConfirm('');
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="mb-4 font-semibold">Passwort ändern</h2>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Aktuelles Passwort">
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Field label="Neues Passwort" hint="Mindestens 12 Zeichen">
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
          </Field>
          <Field label="Wiederholen">
            <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </Field>
        </div>
        {msg && <Alert tone={msg.ok ? 'good' : 'critical'}>{msg.text}</Alert>}
        <Button type="submit" loading={busy}>
          Passwort ändern
        </Button>
      </form>
    </Card>
  );
}

function TotpCard() {
  const refreshAuth = useRefreshAuth();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['totp'],
    queryFn: () => api<{ enabled: boolean; recoveryCodesLeft: number }>('/auth/totp'),
  });
  const [setup, setSetup] = useState<{ qrDataUrl: string; secret: string }>();
  const [codes, setCodes] = useState<string[]>();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [disabling, setDisabling] = useState(false);

  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['totp'] });
    await refreshAuth();
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const begin = () => run(async () => setSetup(await api('/auth/totp/setup', { method: 'POST' })));

  const confirm = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const res = await api<{ recoveryCodes: string[] }>('/auth/totp/confirm', { body: { code } });
      setCodes(res.recoveryCodes);
      setSetup(undefined);
      setCode('');
      await done();
    });
  };

  const disable = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      await api('/auth/totp/disable', { body: { password, code } });
      setDisabling(false);
      setPassword('');
      setCode('');
      await done();
    });
  };

  const enabled = status.data?.enabled;

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        {enabled ? <ShieldCheck className="size-5 shrink-0 text-good" /> : <ShieldOff className="size-5 shrink-0 text-warning" />}
        <h2 className="font-semibold">Zwei-Faktor-Anmeldung</h2>
        {status.data && <Badge tone={enabled ? 'good' : 'warning'}>{enabled ? 'Aktiv' : 'Nicht aktiv'}</Badge>}
      </div>

      {codes && <RecoveryCodes codes={codes} onClose={() => setCodes(undefined)} />}

      {!codes && !enabled && !setup && (
        <div className="space-y-4">
          <p className="text-sm text-text-2">
            Schützt den Zugang zusätzlich mit einem Code aus einer Authenticator-App (z. B. Aegis, 2FAS, Google Authenticator).
            Dringend empfohlen, da PrintHub aus dem Internet erreichbar ist.
          </p>
          <Button onClick={begin} loading={busy}>
            2FA einrichten
          </Button>
        </div>
      )}

      {setup && (
        <form onSubmit={confirm} className="space-y-4">
          <p className="text-sm text-text-2">Scanne den QR-Code mit deiner Authenticator-App und gib den angezeigten Code ein.</p>
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            <img src={setup.qrDataUrl} alt="QR-Code für die Authenticator-App" className="size-48 rounded-lg bg-white p-2" />
            <div className="min-w-0 space-y-1 text-sm">
              <div className="text-text-3">Oder manuell eingeben:</div>
              <code className="block break-all rounded bg-surface-2 px-2 py-1 font-mono text-xs">{setup.secret}</code>
            </div>
          </div>
          <Field label="Code aus der App">
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className="tabular max-w-40 tracking-widest"
              required
            />
          </Field>
          {error && <Alert>{error}</Alert>}
          <div className="flex gap-2">
            <Button type="submit" loading={busy}>
              Aktivieren
            </Button>
            <Button type="button" variant="ghost" onClick={() => setSetup(undefined)}>
              Abbrechen
            </Button>
          </div>
        </form>
      )}

      {!codes && enabled && !disabling && (
        <div className="space-y-4">
          <p className="text-sm text-text-2">
            Noch {status.data?.recoveryCodesLeft ?? 0} unbenutzte Wiederherstellungscodes.
          </p>
          <Button variant="secondary" onClick={() => setDisabling(true)}>
            2FA deaktivieren
          </Button>
        </div>
      )}

      {enabled && disabling && (
        <form onSubmit={disable} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Passwort">
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Field label="Code oder Wiederherstellungscode">
              <Input autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
            </Field>
          </div>
          {error && <Alert>{error}</Alert>}
          <div className="flex gap-2">
            <Button type="submit" variant="danger" loading={busy}>
              Deaktivieren
            </Button>
            <Button type="button" variant="ghost" onClick={() => setDisabling(false)}>
              Abbrechen
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-4">
      <Alert tone="warning">
        Speichere diese Wiederherstellungscodes sicher (z. B. im Passwortmanager). Jeder Code funktioniert einmal, falls du
        keinen Zugriff auf die App hast. Sie werden nur jetzt angezeigt.
      </Alert>
      <div className="grid grid-cols-2 gap-2 rounded-lg bg-surface-2 p-4 font-mono text-sm">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(codes.join('\n'));
            setCopied(true);
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />} Kopieren
        </Button>
        <Button onClick={onClose}>Gespeichert</Button>
      </div>
    </div>
  );
}

function SessionsCard() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<SessionInfo[]>('/auth/sessions') });
  const reload = () => qc.invalidateQueries({ queryKey: ['sessions'] });

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Angemeldete Geräte</h2>
        {(sessions.data?.length ?? 0) > 1 && (
          <Button variant="secondary" onClick={() => api('/auth/sessions/revoke-others', { method: 'POST' }).then(reload)}>
            Alle anderen abmelden
          </Button>
        )}
      </div>
      <div className="divide-y divide-border">
        {sessions.data?.map((s) => (
          <div key={s.id} className="flex items-center gap-3 py-3">
            <Monitor className="size-4 shrink-0 text-text-3" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{describeAgent(s.userAgent)}</div>
              <div className="text-xs text-text-3">
                {s.ip ?? 'unbekannte IP'} · zuletzt {new Date(s.lastSeenAt).toLocaleString('de-DE')}
              </div>
            </div>
            {s.current ? (
              <Badge tone="good">Dieses Gerät</Badge>
            ) : (
              <Button variant="ghost" onClick={() => api(`/auth/sessions/${s.id}`, { method: 'DELETE' }).then(reload)}>
                Abmelden
              </Button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function describeAgent(ua: string | null): string {
  if (!ua) return 'Unbekanntes Gerät';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} auf ${os}` : browser;
}
