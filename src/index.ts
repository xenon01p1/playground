import { app, pool } from './app';
import { redis } from './redis';

// Redis is optional: connection failures must not prevent the HTTP server starting.
void redis
  .connect()
  .catch((error) => console.error('Initial Redis connection failed', error));

const server = Bun.serve({
  hostname: '0.0.0.0',
  port: 3000,
  fetch: app.fetch,
});

console.log(`API listening on ${server.hostname}:${server.port}`);

async function shutdown() {
  await server.stop(true);
  redis.disconnect();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
