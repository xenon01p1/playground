// Explicit opt-in: needs the running Compose stack and stops/restarts its Redis.
// This is not named *.test.ts, so default bun test / CI never runs it.
import assert from 'node:assert/strict';
import { redis } from '../src/redis';
import type { Product } from '../src/app';

const base = process.env.API_BASE_URL ?? 'http://127.0.0.1:3100';
const ids = new Set<number>();
let redisStopped = false;

async function compose(...args: string[]) {
  const child = Bun.spawn(['docker', 'compose', ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  assert.equal(
    await child.exited,
    0,
    `docker compose ${args.join(' ')} failed`,
  );
}

async function request(path: string, method = 'GET', body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
}

async function get(id: number, status: number, cache: string) {
  const response = await request(`/products/${id}`);
  assert.equal(response.status, status);
  assert.equal(response.headers.get('X-Cache'), cache);
  return response;
}

async function create() {
  const response = await request('/products', 'POST', {
    name: `Cache integration ${crypto.randomUUID()}`,
    price: 1299,
    stock: 5,
  });
  assert.equal(response.status, 201);
  const product = (await response.json()) as Product;
  ids.add(product.id);
  return product.id;
}

async function waitForRedis() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await redis.ping()) === 'PONG') return;
    } catch {
      // Reconnection runs in the background, with no offline command queue.
    }
    await Bun.sleep(200);
  }
  throw new Error('Redis did not reconnect within 10 seconds');
}

try {
  await redis.connect();
  const id = await create();
  const key = `cache:product:${id}`;
  await get(id, 200, 'MISS');
  await get(id, 200, 'HIT');
  const cached = await redis.get(key);
  assert.ok(cached);
  assert.equal(JSON.parse(cached).price, 1299);
  const ttl = await redis.ttl(key);
  assert.ok(ttl > 0 && ttl <= 60);
  console.log(
    `PASS: MISS → HIT, cached JSON and TTL=${ttl}s; waiting for actual 60s expiration`,
  );
  await Bun.sleep(31_000);
  console.log('TTL expiration check continues');
  await Bun.sleep(30_000);
  assert.equal(await redis.exists(key), 0);
  await get(id, 200, 'MISS');
  console.log('PASS: actual TTL expiration → MISS');

  const updated = await request(`/products/${id}`, 'PATCH', { price: 1599 });
  assert.equal(updated.status, 200);
  assert.equal(await redis.exists(key), 0);
  assert.equal(
    ((await (await get(id, 200, 'MISS')).json()) as Product).price,
    1599,
  );
  await get(id, 200, 'HIT');
  assert.equal((await request(`/products/${id}`, 'DELETE')).status, 204);
  assert.equal(await redis.exists(key), 0);
  await get(id, 404, 'MISS');
  assert.equal(await redis.exists(key), 0);
  ids.delete(id);
  console.log(
    'PASS: PATCH/DELETE invalidation and nonexistent products not cached',
  );

  const outageId = await create();
  // Keep this key cold so recovery is deterministic even with Redis persistence.
  await compose('stop', 'redis');
  redisStopped = true;
  const started = performance.now();
  await get(outageId, 200, 'BYPASS');
  console.log(
    `PASS: stopped Redis → BYPASS in ${Math.round(performance.now() - started)}ms`,
  );
  assert.equal(
    (await request(`/products/${outageId}`, 'PATCH', { stock: 9 })).status,
    200,
  );
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/ready')).status, 200);
  const deleteId = await create();
  assert.equal((await request(`/products/${deleteId}`, 'DELETE')).status, 204);
  ids.delete(deleteId);
  console.log(
    'PASS: POST/PATCH/DELETE succeed during outage; health/readiness preserved',
  );
  await compose('start', 'redis');
  redisStopped = false;
  await waitForRedis();
  // The server uses its own connection and can reconnect up to 2s later.
  let recovered = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await request(`/products/${outageId}`);
    if (response.headers.get('X-Cache') === 'MISS') {
      assert.equal(((await response.json()) as Product).stock, 9);
      recovered = true;
      break;
    }
    assert.equal(response.headers.get('X-Cache'), 'BYPASS');
    await Bun.sleep(200);
  }
  assert.ok(recovered, 'API cache connection did not recover');
  await get(outageId, 200, 'HIT');
  console.log('PASS: Redis restart → MISS → HIT without restarting API');
} finally {
  if (redisStopped) await compose('start', 'redis');
  try {
    for (const id of ids) {
      assert.equal((await request(`/products/${id}`, 'DELETE')).status, 204);
    }
  } finally {
    redis.disconnect();
  }
}
