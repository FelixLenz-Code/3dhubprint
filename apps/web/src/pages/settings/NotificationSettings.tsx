import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, Smartphone, Trash2 } from 'lucide-react';
import { DEFAULT_NOTIFICATION_EVENTS, NOTIFICATION_EVENTS, type NotificationEvent, type PushDevice } from '@printhub/shared';
import { api } from '../../lib/api';
import { toast, useAction } from '../../lib/feedback';
import { Alert, Badge, Button, Card, Spinner } from '../../components/ui';

type Support = { ok: true } | { ok: false; reason: string };

function pushSupport(): Support {
  if (!window.isSecureContext) return { ok: false, reason: 'Benachrichtigungen funktionieren nur über HTTPS (also über deine Domain, nicht über die LAN-IP).' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    return {
      ok: false,
      reason: ios
        ? 'Auf iPhone/iPad gehen Benachrichtigungen nur, wenn PrintHub über „Teilen → Zum Home-Bildschirm“ installiert und von dort geöffnet wird (ab iOS 16.4).'
        : 'Dieser Browser unterstützt keine Push-Benachrichtigungen.',
    };
  }
  return { ok: true };
}

function keyToBytes(base64url: string): Uint8Array {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function NotificationSettings() {
  const support = pushSupport();
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ['push-devices'], queryFn: () => api<PushDevice[]>('/push/devices') });
  const [subscription, setSubscription] = useState<PushSubscription | null | undefined>(undefined);
  const { busy, run } = useAction();

  useEffect(() => {
    if (!support.ok) return setSubscription(null);
    void navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then(setSubscription);
  }, [support.ok]);

  const reload = () => qc.invalidateQueries({ queryKey: ['push-devices'] });
  const thisDevice = devices.data?.find((d) => d.endpoint === subscription?.endpoint);
  const events = thisDevice?.events ?? DEFAULT_NOTIFICATION_EVENTS;

  const enable = () =>
    run('enable', async () => {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Benachrichtigungen wurden im Browser nicht erlaubt.');
      const { publicKey } = await api<{ publicKey: string }>('/push/key');
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) as BufferSource }));
      await api('/push/subscribe', { body: { subscription: sub.toJSON(), events } });
      setSubscription(sub);
      await reload();
      toast('Benachrichtigungen auf diesem Gerät aktiviert');
    });

  const disable = () =>
    run('disable', async () => {
      if (subscription) {
        await api('/push/subscription', { method: 'DELETE', body: { endpoint: subscription.endpoint } });
        await subscription.unsubscribe();
      }
      setSubscription(null);
      await reload();
    });

  const toggle = (e: NotificationEvent) =>
    run(`ev-${e}`, async () => {
      const next = events.includes(e) ? events.filter((x) => x !== e) : [...events, e];
      await api('/push/subscription', { method: 'PUT', body: { endpoint: subscription!.endpoint, events: next } });
      await reload();
    });

  return (
    <div className="space-y-6">
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {thisDevice ? <Bell className="size-5 shrink-0 text-good" /> : <BellOff className="size-5 shrink-0 text-text-3" />}
          <h2 className="font-semibold">Dieses Gerät</h2>
          {subscription !== undefined && <Badge tone={thisDevice ? 'good' : 'neutral'}>{thisDevice ? 'Aktiv' : 'Aus'}</Badge>}
        </div>

        {!support.ok ? (
          <Alert tone="warning">{support.reason}</Alert>
        ) : subscription === undefined || devices.isLoading ? (
          <Spinner />
        ) : !thisDevice ? (
          <>
            <p className="text-sm text-text-2">Push-Nachrichten aufs Handy oder den PC, wenn ein Druck fertig ist, ein Fehler auftritt oder das Filament ausgeht.</p>
            {Notification.permission === 'denied' && (
              <Alert tone="warning">Benachrichtigungen sind in den Browser-Einstellungen für diese Seite blockiert. Bitte dort erlauben.</Alert>
            )}
            <Button onClick={enable} loading={busy === 'enable'} disabled={Notification.permission === 'denied'}>
              <Bell className="size-4" /> Benachrichtigungen aktivieren
            </Button>
          </>
        ) : (
          <>
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm text-text-2">Benachrichtigen bei:</legend>
              {(Object.entries(NOTIFICATION_EVENTS) as [NotificationEvent, string][]).map(([key, label]) => (
                <label key={key} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={events.includes(key)}
                    onChange={() => toggle(key)}
                    disabled={busy === `ev-${key}`}
                    className="mt-1 shrink-0 accent-[var(--accent)]"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  run('test', async () => {
                    const r = await api<{ sent: number }>('/push/test', { body: { endpoint: subscription!.endpoint } });
                    if (!r.sent) throw new Error('Test konnte nicht zugestellt werden.');
                  }, 'Test gesendet')
                }
                loading={busy === 'test'}
              >
                Test senden
              </Button>
              <Button variant="ghost" onClick={disable} loading={busy === 'disable'}>
                Auf diesem Gerät deaktivieren
              </Button>
            </div>
          </>
        )}
      </Card>

      {!!devices.data?.filter((d) => d.endpoint !== subscription?.endpoint).length && (
        <Card className="p-5">
          <h2 className="mb-3 font-semibold">Weitere Geräte</h2>
          <ul className="divide-y divide-border">
            {devices.data
              .filter((d) => d.endpoint !== subscription?.endpoint)
              .map((d) => (
                <li key={d.id} className="flex items-center gap-3 py-2.5">
                  <Smartphone className="size-4 shrink-0 text-text-3" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{describeAgent(d.userAgent)}</div>
                    <div className="text-xs text-text-3">
                      {d.events.length} Ereignisse · zuletzt zugestellt {d.lastSuccessAt ? new Date(d.lastSuccessAt).toLocaleString('de-DE') : 'noch nie'}
                    </div>
                  </div>
                  <Button variant="ghost" onClick={() => run(`rm-${d.id}`, async () => { await api(`/push/devices/${d.id}`, { method: 'DELETE' }); await reload(); })} aria-label="Gerät entfernen">
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function describeAgent(ua: string | null): string {
  if (!ua) return 'Unbekanntes Gerät';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} auf ${os}` : browser;
}
