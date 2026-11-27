function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Не задана переменная окружения ${name} (см. .env.example)`);
    process.exit(1);
  }
  return value;
}

export const config = {
  vkToken: required('VK_GROUP_TOKEN'),
  nvidiaKey: required('NVIDIA_API_KEY'),
  nvidiaModel: process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  nvidiaBaseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
  timezone: process.env.TIMEZONE || 'Europe/Moscow',
  maxMessages: Number(process.env.MAX_MESSAGES) || 3000,
  cooldownSec: Number(process.env.COMMAND_COOLDOWN_SEC ?? 60),
  askCooldownSec: Number(process.env.ASK_COOLDOWN_SEC ?? 15),
  adminIds: (process.env.ADMIN_IDS ?? '').split(/[\s,]+/).filter(Boolean).map(Number),
};
