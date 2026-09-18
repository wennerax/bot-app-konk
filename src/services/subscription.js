export async function checkRequiredChannels(bot, userId, channels) {
  const results = [];
  for (const channel of channels) {
    try {
      const member = await bot.api.getChatMember(channel.id, userId);
      const isMember = ['creator', 'administrator', 'member'].includes(member.status)
        || (member.status === 'restricted' && member.is_member);
      results.push({ ...channel, isMember, status: member.status });
      if (!isMember) break;
    } catch (error) {
      results.push({ ...channel, isMember: false, status: 'unknown', error: error.description ?? 'Бот не может проверить этот канал' });
      break;
    }
  }

  return {
    passed: results.every((channel) => channel.isMember),
    channels: results
  };
}

export async function findAdminChannels(bot, userId, channels) {
  const results = await Promise.all(channels.map(async (channel) => {
    try {
      const member = await bot.api.getChatMember(channel.id, userId);
      return {
        ...channel,
        isAdmin: ['creator', 'administrator'].includes(member.status),
        canReadMessages: member.status === 'creator' || member.can_manage_chat === true
      };
    } catch {
      return { ...channel, isAdmin: false, canReadMessages: false };
    }
  }));

  return results.filter((channel) => channel.isAdmin && channel.canReadMessages);
}