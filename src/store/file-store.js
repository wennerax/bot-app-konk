import fs from 'node:fs/promises';
import path from 'node:path';

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
      buttonStyle: channel.buttonStyle ?? existing.buttonStyle ?? 'primary'
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
