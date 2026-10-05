import { useSyncExternalStore } from 'react';
import type { PrinterSummary, ServerMessage, TempSample } from '@printhub/shared';

const HISTORY_MS = 20 * 60 * 1000;

type Listener = () => void;
export type LiveConnection = 'connecting' | 'open' | 'closed';

interface State {
  connection: LiveConnection;
  printers: PrinterSummary[];
  temps: Record<number, TempSample[]>;
}

/**
 * Single websocket to /api/ws shared by the whole app. Exposed to React via
 * useSyncExternalStore; each update replaces the state object immutably.
 */
class LiveStore {
  private state: State = { connection: 'connecting', printers: [], temps: {} };
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private retry = 1000;
  private timer?: number;
  private active = false;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  get = () => this.state;

  start() {
    if (this.active) return;
    this.active = true;
    this.connect();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.set({ connection: 'closed', printers: [], temps: {} });
  }

  /** Seeds the history (e.g. from Moonraker's temperature store) without dropping live samples. */
  seedTemps(printerId: number, samples: TempSample[]) {
    const live = this.state.temps[printerId] ?? [];
    const firstLive = live[0]?.t ?? Infinity;
    const merged = [...samples.filter((s) => s.t < firstLive), ...live];
    this.set({ temps: { ...this.state.temps, [printerId]: merged } });
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    this.ws = ws;
    this.set({ connection: 'connecting' });
    ws.onopen = () => {
      this.retry = 1000;
      this.set({ connection: 'open' });
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data) as ServerMessage);
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.set({ connection: 'closed' });
      if (!this.active) return;
      // 4401: session ended -> let the app re-check auth instead of hammering the server.
      if (ev.code === 4401) {
        window.dispatchEvent(new Event('printhub:session-ended'));
        return;
      }
      this.timer = window.setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 15000);
    };
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'snapshot':
        this.set({ printers: msg.printers });
        break;
      case 'status':
        this.set({
          printers: this.state.printers.map((p) => (p.id === msg.printerId ? { ...p, status: msg.status } : p)),
        });
        break;
      case 'temps': {
        const cutoff = msg.sample.t - HISTORY_MS;
        const prev = this.state.temps[msg.printerId] ?? [];
        const start = prev.findIndex((s) => s.t >= cutoff);
        const next = [...(start > 0 ? prev.slice(start) : prev), msg.sample];
        this.set({ temps: { ...this.state.temps, [msg.printerId]: next } });
        break;
      }
    }
  }

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}

export const live = new LiveStore();

export function useLive<T>(select: (s: State) => T): T {
  return useSyncExternalStore(live.subscribe, () => select(live.get()));
}
