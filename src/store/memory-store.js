export class MemoryStore {
  constructor() {
    this.giveaways = new Map();
  }

  async saveGiveaway(giveaway) {
    this.giveaways.set(giveaway.id, giveaway);
    return giveaway;
  }

  async getGiveaway(id) {
    return this.giveaways.get(id) ?? null;
  }

  async listGiveaways() {
    return [...this.giveaways.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}