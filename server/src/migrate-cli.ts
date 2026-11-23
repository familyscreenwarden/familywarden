import { loadConfig } from './config';
import { createPool, migrate } from './db';

async function main(): Promise<void> {
  const pool = createPool(loadConfig().databaseUrl);
  try {
    const applied = await migrate(pool);
    console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
