const API_VERSION = '5.199';
export const FLOOD_CONTROL = 9;
export const FLOOD_HINT =
  'ВК временно ограничил отправку (Flood control): слишком много одинаковых действий. '
  + 'Повторные запросы продлевают ограничение — подождите.';
// 917 — у сообщества нет доступа к беседе (не выданы права администратора)
export const NO_CHAT_ACCESS = 917;

// Сколько сообщений можно запросить за раз в messages.getByConversationMessageId
const BATCH = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Самая крупная копия фото не шире этого размера: модели хватает, а загрузка быстрее
const PHOTO_MAX_SIDE = 1600;

// Ссылки на фото из вложений сообщения
function photoUrls(msg) {
  const urls = [];
  for (const att of msg?.attachments ?? []) {
    if (att.type !== 'photo') continue;
    const sizes = [...(att.photo?.sizes ?? [])].filter((s) => s.url).sort((a, b) => a.width - b.width);
    const best = sizes.filter((s) => Math.max(s.width, s.height) <= PHOTO_MAX_SIDE).at(-1) ?? sizes[0];
    if (best) urls.push(best.url);
  }
  return urls;
}

// Сообщение, на которое ответили, и все пересланные сообщения (включая вложенные пересылки)
function relatedMessages(msg) {
  const result = msg.reply_message ? [msg.reply_message] : [];
  const walk = (list, depth) => {
    for (const fwd of list ?? []) {
      result.push(fwd);
      if (depth < 5) walk(fwd.fwd_messages, depth + 1);
    }
  };
  walk(msg.fwd_messages, 0);
  return result;
}

// Скачивает картинку и превращает её в data URL для модели
export async function downloadImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Не удалось скачать фото: HTTP ${res.status}`);
  const type = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
  const data = Buffer.from(await res.arrayBuffer()).toString('base64');
  return `data:${type};base64,${data}`;
}

export class VkApi {
  constructor(token) {
    this.token = token;
  }

  async call(method, params = {}) {
    const body = new URLSearchParams({ access_token: this.token, v: API_VERSION });
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) body.set(key, String(value));
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://api.vk.com/method/${method}`, { method: 'POST', body });
      const data = await res.json();
      if (!data.error) return data.response;
      // 6 — слишком много запросов в секунду: подождать и повторить
      if (data.error.error_code === 6 && attempt < 5) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      // 9 — флуд-контроль: повтор только продлит ограничение, сразу отдаём ошибку
      const hint = data.error.error_code === FLOOD_CONTROL ? `. ${FLOOD_HINT}` : '';
      const err = new Error(`VK ${method}: [${data.error.error_code}] ${data.error.error_msg}${hint}`);
      err.code = data.error.error_code;
      throw err;
    }
  }

  // Сообщество, которому принадлежит токен
  async getGroup() {
    const res = await this.call('groups.getById');
    // В новых версиях API ответ — { groups: [...] }, в старых — массив
    const [group] = res.groups ?? res;
    return group;
  }

  sendMessage(peerId, text) {
    return this.call('messages.send', {
      peer_id: peerId,
      message: text,
      random_id: Math.floor(Math.random() * 2 ** 31),
      disable_mentions: 1,
    });
  }

  /**
   * Загружает историю чата, идя по номерам сообщений (conversation_message_id) назад от `beforeCmid`,
   * пока не дойдёт до времени `from`. Сообщество не может вызывать messages.getHistory для бесед,
   * а этот метод ему доступен.
   * Возвращает { items (от старых к новым), profiles, groups, truncated }.
   */
  async getHistorySince(peerId, beforeCmid, from, to, maxMessages) {
    const items = [];
    const profiles = new Map();
    const groups = new Map();
    let truncated = false;

    for (let end = beforeCmid - 1; end >= 1; end -= BATCH) {
      const start = Math.max(1, end - BATCH + 1);
      const ids = [];
      for (let id = end; id >= start; id--) ids.push(id);

      const res = await this.call('messages.getByConversationMessageId', {
        peer_id: peerId,
        conversation_message_ids: ids.join(','),
        extended: 1,
        fields: 'first_name,last_name,name',
      });
      for (const p of res.profiles ?? []) profiles.set(p.id, `${p.first_name} ${p.last_name}`);
      for (const g of res.groups ?? []) groups.set(g.id, g.name);

      // Целая пачка недоступна — дальше сообщения, которых сообщество не видит (например, до его добавления)
      if (!res.items?.length) break;

      const batch = [...res.items].sort((a, b) => b.conversation_message_id - a.conversation_message_id);
      let reachedStart = false;
      for (const msg of batch) {
        if (msg.date < from) {
          reachedStart = true;
          break;
        }
        if (msg.date < to) items.push(msg);
      }
      if (items.length >= maxMessages) {
        truncated = true;
        items.length = maxMessages;
        break;
      }
      if (reachedStart) break;
    }

    items.reverse();
    return { items, profiles, groups, truncated };
  }

  // Bots Long Poll: вызывает onMessage для каждого нового сообщения, которое видит сообщество
  async listenMessages(groupId, onMessage) {
    const getServer = () => this.call('groups.getLongPollServer', { group_id: groupId });
    let server = await getServer();
    let ts = server.ts;

    for (;;) {
      let data;
      try {
        const url = `${server.server}?act=a_check&key=${server.key}&ts=${ts}&wait=25`;
        const res = await fetch(url, { signal: AbortSignal.timeout(35_000) });
        data = await res.json();
      } catch (err) {
        console.error('Ошибка Long Poll, повтор через 3 c:', err.message);
        await sleep(3000);
        continue;
      }

      if (data.failed) {
        if (data.failed === 1) {
          ts = data.ts;
        } else {
          try {
            server = await getServer();
            if (data.failed !== 2) ts = server.ts;
          } catch (err) {
            // При флуд-контроле частые переподключения только продлевают блокировку
            const delay = err.code === FLOOD_CONTROL ? 10 * 60_000 : 5000;
            console.error(`Не удалось переподключиться к Long Poll, повтор через ${delay / 1000} c:`, err.message);
            await sleep(delay);
          }
        }
        continue;
      }

      ts = data.ts;
      for (const update of data.updates ?? []) {
        if (update.type !== 'message_new') continue;
        const msg = update.object?.message;
        if (!msg) continue;
        const related = relatedMessages(msg);
        try {
          await onMessage({
            peerId: msg.peer_id,
            cmid: msg.conversation_message_id,
            date: msg.date,
            text: msg.text ?? '',
            fromId: msg.from_id,
            // Тексты сообщения, на которое ответили, и пересланных сообщений
            contextTexts: related.map((m) => m.text).filter(Boolean),
            photos: [msg, ...related].flatMap(photoUrls),
          });
        } catch (err) {
          console.error('Ошибка обработки сообщения:', err);
        }
      }
    }
  }
}
