import { parseGiveawayInput } from './src/bot.js';

const text = 'Билеты | 2 | Подпишись и участвуй ✅';
const parsed = parseGiveawayInput(text, [{
  type: 'custom_emoji',
  offset: text.indexOf('✅'),
  length: 1,
  custom_emoji_id: 'x'
}]);

console.log('parsed', JSON.stringify(parsed, null, 2));
const finalText = `🎁 ${parsed.title}\n\n${parsed.description}`;
console.log('finalText', JSON.stringify(finalText));
console.log('entities', JSON.stringify(parsed.entities, null, 2));
