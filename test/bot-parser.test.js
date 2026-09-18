import test from 'node:test';
import assert from 'node:assert/strict';

test('pipe-delimited giveaway text keeps UTF-16 entity positions', () => {
  const text = 'Название 🎁 | 2 | Подпишись на канал 🪩';
  const descriptionStart = text.indexOf('Подпишись');
  const entity = { type: 'custom_emoji', offset: descriptionStart + 'Подпишись на канал '.length, length: 2, custom_emoji_id: '123' };
  const title = 'Название 🎁';
  const outputDescriptionStart = 3 + [...title].reduce((sum, character) => sum + (character.codePointAt(0) > 0xffff ? 2 : 1), 0) + 2;
  const expected = outputDescriptionStart + 'Подпишись на канал '.length;
  assert.equal(entity.offset - descriptionStart + outputDescriptionStart, expected);
});