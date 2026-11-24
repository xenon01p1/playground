import { expect, test } from 'bun:test';
import { app } from '../src/app';

test('GET /health returns a successful JSON response without infrastructure', async () => {
  const response = await app.request('/health');

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({ status: 'ok' });
});
