import { z } from 'zod';

export const NOTIFICATION_EVENTS = {
  print_done: 'Druck fertig',
  print_error: 'Druckfehler oder Abbruch',
  print_paused: 'Druck pausiert (z. B. Filament leer)',
  printer_error: 'Klipper-Fehler / Drucker offline während eines Drucks',
  slice_failed: 'Slicen fehlgeschlagen',
  slice_done: 'Slicen fertig',
} as const;
export type NotificationEvent = keyof typeof NOTIFICATION_EVENTS;
export const DEFAULT_NOTIFICATION_EVENTS: NotificationEvent[] = ['print_done', 'print_error', 'print_paused', 'printer_error', 'slice_failed'];

const eventSchema = z.enum(Object.keys(NOTIFICATION_EVENTS) as [NotificationEvent, ...NotificationEvent[]]);

export const pushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2048),
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
