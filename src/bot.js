import { Bot, InlineKeyboard } from 'grammy';
import { addParticipant, createGiveaway, ensurePrimaryChannel, getParticipationLink, pickWinners } from './domain/giveaway.js';
import { checkRequiredChannels, findAdminChannels } from './services/subscription.js';

function normalizeCustomEmojiEntities(entities = []) {
  return entities
    .filter((entity) => entity && entity.type === 'custom_emoji' && entity.custom_emoji_id)
    .map((entity) => ({
      ...entity,
      custom_emoji_id: String(entity.custom_emoji_id),
      offset: Number(entity.offset) || 0,
      length: Number(entity.length) || 0
    }));
}

function fallbackEmojiForEntity(entity, index = 0) {
  const palette = ['✨', '🔥', '🎉', '✅', '💎', '🎁', '⭐', '🚀', '🎯', '🏆'];
  const raw = String(entity?.custom_emoji_id ?? '');
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  return palette[(hash + index) % palette.length];
}

function replaceCustomEmojiWithFallback(text = '', entities = []) {
  if (!text || !entities.length) return text;
  const characters = [...text];
  const parts = [];
  let cursor = 0;

  for (const entity of entities) {
    if (!entity || entity.type !== 'custom_emoji' || !entity.custom_emoji_id) continue;
    const start = Number(entity.offset) || 0;
    const length = Number(entity.length) || 0;
    const end = start + length;
    const charStart = utf16IndexToStringIndex(text, start);
    const charEnd = utf16IndexToStringIndex(text, end);
    if (charStart < 0 || charEnd <= charStart || charStart < cursor) continue;
    parts.push(characters.slice(cursor, charStart).join(''));
    parts.push(fallbackEmojiForEntity(entity, parts.length));
    cursor = charEnd;
  }

  parts.push(characters.slice(cursor).join(''));
  return parts.join('');
}

function utf16IndexToStringIndex(value, offset) {
  let cursor = 0;
  let utf16Cursor = 0;
  for (const character of value) {
    const length = character.codePointAt(0) > 0xffff ? 2 : 1;
    if (utf16Cursor >= offset) return cursor;
    utf16Cursor += length;
    cursor += character.length;
  }
  return utf16Cursor >= offset ? cursor : value.length;
}

function convertMarkdownLinksToTelegramEntities(text = '') {
  const entities = [];
  const pattern = /\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const [full, label, url] = match;
    result += text.slice(lastIndex, match.index);
    const labelStart = result.length;
    result += label;
    entities.push({ type: 'text_link', offset: labelStart, length: label.length, url });
    lastIndex = match.index + full.length;
  }

  result += text.slice(lastIndex);
  return { text: result, entities };
}

async function publishGiveaway(bot, channelId, giveaway, miniAppUrl, moderatorChatId = null) {
  const text = `🎁 ${giveaway.title}\n\n${giveaway.description || 'Нажми кнопку, чтобы проверить условия и участвовать.'}`;
  const keyboard = new InlineKeyboard().add({
    text: 'Участвовать',
    url: miniAppUrl,
    style: giveaway.buttonStyle ?? 'primary'
  });
  const customEmojiEntities = normalizeCustomEmojiEntities(giveaway.entities);
  const safeText = customEmojiEntities.length ? replaceCustomEmojiWithFallback(text, customEmojiEntities) : text;
  const { text: textWithLinks, entities: linkEntities } = convertMarkdownLinksToTelegramEntities(safeText);
  const options = {
    reply_markup: keyboard,
    disable_web_page_preview: true,
    ...(linkEntities.length ? { entities: linkEntities } : {})
  };
  const mediaOptions = {
    caption: textWithLinks,
    reply_markup: keyboard,
    disable_web_page_preview: true,
    ...(linkEntities.length ? { caption_entities: linkEntities } : {})
  };

  if (giveaway.media?.type === 'photo') return bot.api.sendPhoto(channelId, giveaway.media.fileId, mediaOptions);
  if (giveaway.media?.type === 'video') return bot.api.sendVideo(channelId, giveaway.media.fileId, mediaOptions);
  if (giveaway.media?.type === 'document') return bot.api.sendDocument(channelId, giveaway.media.fileId, mediaOptions);
  return bot.api.sendMessage(channelId, textWithLinks, options);
}

function utf16Length(value) {
  return [...value].reduce((total, character) => total + (character.codePointAt(0) > 0xffff ? 2 : 1), 0);
}

function codePointLengthAt(value, offset) {
  let cursor = 0;
  for (const character of value) {
    const length = character.codePointAt(0) > 0xffff ? 2 : 1;
    if (cursor === offset) return length;
    cursor += length;
  }
  return 0;
}

export { publishGiveaway };

function getMessageEntities(message) {
  return message?.entities ?? message?.caption_entities ?? [];
}

function shiftEntitiesToText(entities = [], startOffset = 0) {
  return entities
    .filter((entity) => entity.offset >= startOffset)
    .map((entity) => ({ ...entity, offset: entity.offset - startOffset }));
}

function customEmojiCount(entities = []) {
  return entities.filter((entity) => entity.type === 'custom_emoji' && entity.custom_emoji_id).length;
}

export function parseGiveawayInput(text, entities = []) {
  const firstPipe = text.indexOf('|');
  const secondPipe = firstPipe < 0 ? -1 : text.indexOf('|', firstPipe + 1);
  const rawTitle = firstPipe < 0 ? text : text.slice(0, firstPipe);
  const rawWinners = firstPipe < 0 ? '' : text.slice(firstPipe + 1, secondPipe < 0 ? text.length : secondPipe);
  const rawDescription = secondPipe < 0 ? '' : text.slice(secondPipe + 1);
  const title = rawTitle.trim();
  const winnersText = rawWinners.trim();
  const description = rawDescription.trim();
  const titleStart = rawTitle.indexOf(title);
  const descriptionStart = secondPipe < 0 ? -1 : secondPipe + 1 + rawDescription.indexOf(description);
  const outputTitleStart = 3;
  const outputDescriptionStart = outputTitleStart + utf16Length(title) + 2;
  const mappedEntities = entities.flatMap((entity) => {
    const entityLength = entity.length;
    const end = entity.offset + entityLength;
    if (title && entity.offset >= titleStart && end <= titleStart + title.length) {
      return [{ ...entity, length: entityLength, offset: outputTitleStart + entity.offset - titleStart }];
    }
    if (description && entity.offset >= descriptionStart && end <= descriptionStart + description.length) {
      return [{ ...entity, length: entityLength, offset: outputDescriptionStart + entity.offset - descriptionStart }];
    }
    return [];
  });
  return { title, winnersText, description, entities: mappedEntities };
}

function parseDateInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 3, Number(minute)));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatMoscowDate(value) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(value));
}

function remapDescriptionEntities(description, entities, title, sourceText = description) {
  const descriptionStart = 3 + utf16Length(title) + 2;
  const sourceStart = sourceText.indexOf(description);
  return (entities ?? []).flatMap((entity) => {
    const entityEnd = entity.offset + entity.length;
    if (sourceStart < 0 || entity.offset < sourceStart || entityEnd > sourceStart + utf16Length(description)) return [];
    return [{ ...entity, offset: descriptionStart + entity.offset - sourceStart }];
  });
}

async function resolveRequiredChannels(bot, references) {
  const botUser = await bot.api.getMe();
  const requiredChannels = [];
  for (const rawReference of references) {
    const reference = normalizeChannelReference(rawReference);
    if (!reference) throw new Error('Не удалось определить канал по этой ссылке. Для приватного канала укажите ID -100...');
    const chat = await bot.api.getChat(reference);
    if (!['channel', 'supergroup'].includes(chat.type)) throw new Error(`«${chat.title ?? reference}» не является каналом или супергруппой`);
    let botMember;
    try {
      botMember = await bot.api.getChatMember(chat.id, botUser.id);
    } catch (error) {
      if (error.description?.includes('member list is inaccessible')) {
        throw new Error(`Telegram не даёт проверить участников «${chat.title ?? reference}». Добавьте бота администратором именно этого канала и включите «Доступ к сообщениям канала».`);
      }
      throw new Error(`Не удалось проверить права бота в «${chat.title ?? reference}»: ${error.description ?? error.message}`);
    }
    if (!['creator', 'administrator'].includes(botMember.status)) throw new Error(`Бот не является администратором канала «${chat.title ?? reference}»`);
    requiredChannels.push({ id: chat.id, title: chat.title ?? reference, url: chat.username ? `https://t.me/${chat.username}` : null });
  }
  return requiredChannels;
}

function normalizeChannelReference(value) {
  const reference = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(reference)) return reference;
  try {
    const url = new URL(reference);
    if (!['t.me', 'telegram.me', 'www.t.me', 'www.telegram.me'].includes(url.hostname.toLowerCase())) return null;
    const segment = url.pathname.split('/').filter(Boolean)[0];
    if (!segment || segment.startsWith('+') || segment.toLowerCase() === 'joinchat') return null;
    return `@${segment.replace(/^@/, '')}`;
  } catch {
    return null;
  }
}

export function startGiveawayScheduler({ bot, store, intervalMs = 15000 }) {
  const processDueGiveaways = async () => {
    for (const giveaway of await store.listGiveaways()) {
      if (giveaway.status !== 'active' || !giveaway.endsAt || new Date(giveaway.endsAt).getTime() > Date.now()) continue;
      const winners = pickWinners(giveaway);
      await store.saveGiveaway(giveaway);
      console.log(`Giveaway ${giveaway.id} finished automatically at ${formatMoscowDate(new Date().toISOString())} MSK`);
      const winnerText = winners.length ? winners.map((id, index) => `${index + 1}. <a href="tg://user?id=${id}">${id}</a>`).join('\n') : 'Участников нет.';
      try {
        await bot.api.sendMessage(giveaway.channelId, `🏆 Итоги конкурса «${giveaway.title}»\n\nПобедители:\n${winnerText}`, { parse_mode: 'HTML' });
      } catch (error) {
        console.error(`Не удалось опубликовать итоги ${giveaway.id}:`, error.message);
      }
      for (const winnerId of winners) {
        try {
          await bot.api.sendMessage(winnerId, `🎉 Поздравляем! Вы победили в конкурсе «${giveaway.title}».\n\nСвяжитесь с организатором канала для получения приза.`);
        } catch (error) {
          console.warn(`Не удалось отправить уведомление победителю ${winnerId}:`, error.message);
        }
      }
    }
  };
  const timer = setInterval(() => processDueGiveaways().catch((error) => console.error('Ошибка планировщика конкурсов:', error)), intervalMs);
  timer.unref?.();
  processDueGiveaways().catch((error) => console.error('Ошибка первичной проверки конкурсов:', error));
  return () => clearInterval(timer);
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
    .text('🎁 Настройка конкурсов', `contests_menu:${channel.id}`).row();
  if (channel.url) keyboard.url('🔗 Открыть канал', channel.url).row();
  return keyboard.text('⬅️ К списку каналов', 'channels_back').row().text('❌ Закрыть', 'channels_close');
}

function colorPaletteKeyboard(channelId) {
  return new InlineKeyboard()
    .text('🔴 Красный', `button_style_set:${channelId}:danger`)
    .text('🟢 Зелёный', `button_style_set:${channelId}:success`).row()
    .text('🔵 Синий', `button_style_set:${channelId}:primary`)
    .text('⚪ Обычный', `button_style_set:${channelId}:default`).row()
    .text('⬅️ Назад', `channel_settings:${channelId}`);
}

export function createBot({ token, store, publicUrl, miniAppName, managedChannels = [] } = {}) {
  const bot = new Bot(token);
  const pendingActions = new Map();

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

  bot.callbackQuery(/^contests_menu:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const channelId = context.match[1];
    const contests = (await store.listGiveaways()).filter((giveaway) => String(giveaway.channelId) === channelId);
    const keyboard = new InlineKeyboard().text('➕ Создать конкурс', `contest_create:${channelId}`).row();
    for (const contest of contests) keyboard.text(`${contest.status === 'draft' ? '📝' : '🎁'} ${contest.title}`, `contest_settings:${contest.id}`).row();
    keyboard.text('⬅️ Назад', `channel_settings:${channelId}`);
    return context.editMessageText(`🎁 Настройка конкурсов\n\nКонкурсов: ${contests.length}\nВыберите конкурс или создайте новый:`, { reply_markup: keyboard });
  });

  bot.callbackQuery(/^contest_create:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    pendingActions.set(String(context.from.id), { type: 'create', channelId: context.match[1] });
    return context.editMessageText('➕ Новый конкурс\n\nОтправьте:\nНазвание | количество победителей | описание\n\nПример:\nБилеты | 2 | Подпишись и участвуй');
  });

  bot.callbackQuery(/^contest_settings:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const giveaway = await store.getGiveaway(context.match[1]);
    if (!giveaway) return context.reply('Конкурс не найден.');
    return context.editMessageText(`⚙️ Настройка конкурса\n\nНазвание: ${giveaway.title}\nУсловия: ${giveaway.requiredChannels.length}\nОписание: ${giveaway.description || 'не задано'}\nИтоги по Москве: ${giveaway.endsAt ? formatMoscowDate(giveaway.endsAt) : 'вручную'}\nМедиа: ${giveaway.media ? 'добавлено' : 'нет'}\nСтатус: ${giveaway.status}`, { reply_markup: contestSettingsKeyboard(giveaway) });
  });

  bot.callbackQuery(/^contest_publish:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const giveaway = await store.getGiveaway(context.match[1]);
    if (!giveaway) return context.reply('Конкурс не найден.');
    if (giveaway.status !== 'draft') return context.reply('Этот конкурс уже опубликован или завершён.');
    giveaway.status = 'active';
    await store.saveGiveaway(giveaway);
    const username = (await bot.api.getMe()).username;
    await publishGiveaway(bot, giveaway.channelId, giveaway, getParticipationLink(username, giveaway.id), context.from.id);
    return context.editMessageText(`✅ Конкурс опубликован: ${giveaway.title}`);
  });

  bot.callbackQuery(/^contest_finish:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const giveaway = await store.getGiveaway(context.match[1]);
    if (!giveaway) return context.reply('Конкурс не найден.');
    if (giveaway.status !== 'active') return context.reply('Конкурс уже завершён.');
    const winners = pickWinners(giveaway);
    await store.saveGiveaway(giveaway);
    const winnerText = winners.length ? winners.map((id, index) => `${index + 1}. <a href="tg://user?id=${id}">${id}</a>`).join('\n') : 'Участников нет.';
    await bot.api.sendMessage(giveaway.channelId, `🏆 Итоги конкурса «${giveaway.title}»\n\nПобедители:\n${winnerText}`, { parse_mode: 'HTML' });
    for (const winnerId of winners) {
      try {
        await bot.api.sendMessage(winnerId, `🎉 Поздравляем! Вы победили в конкурсе «${giveaway.title}».`);
      } catch (error) {
        console.warn(`Не удалось уведомить победителя ${winnerId}:`, error.message);
      }
    }
    return context.editMessageText(`🏁 Конкурс завершён. Победителей: ${winners.length}`);
  });

  bot.callbackQuery(/^contest_button:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const giveaway = await store.getGiveaway(context.match[1]);
    if (!giveaway) return context.reply('Конкурс не найден.');
    const keyboard = new InlineKeyboard()
      .text('🔴 Красный', `contest_button_set:${giveaway.id}:danger`)
      .text('🟢 Зелёный', `contest_button_set:${giveaway.id}:success`).row()
      .text('🔵 Синий', `contest_button_set:${giveaway.id}:primary`)
      .text('⚪ Обычный', `contest_button_set:${giveaway.id}:default`).row()
      .text('⬅️ Назад', `contest_settings:${giveaway.id}`);
    return context.editMessageText(`🎨 Стиль кнопки\n\nТекущий: ${giveaway.buttonStyle ?? 'primary'}`, { reply_markup: keyboard });
  });

  bot.callbackQuery(/^contest_button_set:(.+):(danger|success|primary|default)$/, async (context) => {
    await context.answerCallbackQuery('Сохранено');
    const giveaway = await store.getGiveaway(context.match[1]);
    if (!giveaway) return context.reply('Конкурс не найден.');
    giveaway.buttonStyle = context.match[2];
    await store.saveGiveaway(giveaway);
    return context.editMessageText(`🎨 Стиль кнопки сохранён: ${giveaway.buttonStyle}`, { reply_markup: contestSettingsKeyboard(giveaway) });
  });

  bot.callbackQuery(/^contest_media:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    pendingActions.set(String(context.from.id), { type: 'contest_media', giveawayId: context.match[1] });
    return context.editMessageText('🖼 Отправьте фото, видео или документ. Медиа будет добавлено в этот конкурс.', { reply_markup: new InlineKeyboard().text('⬅️ Назад', `contest_settings:${context.match[1]}`) });
  });

  bot.callbackQuery(/^contest_delete:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const giveaway = await store.getGiveaway(context.match[1]);
    if (!giveaway) return context.reply('Конкурс не найден.');
    await store.deleteGiveaway(giveaway.id);
    return context.editMessageText('🗑 Конкурс удалён из бота. Уже опубликованное сообщение в канале нужно удалить отдельно.', { reply_markup: new InlineKeyboard().text('⬅️ К конкурсам', `contests_menu:${giveaway.channelId}`) });
  });

  bot.callbackQuery(/^contest_partner_remove:(.+):(.+)$/, async (context) => {
    await context.answerCallbackQuery('Партнёр удалён');
    const giveaway = await store.getGiveaway(context.match[1]);
    if (!giveaway) return context.reply('Конкурс не найден.');
    const partnerIndex = Number(context.match[2]);
    if (!Number.isInteger(partnerIndex) || partnerIndex <= 0 || partnerIndex >= giveaway.requiredChannels.length) return context.reply('Канал конкурса обязателен и не может быть удалён.');
    giveaway.requiredChannels.splice(partnerIndex, 1);
    await store.saveGiveaway(giveaway);
    return context.editMessageText('📋 Условия конкурса\n\nВыберите партнёра для удаления или добавьте нового:', { reply_markup: contestConditionsKeyboard(giveaway) });
  });

  bot.callbackQuery(/^contest_conditions_edit:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const giveaway = await store.getGiveaway(context.match[1]);
    if (!giveaway) return context.reply('Конкурс не найден.');
    pendingActions.set(String(context.from.id), { type: 'contest_conditions', giveawayId: giveaway.id });
    return context.editMessageText('📋 Отправьте @username, публичную ссылку https://t.me/... или ID -100... через запятую.', { reply_markup: new InlineKeyboard().text('⬅️ Назад', `contest_settings:${giveaway.id}`) });
  });

  bot.callbackQuery(/^contest_conditions:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const giveaway = await store.getGiveaway(context.match[1]);
    if (!giveaway) return context.reply('Конкурс не найден.');
    return context.editMessageText('📋 Условия конкурса\n\nНажмите на партнёра, чтобы удалить его из условий:', { reply_markup: contestConditionsKeyboard(giveaway) });
  });

  for (const field of ['name', 'description', 'conditions', 'ends']) {
    bot.callbackQuery(new RegExp(`^contest_${field}:(.+)$`), async (context) => {
      await context.answerCallbackQuery();
      const giveaway = await store.getGiveaway(context.match[1]);
      if (!giveaway) return context.reply('Конкурс не найден.');
      pendingActions.set(String(context.from.id), { type: `contest_${field}`, giveawayId: giveaway.id });
      const prompt = field === 'name' ? 'Отправьте новое название конкурса.'
        : field === 'description' ? 'Отправьте новое описание конкурса. Для ссылок используйте формат [слово](https://example.com).'
          : field === 'conditions' ? 'Отправьте @партнёров через запятую или «нет».'
            : 'Отправьте дату итогов по Москве YYYY-MM-DD HH:mm или «нет».';
      return context.editMessageText(`✏️ ${prompt}`, { reply_markup: new InlineKeyboard().text('⬅️ Назад', `contest_settings:${giveaway.id}`) });
    });
  }

  bot.callbackQuery('channels_back', async (context) => {
    await context.answerCallbackQuery();
    const channels = await findAdminChannels(bot, context.from.id, await store.listChannels());
    if (!channels.length) return context.editMessageText('Доступные каналы не найдены.');
    return context.editMessageText('🎛 Выберите канал для настройки:', { reply_markup: channelListKeyboard(channels) });
  });

  bot.callbackQuery(/^giveaway_help:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const channelId = context.match[1];
    pendingActions.set(String(context.from.id), { type: 'create', channelId });
    return context.editMessageText(`🎁 Создание конкурса\n\nТеперь отправьте одним сообщением:\nНазвание конкурса | количество победителей | описание\n\nПоддерживаются ссылки в описании в формате [слово](https://example.com)\nПример:\nБилеты на концерт | 2 | Подпишись на [канал](https://example.com) и участвуй\n\nСсылки будут кликабельными, без предпросмотра.`, { reply_markup: new InlineKeyboard().text('⬅️ Назад', `channel_settings:${channelId}`) });
  });

  bot.callbackQuery(/^conditions_help:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const channel = await store.getChannel(context.match[1]);
    const conditions = channel?.requiredChannels?.length
      ? channel.requiredChannels.map((item) => `• ${item.title} (${item.id})`).join('\n')
      : 'Не настроены';
    pendingActions.set(String(context.from.id), { type: 'conditions', channelId: context.match[1] });
    return context.editMessageText(`📋 Условия подписки\n\nТекущие обязательные каналы:\n${conditions}\n\nТеперь отправьте партнёров через запятую:\n@partner1, https://t.me/partner2\n\nПубличные ссылки поддерживаются автоматически. Для приватного канала используйте ID -100...\n\nСам канал конкурса добавляется автоматически. Чтобы убрать партнёров, отправьте: нет`, { reply_markup: new InlineKeyboard().text('⬅️ Назад', `channel_settings:${context.match[1]}`) });
  });

  bot.callbackQuery(/^ends_at_help:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const channel = await store.getChannel(context.match[1]);
    const current = channel?.defaultEndsAt ? formatMoscowDate(channel.defaultEndsAt) : 'не задана';
    pendingActions.set(String(context.from.id), { type: 'ends_at', channelId: context.match[1] });
    return context.editMessageText(`⏰ Дата итогов по Москве\n\nТекущая дата: ${current}\n\nОтправьте московскую дату и время:\nYYYY-MM-DD HH:mm\n\nПример: 2026-10-01 20:00\n\nЧтобы отключить автоматические итоги, отправьте: нет`, { reply_markup: new InlineKeyboard().text('⬅️ Назад', `channel_settings:${context.match[1]}`) });
  });

  bot.callbackQuery(/^color_help:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    const channel = await store.getChannel(context.match[1]);
    return context.editMessageText(`🎨 Цвет кнопки под постом\n\nТекущий стиль: ${channel?.buttonStyle ?? 'primary'}\n\nВыберите стиль Telegram для новых публикаций:`, { reply_markup: colorPaletteKeyboard(context.match[1]) });
  });

  bot.callbackQuery(/^button_style_set:(.+):(danger|success|primary|default)$/, async (context) => {
    await context.answerCallbackQuery('Цвет сохранён');
    const channelId = context.match[1];
    const buttonStyle = context.match[2];
    const moderator = await bot.api.getChatMember(channelId, context.from.id);
    if (!['creator', 'administrator'].includes(moderator.status)) return context.reply('Нужны права администратора канала.');
    const channel = await store.getChannel(channelId) ?? { id: channelId, title: channelId };
    await store.saveChannel({ ...channel, buttonStyle });
    return context.editMessageText(`🎨 Стиль кнопки сохранён: ${buttonStyle}\n\nОн будет применён к новым публикациям конкурса.`, { reply_markup: channelSettingsKeyboard({ ...channel, buttonStyle }) });
  });

  bot.callbackQuery(/^media_help:(.+)$/, async (context) => {
    await context.answerCallbackQuery();
    pendingActions.set(String(context.from.id), { type: 'media', channelId: context.match[1] });
    return context.editMessageText('🖼 Медиа поста\n\nОтправьте фото, видео или документ с подписью:\nНазвание конкурса | количество победителей\n\nПример: Билеты | 2', { reply_markup: new InlineKeyboard().text('⬅️ Назад', `channel_settings:${context.match[1]}`) });
  });

  bot.on('message', async (context, next) => {
    const action = pendingActions.get(String(context.from.id));
    if (!action || !['media', 'contest_media'].includes(action.type)) return next();
    const source = context.msg;
    if (action.type === 'contest_media') {
      const giveaway = await store.getGiveaway(action.giveawayId);
      const media = source.photo?.at(-1) ? { type: 'photo', fileId: source.photo.at(-1).file_id }
        : source.video ? { type: 'video', fileId: source.video.file_id }
          : source.document ? { type: 'document', fileId: source.document.file_id } : null;
      if (!giveaway || !media) return context.reply('Отправьте фото, видео или документ.');
      giveaway.media = media;
      pendingActions.delete(String(context.from.id));
      await store.saveGiveaway(giveaway);
      return context.reply('Медиа добавлено в конкурс.', { reply_markup: contestSettingsKeyboard(giveaway) });
    }
    const caption = source.caption ?? '';
    const parsed = parseGiveawayInput(caption, getMessageEntities(source));
    const { title, winnersText, description, entities } = parsed;
    const media = source.photo?.at(-1) ? { type: 'photo', fileId: source.photo.at(-1).file_id }
      : source.video ? { type: 'video', fileId: source.video.file_id }
        : source.document ? { type: 'document', fileId: source.document.file_id } : null;
    if (!media || !title || !Number.isInteger(Number(winnersText)) || Number(winnersText) < 1) {
      return context.reply('Отправьте фото, видео или документ с подписью: Название конкурса | количество победителей');
    }
    pendingActions.delete(String(context.from.id));
    try {
      const moderator = await bot.api.getChatMember(action.channelId, context.from.id);
      if (!['creator', 'administrator'].includes(moderator.status)) return context.reply('Нужны права администратора канала.');
      const channelSettings = await store.getChannel(action.channelId);
        pendingActions.set(String(context.from.id), { type: 'create_confirm', draft: { title, description, entities, sourceText: caption, winnersCount: winnersText, channelId: action.channelId, media, requiredChannels: channelSettings?.requiredChannels ?? [], miniAppButtonColor: channelSettings?.miniAppButtonColor, buttonStyle: channelSettings?.buttonStyle } });
        const emojiIds = entities.filter((entity) => entity.type === 'custom_emoji').map((entity) => entity.custom_emoji_id ?? 'без ID');
        return context.reply(`Получено premium emoji: ${customEmojiCount(entities)} (${emojiIds.join(', ') || 'нет ID'}).\nТеперь отправьте дату итогов по Москве:\nYYYY-MM-DD HH:mm\n\nИли отправьте «нет», чтобы подводить итоги вручную.`);
    } catch (error) {
      return context.reply(`Не удалось опубликовать медиа-конкурс: ${error.message}`);
    }
  });

  bot.on('message:text', async (context, next) => {
    const action = pendingActions.get(String(context.from.id));
    if (!action || context.msg.text.startsWith('/')) return next();
    pendingActions.delete(String(context.from.id));
    if (action.type === 'create') {
      const parsed = parseGiveawayInput(context.msg.text, getMessageEntities(context.msg));
      const { title, winnersText, description, entities } = parsed;
      if (!title || !Number.isInteger(Number(winnersText)) || Number(winnersText) < 1) {
        return context.reply('Формат: Название конкурса | количество победителей');
      }
      try {
        const moderator = await bot.api.getChatMember(action.channelId, context.from.id);
        if (!['creator', 'administrator'].includes(moderator.status)) return context.reply('Нужны права администратора канала.');
        const channelSettings = await store.getChannel(action.channelId);
        pendingActions.set(String(context.from.id), { type: 'create_confirm', draft: { title, description, entities, sourceText: context.msg.text, winnersCount: winnersText, channelId: action.channelId, requiredChannels: channelSettings?.requiredChannels ?? [], miniAppButtonColor: channelSettings?.miniAppButtonColor, buttonStyle: channelSettings?.buttonStyle } });
        const emojiIds = entities.filter((entity) => entity.type === 'custom_emoji').map((entity) => entity.custom_emoji_id ?? 'без ID');
        return context.reply(`Получено premium emoji: ${customEmojiCount(entities)} (${emojiIds.join(', ') || 'нет ID'}).\nТеперь отправьте дату итогов:\nYYYY-MM-DD HH:mm\n\nИли отправьте «нет», чтобы подводить итоги вручную.`);
      } catch (error) {
        return context.reply(`Не удалось создать конкурс: ${error.message}`);
      }
    }
    if (action.type.startsWith('contest_')) {
      const giveaway = await store.getGiveaway(action.giveawayId);
      if (!giveaway) return context.reply('Конкурс не найден.');
      try {
        if (action.type === 'contest_name') {
          const title = context.msg.text.trim();
          giveaway.title = title;
          giveaway.entities = [
            ...(giveaway.entities ?? []).filter((entity) => entity.offset >= 3 + utf16Length(title) + 2),
            ...getMessageEntities(context.msg).map((entity) => ({ ...entity, offset: 3 + entity.offset }))
          ];
        }
        if (action.type === 'contest_description') {
          giveaway.description = context.msg.text.trim();
          const titleLength = utf16Length(giveaway.title);
          const titleEntities = (giveaway.entities ?? []).filter((entity) => entity.offset >= 3 && entity.offset < 3 + titleLength);
          giveaway.entities = [...titleEntities, ...remapDescriptionEntities(giveaway.description, getMessageEntities(context.msg), giveaway.title, context.msg.text)];
          giveaway.sourceText = `${giveaway.title} | ${giveaway.winnersCount} | ${giveaway.description}`;
        }
        if (action.type === 'contest_ends') {
          giveaway.endsAt = context.msg.text.trim().toLowerCase() === 'нет' ? null : parseDateInput(context.msg.text.trim());
          if (context.msg.text.trim().toLowerCase() !== 'нет' && !giveaway.endsAt) return context.reply('Неверная дата. Формат: 2026-10-01 20:00');
        }
        if (action.type === 'contest_conditions') {
          const references = context.msg.text.trim().toLowerCase() === 'нет' ? [] : context.msg.text.split(',').map((item) => item.trim()).filter(Boolean);
          const requiredChannels = await resolveRequiredChannels(bot, [giveaway.channelId, ...references]);
          giveaway.requiredChannels = ensurePrimaryChannel(giveaway.channelId, requiredChannels);
        }
        await store.saveGiveaway(giveaway);
        return context.reply(`Настройка сохранена: ${giveaway.title}`, { reply_markup: contestSettingsKeyboard(giveaway) });
      } catch (error) {
        return context.reply(`Не удалось сохранить настройку: ${error.message}`);
      }
    }
    if (action.type === 'conditions') {
      const references = context.msg.text.toLowerCase() === 'нет' ? [] : context.msg.text.split(',').map((item) => item.trim()).filter(Boolean);
      try {
        const requiredChannels = ensurePrimaryChannel(action.channelId, await resolveRequiredChannels(bot, [action.channelId, ...references]));
        const channel = await store.getChannel(action.channelId) ?? { id: action.channelId, title: action.channelId };
        await store.saveChannel({ ...channel, requiredChannels });
        return context.reply(`Условия сохранены. Обязательных каналов: ${requiredChannels.length}.`);
      } catch (error) {
        return context.reply(`Не удалось сохранить канал: ${error.message}`);
      }
    }
    if (action.type === 'create_confirm') {
      const endsAt = context.msg.text.trim().toLowerCase() === 'нет' ? null : parseDateInput(context.msg.text.trim());
      if (context.msg.text.trim().toLowerCase() !== 'нет' && !endsAt) return context.reply('Неверная дата. Используйте формат: 2026-10-01 20:00 или отправьте «нет».');
      try {
        const giveaway = createGiveaway({ ...action.draft, endsAt, status: 'draft' });
        await store.saveGiveaway(giveaway);
        return context.reply(`Черновик конкурса создан: ${giveaway.title}`, { reply_markup: contestSettingsKeyboard(giveaway) });
      } catch (error) {
        return context.reply(`Не удалось создать конкурс: ${error.message}`);
      }
    }
    if (action.type === 'ends_at') {
      const value = context.msg.text.trim().toLowerCase() === 'нет' ? null : parseDateInput(context.msg.text.trim());
      if (context.msg.text.trim().toLowerCase() !== 'нет' && !value) return context.reply('Неверная дата. Используйте формат: 2026-10-01 20:00');
      const channel = await store.getChannel(action.channelId) ?? { id: action.channelId, title: action.channelId };
      await store.saveChannel({ ...channel, defaultEndsAt: value });
      return context.reply(value ? `Дата итогов по Москве сохранена: ${formatMoscowDate(value)}` : 'Автоматическая дата итогов отключена.');
    }
  });

  bot.command('setconditions', async (context) => {
    const [channelId, partnersText = ''] = context.match.split('|').map((part) => part.trim());
    if (!channelId) return context.reply('Формат: /setconditions ID_канала | @партнер1, @партнер2');
    const moderator = await bot.api.getChatMember(channelId, context.from.id);
    if (!['creator', 'administrator'].includes(moderator.status)) return context.reply('Нужны права администратора канала.');
    const references = [channelId, ...partnersText.split(',').map((item) => item.trim()).filter(Boolean)];
    const requiredChannels = ensurePrimaryChannel(channelId, await resolveRequiredChannels(bot, references));
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
      const sourceText = context.match.trim();
      const fullText = context.msg?.text ?? sourceText;
      const sourceStart = fullText.indexOf(sourceText);
      const messageEntities = getMessageEntities(context.msg).filter((entity) => entity.offset >= (sourceStart < 0 ? 0 : sourceStart));
      const parsed = parseGiveawayInput(sourceText, shiftEntitiesToText(messageEntities, sourceStart < 0 ? 0 : sourceStart));
      const channelSettings = await store.getChannel(channelId);
      const giveaway = createGiveaway({
        title: parsed.title,
        description: parsed.description,
        winnersCount: parsed.winnersText,
        channelId,
        media,
        entities: parsed.entities,
        sourceText,
        endsAt: channelSettings?.defaultEndsAt,
        requiredChannels: channelSettings?.requiredChannels ?? [],
        miniAppButtonColor: channelSettings?.miniAppButtonColor,
        buttonStyle: channelSettings?.buttonStyle
      });
      await store.saveGiveaway(giveaway);
      const username = (await bot.api.getMe()).username;
      await publishGiveaway(bot, channelId, giveaway, getParticipationLink(username, giveaway.id), context.from.id);
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

function contestSettingsKeyboard(giveaway) {
  const keyboard = new InlineKeyboard()
    .text('✏️ Название конкурса', `contest_name:${giveaway.id}`).row()
    .text('📋 Условия', `contest_conditions:${giveaway.id}`).row()
    .text('📝 Описание', `contest_description:${giveaway.id}`).row()
    .text('🎨 Кнопка', `contest_button:${giveaway.id}`).row()
    .text('⏰ Итоги конкурса', `contest_ends:${giveaway.id}`).row()
    .text('🖼 Медиа', `contest_media:${giveaway.id}`).row()
    .text('🚀 Опубликовать', `contest_publish:${giveaway.id}`).row();
  if (giveaway.status === 'active') keyboard.text('🏁 Завершить сейчас', `contest_finish:${giveaway.id}`).row();
  keyboard.text('🗑 Удалить конкурс', `contest_delete:${giveaway.id}`).row();
  return keyboard.text('⬅️ К списку конкурсов', `contests_menu:${giveaway.channelId}`);
}

function contestConditionsKeyboard(giveaway) {
  const keyboard = new InlineKeyboard();
  for (const [index, channel] of (giveaway.requiredChannels ?? []).entries()) {
    if (index === 0) keyboard.text(`🔒 ${channel.title} (канал конкурса)`, `contest_conditions:${giveaway.id}`).row();
    else keyboard.text(`❌ ${channel.title}`, `contest_partner_remove:${giveaway.id}:${index}`).row();
  }
  keyboard.text('➕ Добавить партнёров', `contest_conditions_edit:${giveaway.id}`).row();
  return keyboard.text('⬅️ Назад', `contest_settings:${giveaway.id}`);
}