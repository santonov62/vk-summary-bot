const SYSTEM_PROMPT = `Ты помощник, который делает краткие выжимки из переписки в групповом чате. Отвечай на русском языке.
Структура ответа:
1. Основные темы обсуждения (кратко, списком).
2. Важные договорённости, решения, даты и задачи (кто что должен сделать).
3. Открытые вопросы, если есть.
Не выдумывай того, чего нет в переписке. Упоминай участников по именам.
Не используй markdown-разметку (звёздочки, решётки) — ВКонтакте её не отображает. Только простой текст и списки с «-».`;

const ASSISTANT_PROMPT = `Ты помощник в групповом чате ВКонтакте. Отвечай на русском языке (или на языке вопроса), по делу и кратко.
Если не знаешь ответа или не уверен — так и скажи, не выдумывай.
Не используй markdown-разметку (звёздочки, решётки) — ВКонтакте её не отображает. Только простой текст и списки с «-».`;

const CHAT_PROMPT = `Ты отвечаешь на вопросы по переписке группового чата ВКонтакте. Отвечай на русском языке, по делу и кратко.
Опирайся только на переписку, не выдумывай. Указывай, кто и когда (дата и время) написал нужное сообщение.
Ссылки приводи полностью. Если в переписке нет ответа — так и скажи.
Не используй markdown-разметку (звёздочки, решётки) — ВКонтакте её не отображает. Только простой текст и списки с «-».`;

// Ответ модели, если в части переписки нет ничего по вопросу
const NOTHING_FOUND = 'НИЧЕГО';

// Модель иногда игнорирует запрет на markdown, а ВКонтакте его не отображает — убираем разметку из ответа
export function stripMarkdown(text) {
  return text
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^(\s*)[*+]\s+/gm, '$1- ')
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/\n{3,}/g, '\n\n');
}

// Примерный лимит символов переписки в одном запросе
const CHUNK_CHARS = 60_000;

// Делит переписку на части, которые помещаются в один запрос к модели
function splitChunks(lines) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > CHUNK_CHARS && current.length) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export class Summarizer {
  constructor({ title, apiKey, model, baseUrl, params = {} }) {
    this.title = title;
    this.apiKey = apiKey;
    this.model = model;
    this.params = params;
    this.url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  }

  async chat(userContent, maxTokens = 1500, systemPrompt = SYSTEM_PROMPT) {
    return (await this.complete(userContent, maxTokens, systemPrompt)).text;
  }

  // Как chat, но ещё сообщает, оборвался ли ответ на пределе max_tokens
  async complete(userContent, maxTokens, systemPrompt) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: maxTokens,
        ...this.params,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      throw new Error(`${this.title} API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? '';
    return {
      text: stripMarkdown(text.replace(/<think>[\s\S]*?<\/think>/g, '')).trim(),
      truncated: choice?.finish_reason === 'length',
    };
  }

  /**
   * Ответ на произвольный вопрос. Возвращает { text, truncated }.
   * contextTexts — тексты сообщения, на которое ответили, и пересланных сообщений; images — картинки (data URL).
   */
  ask(question, contextTexts = [], images = [], maxTokens = 4000) {
    let text = question || (images.length ? 'Опиши, что на изображении.' : 'Что скажешь об этом?');
    if (contextTexts.length) {
      const context = contextTexts.map((t) => `«${t}»`).join('\n\n');
      text = `Сообщения, к которым относится вопрос:\n${context}\n\nВопрос: ${text}`;
    }
    const content = images.length
      ? [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
      : text;
    return this.complete(content, maxTokens, ASSISTANT_PROMPT);
  }

  // Ответ на вопрос по переписке (lines — строки «[время] Автор: текст»)
  async askChat(lines, question, periodTitle) {
    const chunks = splitChunks(lines);
    if (chunks.length === 1) {
      return this.chat(
        `Переписка за период: ${periodTitle}.\n\n${chunks[0].join('\n')}\n\nВопрос: ${question}`,
        1500,
        CHAT_PROMPT,
      );
    }

    // Длинная переписка: ищем ответ в каждой части, затем объединяем найденное
    const found = [];
    for (const [i, chunk] of chunks.entries()) {
      const answer = await this.chat(
        `Часть ${i + 1} из ${chunks.length} переписки за период ${periodTitle}.\n\n${chunk.join('\n')}\n\n`
          + `Вопрос: ${question}\n\nВыпиши всё из этой части, что относится к вопросу. `
          + `Если ничего не относится — ответь одним словом: ${NOTHING_FOUND}`,
        1000,
        CHAT_PROMPT,
      );
      if (!answer.toUpperCase().startsWith(NOTHING_FOUND)) found.push(answer);
    }
    if (!found.length) return '';
    if (found.length === 1) return found[0];
    return this.chat(
      `Ниже найденное в разных частях переписки за период ${periodTitle} по вопросу «${question}». `
        + `Объедини в один ответ на вопрос без повторов.\n\n${found.join('\n\n---\n\n')}`,
      1500,
      CHAT_PROMPT,
    );
  }

  async summarize(lines, periodTitle) {
    const chunks = splitChunks(lines);

    if (chunks.length === 1) {
      return this.chat(`Переписка за период: ${periodTitle}.\n\n${chunks[0].join('\n')}`);
    }

    // Длинная переписка: выжимка по частям, затем общая
    const partial = [];
    for (const [i, chunk] of chunks.entries()) {
      partial.push(
        await this.chat(
          `Часть ${i + 1} из ${chunks.length} переписки за период ${periodTitle}.\n\n${chunk.join('\n')}`,
          1000,
        ),
      );
    }
    return this.chat(
      `Ниже выжимки частей переписки за период ${periodTitle}. Объедини их в одну итоговую выжимку без повторов.\n\n` +
        partial.join('\n\n---\n\n'),
    );
  }
}
