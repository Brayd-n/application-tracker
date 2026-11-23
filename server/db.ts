import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';

// Return DATE columns as 'YYYY-MM-DD' strings instead of Dates, so they never shift by a time zone.
pg.types.setTypeParser(1082, (v) => v);

// Connection settings come from the standard PG* environment variables (PGHOST, PGUSER, PGPASSWORD, ...).
export function createPool() {
  return new pg.Pool({ max: 5 });
}

// Applies server/migrations/*.sql in name order, each once. An advisory lock stops two starting
// containers from racing each other.
export async function migrate(pool: pg.Pool) {
  const dir = new URL('./migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(4242)');
    await client.query('CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM migrations')).rows.map((r) => r.name));
    for (const f of files.filter((f) => !done.has(f))) {
      await client.query('BEGIN');
      await client.query(await readFile(new URL(f, dir), 'utf8'));
      await client.query('INSERT INTO migrations (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.query('SELECT pg_advisory_unlock(4242)').catch(() => {});
    client.release();
  }
}
