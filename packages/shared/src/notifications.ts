import { z } from 'zod';

export const NOTIFICATION_EVENTS = {
  print_done: 'Druck fertig',
  print_error: 'Druckfehler oder Abbruch',
  print_paused: 'Druck pausiert (z. B. Filament leer)',
  printer_error: 'Klipper-Fehler / Drucker offline während eines Drucks',
  slice_failed: 'Slicen fehlgeschlagen',
  slice_done: 'Slicen fertig',
  bed_check: 'Kamera: Druckbett frei erkannt',
} as const;
export type NotificationEvent = keyof typeof NOTIFICATION_EVENTS;
export const DEFAULT_NOTIFICATION_EVENTS: NotificationEvent[] = ['print_done', 'print_error', 'print_paused', 'printer_error', 'slice_failed', 'bed_check'];

const eventSchema = z.enum(Object.keys(NOTIFICATION_EVENTS) as [NotificationEvent, ...NotificationEvent[]]);

/**
 * Push services of the browsers (Chrome/Edge/Opera via FCM, Firefox, Safari, legacy Edge).
 * The server posts to the endpoint, so it must not be just any address.
 */
const PUSH_HOSTS = /(^|\.)(googleapis\.com|mozilla\.com|push\.apple\.com|notify\.windows\.com)$/i;

export function isPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

export const pushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2048).refine(isPushEndpoint, 'Unbekannter Push-Dienst'),
    keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
  }),
  events: z.array(eventSchema).default(DEFAULT_NOTIFICATION_EVENTS),
});

export const pushUpdateSchema = z.object({
  endpoint: z.string().url().max(2048),
  events: z.array(eventSchema),
});

export interface PushDevice {
  id: number;
  endpoint: string;
  userAgent: string | null;
  events: NotificationEvent[];
  createdAt: number;
  lastSuccessAt: number | null;
}

/** Payload of a push message, rendered by the service worker. */
export interface PushPayload {
  title: string;
  body: string;
  /** App path to open on click. */
  url: string;
  tag?: string;
}
