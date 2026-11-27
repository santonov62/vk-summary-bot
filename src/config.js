function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Не задана переменная окружения ${name} (см. .env.example)`);
    process.exit(1);
  }
  return value;
}

// Поддерживаемые провайдеры ИИ (все с OpenAI-совместимым API)
const PROVIDERS = {
  nvidia: {
    title: 'NVIDIA',
    env: 'NVIDIA',
    model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    // Отключает режим рассуждений у моделей Nemotron 3: быстрее и не тратит токены
    params: { temperature: 0.3, top_p: 0.95, chat_template_kwargs: { enable_thinking: false } },
  },
  spiderssense: {
    title: 'SpidersSense',
    env: 'SPIDERSSENSE',
    model: 'anthropic/claude-opus-5.5',
    baseUrl: 'https://spiderssense.com/v1',
    // SpidersSense не принимает temperature и top_p для моделей Claude
    params: {},
  },
};

function provider(name, variable) {
  const p = PROVIDERS[name];
  if (!p) {
    console.error(`Неизвестный ${variable} «${name}». Доступно: ${Object.keys(PROVIDERS).join(', ')}`);
    process.exit(1);
  }
  return {
    name,
    title: p.title,
    apiKey: required(`${p.env}_API_KEY`),
    model: process.env[`${p.env}_MODEL`] || p.model,
    baseUrl: process.env[`${p.env}_BASE_URL`] || p.baseUrl,
    params: p.params,
  };
}

const primaryName = (process.env.LLM_PROVIDER || 'nvidia').toLowerCase();
// Запасной провайдер на случай, если основной недоступен или кончился лимит. Пусто или none — без запасного
const fallbackName = (process.env.LLM_FALLBACK || '').toLowerCase();
const useFallback = fallbackName && fallbackName !== 'none' && fallbackName !== primaryName;

export const config = {
  vkToken: required('VK_GROUP_TOKEN'),
  llm: provider(primaryName, 'LLM_PROVIDER'),
  llmFallback: useFallback ? provider(fallbackName, 'LLM_FALLBACK') : null,
  // Сколько минут после сбоя основного провайдера сразу идти к запасному, не пробуя основной
  llmRetryMin: Number(process.env.LLM_RETRY_MIN ?? 10),
  timezone: process.env.TIMEZONE || 'Europe/Moscow',
  maxMessages: Number(process.env.MAX_MESSAGES) || 3000,
  cooldownSec: Number(process.env.COMMAND_COOLDOWN_SEC ?? 60),
  askCooldownSec: Number(process.env.ASK_COOLDOWN_SEC ?? 15),
  askMaxTokens: Number(process.env.ASK_MAX_TOKENS) || 4000,
  adminIds: (process.env.ADMIN_IDS ?? '').split(/[\s,]+/).filter(Boolean).map(Number),
};
