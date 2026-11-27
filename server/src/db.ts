import { Pool, type PoolClient, types } from 'pg';
import { migrations } from './migrations';

// Return `date` columns as plain 'YYYY-MM-DD' strings (not JS Dates, which would shift with the server time zone).
types.setTypeParser(1082, (v: string) => v);

export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  pool.on('error', (err) => {
    console.error('Postgres pool error:', err.message);
  });
  return pool;
}

/** Applies every migration that has not run yet. Safe to call from several processes at once. */
export async function migrate(pool: Pool): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = await client.query<{ id: string }>('SELECT id FROM migrations');
    const have = new Set(done.rows.map((r) => r.id));
    for (const m of migrations) {
      if (have.has(m.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO migrations (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
        applied.push(m.id);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
  }
  return applied;
}

export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
