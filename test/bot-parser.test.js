import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDateInput, parseGiveawayInput, publishGiveaway } from '../src/bot.js';

test('accepts the configured date format for giveaway results', () => {
  const result = parseDateInput('09-21 00:00', new Date('2026-09-20T12:00:00Z'));
  assert.equal(result, '2026-09-20T21:00:00.000Z');
});

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

test('keeps a custom emoji at the end of the description after trimming', () => {
  const text = 'Билеты | 2 | Подпишись и участвуй ✅';
  const emojiOffset = text.indexOf('✅');
  const parsed = parseGiveawayInput(text, [{
    type: 'custom_emoji',
    offset: emojiOffset,
    length: 1,
    custom_emoji_id: '555666777'
  }]);

  assert.equal(parsed.description, 'Подпишись и участвуй ✅');
  assert.deepEqual(parsed.entities, [{
    type: 'custom_emoji',
    offset: 3 + 'Билеты'.length + 2 + 'Подпишись и участвуй '.length,
    length: 1,
    custom_emoji_id: '555666777'
  }]);
});

test('publishes premium emoji entities in channel posts', async () => {
  let payload;
  const bot = { api: { sendRichMessage: async (...args) => { payload = args; } } };
  await publishGiveaway(bot, '-1001', {
    title: 'Билеты',
    description: 'Премиум ✨',
    entities: [{ type: 'custom_emoji', offset: 19, length: 1, custom_emoji_id: '123456789' }],
    buttonStyle: 'primary'
  }, 'https://t.me/example?startapp=g_1');

  assert.equal(payload[0], '-1001');
  assert.match(payload[1].html, /<p>🎁 Билеты<\/p>/);
  assert.match(payload[1].html, /<p>Премиум ✨<\/p>/);
  assert.match(payload[1].html, /<tg-button-row align="center">/);
  assert.match(payload[1].html, /<tg-button type="url" style="primary" url="https:\/\/t\.me\/example\?startapp=g_1">🎁 Участвовать<\/tg-button>/);
});

test('adds the referral button only when a referral channel is configured', async () => {
  let payload;
  const bot = { api: { sendRichMessage: async (...args) => { payload = args; } } };
  await publishGiveaway(bot, '-1001', {
    id: 'giveaway-1',
    title: 'Билеты',
    description: '',
    referralChannel: { id: '-1002', title: 'Канал', url: 'https://t.me/channel' }
  }, 'https://t.me/example?startapp=g_giveaway-1', null, 'example');

  assert.match(payload[1].html, /<tg-button type="url" style="primary" url="https:\/\/t\.me\/example\?start=ref_giveaway-1">🔗 Реф\. ссылка<\/tg-button>/);
  assert.equal((payload[1].html.match(/<tg-button /g) ?? []).length, 2);
});

test('converts markdown links to safe clickable rich message links', async () => {
  let payload;
  const bot = { api: { sendRichMessage: async (...args) => { payload = args; } } };

  await publishGiveaway(bot, '-1001', {
    title: 'Билеты',
    description: 'Подпишись на [<канал>](https://example.com/?x=1&y=2)',
    buttonStyle: 'primary'
  }, 'https://t.me/example?startapp=g_1');

  assert.match(payload[1].html, /Подпишись на <a href="https:\/\/example\.com\/\?x=1&amp;y=2">&lt;канал&gt;<\/a>/);
});

test('keeps giveaway media in the rich message with the same button row', async () => {
  let payload;
  const bot = { api: { sendRichMessage: async (...args) => { payload = args; } } };
  await publishGiveaway(bot, '-1001', {
    title: 'Фото-приз',
    description: 'Условия',
    media: { type: 'photo', fileId: 'telegram-file-id' }
  }, 'https://t.me/example?startapp=g_1');

  assert.equal(payload[1].media[0].id, 'giveaway_media');
  assert.deepEqual(payload[1].media[0].media, { type: 'photo', media: 'telegram-file-id' });
  assert.match(payload[1].html, /<img src="tg:\/\/photo\?id=giveaway_media">/);
  assert.match(payload[1].html, /<tg-button-row align="center">/);
});

test('escapes giveaway title and description before sending rich HTML', async () => {
  let payload;
  const bot = { api: { sendRichMessage: async (...args) => { payload = args; } } };
  await publishGiveaway(bot, '-1001', {
    title: '<приз>',
    description: 'условие <script>alert(1)</script>'
  }, 'https://t.me/example?startapp=g_1');

  assert.match(payload[1].html, /<p>🎁 &lt;приз&gt;<\/p>/);
  assert.match(payload[1].html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(payload[1].html, /<script>/);
});

test('keeps consecutive custom emoji with different UTF-16 lengths', () => {
  const text = 'Билеты | 2 | Подпишись 💜 ✅';
  const firstOffset = text.indexOf('💜');
  const parsed = parseGiveawayInput(text, [
    { type: 'custom_emoji', offset: firstOffset, length: 2, custom_emoji_id: 'purple' },
    { type: 'custom_emoji', offset: firstOffset + 3, length: 1, custom_emoji_id: 'check' }
  ]);

  assert.deepEqual(parsed.entities.map(({ offset, length, custom_emoji_id }) => ({ offset, length, custom_emoji_id })), [
    { offset: 21, length: 2, custom_emoji_id: 'purple' },
    { offset: 24, length: 1, custom_emoji_id: 'check' }
  ]);
});