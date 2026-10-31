import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { createBot, startGiveawayScheduler } from './bot.js';
import { config } from './config.js';
import { createGiveaway, ensurePrimaryChannel } from './domain/giveaway.js';
import { MemoryStore } from './store/memory-store.js';
import { FileStore } from './store/file-store.js';
import { addParticipant } from './domain/giveaway.js';
import { checkRequiredChannels } from './services/subscription.js';
import { validateWebAppInitData } from './services/telegram-auth.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function getReferralContext(initData, giveaway, userId) {
  const startParam = new URLSearchParams(initData ?? '').get('start_param') ?? '';
  const match = /^g_(.+)_r_(\d+)$/.exec(startParam);
  if (!match || match[1] !== String(giveaway.id) || !giveaway.referralChannel) return null;
  const referrerId = match[2];
  if (referrerId === String(userId) || !giveaway.participants.includes(referrerId)) return null;
  return { referrerId, referralChannel: giveaway.referralChannel };
}

function publicGiveaway(giveaway) {
  const { referralCounts, referredBy, ...publicData } = giveaway;
  return publicData;
}

export function buildServer({ bot, store, botToken, webhookSecret } = {}) {
  const app = Fastify({ logger: true });
  const giveawayStore = store ?? new MemoryStore();
  app.register(fastifyStatic, { root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public') });
  app.get('/', async (_, reply) => reply.sendFile('index.html'));
  app.get('/health', async () => ({ ok: true }));
  app.get('/api/telegram-status', async (_, reply) => {
    if (!bot) return reply.code(503).send({ ok: false, error: 'BOT_TOKEN не настроен' });
    const info = await bot.api.getWebhookInfo();
    return {
      ok: true,
      webhookUrl: info.url,
      pendingUpdates: info.pending_update_count,
      lastError: info.last_error_message ?? null,
      lastErrorDate: info.last_error_date ?? null
    };
  });
  app.get('/api/giveaways', async () => (await giveawayStore.listGiveaways())
    .filter((giveaway) => giveaway.status !== 'draft')
    .map(publicGiveaway));
  app.get('/api/my-participations', async (request, reply) => {
    if (!botToken) return reply.code(503).send({ error: 'BOT_TOKEN не настроен' });
    const user = validateWebAppInitData(request.headers['x-telegram-init-data'], botToken);
    if (!user) return reply.code(401).send({ error: 'Telegram не передал данные пользователя. Откройте Mini App из Telegram.' });
    const giveaways = await giveawayStore.listGiveaways();
    return giveaways
      .filter((giveaway) => giveaway.status !== 'draft' && giveaway.participants.includes(String(user.id)))
      .map(publicGiveaway);
  });
  app.get('/api/giveaways/:id', async (request, reply) => {
    const giveaway = await giveawayStore.getGiveaway(request.params.id);
    if (!giveaway || giveaway.status === 'draft') return reply.code(404).send({ error: 'Конкурс не опубликован' });
    const user = botToken ? validateWebAppInitData(request.headers['x-telegram-init-data'], botToken) : null;
    const userId = user ? String(user.id) : null;
    const winners = Array.isArray(giveaway.winners) ? giveaway.winners : [];
    const winnerIndex = userId ? winners.findIndex((winnerId) => String(winnerId) === userId) : -1;
    return {
      ...publicGiveaway(giveaway),
      viewerResult: giveaway.status === 'finished' && userId
        ? { participated: giveaway.participants.includes(userId), won: winnerIndex >= 0, place: winnerIndex >= 0 ? winnerIndex + 1 : null }
        : null
    };
  });
  app.get('/api/media/:fileId', async (request, reply) => {
    if (!bot || !botToken) return reply.code(503).send({ error: 'Telegram bot не настроен' });
    const fileId = request.params.fileId;
    const giveaways = await giveawayStore.listGiveaways();
    const isPublishedMedia = giveaways.some((giveaway) => giveaway.status !== 'draft' && giveaway.media?.fileId === fileId);
    if (!isPublishedMedia) return reply.code(404).send({ error: 'Медиа не найдено' });
    const file = await bot.api.getFile(fileId);
    const mediaResponse = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
    if (!mediaResponse.ok) return reply.code(404).send({ error: 'Медиа не найдено' });
    reply.type(mediaResponse.headers.get('content-type') ?? 'application/octet-stream');
    return Buffer.from(await mediaResponse.arrayBuffer());
  });
  app.post('/api/giveaways', async (request, reply) => {
    if (!bot || !botToken) return reply.code(503).send({ error: 'Telegram bot не настроен' });
    const user = validateWebAppInitData(request.headers['x-telegram-init-data'], botToken);
    if (!user) return reply.code(401).send({ error: 'Недействительные данные Telegram' });
    try {
      const input = request.body ?? {};
      const moderator = await bot.api.getChatMember(input.channelId, user.id);
      if (!['creator', 'administrator'].includes(moderator.status)) {
        return reply.code(403).send({ error: 'Создавать конкурсы может только администратор канала' });
      }
      const giveaway = createGiveaway(input);
      await giveawayStore.saveGiveaway(giveaway);
      return reply.code(201).send(giveaway);
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });
  app.post('/api/giveaways/:id/participate', async (request, reply) => {
    if (!bot || !botToken) return reply.code(503).send({ error: 'Telegram bot не настроен' });
    const user = validateWebAppInitData(request.headers['x-telegram-init-data'], botToken);
    if (!user) return reply.code(401).send({ error: 'Недействительные данные Telegram' });
    const giveaway = await giveawayStore.getGiveaway(request.params.id);
    if (!giveaway) return reply.code(404).send({ error: 'Конкурс не найден' });
    giveaway.requiredChannels = ensurePrimaryChannel(giveaway.channelId, giveaway.requiredChannels);
    const referral = getReferralContext(request.headers['x-telegram-init-data'], giveaway, user.id);
    const referralIsRequired = referral && giveaway.requiredChannels.some(
      (channel) => String(channel.id) === String(referral.referralChannel.id)
    );
    const channelsToCheck = referral && !referralIsRequired
      ? [...giveaway.requiredChannels, referral.referralChannel]
      : giveaway.requiredChannels;
    const check = await checkRequiredChannels(bot, user.id, channelsToCheck);
    if (!check.passed) return reply.code(403).send({ error: 'Не выполнены условия конкурса', channels: check.channels, missingChannels: check.channels.filter((channel) => !channel.isMember) });
    const result = giveawayStore.addParticipant
      ? await giveawayStore.addParticipant(giveaway.id, user.id, user, referral?.referrerId)
      : addParticipant(giveaway, user.id, user, referral?.referrerId);
    if (!giveawayStore.addParticipant) await giveawayStore.saveGiveaway(giveaway);
    return { ...result, giveawayId: giveaway.id };
  });
  if (bot) {
    app.get('/telegram/webhook', async () => ({ ok: true, message: 'Telegram webhook endpoint is ready' }));
    app.post('/telegram/webhook', async (request, reply) => {
      if (!webhookSecret || request.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
        return reply.code(401).send({ ok: false, error: 'Invalid webhook secret' });
      }
      console.log(`Telegram webhook POST received: ${request.body?.update_id ?? 'unknown'}`);
      await bot.handleUpdate(request.body);
      return reply.send({ ok: true });
    });
  }
  return app;
}

const isDirectRun = path.basename(process.argv[1] ?? '') === 'server.js';

if (isDirectRun) {
  const store = await new FileStore(config.dataFile).init();
  console.log(`File database: ${config.dataFile}`);
  const bot = config.botToken ? createBot({ token: config.botToken, store, publicUrl: config.publicUrl, miniAppName: process.env.MINI_APP_NAME, managedChannels: config.managedChannels }) : null;
  const app = buildServer({ bot, store, botToken: config.botToken, webhookSecret: config.webhookSecret });
  if (bot) await bot.init();
  if (bot) startGiveawayScheduler({ bot, store });
  await app.listen({ port: config.port, host: '0.0.0.0' });
  if (bot) {
    const publicUrl = new URL(config.publicUrl);
    const hasPublicHostname = publicUrl.hostname.includes('.') && publicUrl.hostname !== 'localhost';
    console.log(`Configured public URL: ${config.publicUrl}`);
    if (publicUrl.protocol === 'https:' && hasPublicHostname) {
      try {
        await bot.api.setWebhook(`${config.publicUrl.replace(/\/$/, '')}/telegram/webhook`, { secret_token: config.webhookSecret });
        const webhookInfo = await bot.api.getWebhookInfo();
        console.log(`Telegram webhook configured: ${webhookInfo.url}`);
      } catch (error) {
        console.error(`Webhook не настроен для ${config.publicUrl}: ${error.description ?? error.message}`);
        console.error('Проверьте PUBLIC_URL: нужен полный публичный DNS-адрес, например https://bred.bothost.tech');
        await bot.api.deleteWebhook();
        bot.start();
      }
    } else {
      console.warn(`PUBLIC_URL=${config.publicUrl} не является публичным HTTPS-адресом; используется long polling.`);
      await bot.api.deleteWebhook();
      bot.start();
    }
  }
}