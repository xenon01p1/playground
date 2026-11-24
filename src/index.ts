import { Hono } from 'hono';
import { Pool } from 'pg';

const pool = new Pool({
  // pg reads PGHOST, PGPORT, PGUSER, PGPASSWORD, and PGDATABASE.
  max: 5,
  connectionTimeoutMillis: 2_000,
  query_timeout: 2_000,
  statement_timeout: 2_000,
  idleTimeoutMillis: 10_000,
});

// A database outage can also disconnect idle clients between requests.
pool.on('error', () => console.error('Idle PostgreSQL connection lost'));

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/ready', async (c) => {
  try {
    await pool.query('SELECT 1');
    return c.json({ status: 'ready' });
  } catch {
    return c.json({ status: 'unavailable' }, 503);
  }
});

const server = Bun.serve({
  hostname: '0.0.0.0',
  port: 3000,
  fetch: app.fetch,
});

console.log(`API listening on ${server.hostname}:${server.port}`);

async function shutdown() {
  await server.stop(true);
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
