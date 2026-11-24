import { app, pool } from './app';

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
