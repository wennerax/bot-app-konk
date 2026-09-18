import { Bot, InlineKeyboard } from 'grammy';
import { addParticipant, createGiveaway, getParticipationLink, pickWinners } from './domain/giveaway.js';
import { checkRequiredChannels, findAdminChannels } from './services/subscription.js';

async function publishGiveaway(bot, channelId, giveaway, miniAppUrl) {
  const text = `🎁 ${giveaway.title}\n\n${giveaway.description || 'Нажми кнопку, чтобы проверить условия и участвовать.'}`;
  const keyboard = new InlineKeyboard().url('Участвовать', miniAppUrl);
  const options = { reply_markup: keyboard, entities: giveaway.entities };
  if (giveaway.media?.type === 'photo') return bot.api.sendPhoto(channelId, giveaway.media.fileId, { caption: text, caption_entities: giveaway.entities, reply_markup: keyboard });
  if (giveaway.media?.type === 'video') return bot.api.sendVideo(channelId, giveaway.media.fileId, { caption: text, caption_entities: giveaway.entities, reply_markup: keyboard });
  if (giveaway.media?.type === 'document') return bot.api.sendDocument(channelId, giveaway.media.fileId, { caption: text, caption_entities: giveaway.entities, reply_markup: keyboard });
  return bot.api.sendMessage(channelId, text, options);
}

function channelListKeyboard(channels) {
  const keyboard = new InlineKeyboard();
  for (const channel of channels) {
    keyboard.text(`${channel.title}`, `channel_settings:${channel.id}`).row();
  }
  keyboard.text('❌ Закрыть', 'channels_close');
  return keyboard;
}

function channelSettingsKeyboard(channel) {
  const keyboard = new InlineKeyboard()
    .text('🎁 Создать конкурс', `giveaway_help:${channel.id}`).row()
    .text('📋 Условия подписки', `conditions_help:${channel.id}`).row()
    .text('🎨 Цвет Mini App', `color_help:${channel.id}`).row()
    .text('🖼 Медиа поста', `media_help:${channel.id}`).row();
  if (channel.url) keyboard.url('🔗 Открыть канал', channel.url).row();
  return keyboard.text('⬅️ К списку каналов', 'channels_back').row().text('❌ Закрыть', 'channels_close');
}

export function createBot({ token, store, publicUrl, miniAppName, managedChannels = [] } = {}) {
  const bot = new Bot(token);

  bot.catch((error) => {
    console.error('Telegram update error:', error.error?.description ?? error.message);
  });

  bot.use(async (context, next) => {
    console.log(`Telegram update received: ${context.update.update_id}`);
    await next();
  });

  for (const channel of managedChannels) {
    store.saveChannel(channel).catch((error) => console.error('Не удалось сохранить канал:', error.message));
  }

  const rememberChannel = async (chat) => {
    if (chat?.type !== 'channel') return;
    await store.saveChannel({
      id: chat.id,
      title: chat.title ?? 'Без названия',
      username: chat.username ?? null,
      url: chat.username ? `https://t.me/${chat.username}` : null
    });
  };

  bot.on('my_chat_member', async (context, next) => {
    await rememberChannel(context.chat);
    await next();
  });

  bot.on('channel_post', async (context, next) => {
    await rememberChannel(context.chat);
    await next();
  });

  bot.api.setMyCommands([
    { command: 'start', description: 'Открыть конкурс' },
    { command: 'menu', description: 'Мои каналы' },
    { command: 'newgiveaway', description: 'Создать конкурс' }
  ]).catch((error) => console.error('Не удалось установить команды:', error.message));

  bot.command('start', async (context) => {
    const payload = context.match?.trim();
    if (!payload?.startsWith('g_')) return context.reply('Привет! Открой конкурс из канала или используй /menu.');
    const giveaway = await store.getGiveaway(payload.slice(2));
    if (!giveaway) return context.reply('Этот конкурс больше не найден.');
    const check = await checkRequiredChannels(bot, context.from.id, giveaway.requiredChannels);
    if (!check.passed) {
      const keyboard = new InlineKeyboard();
      for (const channel of check.channels.filter((item) => !item.isMember && item.url)) {
        keyboard.url(`Подписаться: ${channel.title}`, channel.url).row();
      }
      keyboard.text('Проверить подписку', `check_${giveaway.id}`);
      return context.reply('Сначала подпишись на обязательные каналы, затем нажми проверку.', { reply_markup: keyboard });
    }
    const result = addParticipant(giveaway, context.from.id);
    await store.saveGiveaway(giveaway);
    return context.reply(result.added ? 'Готово, ты участвуешь в конкурсе!' : 'Ты уже участвуешь в этом конкурсе.');
  });

  bot.callbackQuery(/^check_(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const giveaway = await store.getGiveaway(context.match[1]);
    if (!giveaway) return context.reply('Конкурс больше не найден.');
    const check = await checkRequiredChannels(bot, context.from.id, giveaway.requiredChannels);
    if (!check.passed) return context.reply('Подписка пока не подтверждена.');
    const result = addParticipant(giveaway, context.from.id);
    await store.saveGiveaway(giveaway);
    return context.reply(result.added ? 'Подписка подтверждена, ты участвуешь!' : 'Ты уже участвуешь.');
  });

  bot.command('menu', async (context) => {
    const discoveredChannels = await store.listChannels();
    const channels = await findAdminChannels(bot, context.from.id, discoveredChannels);
    if (!channels.length) return context.reply('Каналы пока не обнаружены. Добавь бота администратором канала и создай/отредактируй пост в канале, чтобы Telegram прислал событие боту.');
    return context.reply('🎛 Выберите канал для настройки:', { reply_markup: channelListKeyboard(channels) });
  });

  bot.callbackQuery(/^channel_settings:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const channelId = context.match[1];
    const channel = (await store.listChannels()).find((item) => String(item.id) === channelId);
    if (!channel) return context.reply('Канал больше не найден.');
    const moderator = await bot.api.getChatMember(channelId, context.from.id);
    if (!['creator', 'administrator'].includes(moderator.status)) return context.reply('У вас больше нет прав администратора этого канала.');
    return context.editMessageText(`🎛 Настройки канала\n\n${channel.title}\nID: ${channel.id}\n\nВыберите действие:`, { reply_markup: channelSettingsKeyboard(channel) });
  });

  bot.callbackQuery('channels_back', async (context) => {
    await context.answerCallbackQuery();
    const channels = await findAdminChannels(bot, context.from.id, await store.listChannels());
    if (!channels.length) return context.editMessageText('Доступные каналы не найдены.');
    return context.editMessageText('🎛 Выберите канал для настройки:', { reply_markup: channelListKeyboard(channels) });
  });

  bot.callbackQuery(/^giveaway_help:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const channelId = context.match[1];
    return context.editMessageText(`🎁 Создание конкурса\n\nОтправьте боту команду:\n/newgiveaway Название | количество победителей | ${channelId}\n\nПример:\n/newgiveaway Билеты | 2 | ${channelId}`, { reply_markup: new InlineKeyboard().text('⬅️ Назад', `channel_settings:${channelId}`) });
  });

  bot.callbackQuery(/^conditions_help:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const channel = await store.getChannel(context.match[1]);
    const conditions = channel?.requiredChannels?.length
      ? channel.requiredChannels.map((item) => `• ${item.title} (${item.id})`).join('\n')
      : 'Не настроены';
    return context.editMessageText(`📋 Условия подписки\n\nТекущие обязательные каналы:\n${conditions}\n\nЧтобы настроить, отправьте боту:\n/setconditions ID_канала | @партнер1, @партнер2\n\nДля участия в самом канале добавьте его ID первым. Пустой список отключает проверку подписок.`, { reply_markup: new InlineKeyboard().text('⬅️ Назад', `channel_settings:${context.match[1]}`) });
  });

  bot.callbackQuery(/^color_help:(.+)$/, async (context) => {
    await context.answerCallbackQuery('Цвет кнопки под постом Telegram не настраивается');
    return context.editMessageText('🎨 Цвет кнопки\n\nTelegram не позволяет менять цвет inline-кнопки под постом: его задаёт приложение Telegram.\n\nЦвет кнопки внутри Mini App можно изменить командой:\n/setappcolor ID_канала | #ff5a36', { reply_markup: new InlineKeyboard().text('⬅️ Назад', `channel_settings:${context.match[1]}`) });
  });

  bot.callbackQuery(/^media_help:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    return context.editMessageText(`🖼 Медиа поста\n\nОтправьте боту фото, видео или документ, затем ответьте на него командой:\n/newgiveaway Название | 2 | ${context.match[1]}\n\nМедиа будет опубликовано вместе с конкурсом.`, { reply_markup: new InlineKeyboard().text('⬅️ Назад', `channel_settings:${context.match[1]}`) });
  });

  bot.command('setconditions', async (context) => {
    const [channelId, partnersText = ''] = context.match.split('|').map((part) => part.trim());
    if (!channelId) return context.reply('Формат: /setconditions ID_канала | @партнер1, @партнер2');
    const moderator = await bot.api.getChatMember(channelId, context.from.id);
    if (!['creator', 'administrator'].includes(moderator.status)) return context.reply('Нужны права администратора канала.');
    const references = [channelId, ...partnersText.split(',').map((item) => item.trim()).filter(Boolean)];
    const requiredChannels = [];
    for (const reference of references) {
      const chat = await bot.api.getChat(reference);
      requiredChannels.push({ id: chat.id, title: chat.title ?? reference, url: chat.username ? `https://t.me/${chat.username}` : null });
    }
    const channel = await store.getChannel(channelId) ?? { id: channelId, title: channelId };
    await store.saveChannel({ ...channel, requiredChannels });
    return context.reply(`Условия сохранены. Обязательных каналов: ${requiredChannels.length}.`);
  });

  bot.command('setappcolor', async (context) => {
    const [channelId, color] = context.match.split('|').map((part) => part.trim());
    if (!channelId || !/^#[0-9a-f]{6}$/i.test(color ?? '')) return context.reply('Формат: /setappcolor ID_канала | #ff5a36');
    const moderator = await bot.api.getChatMember(channelId, context.from.id);
    if (!['creator', 'administrator'].includes(moderator.status)) return context.reply('Нужны права администратора канала.');
    const channel = await store.getChannel(channelId) ?? { id: channelId, title: channelId };
    await store.saveChannel({ ...channel, miniAppButtonColor: color });
    return context.reply(`Цвет кнопки Mini App сохранён: ${color}`);
  });

  bot.callbackQuery('channels_close', async (context) => {
    await context.answerCallbackQuery();
    return context.deleteMessage();
  });

  bot.command('newgiveaway', async (context) => {
    const [title, winnersText, channelId] = context.match.split('|').map((part) => part.trim());
    if (!title || !winnersText || !channelId) {
      return context.reply('Формат команды:\n/newgiveaway Название конкурса | количество победителей | ID канала\n\nПример:\n/newgiveaway Билеты | 2 | -1001234567890');
    }
    try {
      const moderator = await bot.api.getChatMember(channelId, context.from.id);
      if (!['creator', 'administrator'].includes(moderator.status)) {
        return context.reply('Создавать конкурсы может только администратор этого канала.');
      }
      const sourceMessage = context.msg?.reply_to_message ?? context.msg;
      const media = sourceMessage?.photo?.at(-1) ? { type: 'photo', fileId: sourceMessage.photo.at(-1).file_id }
        : sourceMessage?.video ? { type: 'video', fileId: sourceMessage.video.file_id }
          : sourceMessage?.document ? { type: 'document', fileId: sourceMessage.document.file_id } : null;
      const sourceText = context.msg?.text ?? context.msg?.caption ?? '';
      const titleStart = sourceText.indexOf(title);
      const titleEnd = titleStart + title.length;
      const entities = (context.msg?.entities ?? context.msg?.caption_entities ?? [])
        .filter((entity) => entity.offset >= titleStart && entity.offset + entity.length <= titleEnd)
        .map((entity) => ({ ...entity, offset: entity.offset - titleStart + 3 }));
      const channelSettings = await store.getChannel(channelId);
      const giveaway = createGiveaway({
        title,
        winnersCount: winnersText,
        channelId,
        media,
        entities,
        requiredChannels: channelSettings?.requiredChannels ?? [],
        miniAppButtonColor: channelSettings?.miniAppButtonColor
      });
      await store.saveGiveaway(giveaway);
      const username = (await bot.api.getMe()).username;
      await publishGiveaway(bot, channelId, giveaway, getParticipationLink(username, giveaway.id));
      await context.reply(`Конкурс создан: ${giveaway.id}`);
    } catch (error) {
      await context.reply(`Не удалось создать конкурс: ${error.message}`);
    }
  });

  return bot;
}

export function selectAndCloseGiveaway(giveaway, random) {
  return pickWinners(giveaway, random);
}