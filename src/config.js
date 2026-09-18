import 'dotenv/config';
import path from 'node:path';

function parseChannels(value) {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('MANAGED_CHANNELS должен быть JSON-массивом');
  }
}

export const config = {
  botToken: process.env.BOT_TOKEN,
  publicUrl: process.env.PUBLIC_URL ?? process.env.APP_URL ?? 'https://bot-1789719870-1665-wennera.bothost.tech',
  port: Number(process.env.PORT ?? 3000),
  webhookSecret: process.env.WEBHOOK_SECRET ?? 'change-me',
  managedChannels: parseChannels(process.env.MANAGED_CHANNELS),
  dataFile: process.env.DATA_FILE ?? path.join(process.cwd(), 'data', 'bot-data.json')
};