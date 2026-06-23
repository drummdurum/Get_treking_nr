import { chromium, type Page } from 'playwright';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import {
  launchAndLogin as launchAoAndLogin,
  getTrackingForOrder as getAoTrackingForOrder,
  closeBrowser as closeAoBrowser,
} from '../ao/ao-scraper';
import {
  launchAndLogin as launchAhlsellAndLogin,
  getTrackingForOrder as getAhlsellTrackingForOrder,
  closeBrowser as closeAhlsellBrowser,
} from '../ashley/ashley';
import {
  launchAndLogin as launchBdAndLogin,
  getTrackingForOrder as getBdTrackingForOrder,
  closeBrowser as closeBdBrowser,
} from '../BD_SGDD/bd-scraper';
import type { ScrapeResult, TrackingItem } from '../types';

type ProviderName = 'ao' | 'ahlsell' | 'bd';

interface TrackingProvider {
  name: ProviderName;
  launchAndLogin: () => Promise<void>;
  getTrackingForOrder: (reference: string) => Promise<ScrapeResult>;
  closeBrowser: () => Promise<void>;
}

export interface ManualTrackingRow {
  orderId: number;
  trackingNumber: string;
  carrier: string;
}

const PROVIDERS: Record<ProviderName, TrackingProvider> = {
  ao: {
    name: 'ao',
    launchAndLogin: launchAoAndLogin,
    getTrackingForOrder: getAoTrackingForOrder,
    closeBrowser: closeAoBrowser,
  },
  ahlsell: {
    name: 'ahlsell',
    launchAndLogin: launchAhlsellAndLogin,
    getTrackingForOrder: getAhlsellTrackingForOrder,
    closeBrowser: closeAhlsellBrowser,
  },
  bd: {
    name: 'bd',
    launchAndLogin: launchBdAndLogin,
    getTrackingForOrder: getBdTrackingForOrder,
    closeBrowser: closeBdBrowser,
  },
};

function parseLimitArg(): number | undefined {
  const idx = process.argv.indexOf('--limit');
  const raw = idx === -1 ? process.env.WP_FULFILLMENT_LIMIT : process.argv[idx + 1];
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOrderIdArg(): number | undefined {
  const idx = process.argv.indexOf('--order-id');
  const raw = idx === -1 ? process.env.WP_FULFILLMENT_ORDER_ID : process.argv[idx + 1];
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseManualTrackingNumberArg(): string | undefined {
  const idx = process.argv.indexOf('--tracking-number');
  const raw = idx === -1 ? process.env.WP_FULFILLMENT_TRACKING_NUMBER : process.argv[idx + 1];
  const value = (raw ?? '').trim();
  return value.length > 0 ? value : undefined;
}

function parseFileArg(): string | undefined {
  const idx = process.argv.findIndex((arg) => arg === '--file' || arg === '--csv');
  const raw = idx === -1 ? process.env.TRACKING_CSV_FILE : process.argv[idx + 1];
  const value = (raw ?? '').trim();
  return value.length > 0 ? value : undefined;
}

function parseCarrierArg(): string {
  const idx = process.argv.indexOf('--carrier');
  if (idx === -1) return process.env.WP_FULFILLMENT_CARRIER ?? process.env.WP_DEFAULT_CARRIER ?? 'GLS';
  const value = (process.argv[idx + 1] ?? '').trim();
  return value.length > 0 ? value : (process.env.WP_DEFAULT_CARRIER ?? 'GLS');
}

function isDryRun(): boolean {
  return process.argv.includes('--dry-run') || process.env.WP_FULFILLMENT_DRY_RUN === 'true';
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

function detectDelimiter(headerLine: string): string {
  const delimiters = [';', ',', '\t'];
  return delimiters
    .map((delimiter) => ({
      delimiter,
      count: parseCsvLine(headerLine, delimiter).length,
    }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter ?? ';';
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getColumnIndex(headers: string[], aliases: string[]): number {
  const normalized = headers.map(normalizeHeader);
  return normalized.findIndex((header) => aliases.includes(header));
}

function loadManualTrackingRows(fileArg: string, defaultCarrier: string): ManualTrackingRow[] {
  const filePath = path.resolve(process.cwd(), fileArg);
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (lines.length < 2) {
    throw new Error(`CSV-filen mangler data: ${filePath}`);
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = parseCsvLine(lines[0], delimiter);
  const orderIdx = getColumnIndex(headers, ['orderid', 'order', 'ordreid', 'ordre', 'ordrenr', 'ordrenummer']);
  const trackingIdx = getColumnIndex(headers, ['trackingnumber', 'tracking', 'trackingnr', 'trackingnummer', 'tracktrace', 'trackandtrace']);
  const carrierIdx = getColumnIndex(headers, ['carrier', 'fragtfirma', 'leverandor', 'leverandoer', 'provider', 'shippingcarrier']);

  if (orderIdx === -1 || trackingIdx === -1) {
    throw new Error('CSV skal mindst have kolonner for order_id og tracking_number.');
  }

  const rows: ManualTrackingRow[] = [];
  const seen = new Set<number>();

  for (const [index, line] of lines.slice(1).entries()) {
    const cols = parseCsvLine(line, delimiter);
    const orderId = Number.parseInt(cols[orderIdx] ?? '', 10);
    const trackingNumber = (cols[trackingIdx] ?? '').trim();
    const carrier = ((carrierIdx >= 0 ? cols[carrierIdx] : '') ?? '').trim() || defaultCarrier;

    if (!Number.isFinite(orderId) || orderId <= 0 || trackingNumber.length === 0) {
      logger.warn(`Springer CSV-linje ${index + 2} over: mangler gyldigt ordre-ID eller trackingnummer.`);
      continue;
    }

    if (seen.has(orderId)) {
      logger.warn(`CSV indeholder ordre #${orderId} flere gange. Bruger den første række.`);
      continue;
    }

    seen.add(orderId);
    rows.push({ orderId, trackingNumber, carrier });
  }

  logger.info(`Indlæste ${rows.length} tracking-række(r) fra ${filePath}.`);
  return rows;
}

function isBrowserRelatedError(message?: string): boolean {
  const m = (message ?? '').toLowerCase();
  return m.includes('browser') || m.includes('lukket') || m.includes('closed');
}

function getProviderSequence(): ProviderName[] {
  const raw = (process.env.SCRAPER_PROVIDERS ?? 'ahlsell,bd').toLowerCase();
  const requested = raw
    .split(',')
    .map((x) => x.trim())
    .filter((x): x is ProviderName => x === 'ao' || x === 'ahlsell' || x === 'bd');
  const unique = [...new Set(requested)];
  return unique.length > 0 ? unique : ['ao', 'ahlsell', 'bd'];
}

async function loginWordPress(page: Page): Promise<void> {
  if (!config.wpAdmin.username || !config.wpAdmin.password) {
    throw new Error('WP_ADMIN_USERNAME/WP_ADMIN_PASSWORD mangler i .env');
  }

  logger.info(`Logger ind i WordPress via ${config.wpAdmin.loginUrl}`);
  await page.goto(config.wpAdmin.loginUrl, { waitUntil: 'domcontentloaded' });

  const userInput = page.locator('#user_login, input[name="log"], input[type="email"]').first();
  const passInput = page.locator('#user_pass, input[name="pwd"], input[type="password"]').first();
  const submitBtn = page.locator('#wp-submit, button[type="submit"], input[type="submit"]').first();

  await userInput.fill(config.wpAdmin.username);
  await passInput.fill(config.wpAdmin.password);
  await submitBtn.click();

  await page.waitForURL(/wp-admin|fulfillment-dashboard|admin\.php/, { timeout: 25_000 });
  logger.info('WordPress login OK.');
}

async function gotoFulfillmentDashboard(page: Page): Promise<void> {
  await page.goto(config.wpAdmin.dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#fulfillment_search_input').waitFor({ timeout: 20_000 });
}

async function collectOrderIds(page: Page): Promise<number[]> {
  const addButtons = page.locator('a.add_inline_tracking');
  const count = await addButtons.count();

  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const href = (await addButtons.nth(i).getAttribute('href')) ?? '';
    const match = href.match(/#(\d+)/);
    if (!match) continue;

    const id = Number.parseInt(match[1], 10);
    if (Number.isFinite(id)) ids.push(id);
  }

  return [...new Set(ids)];
}

async function findTracking(reference: string, providers: TrackingProvider[]): Promise<TrackingItem | null> {
  let sawNotReady = false;
  let sawNotFound = false;
  let lastErrorMessage: string | undefined;

  for (const provider of providers) {
    logger.info(`Opslag via ${provider.name} for ordre #${reference}`);
    let result = await provider.getTrackingForOrder(reference);

    if (!result.success && result.reason === 'error' && isBrowserRelatedError(result.message)) {
      logger.warn(`Browser lukket hos ${provider.name} - forsoger genstart.`);
      try {
        await provider.closeBrowser().catch(() => undefined);
        await provider.launchAndLogin();
        result = await provider.getTrackingForOrder(reference);
      } catch (err) {
        lastErrorMessage = String(err);
        continue;
      }
    }

    if (result.success) {
      return result.trackingItems[0] ?? null;
    }

    if (result.reason === 'not_ready') sawNotReady = true;
    if (result.reason === 'not_found') sawNotFound = true;
    if (result.reason === 'error') lastErrorMessage = result.message;
  }

  if (sawNotReady) logger.info(`Tracking ikke klar endnu for ordre #${reference}.`);
  else if (sawNotFound) logger.warn(`Ingen tracking fundet hos providers for ordre #${reference}.`);
  else logger.error(`Fejl ved tracking-opslag for ordre #${reference}: ${lastErrorMessage ?? 'ukendt fejl'}`);

  return null;
}

async function clickSearchForOrder(page: Page, orderId: number): Promise<void> {
  const searchInput = page.locator('#fulfillment_search_input');
  await searchInput.fill(String(orderId));
  await page.locator('#fulfillment_search_submit').click();
  await page.waitForTimeout(1800);
}

async function openInlineTrackingForm(page: Page, orderId: number): Promise<boolean> {
  const exactHrefBtn = page.locator(`a.add_inline_tracking[href="#${orderId}"]`).first();
  if ((await exactHrefBtn.count()) > 0) {
    await exactHrefBtn.click();
    await page.waitForTimeout(600);
    return true;
  }

  const rowScopedBtn = page.locator(`tr:has-text("${orderId}") a.add_inline_tracking`).first();
  if ((await rowScopedBtn.count()) > 0) {
    await rowScopedBtn.click();
    await page.waitForTimeout(600);
    return true;
  }

  const anyVisibleBtn = page.locator('a.add_inline_tracking:visible').first();
  if ((await anyVisibleBtn.count()) > 0) {
    await anyVisibleBtn.click();
    await page.waitForTimeout(600);
    return true;
  }

  const allButtons = page.locator('a.add_inline_tracking');
  if ((await allButtons.count()) > 0) {
    await allButtons.first().click();
    await page.waitForTimeout(600);
    return true;
  }

  return false;
}

async function fillTrackingForm(page: Page, trackingNumber: string, carrier: string): Promise<void> {
  const trackingField = page.locator(
    'input[name*="tracking" i], input[id*="tracking" i], input.tracking_number, #tracking_number'
  ).first();

  await trackingField.fill(trackingNumber);

  const carrierSelect = page.locator('select[name*="carrier" i], select[id*="carrier" i]').first();
  if ((await carrierSelect.count()) > 0) {
    const optionCount = await carrierSelect.locator('option').count();
    if (optionCount > 0) {
      const candidate = carrier.toLowerCase();
      const options = await carrierSelect.locator('option').allTextContents();
      const selected = options.find((x) => x.toLowerCase().includes(candidate));
      if (selected) {
        await carrierSelect.selectOption({ label: selected });
      }
    }
  } else {
    const carrierInput = page.locator('input[name*="carrier" i], input[id*="carrier" i]').first();
    if ((await carrierInput.count()) > 0) {
      await carrierInput.fill(carrier);
    }
  }
}

async function submitForm(page: Page): Promise<void> {
  const submitButton = page
    .locator(
      'button:has-text("Opfyld"), button:has-text("Tilføj"), button:has-text("Gem"), button:has-text("Save"), button:has-text("Fulfill"), input[type="submit"]'
    )
    .first();

  await submitButton.click();
  await page.waitForTimeout(1200);
}

export async function runWordPressFulfillment(rowsFromIndex?: ManualTrackingRow[]): Promise<void> {
  const limitArg = parseLimitArg();
  const orderIdArg = parseOrderIdArg();
  const manualTrackingNumber = parseManualTrackingNumberArg();
  const manualCarrier = parseCarrierArg();
  const fileArg = parseFileArg();
  const manualRows = rowsFromIndex ?? (fileArg ? loadManualTrackingRows(fileArg, manualCarrier) : []);
  const limit = limitArg ?? config.bot.testOrderLimit;
  const dryRun = isDryRun();

  if (!config.wpAdmin.username || !config.wpAdmin.password) {
    throw new Error('WP_ADMIN_USERNAME/WP_ADMIN_PASSWORD mangler i .env');
  }

  if (manualTrackingNumber && !orderIdArg) {
    throw new Error('Brug --order-id sammen med --tracking-number.');
  }

  if (manualTrackingNumber && (fileArg || rowsFromIndex)) {
    throw new Error('Brug enten --tracking-number, --file eller index-listen, ikke flere samtidigt.');
  }

  logger.info('Starter WordPress browser-flow for fulfillment tracking.');
  if (dryRun) {
    logger.info('Dry-run aktiv: finder ordrer og tracking, men gemmer ikke i WordPress.');
  }
  if (orderIdArg) {
    logger.info(`Single-order mode aktiv for ordre #${orderIdArg}.`);
  }
  if (manualTrackingNumber) {
    logger.info(
      `Manuel tracking mode aktiv: ${manualCarrier}/${manualTrackingNumber}.`
    );
  }
  if (fileArg) {
    logger.info(`Batch tracking mode aktiv: ${manualRows.length} ordre(r) fra CSV.`);
  }
  if (rowsFromIndex) {
    logger.info(`Index batch mode aktiv: ${manualRows.length} tracking-række(r) fundet af index.ts.`);
  }

  const activeProviders: TrackingProvider[] = [];

  if (!manualTrackingNumber && !fileArg && !rowsFromIndex) {
    const providerSequence = getProviderSequence();

    for (const providerName of providerSequence) {
      if (
        providerName === 'ao' &&
        (!config.ao.username || !config.ao.password)
      ) {
        logger.warn('Springer AO over: mangler AO_USERNAME/AO_PASSWORD.');
        continue;
      }

      if (
        providerName === 'ahlsell' &&
        (!config.ahlsell.username || !config.ahlsell.password)
      ) {
        logger.warn('Springer Ahlsell over: mangler AHLSELL/AS brugernavn eller kodeord.');
        continue;
      }

      if (
        providerName === 'bd' &&
        (!config.bd.username || !config.bd.password)
      ) {
        logger.warn('Springer BD over: mangler BD_USERNAME/BD_PASSWORD.');
        continue;
      }

      const provider = PROVIDERS[providerName];
      try {
        logger.info(`Starter provider: ${provider.name}`);
        await provider.launchAndLogin();
        activeProviders.push(provider);
      } catch (err) {
        logger.error(`Kunne ikke starte provider ${provider.name}:`, err);
      }
    }

    if (activeProviders.length === 0) {
      throw new Error('Ingen aktive tracking providers kunne startes.');
    }
  }

  const browser = await chromium.launch({ headless: config.bot.headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  let processed = 0;
  let updated = 0;

  try {
    await loginWordPress(page);
    await gotoFulfillmentDashboard(page);

    let orderIds = manualRows.length > 0
      ? manualRows.map((row) => row.orderId)
      : orderIdArg ? [orderIdArg] : await collectOrderIds(page);

    if (orderIdArg && manualRows.length > 0) {
      orderIds = orderIds.filter((id) => id === orderIdArg);
      if (orderIds.length === 0) {
        logger.warn(`--order-id ${orderIdArg} blev angivet, men findes ikke i CSV-filen.`);
      }
    }

    if (limit && limit > 0) {
      orderIds = orderIds.slice(0, limit);
    }

    logger.info(`Fant ${orderIds.length} ordre(r) klar til inline tracking.`);
    if (orderIds.length > 0) {
      logger.info(`Ordre-IDer: ${orderIds.join(', ')}`);
    }

    if (manualRows.length > 0) {
      for (const row of manualRows.filter((manualRow) => orderIds.includes(manualRow.orderId))) {
        processed++;
        const tracking = {
          trackingNumber: row.trackingNumber,
          carrier: row.carrier,
        } as TrackingItem;

        logger.info(
          `Ordre #${row.orderId}: tracking klar fra liste ${tracking.carrier}/${tracking.trackingNumber}`
        );

        await gotoFulfillmentDashboard(page);
        await clickSearchForOrder(page, row.orderId);

        const opened = await openInlineTrackingForm(page, row.orderId);
        if (!opened) {
          logger.warn(`Ordre #${row.orderId}: kunne ikke finde 'Tilfoj sporing'-knappen efter sogning.`);
          continue;
        }

        if (dryRun) {
          logger.info(`Dry-run: ville have opdateret ordre #${row.orderId}.`);
          continue;
        }

        await fillTrackingForm(page, tracking.trackingNumber, tracking.carrier);
        await submitForm(page);
        updated++;
        logger.info(`Ordre #${row.orderId} opdateret via browser-flow.`);
      }
    } else for (const orderId of orderIds) {
      processed++;
      const tracking = manualTrackingNumber
          ? ({ trackingNumber: manualTrackingNumber, carrier: manualCarrier } as TrackingItem)
          : await findTracking(String(orderId), activeProviders);
      if (!tracking) continue;

      logger.info(
        `Ordre #${orderId}: tracking fundet ${tracking.carrier}/${tracking.trackingNumber}`
      );

      await gotoFulfillmentDashboard(page);
      await clickSearchForOrder(page, orderId);

      const opened = await openInlineTrackingForm(page, orderId);
      if (!opened) {
        logger.warn(`Ordre #${orderId}: kunne ikke finde 'Tilfoj sporing'-knappen efter sogning.`);
        continue;
      }

      if (dryRun) {
        logger.info(`Dry-run: ville have opdateret ordre #${orderId}.`);
        continue;
      }

      await fillTrackingForm(page, tracking.trackingNumber, tracking.carrier);
      await submitForm(page);
      updated++;
      logger.info(`Ordre #${orderId} opdateret via browser-flow.`);
    }
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);

    for (const provider of activeProviders) {
      await provider.closeBrowser().catch(() => undefined);
    }
  }

  logger.info(
    `WordPress browser-flow afsluttet. Behandlet: ${processed}. Opdateret: ${updated}.`
  );
}

let isRunning = false;

async function runSafely(sendFatalExit = false): Promise<void> {
  if (isRunning) {
    logger.warn('WordPress browser-flow kører allerede. Springer denne planlagte kørsel over.');
    return;
  }

  isRunning = true;
  try {
    await runWordPressFulfillment();
  } catch (err) {
    logger.error('Fatal fejl i WordPress browser-flow:', err);
    if (sendFatalExit) process.exit(1);
  } finally {
    isRunning = false;
  }
}

const runOnce = process.argv.includes('--once') || process.env.WP_FULFILLMENT_RUN_ONCE === 'true';

if (require.main === module && runOnce) {
  runSafely(true)
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Fatal fejl i WordPress browser-flow:', err);
      process.exit(1);
    });
} else if (require.main === module) {
  if (config.bot.runOnStartup) {
    logger.info('Kører WordPress browser-flow én gang med det samme ved opstart.');
    runSafely().catch((err) => logger.error('Fejl ved opstartsrun:', err));
  }

  logger.info(
    `Planlægger WordPress browser-flow: "${config.bot.cronSchedule}" ` +
    `(timezone: ${config.bot.cronTimezone})`
  );

  cron.schedule(config.bot.cronSchedule, () => {
    runSafely().catch((err) => logger.error('Uventet cron-fejl:', err));
  }, { timezone: config.bot.cronTimezone });

  logger.info('WordPress browser-flow er aktivt og venter på næste kørsel.');
}
