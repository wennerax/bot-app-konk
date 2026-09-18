import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRequiredChannels } from '../src/services/subscription.js';

test('checks the contest channel before partner channels', async () => {
  const checked = [];
  const bot = { api: { getChatMember: async (channelId) => {
    checked.push(channelId);
    return { status: channelId === '-1001' ? 'left' : 'member' };
  } } };
  const result = await checkRequiredChannels(bot, 42, [
    { id: '-1001', title: 'Канал конкурса' },
    { id: '-1002', title: 'Партнёр' }
  ]);

  assert.deepEqual(checked, ['-1001']);
  assert.equal(result.passed, false);
  assert.equal(result.channels[0].id, '-1001');
});