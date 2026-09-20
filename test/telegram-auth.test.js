import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateWebAppInitData } from '../src/services/telegram-auth.js';

function createInitData(botToken, authDate) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify({ id: 42 }) });
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

test('rejects Mini App data from the future beyond clock skew', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(validateWebAppInitData(createInitData('token', now + 61), 'token'), null);
});

test('accepts a valid Mini App user', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual(validateWebAppInitData(createInitData('token', now), 'token'), { id: 42 });
});