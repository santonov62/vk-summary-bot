import { config } from './config.js';
import { VkApi, FLOOD_CONTROL, FLOOD_HINT, NO_CHAT_ACCESS, downloadImage } from './vk.js';
import { Summarizer } from './summarizer.js';
import { parsePeriod, formatTime, PERIODS_HELP } from './periods.js';

const vk = new VkApi(config.vkToken);
const summarizer = new Summarizer(config.llm, { fallback: config.llmFallback, retryMin: config.llmRetryMin });

const COMMAND_RE = /^[/!](сводка|выжимка|summary|итоги)(?:\s+(.*))?$/is;
const HELP_RE = /^[/!](помощь|help)$/i;
const ASK_RE = /^[/!](ии|ai|вопрос|спроси)(?:\s+(.*))?$/is;
const CHAT_RE = /^[/!](чат|chat)(?:\s+(.*))?$/is;
// Упоминание бота перед командой: «[club123|@bot] /сводка»
const MENTION_RE = /^\[(?:club|public)\d+\|[^\]]*\][,\s]*/i;
// Метка ответов бота: по ней они исключаются из следующих сводок
const BOT_MARK = '🤖';
const VK_MAX_LEN = 4000;
// Сколько фото из сообщения отправлять модели за один вопрос
const MAX_IMAGES = 4;
// Пауза между частями длинной сводки, чтобы не попасть под флуд-контроль
const SEND_DELAY_MS = 1500;
// После флуд-контроля команды игнорируются это время: любые запросы продлевают ограничение
const FLOOD_PAUSE_MS = 30 * 60_000;
const busyChats = new Set();
let floodPausedUntil = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function handleFlood(err) {
  if (err?.code !== FLOOD_CONTROL) return false;
  floodPausedUntil = Date.now() + FLOOD_PAUSE_MS;
  console.error(`${FLOOD_HINT}\nКоманды не обрабатываются ${FLOOD_PAUSE_MS / 60_000} мин.`);
  return true;
}

const HELP_TEXT = `${BOT_MARK} Команды:

/сводка [период] — выжимка переписки
Периоды: ${PERIODS_HELP}
Примеры: /сводка, /сводка вчера, /сводка 3д, /сводка 20.11-25.11

/ии вопрос — задать любой вопрос ИИ
Пример: /ии как сварить борщ
Если отправить /ии ответом на сообщение или переслать сообщения вместе с /ии, вопрос будет про них (например, «/ии переведи»).
ИИ понимает картинки: прикрепите фото к /ии или ответьте /ии на сообщение с фото.

/чат [период] вопрос — вопрос по переписке этого чата (по умолчанию за последние 7 дней)
Примеры: /чат кто обещал взять проектор?, /чат найди ссылку на магазин, /чат месяц что решили по поездке?`;

const ATTACH_NAMES = {
  photo: 'фото', video: 'видео', audio: 'аудио', doc: 'документ', link: 'ссылка',
  sticker: 'стикер', audio_message: 'голосовое сообщение', wall: 'запись со стены',
  poll: 'опрос', graffiti: 'граффити', gift: 'подарок', market: 'товар',
};

// Текст сообщения + пометки о вложениях, ответах и пересланных сообщениях
function messageText(msg) {
  const parts = [];
  if (msg.text) parts.push(msg.text);
  for (const att of msg.attachments ?? []) {
    if (att.type === 'audio_message' && att.audio_message?.transcript) {
      parts.push(`[голосовое: ${att.audio_message.transcript}]`);
    } else if (att.type === 'link' && att.link?.url) {
      parts.push(`[ссылка: ${att.link.title ?? ''} ${att.link.url}]`);
    } else if (att.type === 'poll' && att.poll?.question) {
      parts.push(`[опрос: ${att.poll.question}]`);
    } else if (att.type === 'doc' && att.doc?.title) {
      parts.push(`[документ: ${att.doc.title}]`);
    } else {
      parts.push(`[${ATTACH_NAMES[att.type] ?? att.type}]`);
    }
  }
  if (msg.reply_message?.text) parts.push(`(в ответ на: «${msg.reply_message.text.slice(0, 200)}»)`);
  for (const fwd of msg.fwd_messages ?? []) {
    if (fwd.text) parts.push(`(переслано: «${fwd.text.slice(0, 500)}»)`);
  }
  if (msg.action) parts.push(`[служебное: ${msg.action.type}]`);
  return parts.join(' ');
}

const stripMention = (text) => (text ?? '').trim().replace(MENTION_RE, '');

function isServiceText(text) {
  const t = stripMention(text);
  return t.startsWith(BOT_MARK) || [COMMAND_RE, HELP_RE, ASK_RE, CHAT_RE].some((re) => re.test(t));
}

function authorName(id, profiles, groups) {
  if (id > 0) return profiles.get(id) ?? `id${id}`;
  return groups.get(-id) ?? `club${-id}`;
}

function splitMessage(text) {
  const result = [];
  let rest = text;
  while (rest.length > VK_MAX_LEN) {
    let cut = rest.lastIndexOf('\n', VK_MAX_LEN);
    if (cut < VK_MAX_LEN / 2) cut = VK_MAX_LEN;
    result.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) result.push(rest);
  return result;
}

const reply = (peerId, text) => vk.sendMessage(peerId, `${BOT_MARK} ${text}`);

const NO_ACCESS_TEXT = 'Нет доступа к переписке. Сделайте сообщество администратором беседы и повторите команду.';

// Переписка за период в виде строк «[время] Автор: текст», без команд и ответов бота
async function loadLines(peerId, commandCmid, period) {
  const { items, profiles, groups, truncated } = await vk.getHistorySince(
    peerId, commandCmid, period.from, period.to, config.maxMessages,
  );
  const lines = items
    .filter((msg) => !isServiceText(msg.text))
    .map((msg) => ({ msg, text: messageText(msg) }))
    .filter(({ text }) => text)
    .map(({ msg, text }) =>
      `[${formatTime(msg.date, config.timezone)}] ${authorName(msg.from_id, profiles, groups)}: ${text}`);
  return { lines, truncated };
}

async function handleSummary(peerId, periodArg, commandDate, commandCmid) {
  const period = parsePeriod(periodArg ?? '', commandDate, config.timezone);
  if (!period) {
    await reply(peerId, `Не понял период «${periodArg}». Доступно: ${PERIODS_HELP}`);
    return;
  }
  if (busyChats.has(peerId)) {
    await reply(peerId, 'Уже готовлю сводку, подождите немного.');
    return;
  }

  busyChats.add(peerId);
  try {
    const { lines, truncated } = await loadLines(peerId, commandCmid, period);
    if (!lines.length) {
      await reply(peerId, `За период «${period.title}» сообщений не найдено.`);
      return;
    }

    await reply(peerId, `Готовлю сводку за ${period.title} (${lines.length} сообщ.)…`);
    const summary = await summarizer.summarize(lines, period.title);
    const note = truncated ? `\n(учтены только последние ${config.maxMessages} сообщений)` : '';
    const header = `Сводка за ${period.title} (${lines.length} сообщ.)${note}:\n\n`;
    const parts = splitMessage(header + (summary || 'Модель вернула пустой ответ.'));
    for (const [i, part] of parts.entries()) {
      if (i > 0) await sleep(SEND_DELAY_MS);
      await reply(peerId, part);
    }
  } catch (err) {
    // При флуд-контроле отправить сообщение об ошибке всё равно не получится
    if (handleFlood(err)) return;
    console.error('Ошибка при создании сводки:', err);
    const text = err.code === NO_CHAT_ACCESS ? NO_ACCESS_TEXT : 'Не удалось сделать сводку, подробности в логе бота.';
    await reply(peerId, text).catch(handleFlood);
  } finally {
    busyChats.delete(peerId);
  }
}

// «/чат неделя что решили?» — период в начале необязателен, по умолчанию последние 7 дней
function parseChatQuestion(arg, now) {
  const [first, ...rest] = arg.split(/\s+/);
  const period = rest.length ? parsePeriod(first, now, config.timezone) : null;
  if (period) return { period, question: rest.join(' ') };
  return { period: parsePeriod('неделя', now, config.timezone), question: arg };
}

async function handleChatQuestion(peerId, arg, commandDate, commandCmid) {
  if (!arg) {
    await reply(peerId, 'Напишите вопрос по переписке, например: /чат кто обещал взять проектор?');
    return;
  }
  if (busyChats.has(peerId)) {
    await reply(peerId, 'Уже работаю с перепиской этого чата, подождите немного.');
    return;
  }
  const { period, question } = parseChatQuestion(arg, commandDate);

  busyChats.add(peerId);
  try {
    const { lines, truncated } = await loadLines(peerId, commandCmid, period);
    if (!lines.length) {
      await reply(peerId, `За период «${period.title}» сообщений не найдено.`);
      return;
    }
    const answer = await summarizer.askChat(lines, question, period.title);
    const note = truncated ? ` (учтены только последние ${config.maxMessages} сообщений)` : '';
    const text = answer || `В переписке за ${period.title} ничего не нашлось.`;
    const parts = splitMessage(`${text}\n\n(искал за ${period.title}, ${lines.length} сообщ.${note})`);
    for (const [i, part] of parts.entries()) {
      if (i > 0) await sleep(SEND_DELAY_MS);
      await reply(peerId, part);
    }
  } catch (err) {
    if (handleFlood(err)) return;
    console.error('Ошибка при ответе по переписке:', err);
    const text = err.code === NO_CHAT_ACCESS ? NO_ACCESS_TEXT : 'Не удалось получить ответ, подробности в логе бота.';
    await reply(peerId, text).catch(handleFlood);
  } finally {
    busyChats.delete(peerId);
  }
}

// Сколько символов из сообщений, на которые ответили или которые переслали, отправлять модели
const MAX_CONTEXT_CHARS = 30_000;

function limitContext(texts) {
  const result = [];
  let left = MAX_CONTEXT_CHARS;
  for (const text of texts) {
    if (left <= 0) break;
    result.push(text.length > left ? `${text.slice(0, left)}…` : text);
    left -= text.length;
  }
  return result;
}

async function handleAsk(peerId, question, contextTexts, photos) {
  if (!question && !photos.length && !contextTexts.length) {
    await reply(peerId, 'Напишите вопрос после команды или прикрепите фото, например: /ии как сварить борщ');
    return;
  }
  try {
    const images = await Promise.all(photos.slice(0, MAX_IMAGES).map(downloadImage));
    const { text, truncated } = await summarizer.ask(
      question, limitContext(contextTexts), images, config.askMaxTokens,
    );
    if (truncated) console.log('  ответ модели обрезан на пределе ASK_MAX_TOKENS');
    let answer = text || 'Модель вернула пустой ответ.';
    if (truncated) {
      // Модель может потратить весь предел на скрытые рассуждения и не успеть написать ответ
      answer = text
        ? `${text}\n\n(ответ обрезан — слишком длинный. Уточните или сузьте вопрос)`
        : 'Ответ получился слишком длинным и не уместился. Уточните или сузьте вопрос.';
    }
    const parts = splitMessage(answer);
    for (const [i, part] of parts.entries()) {
      if (i > 0) await sleep(SEND_DELAY_MS);
      await reply(peerId, part);
    }
  } catch (err) {
    if (handleFlood(err)) return;
    console.error('Ошибка при ответе на вопрос:', err);
    await reply(peerId, 'Не удалось получить ответ, подробности в логе бота.').catch(handleFlood);
  }
}

// Ограничение частоты команд в одном чате, чтобы не тратить лимиты ИИ и не словить флуд-контроль ВК.
// Для сводок и вопросов паузы отдельные.
const lastCommandAt = { summary: new Map(), ask: new Map() };

function cooldownLeft(kind, peerId, fromId, now) {
  const seconds = kind === 'ask' ? config.askCooldownSec : config.cooldownSec;
  if (config.adminIds.includes(fromId) || !seconds) return 0;
  const last = lastCommandAt[kind].get(peerId) ?? 0;
  if (now - last < seconds) return seconds - (now - last);
  lastCommandAt[kind].set(peerId, now);
  return 0;
}

async function onMessage({ peerId, cmid, date, text, fromId, contextTexts, photos }) {
  const command = stripMention(text);
  if (command.startsWith(BOT_MARK)) return;

  const isHelp = HELP_RE.test(command);
  const ask = command.match(ASK_RE);
  const chat = command.match(CHAT_RE);
  const match = command.match(COMMAND_RE);
  if (!isHelp && !ask && !chat && !match) return;

  console.log(`Команда в чате ${peerId} от id${fromId}: ${command}`);
  if (Date.now() < floodPausedUntil) {
    const minutes = Math.ceil((floodPausedUntil - Date.now()) / 60_000);
    console.log(`  пропущена: пауза после флуд-контроля ВК, осталось ~${minutes} мин.`);
    return;
  }
  // Справка дешёвая, пауза действует только на сводки и вопросы.
  // Вопрос по переписке читает историю так же, как сводка, поэтому у них общая пауза.
  const left = isHelp ? 0 : cooldownLeft(ask ? 'ask' : 'summary', peerId, fromId, date);
  if (left) {
    console.log(`  пропущена: слишком частые команды, повтор возможен через ${left} c`);
    return;
  }

  try {
    if (isHelp) await vk.sendMessage(peerId, HELP_TEXT);
    else if (ask) await handleAsk(peerId, (ask[2] ?? '').trim(), contextTexts, photos);
    else if (chat) await handleChatQuestion(peerId, (chat[2] ?? '').trim(), date, cmid);
    else await handleSummary(peerId, match[2], date, cmid);
  } catch (err) {
    if (!handleFlood(err)) throw err;
  }
}

let group;
try {
  group = await vk.getGroup();
} catch (err) {
  console.error(`Не удалось запустить бота: ${err.message}`);
  process.exit(1);
}
console.log(`Бот запущен от имени сообщества «${group.name}» (club${group.id}). ИИ: ${config.llm.title}, ${config.llm.model}`
  + (config.llmFallback ? `; запасной: ${config.llmFallback.title}, ${config.llmFallback.model}` : ''));
await vk.listenMessages(group.id, onMessage);
