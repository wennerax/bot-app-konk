import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildServer } from '../src/server.js';
import { MemoryStore } from '../src/store/memory-store.js';

function initData(botToken, user = { id: 42, first_name: 'Test' }, startParam = null) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) });
  if (startParam) params.set('start_param', startParam);
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update([...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n')).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

test('health endpoint responds', async () => {
  const app = buildServer({ store: new MemoryStore() });
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  await app.close();
});

test('API creates and lists giveaways only for an authenticated channel admin', async () => {
  const botToken = 'test-token';
  const bot = { api: { getChatMember: async () => ({ status: 'administrator' }) } };
  const app = buildServer({ bot, botToken, store: new MemoryStore() });
  const created = await app.inject({
    method: 'POST',
    url: '/api/giveaways',
    headers: { 'x-telegram-init-data': initData(botToken) },
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

test('only credits a referral after the invitee passes subscription checks', async () => {
  const botToken = 'test-token';
  const store = new MemoryStore();
  const giveaway = {
    id: 'referral-test',
    title: 'Приз',
    description: '',
    channelId: '-1001',
    requiredChannels: [{ id: '-1001', title: 'Канал', url: null }],
    winnersCount: 1,
    status: 'active',
    participants: ['10'],
    participantProfiles: {},
    referralCounts: {},
    referredBy: {},
    winners: [],
    createdAt: new Date().toISOString(),
    endsAt: null
  };
  await store.saveGiveaway(giveaway);
  let isMember = false;
  const bot = {
    api: {
      getChatMember: async () => ({ status: isMember ? 'member' : 'left' }),
      getMe: async () => ({ username: 'test_bot' })
    }
  };
  const app = buildServer({ bot, botToken, store });
  const headers = { 'x-telegram-init-data': initData(botToken, { id: 20, first_name: 'Friend' }, 'g_referral-test_r_10') };
  const rejected = await app.inject({
    method: 'POST',
    url: `/api/giveaways/${giveaway.id}/participate`,
    headers
  });
  assert.equal(rejected.statusCode, 403);
  assert.deepEqual((await store.getGiveaway(giveaway.id)).referralCounts, {});
  isMember = true;
  const response = await app.inject({
    method: 'POST',
    url: `/api/giveaways/${giveaway.id}/participate`,
    headers
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().added, true);
  assert.equal(response.json().referralLink, 'https://t.me/test_bot?startapp=g_referral-test_r_20');
  assert.equal(response.json().referralCount, 0);
  const savedGiveaway = await store.getGiveaway(giveaway.id);
  assert.deepEqual(savedGiveaway.referralCounts, { '10': 1 });
  assert.deepEqual(savedGiveaway.referredBy, { '20': '10' });
  const publicResponse = await app.inject({ method: 'GET', url: `/api/giveaways/${giveaway.id}` });
  assert.equal('referralCounts' in publicResponse.json(), false);
  assert.equal('referredBy' in publicResponse.json(), false);
  await app.close();
});

test('Mini App entry page responds at root', async () => {
  const app = buildServer({ store: new MemoryStore() });
  const response = await app.inject({ method: 'GET', url: '/' });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  await app.close();
});

test('webhook diagnostic responds to browser GET', async () => {
  const app = buildServer({ store: new MemoryStore(), bot: {} });
  const response = await app.inject({ method: 'GET', url: '/telegram/webhook' });
  assert.equal(response.statusCode, 200);
  await app.close();
});

test('webhook rejects requests without Telegram secret', async () => {
  let handled = false;
  const app = buildServer({ bot: { handleUpdate: async () => { handled = true; } }, webhookSecret: 'secret', store: new MemoryStore() });
  const response = await app.inject({ method: 'POST', url: '/telegram/webhook', payload: { update_id: 1 } });
  assert.equal(response.statusCode, 401);
  assert.equal(handled, false);
  await app.close();
});