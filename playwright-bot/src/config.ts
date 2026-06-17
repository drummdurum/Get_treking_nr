import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const wpBaseUrl = require_env('WP_BASE_URL').replace(/\/$/, '');
const wpApiKey = process.env.WP_API_KEY ?? process.env.KG_TRACKING_API_KEY ?? '';

function require_env(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Manglende miljøvariabel: ${key}. Se .env.example.`);
  }
  return value;
}


export const config = {
  wp: {
    baseUrl:  wpBaseUrl,
    apiKey:   wpApiKey,
  },
  wpAdmin: {
    loginUrl:     process.env.WP_ADMIN_LOGIN_URL ?? `${wpBaseUrl}/mellon`,
    dashboardUrl: process.env.WP_FULFILLMENT_URL ?? `${wpBaseUrl}/wp-admin/admin.php?page=fulfillment-dashboard`,
    username:     process.env.WP_ADMIN_USERNAME ?? '',
    password:     process.env.WP_ADMIN_PASSWORD ?? '',
  },
  ao: {
    loginUrl: process.env.AO_LOGIN_URL ?? 'https://www.ao.dk/login',
    username: process.env.AO_USERNAME ?? '',
    password: process.env.AO_PASSWORD ?? '',
    userDataDir: path.resolve(process.env.AO_USER_DATA_DIR ?? './.browser-profiles/ao'),
  },
  ahlsell: {
    baseUrl:  process.env.AHLSELL_BASE_URL ?? 'https://www.ahlsell.dk/da',
    username: process.env.AS_USERNAME ?? process.env.AHLSELL_USERNAME ?? '',
    password: process.env.AS_PASSWORD ?? process.env.AHLSELL_PASSWORD ?? '',
  },
  bd: {
    loginUrl: process.env.BD_LOGIN_URL ?? 'https://www.bd.dk/login',
    ordersUrl: process.env.BD_ORDERS_URL ?? 'https://www.bd.dk/mit-bd/koeb#ordrer',
    username: process.env.BD_USERNAME ?? '',
    password: process.env.BD_PASSWORD ?? '',
  },
  bot: {
    cronSchedule:       process.env.CRON_SCHEDULE        ?? '0 6 * * *',
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
