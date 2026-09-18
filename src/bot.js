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

export function createBot({ token, store, publicUrl, miniAppName, managedChannels = [] } = {}) {
  const bot = new Bot(token);

  bot.catch((error) => {
    console.error('Telegram update error:', error.error?.description ?? error.message);
  });

  bot.use(async (context, next) => {
    console.log(`Telegram update received: ${context.update.update_id}`);
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
    if (!managedChannels.length) {
      return context.reply('Каналы ещё не настроены. Добавь MANAGED_CHANNELS в переменные хоста, например:\n[{"id":"-1001234567890","title":"БРЕД-РОЗЫГРЫШИ","url":"https://t.me/your_channel"}]');
    }
    const channels = await findAdminChannels(bot, context.from.id, managedChannels);
    if (!channels.length) return context.reply('Каналы с нужными правами не найдены. Добавь бота администратором канала.');
    const lines = channels.map((channel) => `• ${channel.title} (${channel.id})`);
    return context.reply(`Доступные каналы для конкурсов:\n${lines.join('\n')}\n\nMini App: ${publicUrl}`);
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
      const giveaway = createGiveaway({ title, winnersCount: winnersText, channelId, media, entities });
      await store.saveGiveaway(giveaway);
      const username = (await bot.api.getMe()).username;
      await publishGiveaway(bot, channelId, giveaway, getParticipationLink(username, giveaway.id, miniAppName));
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