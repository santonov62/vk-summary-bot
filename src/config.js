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

const providerName = (process.env.LLM_PROVIDER || 'nvidia').toLowerCase();
const provider = PROVIDERS[providerName];
if (!provider) {
  console.error(`Неизвестный LLM_PROVIDER «${providerName}». Доступно: ${Object.keys(PROVIDERS).join(', ')}`);
  process.exit(1);
}

export const config = {
  vkToken: required('VK_GROUP_TOKEN'),
  llm: {
    name: providerName,
    title: provider.title,
    apiKey: required(`${provider.env}_API_KEY`),
    model: process.env[`${provider.env}_MODEL`] || provider.model,
    baseUrl: process.env[`${provider.env}_BASE_URL`] || provider.baseUrl,
    params: provider.params,
  },
  timezone: process.env.TIMEZONE || 'Europe/Moscow',
  maxMessages: Number(process.env.MAX_MESSAGES) || 3000,
  cooldownSec: Number(process.env.COMMAND_COOLDOWN_SEC ?? 60),
  askCooldownSec: Number(process.env.ASK_COOLDOWN_SEC ?? 15),
  adminIds: (process.env.ADMIN_IDS ?? '').split(/[\s,]+/).filter(Boolean).map(Number),
};
