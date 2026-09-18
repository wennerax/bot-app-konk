import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { createBot, startGiveawayScheduler } from './bot.js';
import { config } from './config.js';
import { createGiveaway } from './domain/giveaway.js';
import { MemoryStore } from './store/memory-store.js';
import { FileStore } from './store/file-store.js';
import { addParticipant } from './domain/giveaway.js';
import { checkRequiredChannels } from './services/subscription.js';
import { validateWebAppInitData } from './services/telegram-auth.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function buildServer({ bot, store, botToken } = {}) {
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
  app.get('/api/giveaways', async () => (await giveawayStore.listGiveaways()).filter((giveaway) => giveaway.status !== 'draft'));
  app.get('/api/my-participations', async (request, reply) => {
    if (!botToken) return reply.code(503).send({ error: 'BOT_TOKEN не настроен' });
    const user = validateWebAppInitData(request.headers['x-telegram-init-data'], botToken);
    if (!user) return reply.code(401).send({ error: 'Telegram не передал данные пользователя. Откройте Mini App из Telegram.' });
    const giveaways = await giveawayStore.listGiveaways();
    return giveaways.filter((giveaway) => giveaway.status !== 'draft' && giveaway.participants.includes(String(user.id)));
  });
  app.get('/api/giveaways/:id', async (request, reply) => {
    const giveaway = await giveawayStore.getGiveaway(request.params.id);
    if (!giveaway || giveaway.status === 'draft') return reply.code(404).send({ error: 'Конкурс не опубликован' });
    return giveaway;
  });
  app.get('/api/media/:fileId', async (request, reply) => {
    if (!bot || !botToken) return reply.code(503).send({ error: 'Telegram bot не настроен' });
    const file = await bot.api.getFile(request.params.fileId);
    const mediaResponse = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
    if (!mediaResponse.ok) return reply.code(404).send({ error: 'Медиа не найдено' });
    reply.type(mediaResponse.headers.get('content-type') ?? 'application/octet-stream');
    return Buffer.from(await mediaResponse.arrayBuffer());
  });
  app.post('/api/giveaways', async (request, reply) => {
    try {
      const giveaway = createGiveaway(request.body ?? {});
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
    const check = await checkRequiredChannels(bot, user.id, giveaway.requiredChannels);
    if (!check.passed) return reply.code(403).send({ error: 'Не выполнены условия конкурса', channels: check.channels, missingChannels: check.channels.filter((channel) => !channel.isMember) });
    const result = addParticipant(giveaway, user.id);
    await giveawayStore.saveGiveaway(giveaway);
    return { ...result, giveawayId: giveaway.id };
  });
  if (bot) {
    app.get('/telegram/webhook', async () => ({ ok: true, message: 'Telegram webhook endpoint is ready' }));
    app.post('/telegram/webhook', async (request, reply) => {
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
  const app = buildServer({ bot, store, botToken: config.botToken });
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