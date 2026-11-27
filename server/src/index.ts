import { createApp } from './app';
import { loadConfig } from './config';
import { createPool, migrate } from './db';
import { lockExpiredTrials, purgeExpired } from './state';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const applied = await migrate(pool);
  if (applied.length > 0) console.log(`Applied migrations: ${applied.join(', ')}`);

  const app = createApp({ pool, config });
  const server = app.listen(config.port, () => {
    console.log(`Family Screen Warden server listening on port ${config.port} (${config.publicUrl})`);
    if (config.devLinks) console.log('DEV_LINKS=1: sign-in links are returned in the API response. Do not use this in production.');
    if (!config.ses) console.log('Amazon SES is not configured: sign-in links are written to this log.');
    if (!config.billingEnabled) console.log('BILLING_ENABLED is off: no paywall, trials never end.');
    else if (!config.stripeSecretKey) console.log('STRIPE_SECRET_KEY is not set: billing answers 503.');
    if (config.publishToken.length < 32) console.log('PUBLISH_TOKEN is not set (32+ characters): publishing the kids app is off.');
    console.log(`Files (app versions, APKs, photos from texts) are kept in ${config.dataDir}`);
  });

  // Background check: trials that have run out become locked; old tokens are cleared.
  const housekeeping = async (): Promise<void> => {
    try {
      // BILLING_ENABLED off: trials never end, nobody is locked.
      if (config.billingEnabled) {
        const locked = await lockExpiredTrials(pool);
        if (locked > 0) console.log(`Locked ${locked} account(s) whose trial ended.`);
      }
      await purgeExpired(pool, config.dataDir);
    } catch (err) {
      console.error('Housekeeping failed:', err instanceof Error ? err.message : err);
    }
  };
  void housekeeping();
  const timer = setInterval(() => void housekeeping(), 10 * 60 * 1000);
  timer.unref();

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down.`);
    clearInterval(timer);
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
