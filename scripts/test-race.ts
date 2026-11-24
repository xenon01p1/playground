// Deliberately unsafe, local-learning-only experiment. Not part of bun test/CI.
import { Pool } from 'pg';

const base =
  process.env.API_BASE_URL ??
  `http://127.0.0.1:${process.env.API_HOST_PORT ?? 3100}`;
// Separate script process: connect directly to the same Compose PostgreSQL DB.
const db = new Pool({
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? process.env.POSTGRES_HOST_PORT ?? 5433),
  user: process.env.PGUSER ?? process.env.POSTGRES_USER,
  password: process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD,
  database: process.env.PGDATABASE ?? process.env.POSTGRES_DB,
  max: 1,
  connectionTimeoutMillis: 2_000,
  query_timeout: 2_000,
  statement_timeout: 2_000,
});

const initialStock = 100;
const totalRequests = 100;
const quantity = 10;

try {
  const response = await fetch(`${base}/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `Unsafe race experiment ${crypto.randomUUID()}`,
      price: 100,
      stock: initialStock,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 201)
    throw new Error(`Product creation returned HTTP ${response.status}`);
  const product = (await response.json()) as { id: number };
  const productId = product.id;
  console.log(
    `Test product ID: ${productId} (retained with its orders for inspection)`,
  );

  const results = await Promise.allSettled(
    Array.from({ length: totalRequests }, async () => {
      const response = await fetch(`${base}/orders/unsafe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, quantity }),
        signal: AbortSignal.timeout(30_000),
      });
      await response.arrayBuffer();
      return response.status;
    }),
  );
  const successfulOrders = results.filter(
    (result) => result.status === 'fulfilled' && result.value === 201,
  ).length;
  const rejectedOrders = results.filter(
    (result) => result.status === 'fulfilled' && result.value !== 201,
  ).length;
  const requestErrors = results.filter(
    (result) => result.status === 'rejected',
  ).length;

  // Read both measurements directly from PostgreSQL; cached stock can be stale.
  const products = await db.query('SELECT stock FROM products WHERE id = $1', [
    productId,
  ]);
  if (!products.rows[0]) throw new Error('Test product disappeared');
  const orders = await db.query(
    'SELECT COALESCE(SUM(quantity), 0) AS quantity FROM orders WHERE product_id = $1',
    [productId],
  );
  const stock = products.rows[0].stock as number;
  const totalUnitsSold = Number(orders.rows[0].quantity);
  const expectedStock = initialStock - totalUnitsSold;
  const oversoldUnits = Math.max(0, totalUnitsSold - initialStock);
  const raceDetected = stock !== expectedStock || oversoldUnits > 0;

  console.log(`Initial stock: ${initialStock}`);
  console.log(`Total requests: ${totalRequests}`);
  console.log(`Quantity per request: ${quantity}`);
  console.log(`Successful orders: ${successfulOrders}`);
  console.log(`Rejected orders: ${rejectedOrders}`);
  console.log(`Request errors: ${requestErrors}`);
  console.log(`Total units sold: ${totalUnitsSold}`);
  console.log(`Expected remaining stock: ${expectedStock}`);
  console.log(`Actual remaining stock: ${stock}`);
  console.log(`Oversold units: ${oversoldUnits}`);
  console.log(`Race condition detected: ${raceDetected ? 'YES' : 'NO'}`);
} finally {
  await db.end();
}
