import { Hono } from 'hono';
import { Pool } from 'pg';

export const pool = new Pool({
  // pg reads PGHOST, PGPORT, PGUSER, PGPASSWORD, and PGDATABASE.
  max: 5,
  connectionTimeoutMillis: 2_000,
  query_timeout: 2_000,
  statement_timeout: 2_000,
  idleTimeoutMillis: 10_000,
});

// A database outage can also disconnect idle clients between requests.
pool.on('error', () => console.error('Idle PostgreSQL connection lost'));

export const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/ready', async (c) => {
  try {
    await pool.query('SELECT 1');
    return c.json({ status: 'ready' });
  } catch {
    return c.json({ status: 'unavailable' }, 503);
  }
});
