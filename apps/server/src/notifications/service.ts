import webpush from 'web-push';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  DEFAULT_NOTIFICATION_EVENTS,
  type JobInfo,
  type NotificationEvent,
  type PushDevice,
  type PushPayload,
} from '@printhub/shared';
import type { Db } from '../db/index.js';
import { appSettings, pushSubscriptions } from '../db/schema.js';
import type { SecretBox } from '../crypto.js';
import type { PrinterManager } from '../printers/manager.js';
import type { PrintEvent } from '../printers/events.js';
import type { SlicingService } from '../slicer/service.js';
import type { BedCheckService } from '../bedcheck/service.js';

const MAX_FAILURES = 5;

const fmtDuration = (s?: number) => {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
const fileLabel = (f?: string) => (f ? f.split('/').pop()!.replace(/\.gcode$/i, '') : 'Druck');

/** Web Push (VAPID) to every subscribed browser/phone, filtered by the events each device chose. */
export class NotificationService {
  private vapid!: { publicKey: string; privateKey: string };

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly log: FastifyBaseLogger,
    private readonly subject: string,
  ) {
    this.vapid = this.loadKeys();
    webpush.setVapidDetails(subject, this.vapid.publicKey, this.vapid.privateKey);
  }

  get publicKey() {
    return this.vapid.publicKey;
  }

  /** Generated once; the private key is stored encrypted. */
  private loadKeys() {
    const row = this.db.select().from(appSettings).where(eq(appSettings.key, 'vapid')).get();
    if (row) {
      const stored = JSON.parse(row.value) as { publicKey: string; privateKey: string };
      try {
        return { publicKey: stored.publicKey, privateKey: this.box.decrypt(stored.privateKey) };
      } catch {
        // APP_SECRET changed: the old key is unusable, and so are subscriptions made with it.
        this.log.error('VAPID-Schlüssel nicht entschlüsselbar (APP_SECRET geändert?) – erzeuge neue; Geräte müssen Benachrichtigungen neu aktivieren');
        this.db.delete(pushSubscriptions).run();
      }
    }
    const keys = webpush.generateVAPIDKeys();
    const value = JSON.stringify({ publicKey: keys.publicKey, privateKey: this.box.encrypt(keys.privateKey) });
    this.db.insert(appSettings).values({ key: 'vapid', value }).onConflictDoUpdate({ target: appSettings.key, set: { value } }).run();
    return keys;
  }

  subscribe(userId: number, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, events: NotificationEvent[], userAgent: string | null) {
    const existing = this.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint)).get();
    const values = {
      userId,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent: userAgent?.slice(0, 256) ?? null,
      events: JSON.stringify(events),
      failures: 0,
    };
    if (existing) this.db.update(pushSubscriptions).set(values).where(eq(pushSubscriptions.id, existing.id)).run();
    else this.db.insert(pushSubscriptions).values({ ...values, createdAt: Date.now() }).run();
  }

  updateEvents(userId: number, endpoint: string, events: NotificationEvent[]): boolean {
    return (
      this.db
        .update(pushSubscriptions)
        .set({ events: JSON.stringify(events) })
        .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)))
        .run().changes > 0
    );
  }

  unsubscribe(userId: number, endpoint: string) {
    this.db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId))).run();
  }

  removeDevice(userId: number, id: number): boolean {
    return this.db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId))).run().changes > 0;
  }

  devices(userId: number): PushDevice[] {
    return this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .all()
      .map((s) => ({
        id: s.id,
        endpoint: s.endpoint,
        userAgent: s.userAgent,
        events: JSON.parse(s.events),
        createdAt: s.createdAt,
        lastSuccessAt: s.lastSuccessAt,
      }));
  }

  /** Sends to all devices that want `event` (or, for tests, only to one endpoint). */
  async send(event: NotificationEvent | 'test', payload: PushPayload, only?: { endpoint: string; userId: number }): Promise<number> {
    const onlyEndpoint = only?.endpoint;
    const subs = only
      ? this.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, only.userId)).all()
      : this.db.select().from(pushSubscriptions).all();
    let sent = 0;
    await Promise.all(
      subs.map(async (s) => {
        if (onlyEndpoint ? s.endpoint !== onlyEndpoint : event === 'test' || !(JSON.parse(s.events) as string[]).includes(event)) return;
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), {
            TTL: 6 * 3600,
            urgency: event === 'print_error' || event === 'printer_error' ? 'high' : 'normal',
            topic: payload.tag?.slice(0, 32),
          });
          sent++;
          this.db.update(pushSubscriptions).set({ failures: 0, lastSuccessAt: Date.now() }).where(eq(pushSubscriptions.id, s.id)).run();
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // 404/410: the browser dropped the subscription.
          if (status === 404 || status === 410 || s.failures + 1 >= MAX_FAILURES) {
            this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id)).run();
            this.log.info({ status, endpoint: s.endpoint.slice(0, 60) }, 'push subscription removed');
          } else {
            this.db.update(pushSubscriptions).set({ failures: s.failures + 1 }).where(eq(pushSubscriptions.id, s.id)).run();
            this.log.warn({ status, err: (err as Error).message }, 'push failed');
          }
        }
      }),
    );
    return sent;
  }

  /** Camera found the bed empty: asks for confirmation, or reports that it released the bed. */
  attachBedCheck(manager: PrinterManager, bedCheck: BedCheckService) {
    bedCheck.onSuggest = (printerId, auto, waiting) => {
      const next = waiting ? ` Der nächste Auftrag ${auto ? 'startet' : 'startet danach'} (${waiting} in der Warteschlange).` : '';
      const name = manager.name(printerId);
      void this.send(
        'bed_check',
        auto
          ? { title: `🟢 ${name}: Druckbett frei erkannt`, body: `Die Kamera sieht ein leeres Bett und hat es freigegeben.${next}`, url: `/printers/${printerId}`, tag: `printer-${printerId}` }
          : { title: `📷 ${name}: Druckbett frei?`, body: `Die Kamera sieht ein leeres Bett. Bitte kurz bestätigen.${next}`, url: `/printers/${printerId}`, tag: `printer-${printerId}` },
      ).catch((err) => this.log.error({ err }, 'push dispatch failed'));
    };
    bedCheck.onBlocked = (printerId, result) => {
      const name = manager.name(printerId);
      void this.send('bed_check', {
        title: `⚠️ ${name}: Druckstart angehalten`,
        body:
          result.verdict === 'error'
            ? `Die Kamera war vor dem Start nicht erreichbar (${result.error ?? 'Fehler'}). Bett prüfen und freigeben.`
            : 'Die Kamera sieht vor dem Start etwas auf dem Bett. Bett räumen und freigeben, dann startet der Auftrag.',
        url: `/printers/${printerId}`,
        tag: `printer-${printerId}`,
      }).catch((err) => this.log.error({ err }, 'push dispatch failed'));
    };
  }

  /** Translates printer and job events into notifications. */
  attach(manager: PrinterManager, slicing: SlicingService) {
    const fire = (event: NotificationEvent, payload: PushPayload) =>
      void this.send(event, payload).catch((err) => this.log.error({ err }, 'push dispatch failed'));

    manager.on('print', (e: PrintEvent) => {
      const name = manager.name(e.printerId);
      const url = `/printers/${e.printerId}`;
      const tag = `printer-${e.printerId}`;
      switch (e.type) {
        case 'finished': {
          if (e.result === 'complete') {
            const waiting = slicing.waitingCount(e.printerId);
            fire('print_done', {
              title: `✅ ${name}: Druck fertig`,
              body: `${fileLabel(e.filename)}${e.duration ? ` (${fmtDuration(e.duration)})` : ''}. ${
                waiting ? `Bett räumen und bestätigen, dann startet der nächste (${waiting} in der Warteschlange).` : 'Bitte Druckbett räumen.'
              }`,
              url,
              tag,
            });
          } else {
            fire('print_error', {
              title: e.result === 'error' ? `❌ ${name}: Druckfehler` : `⏹ ${name}: Druck abgebrochen`,
              body: `${fileLabel(e.filename)}${e.message ? `: ${e.message}` : ''}`,
              url,
              tag,
            });
          }
          break;
        }
        case 'paused':
          fire('print_paused', {
            title: `⏸ ${name}: Druck pausiert`,
            body: `${fileLabel(e.filename)}${e.message ? `: ${e.message}` : ''}`,
            url,
            tag,
          });
          break;
        case 'klippy_error':
          fire('printer_error', {
            title: `⚠️ ${name}: Klipper-Fehler`,
            body: e.message?.split('\n')[0] ?? 'Klipper ist nicht mehr bereit.',
            url,
            tag,
          });
          break;
        case 'offline_while_printing':
          fire('printer_error', {
            title: `📡 ${name}: nicht erreichbar`,
            body: `Seit über einer Minute keine Verbindung während „${fileLabel(e.filename)}“.`,
            url,
            tag,
          });
          break;
      }
    });

    const lastStatus = new Map<number, string>();
    slicing.on('job', (job: JobInfo) => {
      const before = lastStatus.get(job.id);
      lastStatus.set(job.id, job.status);
      if (before === job.status || before === undefined || job.draft) return;
      const names = job.models.map((m) => m.name).join(', ');
      if (job.status === 'failed') {
        fire('slice_failed', { title: '❌ Slicen fehlgeschlagen', body: `${names}: ${job.error ?? ''}`, url: '/jobs', tag: `job-${job.id}` });
      } else if (job.status === 'sliced' && before === 'slicing') {
        fire('slice_done', { title: '🧩 Slicen fertig', body: `${names} für ${job.printer?.name ?? '?'} ist bereit.`, url: '/jobs', tag: `job-${job.id}` });
      }
    });
    slicing.on('job_removed', (id) => lastStatus.delete(id));
    slicing.on('queue_error', (job, message) =>
      fire('print_error', {
        title: `❌ ${job.printer?.name ?? 'Drucker'}: Warteschlange angehalten`,
        body: `${job.models.map((m) => m.name).join(', ')} konnte nicht gestartet werden: ${message}`,
        url: '/jobs',
        tag: `job-${job.id}`,
      }),
    );
  }
}

export { DEFAULT_NOTIFICATION_EVENTS };
