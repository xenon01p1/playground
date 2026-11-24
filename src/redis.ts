import Redis from 'ioredis';

// This cache client fails fast. Future queue workers need separate connections
// and different retry settings; do not reuse this client for blocking jobs.
export const redis = new Redis({
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6380),
  lazyConnect: true,
  connectTimeout: 500,
  commandTimeout: 500,
  socketTimeout: 1_000,
  maxRetriesPerRequest: 0,
  enableOfflineQueue: false,
  autoResendUnfulfilledCommands: false,
  retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
});

// Keep details in server logs, never in HTTP responses.
redis.on('error', (error) => console.error('Redis connection failed', error));
