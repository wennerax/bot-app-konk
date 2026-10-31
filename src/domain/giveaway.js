import crypto, { randomInt } from 'node:crypto';

export function ensurePrimaryChannel(channelId, channels = []) {
  const primaryId = String(channelId ?? '').trim();
  const uniqueChannels = [];
  const seen = new Set([primaryId]);
  const primary = channels.find((channel) => String(channel?.id) === primaryId);

  uniqueChannels.push(primary ?? { id: primaryId, title: primaryId, url: null });
  for (const channel of channels) {
    const id = String(channel?.id ?? '').trim();
    const title = String(channel?.title ?? '').trim().toLowerCase();
    if (id !== primaryId && (title === 'тест' || title === 'бредишь')) continue;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniqueChannels.push(channel);
  }
  return uniqueChannels;
}

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
    channelId,
    requiredChannels: ensurePrimaryChannel(channelId, Array.isArray(input.requiredChannels) ? input.requiredChannels : []),
    miniAppButtonColor: input.miniAppButtonColor ?? '#e6ff54',
    buttonStyle: ['danger', 'success', 'primary', 'default'].includes(input.buttonStyle) ? input.buttonStyle : 'primary',
    media: input.media ?? null,
    entities: Array.isArray(input.entities) ? input.entities : [],
    winnersCount,
    status: input.status ?? 'active',
    participants: [],
    participantProfiles: {},
    referralCounts: {},
    referredBy: {},
    winners: [],
    createdAt: now.toISOString(),
    endsAt: input.endsAt ? new Date(input.endsAt).toISOString() : null
  };
}

export function addParticipant(giveaway, userId, profile = null, referrerId = null) {
  const normalizedId = String(userId);
  if (giveaway.status !== 'active') return { added: false, reason: 'closed' };
  if (giveaway.participants.includes(normalizedId)) return { added: false, reason: 'already_joined' };
  giveaway.participants.push(normalizedId);
  if (profile) {
    giveaway.participantProfiles ??= {};
    giveaway.participantProfiles[normalizedId] = {
      username: profile.username ?? null,
      firstName: profile.first_name ?? profile.firstName ?? null,
      lastName: profile.last_name ?? profile.lastName ?? null
    };
  }
  const normalizedReferrerId = referrerId == null ? null : String(referrerId);
  if (normalizedReferrerId && normalizedReferrerId !== normalizedId && giveaway.participants.includes(normalizedReferrerId)) {
    giveaway.referralCounts ??= {};
    giveaway.referredBy ??= {};
    if (!giveaway.referredBy[normalizedId]) {
      giveaway.referredBy[normalizedId] = normalizedReferrerId;
      giveaway.referralCounts[normalizedReferrerId] = (giveaway.referralCounts[normalizedReferrerId] ?? 0) + 1;
    }
  }
  return { added: true, reason: 'joined' };
}

export function pickWinners(giveaway, random) {
  if (giveaway.status !== 'active') return giveaway.winners ?? [];
  if (giveaway.participants.length === 0) {
    giveaway.winners = [];
    giveaway.status = 'finished';
    return [];
  }
  const pool = [...giveaway.participants];
  const winners = [];
  const count = Math.min(giveaway.winnersCount, pool.length);

  for (let index = 0; index < count; index += 1) {
    const weights = pool.map((userId) => {
      const referrals = Number(giveaway.referralCounts?.[userId] ?? 0);
      return 1 + (Number.isSafeInteger(referrals) && referrals > 0 ? referrals : 0);
    });
    const totalWeight = weights.reduce((total, weight) => total + weight, 0);
    let draw = random ? random() * totalWeight : randomInt(totalWeight);
    let selectedIndex = weights.findIndex((weight) => {
      if (draw < weight) return true;
      draw -= weight;
      return false;
    });
    if (selectedIndex < 0) selectedIndex = pool.length - 1;
    winners.push(pool.splice(selectedIndex, 1)[0]);
  }

  giveaway.winners = winners;
  giveaway.status = 'finished';
  return winners;
}

export function getParticipationLink(botUsername, giveawayId, referrerId = null) {
  const referralParam = referrerId == null ? '' : `_r_${referrerId}`;
  return `https://t.me/${botUsername}?startapp=g_${giveawayId}${referralParam}`;
}