import { addParticipant } from '../domain/giveaway.js';

export class MemoryStore {
  constructor() {
    this.giveaways = new Map();
    this.channels = new Map();
  }

  async saveGiveaway(giveaway) {
    this.giveaways.set(giveaway.id, giveaway);
    return giveaway;
  }

  async addParticipant(id, userId, profile, referrerId) {
    const giveaway = this.giveaways.get(id);
    if (!giveaway) return { added: false, reason: 'not_found' };
    return addParticipant(giveaway, userId, profile, referrerId);
  }

  async getGiveaway(id) {
    return this.giveaways.get(id) ?? null;
  }

  async deleteGiveaway(id) {
    this.giveaways.delete(id);
  }

  async listGiveaways() {
    return [...this.giveaways.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async saveChannel(channel) {
    const existing = this.channels.get(String(channel.id));
    this.channels.set(String(channel.id), {
      ...existing,
      ...channel,
      id: String(channel.id),
      requiredChannels: channel.requiredChannels ?? existing?.requiredChannels ?? [],
      miniAppButtonColor: channel.miniAppButtonColor ?? existing?.miniAppButtonColor ?? '#e6ff54'
    });
    return this.channels.get(String(channel.id));
  }

  async listChannels() {
    return [...this.channels.values()];
  }

  async getChannel(id) {
    return this.channels.get(String(id)) ?? null;
  }
}