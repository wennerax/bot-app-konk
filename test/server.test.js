import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { MemoryStore } from '../src/store/memory-store.js';

test('health endpoint responds', async () => {
  const app = buildServer({ store: new MemoryStore() });
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  await app.close();
});

test('API creates and lists giveaways', async () => {
  const app = buildServer({ store: new MemoryStore() });
  const created = await app.inject({
    method: 'POST',
    url: '/api/giveaways',
    payload: { title: 'Билеты', channelId: '-1001', winnersCount: 2 }
  });
  assert.equal(created.statusCode, 201);
  const list = await app.inject({ method: 'GET', url: '/api/giveaways' });
  assert.equal(list.json().length, 1);
  await app.close();
});

test('API returns 404 for unknown giveaway', async () => {
  const app = buildServer({ store: new MemoryStore() });
  const response = await app.inject({ method: 'GET', url: '/api/giveaways/missing' });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('Mini App entry page responds at root', async () => {
  const app = buildServer({ store: new MemoryStore() });
  const response = await app.inject({ method: 'GET', url: '/' });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  await app.close();
});