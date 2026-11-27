import { config } from './config.js';
import { VkApi } from './vk.js';
import { Summarizer } from './summarizer.js';

let ok = true;
const vk = new VkApi(config.vkToken);

try {
  const group = await vk.getGroup();
  console.log(`✅ VK токен рабочий: сообщество «${group.name}» (club${group.id})`);
  try {
    const settings = await vk.call('groups.getLongPollSettings', { group_id: group.id });
    const enabled = Boolean(settings.is_enabled);
    const newMessages = Boolean(settings.events?.message_new);
    console.log(`${enabled ? '✅' : '❌'} Long Poll API включён`);
    console.log(`${newMessages ? '✅' : '❌'} событие «Входящее сообщение» (message_new) включено`);
    if (!enabled || !newMessages) ok = false;
  } catch (err) {
    ok = false;
    console.log(`❌ не удалось проверить настройки Long Poll: ${err.message}`);
  }
  try {
    const res = await vk.call('messages.getConversations', { count: 1 });
    console.log(`✅ доступ к сообщениям есть (чатов у сообщества: ${res.count})`);
  } catch (err) {
    ok = false;
    console.log(`❌ нет доступа к сообщениям: ${err.message}`);
  }
} catch (err) {
  ok = false;
  console.log(`❌ VK токен не работает: ${err.message}`);
}

// Каждый провайдер проверяется отдельно, без переключения на запасной
for (const [role, llm] of [['основной', config.llm], ['запасной', config.llmFallback]]) {
  if (!llm) continue;
  try {
    const summarizer = new Summarizer(llm);
    const started = Date.now();
    const answer = await summarizer.summarize(
      ['[27.11 10:00] Иван: Встречаемся завтра в 15:00 у офиса', '[27.11 10:01] Мария: Ок, я возьму проектор'],
      'тест',
    );
    console.log(`✅ ИИ ${role}: ${llm.title} (${llm.model}) отвечает, ${((Date.now() - started) / 1000).toFixed(1)} c:`);
    console.log(answer.split('\n').map((l) => `   ${l}`).join('\n'));
  } catch (err) {
    ok = false;
    console.log(`❌ ИИ ${role}: ${llm.title}: ${err.message}`);
  }
}

process.exit(ok ? 0 : 1);
