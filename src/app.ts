import { Hono } from 'hono';
import { Pool } from 'pg';
import { redis } from './redis';

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

export type Product = {
  id: number;
  name: string;
  price: number;
  stock: number;
  created_at: Date | string;
  updated_at: Date | string;
};

// Small dependency seams let route tests run without infrastructure.
type Database = {
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};
type Cache = {
  get: (key: string) => Promise<string | null>;
  set: (
    key: string,
    value: string,
    mode: 'EX',
    ttl: number,
  ) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
};

const maxInteger = 2_147_483_647;
function isInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= maxInteger
  );
}

function validInput(
  value: unknown,
  partial: boolean,
): value is {
  name?: string;
  price?: number;
  stock?: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (
    !keys.length ||
    keys.some((key) => !['name', 'price', 'stock'].includes(key))
  )
    return false;
  if (!partial && (!('name' in body) || !('price' in body))) return false;
  if ('name' in body && (typeof body.name !== 'string' || !body.name.trim()))
    return false;
  return (
    (!('price' in body) || isInteger(body.price)) &&
    (!('stock' in body) || isInteger(body.stock))
  );
}

function validCachedProduct(value: unknown, id: number): value is Product {
  if (!value || typeof value !== 'object') return false;
  const product = value as Record<string, unknown>;
  return (
    product.id === id &&
    typeof product.name === 'string' &&
    product.name.trim().length > 0 &&
    isInteger(product.price) &&
    isInteger(product.stock) &&
    typeof product.created_at === 'string' &&
    typeof product.updated_at === 'string'
  );
}

export function createApp(db: Database = pool, cache: Cache = redis) {
  const app = new Hono();

  app.onError((error, c) => {
    console.error('Database request failed', error);
    if ('code' in error && error.code === '23503') {
      return c.json({ error: 'Product is referenced by an order' }, 409);
    }
    return c.json({ error: 'Service unavailable' }, 503);
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/ready', async (c) => {
    try {
      await db.query('SELECT 1');
      return c.json({ status: 'ready' });
    } catch {
      return c.json({ status: 'unavailable' }, 503);
    }
  });

  app.use('/products/:id', async (c, next) => {
    const raw = c.req.param('id');
    const id = Number(raw);
    if (!/^\d+$/.test(raw) || !isInteger(id) || id === 0) {
      return c.json({ error: 'Invalid product id' }, 400);
    }
    await next();
  });

  app.post('/products', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!validInput(body, false))
      return c.json({ error: 'Invalid product input' }, 400);
    const { rows } = await db.query(
      'INSERT INTO products (name, price, stock) VALUES ($1, $2, $3) RETURNING *',
      [body.name?.trim(), body.price, body.stock ?? 0],
    );
    return c.json(rows[0], 201);
  });

  app.get('/products/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const key = `cache:product:${id}`;
    let bypass = false;
    try {
      const cached = await cache.get(key);
      if (cached !== null) {
        const product: unknown = JSON.parse(cached);
        if (!validCachedProduct(product, id))
          throw new Error('Invalid cached product');
        c.header('X-Cache', 'HIT');
        return c.json(product);
      }
    } catch (error) {
      console.error('Redis product read failed', error);
      bypass = true;
    }

    c.header('X-Cache', bypass ? 'BYPASS' : 'MISS');
    const { rows } = await db.query('SELECT * FROM products WHERE id = $1', [
      id,
    ]);
    const product = rows[0];
    if (!product) return c.json({ error: 'Product not found' }, 404);
    if (!bypass) {
      try {
        await cache.set(key, JSON.stringify(product), 'EX', 60);
      } catch (error) {
        console.error('Redis product fill failed', error);
        c.header('X-Cache', 'BYPASS');
      }
    }
    return c.json(product);
  });

  async function invalidate(id: number) {
    try {
      await cache.del(`cache:product:${id}`);
    } catch (error) {
      // The database write has committed. Do not report it as failed.
      console.error(
        'Redis product invalidation failed; stale cache may remain',
        error,
      );
    }
  }

  app.patch('/products/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const body: unknown = await c.req.json().catch(() => null);
    if (!validInput(body, true))
      return c.json({ error: 'Invalid product input' }, 400);
    const { rows } = await db.query(
      `UPDATE products SET name = COALESCE($1, name), price = COALESCE($2, price),
       stock = COALESCE($3, stock), updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *`,
      [body.name?.trim() ?? null, body.price ?? null, body.stock ?? null, id],
    );
    if (!rows[0]) return c.json({ error: 'Product not found' }, 404);
    await invalidate(id);
    return c.json(rows[0]);
  });

  app.delete('/products/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const { rows } = await db.query(
      'DELETE FROM products WHERE id = $1 RETURNING *',
      [id],
    );
    if (!rows[0]) return c.json({ error: 'Product not found' }, 404);
    await invalidate(id);
    return c.body(null, 204);
  });

  // Deliberately unsafe, local-learning-only: this is not safe order placement.
  app.post('/orders/unsafe', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Invalid order input' }, 400);
    }
    const { productId, quantity } = body as Record<string, unknown>;
    if (
      !isInteger(productId) ||
      productId === 0 ||
      !isInteger(quantity) ||
      quantity === 0 ||
      Object.keys(body).some((key) => !['productId', 'quantity'].includes(key))
    ) {
      return c.json({ error: 'Invalid order input' }, 400);
    }

    // Inventory must come directly from PostgreSQL, never the Redis cache.
    const result = await db.query('SELECT * FROM products WHERE id = $1', [
      productId,
    ]);
    const product = result.rows[0] as Product | undefined;
    if (!product) return c.json({ error: 'Product not found' }, 404);
    const stock = product.stock;
    if (stock < quantity) return c.json({ error: 'Insufficient stock' }, 409);

    // Other requests can read the same stock while this request sleeps.
    await Bun.sleep(100);
    const newStock = stock - quantity;
    const total = product.price * quantity;
    if (!isInteger(total))
      return c.json({ error: 'Order total exceeds integer range' }, 400);

    // Writing a value calculated from the old stock loses concurrent deductions.
    await db.query(
      'UPDATE products SET stock = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newStock, productId],
    );
    const orders = await db.query(
      'INSERT INTO orders (product_id, quantity, total) VALUES ($1, $2, $3) RETURNING *',
      [productId, quantity, total],
    );
    const order = orders.rows[0];
    await invalidate(productId);
    return c.json(order, 201);
  });

  return app;
}

export const app = createApp();
