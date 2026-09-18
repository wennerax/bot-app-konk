import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGiveawayInput } from '../src/bot.js';

test('pipe-delimited giveaway text keeps UTF-16 entity positions', () => {
  const text = 'Название 🎁 | 2 | Подпишись на канал 🪩';
  const descriptionStart = text.indexOf('Подпишись');
  const entity = { type: 'custom_emoji', offset: descriptionStart + 'Подпишись на канал '.length, length: 2, custom_emoji_id: '123' };
  const title = 'Название 🎁';
  const outputDescriptionStart = 3 + [...title].reduce((sum, character) => sum + (character.codePointAt(0) > 0xffff ? 2 : 1), 0) + 2;
  const expected = outputDescriptionStart + 'Подпишись на канал '.length;
  assert.equal(entity.offset - descriptionStart + outputDescriptionStart, expected);
});

test('preserves custom emoji entity data in giveaway description', () => {
  const text = 'Приз | 1 | 🔥 Премиум эмодзи';
  const emojiOffset = text.indexOf('🔥');
  const parsed = parseGiveawayInput(text, [{
    type: 'custom_emoji',
    offset: emojiOffset,
    length: 2,
    custom_emoji_id: '987654321'
  }]);

  assert.deepEqual(parsed.entities, [{
    type: 'custom_emoji',
    offset: 3 + 'Приз'.length + 2,
    length: 2,
    custom_emoji_id: '987654321'
  }]);
});