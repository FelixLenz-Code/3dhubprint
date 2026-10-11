import { config } from './config.js';
import { buildApp } from './app.js';
import { startWatchdog } from './watchdog.js';

const app = await buildApp();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
// A hung server is ended so Docker restarts it; it also logs its vitals now and then.
if (config.isProd) startWatchdog({ host: config.HOST, port: config.PORT, dataDir: config.dataDir, log: app.log.child({ module: 'watchdog' }) });
