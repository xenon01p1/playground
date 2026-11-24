import { expect, mock, test } from 'bun:test';
import { createApp } from '../src/app';

function fixture() {
  const product = { id: 1, name: 'Race test', price: 1299, stock: 100 };
  const order = { id: 7, product_id: 1, quantity: 10, total: 12990 };
  const steps: string[] = [];
  const db = {
    query: mock(
      async (
        sql: string,
        _values?: unknown[],
      ): Promise<{ rows: Record<string, unknown>[] }> => {
        if (sql.startsWith('SELECT')) {
          steps.push('read product');
          return { rows: [product] };
        }
        if (sql.startsWith('UPDATE')) {
          steps.push('update stock');
          return { rows: [] };
        }
        steps.push('insert order');
        return { rows: [order] };
      },
    ),
  };
  const cache = {
    get: mock(async (_key: string): Promise<string | null> => null),
    set: mock(
      async (_key: string, _value: string, _mode: 'EX', _ttl: number) => 'OK',
    ),
    del: mock(async (_key: string) => {
      steps.push('invalidate');
      return 1;
    }),
  };
  const app = createApp(db, cache);
  const request = (body: unknown) =>
    app.request('/orders/unsafe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, request, db, cache, product, order, steps };
}

test('unsafe order reads PostgreSQL, writes calculated stock, inserts integer total, then invalidates', async () => {
  const { request, db, cache, order, steps } = fixture();
  const response = await request({ productId: 1, quantity: 10 });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(order);
  expect(steps).toEqual([
    'read product',
    'update stock',
    'insert order',
    'invalidate',
  ]);
  expect(db.query).toHaveBeenNthCalledWith(
    1,
    'SELECT * FROM products WHERE id = $1',
    [1],
  );
  expect(db.query).toHaveBeenNthCalledWith(
    2,
    'UPDATE products SET stock = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
    [90, 1],
  );
  expect(db.query).toHaveBeenNthCalledWith(
    3,
    'INSERT INTO orders (product_id, quantity, total) VALUES ($1, $2, $3) RETURNING *',
    [1, 10, 12990],
  );
  expect(cache.del).toHaveBeenCalledWith('cache:product:1');
  expect(cache.get).not.toHaveBeenCalled();
  expect(cache.set).not.toHaveBeenCalled();
});

test('unsafe order rejects malformed JSON and invalid identifiers/quantities before querying', async () => {
  const { app, request, db } = fixture();
  expect(
    (await app.request('/orders/unsafe', { method: 'POST', body: '{bad' }))
      .status,
  ).toBe(400);
  for (const body of [
    null,
    [],
    {},
    { productId: 1 },
    { productId: '1', quantity: 10 },
    { productId: 0, quantity: 10 },
    { productId: -1, quantity: 10 },
    { productId: 1.5, quantity: 10 },
    { productId: 2147483648, quantity: 10 },
    { productId: 1, quantity: 0 },
    { productId: 1, quantity: -1 },
    { productId: 1, quantity: 1.5 },
    { productId: 1, quantity: '10' },
    { productId: 1, quantity: 2147483648 },
    { productId: 1, quantity: 10, total: 1 },
  ]) {
    expect((await request(body)).status).toBe(400);
  }
  expect(db.query).not.toHaveBeenCalled();
});

test('unsafe order returns 404 for a missing product without writing or invalidating', async () => {
  const { request, db, cache } = fixture();
  db.query.mockResolvedValue({ rows: [] });
  expect((await request({ productId: 1, quantity: 10 })).status).toBe(404);
  expect(db.query).toHaveBeenCalledTimes(1);
  expect(cache.del).not.toHaveBeenCalled();
});

test('unsafe order returns 409 for insufficient stock without writing or invalidating', async () => {
  const { request, db, cache, product } = fixture();
  product.stock = 9;
  expect((await request({ productId: 1, quantity: 10 })).status).toBe(409);
  expect(db.query).toHaveBeenCalledTimes(1);
  expect(cache.del).not.toHaveBeenCalled();
});

test('unsafe order rejects a total outside PostgreSQL INTEGER range before writing', async () => {
  const { request, db, cache, product } = fixture();
  product.price = 2147483647;
  expect((await request({ productId: 1, quantity: 10 })).status).toBe(400);
  expect(db.query).toHaveBeenCalledTimes(1);
  expect(cache.del).not.toHaveBeenCalled();
});

test('unsafe order preserves success if Redis invalidation fails', async () => {
  const { request, cache } = fixture();
  cache.del.mockRejectedValue(new Error('Redis down'));
  const original = console.error;
  const logs = mock(() => {});
  console.error = logs;
  try {
    expect((await request({ productId: 1, quantity: 10 })).status).toBe(201);
    expect(logs).toHaveBeenCalled();
  } finally {
    console.error = original;
  }
});

test('unsafe order does not invalidate if the insert fails after the stock update', async () => {
  const { request, db, cache } = fixture();
  // Explicit responses demonstrate the partial-write limitation without a transaction.
  db.query.mockReset();
  db.query.mockResolvedValueOnce({ rows: [{ id: 1, price: 100, stock: 100 }] });
  db.query.mockResolvedValueOnce({ rows: [] });
  db.query.mockRejectedValueOnce(new Error('private database error'));
  const original = console.error;
  console.error = () => {};
  try {
    const response = await request({ productId: 1, quantity: 10 });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Service unavailable' });
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(cache.del).not.toHaveBeenCalled();
  } finally {
    console.error = original;
  }
});
