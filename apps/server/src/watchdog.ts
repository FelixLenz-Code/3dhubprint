import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { FastifyBaseLogger } from 'fastify';

const CHECK_MS = 30_000;
const CHECK_TIMEOUT_MS = 10_000;
/** Unanswered checks in a row before the process is ended (~2 min). */
const MAX_FAILURES = 4;
const STATS_MS = 30_000;
/** How often the vitals go to the regular log, so slow growth shows up there. */
const HEARTBEAT_MS = 15 * 60_000;
const LOG_LIMIT = 1024 * 1024;

/**
 * Runs in its own thread, so it keeps working while the main thread hangs. Asks the server
 * for /api/health; when it stops answering, it writes the last known vitals to stderr and
 * <data>/watchdog.log and kills the process, so Docker's restart policy starts it again
 * (Docker never restarts a container that is merely unhealthy). Writes with writeSync:
 * a worker's process.stderr goes through the (hung) main thread.
 */
const WORKER = `
const fs = require('node:fs');
const { parentPort, workerData: w } = require('node:worker_threads');
let stats = {};
let failures = 0;
parentPort.on('message', (m) => (stats = m));
const write = (msg, extra) => {
  const line = JSON.stringify({ level: 60, time: Date.now(), module: 'watchdog', msg, failures, ...extra, stats }) + '\\n';
  try { fs.writeSync(2, line); } catch {}
  try {
    if (fs.existsSync(w.logFile) && fs.statSync(w.logFile).size > w.logLimit) fs.renameSync(w.logFile, w.logFile + '.1');
    fs.appendFileSync(w.logFile, line);
  } catch {}
};
setInterval(async () => {
  try {
    await fetch(w.url, { signal: AbortSignal.timeout(w.timeoutMs) });
    failures = 0;
  } catch (err) {
    failures++;
    if (failures < w.maxFailures) return;
    write('server not answering, restarting', { err: String(err && err.message || err) });
    process.kill(process.pid, 'SIGKILL');
  }
}, w.checkMs);
`;

export function startWatchdog(opts: { host: string; port: number; dataDir: string; log: FastifyBaseLogger; extra?: () => Record<string, unknown> }) {
  const host = opts.host === '0.0.0.0' || opts.host === '::' ? '127.0.0.1' : opts.host;
  const worker = new Worker(WORKER, {
    eval: true,
    workerData: {
      url: `http://${host.includes(':') ? `[${host}]` : host}:${opts.port}/api/health`,
      logFile: path.join(opts.dataDir, 'watchdog.log'),
      logLimit: LOG_LIMIT,
      checkMs: CHECK_MS,
      timeoutMs: CHECK_TIMEOUT_MS,
      maxFailures: MAX_FAILURES,
    },
  });
  worker.unref();
  worker.on('error', (err) => opts.log.error({ err }, 'watchdog failed'));

  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const vitals = () => {
    const m = process.memoryUsage();
    const mb = (n: number) => Math.round(n / 1048576);
    let fds: number | undefined;
    try {
      fds = fs.readdirSync('/proc/self/fd').length;
    } catch {
      /* not Linux */
    }
    const v = {
      uptimeMin: Math.round(process.uptime() / 60),
      rssMb: mb(m.rss),
      heapMb: mb(m.heapUsed),
      externalMb: mb(m.external),
      fds,
      resources: process.getActiveResourcesInfo().length,
      loopDelayMaxMs: Math.round(delay.max / 1e6),
      loopDelayP99Ms: Math.round(delay.percentile(99) / 1e6),
      ...opts.extra?.(),
    };
    delay.reset();
    return v;
  };

  let lastHeartbeat = Date.now();
  let peakDelay = 0;
  const timer = setInterval(() => {
    const v = vitals();
    worker.postMessage(v);
    peakDelay = Math.max(peakDelay, v.loopDelayMaxMs);
    if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
      opts.log.info({ ...v, loopDelayMaxMs: peakDelay }, 'vitals');
      lastHeartbeat = Date.now();
      peakDelay = 0;
    }
  }, STATS_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    delay.disable();
    void worker.terminate();
  };
}
