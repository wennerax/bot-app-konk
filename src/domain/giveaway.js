import crypto from 'node:crypto';

export function createGiveaway(input, now = new Date()) {
  const title = String(input.title ?? '').trim();
  const channelId = String(input.channelId ?? '').trim();
  const winnersCount = Number(input.winnersCount);

  if (!title) throw new Error('Название конкурса обязательно');
  if (!channelId) throw new Error('Канал конкурса обязателен');
  if (!Number.isInteger(winnersCount) || winnersCount < 1) {
    throw new Error('Количество победителей должно быть положительным целым числом');
  }

  return {
    id: input.id ?? crypto.randomUUID(),
    title,
    description: String(input.description ?? '').trim(),
    sourceText: String(input.sourceText ?? '').trim(),
    channelId,
    requiredChannels: Array.isArray(input.requiredChannels) ? input.requiredChannels : [],
    miniAppButtonColor: input.miniAppButtonColor ?? '#e6ff54',
    media: input.media ?? null,
    entities: Array.isArray(input.entities) ? input.entities : [],
    winnersCount,
    status: 'active',
    participants: [],
    winners: [],
    createdAt: now.toISOString(),
    endsAt: input.endsAt ? new Date(input.endsAt).toISOString() : null
  };
}

export function addParticipant(giveaway, userId) {
  const normalizedId = String(userId);
  if (giveaway.status !== 'active') return { added: false, reason: 'closed' };
  if (giveaway.participants.includes(normalizedId)) return { added: false, reason: 'already_joined' };
  giveaway.participants.push(normalizedId);
  return { added: true, reason: 'joined' };
}

export function pickWinners(giveaway, random = Math.random) {
  if (giveaway.participants.length === 0) return [];
  const pool = [...giveaway.participants];
  const winners = [];
  const count = Math.min(giveaway.winnersCount, pool.length);

  for (let index = 0; index < count; index += 1) {
    const selectedIndex = Math.floor(random() * pool.length);
    winners.push(pool.splice(selectedIndex, 1)[0]);
  }

  giveaway.winners = winners;
  giveaway.status = 'finished';
  return winners;
}

export function getParticipationLink(botUsername, giveawayId) {
  return `https://t.me/${botUsername}?startapp=g_${giveawayId}`;
}