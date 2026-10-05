import { useSyncExternalStore } from 'react';
import type { ConsoleLine, JobInfo, PrinterSummary, ServerMessage, TempSample } from '@printhub/shared';

const HISTORY_MS = 20 * 60 * 1000;
const CONSOLE_LINES = 300;

type Listener = () => void;
export type LiveConnection = 'connecting' | 'open' | 'closed';

interface State {
  connection: LiveConnection;
  printers: PrinterSummary[];
  temps: Record<number, TempSample[]>;
  consoles: Record<number, ConsoleLine[]>;
  /** null until the initial job list has been loaded. */
  jobs: JobInfo[] | null;
}

/**
 * Single websocket to /api/ws shared by the whole app. Exposed to React via
 * useSyncExternalStore; each update replaces the state object immutably.
 */
class LiveStore {
  private state: State = { connection: 'connecting', printers: [], temps: {}, consoles: {}, jobs: null };
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
    this.set({ connection: 'closed', printers: [], temps: {}, consoles: {}, jobs: null });
  }

  /** Seeds the history (e.g. from Moonraker's temperature store) without dropping live samples. */
  seedTemps(printerId: number, samples: TempSample[]) {
    const live = this.state.temps[printerId] ?? [];
    const firstLive = live[0]?.t ?? Infinity;
    const merged = [...samples.filter((s) => s.t < firstLive), ...live];
    this.set({ temps: { ...this.state.temps, [printerId]: merged } });
  }

  /** Seeds the console from the server's buffer; live lines received meanwhile are kept. */
  seedConsole(printerId: number, lines: ConsoleLine[]) {
    const live = this.state.consoles[printerId] ?? [];
    const firstLive = live[0]?.t ?? Infinity;
    const merged = [...lines.filter((l) => l.t < firstLive), ...live].slice(-CONSOLE_LINES);
    this.set({ consoles: { ...this.state.consoles, [printerId]: merged } });
  }

  setJobs(jobs: JobInfo[]) {
    this.set({ jobs });
  }

  /** Inserts or replaces a job (newest first). */
  upsertJob(job: JobInfo) {
    if (!this.state.jobs) return;
    const rest = this.state.jobs.filter((j) => j.id !== job.id);
    this.set({ jobs: [job, ...rest].sort((a, b) => b.createdAt - a.createdAt) });
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    this.ws = ws;
    this.set({ connection: 'connecting' });
    ws.onopen = () => {
      this.retry = 1000;
      this.set({ connection: 'open', jobs: null });
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
      case 'job':
        this.upsertJob(msg.job);
        break;
      case 'job_removed':
        if (this.state.jobs) this.set({ jobs: this.state.jobs.filter((j) => j.id !== msg.id) });
        break;
      case 'console': {
        const next = [...(this.state.consoles[msg.printerId] ?? []), ...msg.lines].slice(-CONSOLE_LINES);
        this.set({ consoles: { ...this.state.consoles, [msg.printerId]: next } });
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
