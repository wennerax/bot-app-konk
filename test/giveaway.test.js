import test from 'node:test';
import assert from 'node:assert/strict';
import { addParticipant, createGiveaway, ensurePrimaryChannel, getParticipationLink, getReferralBotLink, pickWinners } from '../src/domain/giveaway.js';

test('puts the contest channel first and removes legacy default partners', () => {
  const channels = ensurePrimaryChannel('-1001', [
    { id: '-1002', title: 'Тест' },
    { id: '-1003', title: 'Бредишь' },
    { id: '-1004', title: 'Партнёр' },
    { id: '-1001', title: 'Канал конкурса' }
  ]);
  assert.deepEqual(channels.map((channel) => channel.id), ['-1001', '-1004']);
});

test('creates a giveaway with defaults', () => {
  const giveaway = createGiveaway({ title: 'Билеты', channelId: '-1001', winnersCount: 2 });
  assert.equal(giveaway.status, 'active');
  assert.deepEqual(giveaway.participants, []);
});

test('registers a participant only once', () => {
  const giveaway = createGiveaway({ title: 'Приз', channelId: '-1001', winnersCount: 1 });
  assert.deepEqual(addParticipant(giveaway, 42, { username: 'winner', first_name: 'Иван' }), { added: true, reason: 'joined' });
  assert.deepEqual(giveaway.participantProfiles['42'], { username: 'winner', firstName: 'Иван', lastName: null });
  assert.deepEqual(addParticipant(giveaway, 42), { added: false, reason: 'already_joined' });
});

test('credits a successful referral once and rejects self-referrals', () => {
  const giveaway = createGiveaway({ title: 'Приз', channelId: '-1001', winnersCount: 1 });
  giveaway.referralChannel = { id: '-1002', title: 'Реферальный канал' };
  addParticipant(giveaway, 10);
  assert.deepEqual(addParticipant(giveaway, 20, null, 10), { added: true, reason: 'joined' });
  assert.deepEqual(addParticipant(giveaway, 20, null, 10), { added: false, reason: 'already_joined' });
  assert.deepEqual(addParticipant(giveaway, 30, null, 30), { added: true, reason: 'joined' });
  assert.deepEqual(giveaway.referralCounts, { '10': 1 });
  assert.deepEqual(giveaway.referredBy, { '20': '10' });
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
  assert.equal(getParticipationLink('example_bot', 'giveaway-1', 42), 'https://t.me/example_bot?startapp=g_giveaway-1_r_42');
  assert.equal(getReferralBotLink('example_bot', 'giveaway-1'), 'https://t.me/example_bot?start=ref_giveaway-1');
  assert.equal(getReferralBotLink('example_bot', 'giveaway-1', 42), 'https://t.me/example_bot?start=ref_giveaway-1_42');
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

test('weights winner selection by verified referral count without duplicate winners', () => {
  const giveaway = createGiveaway({ title: 'Приз', channelId: '-1001', winnersCount: 2 });
  giveaway.referralChannel = { id: '-1002', title: 'Реферальный канал' };
  giveaway.participants = ['1', '2', '3'];
  giveaway.referralCounts = { '1': 3 };
  assert.deepEqual(pickWinners(giveaway, () => 0.5), ['1', '3']);
  assert.equal(new Set(giveaway.winners).size, giveaway.winners.length);
});