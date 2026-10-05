import type { ConnectionState, PrintState, PrinterStatus } from '@printhub/shared';

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '–';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${m.toString().padStart(2, '0')} min`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

export function formatClock(secondsFromNow: number | undefined): string {
  if (secondsFromNow === undefined) return '–';
  const d = new Date(Date.now() + secondsFromNow * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('de-DE', sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

export const formatTemp = (t: number | undefined) => (t === undefined ? '–' : `${t.toFixed(1)}°`);

export function formatFilament(mm: number | undefined): string {
  if (mm === undefined) return '–';
  return mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`;
}

export function fileLabel(path: string | undefined): string {
  if (!path) return '';
  return path.split('/').pop()!.replace(/\.gcode$/i, '');
}

export type Tone = 'good' | 'warning' | 'critical' | 'info' | 'neutral';

/** One badge per printer combining connection and print state. */
export function statusBadge(s: PrinterStatus): { label: string; tone: Tone } {
  const conn: Record<ConnectionState, { label: string; tone: Tone } | null> = {
    connecting: { label: 'Verbinde…', tone: 'neutral' },
    offline: { label: 'Offline', tone: 'critical' },
    disabled: { label: 'Deaktiviert', tone: 'neutral' },
    klippy_not_ready: {
      label: s.klippyState === 'shutdown' ? 'Klipper Shutdown' : s.klippyState === 'error' ? 'Klipper Fehler' : 'Klipper startet',
      tone: s.klippyState === 'startup' ? 'warning' : 'critical',
    },
    connected: null,
  };
  const c = conn[s.connection];
  if (c) return c;
  const print: Record<PrintState, { label: string; tone: Tone }> = {
    standby: { label: 'Bereit', tone: 'good' },
    printing: { label: 'Druckt', tone: 'info' },
    paused: { label: 'Pausiert', tone: 'warning' },
    complete: { label: 'Fertig', tone: 'good' },
    cancelled: { label: 'Abgebrochen', tone: 'warning' },
    error: { label: 'Fehler', tone: 'critical' },
  };
  return print[s.printState ?? 'standby'];
}

export const isActivePrint = (s: PrinterStatus) =>
  s.connection === 'connected' && (s.printState === 'printing' || s.printState === 'paused');
