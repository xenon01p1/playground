import { describe, expect, mock, test } from 'bun:test';
import { createApp, type Product } from '../src/app';

const product: Product = {
  id: 1,
  name: 'Coffee',
  price: 1299,
  stock: 5,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function fixture() {
  const db = {
    query: mock(async (_sql: string, _values?: unknown[]) => ({
      rows: [product],
    })),
  };
  const cache = {
    get: mock(async (_key: string): Promise<string | null> => null),
    set: mock(
      async (_key: string, _value: string, _mode: 'EX', _ttl: number) => 'OK',
    ),
    del: mock(async (_key: string) => 1),
  };
  return { app: createApp(db, cache), db, cache };
}

function jsonRequest(method: string, body: unknown) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// Silence expected server logs only within the failing request, then restore.
async function withoutErrorLogs<T>(run: () => T | Promise<T>) {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
}

describe('product cache-aside', () => {
  test('MISS queries PostgreSQL with parameters and fills JSON with a 60s TTL', async () => {
    const { app, db, cache } = fixture();
    const response = await app.request('/products/01');
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Cache')).toBe('MISS');
    expect(await response.json()).toEqual(product);
    expect(db.query).toHaveBeenCalledWith(
      'SELECT * FROM products WHERE id = $1',
      [1],
    );
    expect(cache.set).toHaveBeenCalledWith(
      'cache:product:1',
      JSON.stringify(product),
      'EX',
      60,
    );
  });

  test('HIT returns JSON without querying PostgreSQL or refreshing TTL', async () => {
    const { app, db, cache } = fixture();
    cache.get.mockResolvedValue(JSON.stringify(product));
    const response = await app.request('/products/1');
    expect(response.headers.get('X-Cache')).toBe('HIT');
    expect(await response.json()).toEqual(product);
    expect(db.query).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  test('does not cache missing products', async () => {
    const { app, db, cache } = fixture();
    db.query.mockResolvedValue({ rows: [] });
    const response = await app.request('/products/1');
    expect(response.status).toBe(404);
    expect(response.headers.get('X-Cache')).toBe('MISS');
    expect(cache.set).not.toHaveBeenCalled();
  });

  for (const cached of ['{bad JSON', 'null', '{"id":2}', '[]']) {
    test(`invalid cache data falls back safely: ${cached}`, async () => {
      const { app, db, cache } = fixture();
      cache.get.mockResolvedValue(cached);
      const response = await withoutErrorLogs(() => app.request('/products/1'));
      expect(response.headers.get('X-Cache')).toBe('BYPASS');
      expect(await response.json()).toEqual(product);
      expect(db.query).toHaveBeenCalledTimes(1);
    });
  }

  for (const operation of ['get', 'set'] as const) {
    test(`Redis ${operation} failure returns PostgreSQL result with BYPASS`, async () => {
      const { app, cache } = fixture();
      cache[operation].mockRejectedValue(
        new Error('private connection detail'),
      );
      const response = await withoutErrorLogs(() => app.request('/products/1'));
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Cache')).toBe('BYPASS');
      expect(await response.json()).toEqual(product);
      if (operation === 'get') expect(cache.set).not.toHaveBeenCalled();
    });
  }

  test('database failures return a generic error and never fill cache', async () => {
    const { app, db, cache } = fixture();
    db.query.mockRejectedValue(new Error('private database detail'));
    const response = await withoutErrorLogs(() => app.request('/products/1'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Service unavailable' });
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe('product writes and validation', () => {
  test('POST uses parameters, defaults stock, and never fills cache', async () => {
    const { app, db, cache } = fixture();
    const name = "Coffee'; DELETE FROM products; --";
    const response = await app.request(
      '/products',
      jsonRequest('POST', { name, price: 1299 }),
    );
    expect(response.status).toBe(201);
    expect(db.query.mock.calls[0]?.[1]).toEqual([name, 1299, 0]);
    expect(db.query.mock.calls[0]?.[0]).not.toContain(name);
    expect(cache.set).not.toHaveBeenCalled();
    expect(cache.del).not.toHaveBeenCalled();
  });

  for (const method of ['PATCH', 'DELETE']) {
    test(`${method} invalidates only after the database resolves`, async () => {
      const { app, db, cache } = fixture();
      const order: string[] = [];
      db.query.mockImplementation(async () => {
        await Promise.resolve();
        order.push('database committed');
        return { rows: [product] };
      });
      cache.del.mockImplementation(async () => {
        order.push('invalidate');
        return 1;
      });
      const response = await app.request(
        '/products/1',
        jsonRequest(method, { price: 0 }),
      );
      expect(response.status).toBe(method === 'PATCH' ? 200 : 204);
      expect(order).toEqual(['database committed', 'invalidate']);
      expect(cache.del).toHaveBeenCalledWith('cache:product:1');
      if (method === 'PATCH')
        expect(db.query.mock.calls[0]?.[1]).toEqual([null, 0, null, 1]);
    });

    test(`${method} keeps success when invalidation fails`, async () => {
      const { app, cache } = fixture();
      cache.del.mockRejectedValue(new Error('Redis down'));
      const response = await withoutErrorLogs(() =>
        app.request('/products/1', jsonRequest(method, { stock: 0 })),
      );
      expect(response.status).toBe(method === 'PATCH' ? 200 : 204);
    });

    for (const failure of ['missing', 'database error']) {
      test(`${method} does not invalidate on ${failure}`, async () => {
        const { app, db, cache } = fixture();
        if (failure === 'missing') db.query.mockResolvedValue({ rows: [] });
        else db.query.mockRejectedValue(new Error('database down'));
        const response = await withoutErrorLogs(() =>
          app.request('/products/1', jsonRequest(method, { stock: 0 })),
        );
        expect(response.status).toBe(failure === 'missing' ? 404 : 503);
        expect(cache.del).not.toHaveBeenCalled();
      });
    }
  }

  test('referenced product deletion returns 409 without invalidating', async () => {
    const { app, db, cache } = fixture();
    db.query.mockRejectedValue(
      Object.assign(new Error('foreign key'), { code: '23503' }),
    );
    const response = await withoutErrorLogs(() =>
      app.request('/products/1', { method: 'DELETE' }),
    );
    expect(response.status).toBe(409);
    expect(cache.del).not.toHaveBeenCalled();
  });

  for (const body of [
    null,
    [],
    {},
    { name: ' ', price: 1 },
    { name: 'x', price: 1.5 },
    { name: 'x', price: -1 },
    { name: 'x', price: 2147483648 },
    { name: 'x', price: '1' },
    { name: 'x', price: 1, stock: null },
    { name: 'x', price: 1, id: 7 },
  ]) {
    test(`rejects invalid POST body ${JSON.stringify(body)}`, async () => {
      const { app, db } = fixture();
      expect(
        (await app.request('/products', jsonRequest('POST', body))).status,
      ).toBe(400);
      expect(db.query).not.toHaveBeenCalled();
    });
  }

  test('rejects malformed JSON and empty/null PATCH fields', async () => {
    const { app, db } = fixture();
    expect(
      (await app.request('/products', { method: 'POST', body: '{bad' })).status,
    ).toBe(400);
    for (const body of [{}, { name: null }, { price: null }, { stock: -1 }]) {
      expect(
        (await app.request('/products/1', jsonRequest('PATCH', body))).status,
      ).toBe(400);
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  for (const id of ['0', '-1', '1.5', '2147483648', 'nope', '1 OR 1=1']) {
    test(`rejects invalid id ${id} before touching infrastructure`, async () => {
      const { app, db, cache } = fixture();
      for (const method of ['GET', 'PATCH', 'DELETE']) {
        const response = await app.request(
          `/products/${encodeURIComponent(id)}`,
          { method },
        );
        expect(response.status).toBe(400);
      }
      expect(db.query).not.toHaveBeenCalled();
      expect(cache.get).not.toHaveBeenCalled();
    });
  }

  test('health and readiness do not depend on Redis', async () => {
    const { app, db, cache } = fixture();
    cache.get.mockRejectedValue(new Error('Redis down'));
    expect((await app.request('/health')).status).toBe(200);
    expect(db.query).not.toHaveBeenCalled();
    expect((await app.request('/ready')).status).toBe(200);
    db.query.mockRejectedValue(new Error('PostgreSQL down'));
    expect((await app.request('/ready')).status).toBe(503);
    expect(cache.get).not.toHaveBeenCalled();
  });
});
