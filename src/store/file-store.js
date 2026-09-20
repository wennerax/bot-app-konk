import fs from 'node:fs/promises';
import path from 'node:path';
import { ensurePrimaryChannel } from '../domain/giveaway.js';
import { addParticipant } from '../domain/giveaway.js';

const emptyData = () => ({ channels: {}, giveaways: {} });

export class FileStore {
  constructor(filePath = path.join(process.cwd(), 'data', 'bot-data.json')) {
    this.filePath = filePath;
    this.data = emptyData();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      this.data = { ...emptyData(), ...JSON.parse(content) };
      let migrated = false;
      for (const channel of Object.values(this.data.channels)) {
        const requiredChannels = ensurePrimaryChannel(channel.id, channel.requiredChannels ?? []);
        migrated ||= JSON.stringify(requiredChannels) !== JSON.stringify(channel.requiredChannels ?? []);
        channel.requiredChannels = requiredChannels;
      }
      for (const giveaway of Object.values(this.data.giveaways)) {
        const requiredChannels = ensurePrimaryChannel(giveaway.channelId, giveaway.requiredChannels ?? []);
        migrated ||= JSON.stringify(requiredChannels) !== JSON.stringify(giveaway.requiredChannels ?? []);
        giveaway.requiredChannels = requiredChannels;
      }
      if (migrated) await this.persist();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persist();
    }
    return this;
  }

  async persist() {
    const snapshot = JSON.stringify(this.data, null, 2);
    const temporaryPath = `${this.filePath}.tmp`;
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.writeFile(temporaryPath, snapshot, 'utf8');
      await fs.rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }

  async saveGiveaway(giveaway) {
    this.data.giveaways[giveaway.id] = structuredClone(giveaway);
    await this.persist();
    return giveaway;
  }

  async getGiveaway(id) {
    return this.data.giveaways[id] ? structuredClone(this.data.giveaways[id]) : null;
  }

  async addParticipant(id, userId, profile) {
    const giveaway = this.data.giveaways[id];
    if (!giveaway) return { added: false, reason: 'not_found' };
    const result = addParticipant(giveaway, userId, profile);
    if (result.added) await this.persist();
    return result;
  }

  async deleteGiveaway(id) {
    delete this.data.giveaways[id];
    await this.persist();
  }

  async listGiveaways() {
    return Object.values(this.data.giveaways)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((giveaway) => structuredClone(giveaway));
  }

  async saveChannel(channel) {
    const id = String(channel.id);
    const existing = this.data.channels[id] ?? {};
    this.data.channels[id] = {
      ...existing,
      ...structuredClone(channel),
      id,
      requiredChannels: channel.requiredChannels ?? existing.requiredChannels ?? [],
      miniAppButtonColor: channel.miniAppButtonColor ?? existing.miniAppButtonColor ?? '#e6ff54',
      buttonStyle: channel.buttonStyle ?? existing.buttonStyle ?? 'primary',
      defaultEndsAt: channel.defaultEndsAt ?? existing.defaultEndsAt ?? null
    };
    await this.persist();
    return structuredClone(this.data.channels[id]);
  }

  async listChannels() {
    return Object.values(this.data.channels).map((channel) => structuredClone(channel));
  }

  async getChannel(id) {
    const channel = this.data.channels[String(id)];
    return channel ? structuredClone(channel) : null;
  }

  async close() {
    await this.writeQueue;
  }
}
