import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function require_env(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Manglende miljøvariabel: ${key}. Se .env.example.`);
  }
  return value;
}

export const config = {
  wp: {
    baseUrl:  require_env('WP_BASE_URL').replace(/\/$/, ''),
    apiKey:   require_env('WP_API_KEY'),
  },
  ao: {
    loginUrl: process.env.AO_LOGIN_URL ?? 'https://www.ao.dk/login',
    username: require_env('AO_USERNAME'),
    password: require_env('AO_PASSWORD'),
  },
  bot: {
    cronSchedule:       process.env.CRON_SCHEDULE        ?? '*/30 * * * *',
    maxRetriesPerOrder: parseInt(process.env.MAX_RETRIES_PER_ORDER ?? '10', 10),
    pageTimeoutMs:      parseInt(process.env.PAGE_TIMEOUT_MS       ?? '30000', 10),
    runOnStartup:       process.env.RUN_ON_STARTUP        !== 'false',
    headless:           process.env.HEADLESS              !== 'false',
  },
  log: {
    level:  process.env.LOG_LEVEL ?? 'info',
    logDir: path.resolve(process.env.LOG_DIR ?? './logs'),
  },
} as const;
