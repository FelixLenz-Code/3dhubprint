import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, api } from '../lib/api';
import { useRefreshAuth } from '../lib/auth';
import { Alert, Button, Card, Field, Input } from '../components/ui';

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6 sm:p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="/icon.svg" alt="" className="mb-4 size-12" />
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-text-2">{subtitle}</p>
        </div>
        {children}
      </Card>
    </div>
  );
}

export function SetupPage() {
  const refreshAuth = useRefreshAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('Passwörter stimmen nicht überein');
    setBusy(true);
    setError(undefined);
    try {
      await api('/auth/setup', { body: { username, password } });
      await refreshAuth();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Willkommen bei PrintHub" subtitle="Lege das Administrator-Konto an.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Benutzername">
          <Input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} autoFocus />
        </Field>
        <Field label="Passwort" hint="Mindestens 12 Zeichen. Eine Passphrase aus mehreren Wörtern ist ideal.">
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} />
        </Field>
        <Field label="Passwort wiederholen">
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </Field>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" loading={busy} className="w-full">
          Konto anlegen
        </Button>
      </form>
    </AuthShell>
  );
}

export function LoginPage() {
  const refreshAuth = useRefreshAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/auth/login', { body: { username, password, code: needsCode ? code : undefined } });
      await refreshAuth();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totp_required') {
        setNeedsCode(true);
      } else {
        setError((err as Error).message);
        if (err instanceof ApiError && err.code === 'invalid_code') setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={needsCode ? 'Bestätigung' : 'Anmelden'}
      subtitle={needsCode ? 'Code aus deiner Authenticator-App oder ein Wiederherstellungscode' : 'PrintHub'}
    >
      <form onSubmit={submit} className="space-y-4">
        {needsCode ? (
          <Field label="Code">
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className="tabular text-center text-lg tracking-widest"
              autoFocus
              required
            />
          </Field>
        ) : (
          <>
            <Field label="Benutzername">
              <Input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
            </Field>
            <Field label="Passwort">
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
          </>
        )}
        {error && <Alert>{error}</Alert>}
        <Button type="submit" loading={busy} className="w-full">
          {needsCode ? 'Bestätigen' : 'Anmelden'}
        </Button>
        {needsCode && (
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => {
              setNeedsCode(false);
              setCode('');
              setError(undefined);
            }}
          >
            Zurück
          </Button>
        )}
      </form>
    </AuthShell>
  );
}
