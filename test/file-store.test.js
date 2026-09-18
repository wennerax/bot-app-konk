import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/store/file-store.js';
import { createGiveaway } from '../src/domain/giveaway.js';

test('file store persists channels and giveaways', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'giveaway-store-'));
  const filePath = path.join(directory, 'bot-data.json');
  const firstStore = await new FileStore(filePath).init();
  await firstStore.saveChannel({ id: '-1001', title: 'Test channel' });
  await firstStore.saveGiveaway(createGiveaway({ title: 'Prize', channelId: '-1001', winnersCount: 1 }));
  await firstStore.close();

  const reopenedStore = await new FileStore(filePath).init();
  assert.equal((await reopenedStore.listChannels()).length, 1);
  assert.equal((await reopenedStore.listGiveaways()).length, 1);
  await fs.rm(directory, { recursive: true, force: true });
});