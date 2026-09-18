import test from 'node:test';
import assert from 'node:assert/strict';
import { addParticipant, createGiveaway, getParticipationLink, pickWinners } from '../src/domain/giveaway.js';

test('creates a giveaway with defaults', () => {
  const giveaway = createGiveaway({ title: 'Билеты', channelId: '-1001', winnersCount: 2 });
  assert.equal(giveaway.status, 'active');
  assert.deepEqual(giveaway.participants, []);
});

test('registers a participant only once', () => {
  const giveaway = createGiveaway({ title: 'Приз', channelId: '-1001', winnersCount: 1 });
  assert.deepEqual(addParticipant(giveaway, 42), { added: true, reason: 'joined' });
  assert.deepEqual(addParticipant(giveaway, 42), { added: false, reason: 'already_joined' });
});

test('selects unique winners and closes the giveaway', () => {
  const giveaway = createGiveaway({ title: 'Приз', channelId: '-1001', winnersCount: 2 });
  giveaway.participants = ['1', '2', '3'];
  const winners = pickWinners(giveaway, () => 0);
  assert.deepEqual(winners, ['1', '2']);
  assert.equal(giveaway.status, 'finished');
});

test('builds a Telegram deep link', () => {
  assert.equal(getParticipationLink('example_bot', 'giveaway-1'), 'https://t.me/example_bot?startapp=g_giveaway-1');
});

test('closes an empty giveaway so the scheduler does not retry it forever', () => {
  const giveaway = createGiveaway({ title: 'Без участников', channelId: '-1001', winnersCount: 1 });
  assert.deepEqual(pickWinners(giveaway), []);
  assert.equal(giveaway.status, 'finished');
});

test('selects exactly the configured number from one hundred participants', () => {
  const giveaway = createGiveaway({ title: 'Приз', channelId: '-1001', winnersCount: 2 });
  giveaway.participants = Array.from({ length: 100 }, (_, index) => String(index + 1));
  const winners = pickWinners(giveaway);
  assert.equal(winners.length, 2);
  assert.equal(new Set(winners).size, 2);
  assert.ok(winners.every((winner) => giveaway.participants.includes(winner)));
  assert.equal(giveaway.status, 'finished');
});