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

function require_api_key(): string {
  const wpKey = process.env.WP_API_KEY;
  const kgKey = process.env.KG_TRACKING_API_KEY;
  const key = wpKey ?? kgKey;
  if (!key) {
    throw new Error('Manglende miljøvariabel: WP_API_KEY eller KG_TRACKING_API_KEY.');
  }
  return key;
}

export const config = {
  wp: {
    baseUrl:  require_env('WP_BASE_URL').replace(/\/$/, ''),
    apiKey:   require_api_key(),
  },
  ao: {
    loginUrl: process.env.AO_LOGIN_URL ?? 'https://www.ao.dk/login',
    username: require_env('AO_USERNAME'),
    password: require_env('AO_PASSWORD'),
  },
  ahlsell: {
    baseUrl:  process.env.AHLSELL_BASE_URL ?? 'https://www.ahlsell.dk/da',
    username: process.env.AS_USERNAME ?? process.env.AHLSELL_USERNAME ?? '',
    password: process.env.AS_PASSWORD ?? process.env.AHLSELL_PASSWORD ?? '',
  },
  bot: {
    cronSchedule:       process.env.CRON_SCHEDULE        ?? '0 3 * * *',
    cronTimezone:       process.env.CRON_TIMEZONE        ?? process.env.TZ ?? 'Europe/Copenhagen',
    maxRetriesPerOrder: parseInt(process.env.MAX_RETRIES_PER_ORDER ?? '10', 10),
    pageTimeoutMs:      parseInt(process.env.PAGE_TIMEOUT_MS       ?? '30000', 10),
    runOnStartup:       process.env.RUN_ON_STARTUP        !== 'false',
    headless:           process.env.HEADLESS              !== 'false',
    testOrderLimit:     process.env.TEST_ORDER_LIMIT ? parseInt(process.env.TEST_ORDER_LIMIT, 10) : undefined,
  },
  log: {
    level:  process.env.LOG_LEVEL ?? 'info',
    logDir: path.resolve(process.env.LOG_DIR ?? './logs'),
  },
  mail: {
    apiKey: process.env.RESEND_API_KEY ?? '',
    from:   process.env.RESEND_FROM   ?? '',
    to:     process.env.RESEND_TO     ?? '',
  },
} as const;
