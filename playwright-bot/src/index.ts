/**
 * index.ts – Kloakgods Tracking Bot
 * ─────────────────────────────────
 * Cron-drevet bot der:
 *   1. Henter WooCommerce-ordrer uden tracking men med AO reference
 *   2. Logger ind på AO og slår hvert referencenummer op
 *   3. Poster tracking-nummeret tilbage til WooCommerce
 *
 * Kørsel:
 *   npm run dev          – kør med ts-node (udvikling)
 *   npm run dev -- --once  – kør én gang og afslut
 *   npm start            – kør compiled JS
 */

import cron from 'node-cron';
import { config } from './config';
import { logger } from './logger';
import {
  getOrdersMissingTracking,
  postTracking,
  markOrderChecked,
} from './wordpress-client';
import {
  launchAndLogin as launchAoAndLogin,
  getTrackingForOrder as getAoTrackingForOrder,
  closeBrowser as closeAoBrowser,
} from './ao/ao-scraper';
import {
  launchAndLogin as launchAhlsellAndLogin,
  getTrackingForOrder as getAhlsellTrackingForOrder,
  closeBrowser as closeAhlsellBrowser,
} from './ashley/ashley';
import {
  launchAndLogin as launchBdAndLogin,
  getTrackingForOrder as getBdTrackingForOrder,
  closeBrowser as closeBdBrowser,
} from './BD_SGDD/bd-scraper';
import { sendMorningReport } from './mailer';
import { runWordPressFulfillment, type ManualTrackingRow } from './wordpress/update-fulfillment';
import { dedupeTrackingItems, hasTrackingNumberLetterPrefix } from './tracking-utils';
import type { RunSummary, ScrapeResult, UpdatedOrder } from './types';

type ProviderName = 'ao' | 'ahlsell' | 'bd';

interface TrackingProvider {
  name: ProviderName;
  launchAndLogin: () => Promise<void>;
  getTrackingForOrder: (reference: string) => Promise<ScrapeResult>;
  closeBrowser: () => Promise<void>;
}

interface ProviderTrackingUpdate {
  orderId: number;
  carrier: string;
  trackingNumber: string;
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

function isBrowserRelatedError(message?: string): boolean {
  const m = (message ?? '').toLowerCase();
  return m.includes('browser') || m.includes('lukket');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timeout efter ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function getProviderSequence(): ProviderName[] {
  const raw = (process.env.SCRAPER_PROVIDERS ?? 'ao,ahlsell,bd').toLowerCase();
  const requested = raw
    .split(',')
    .map((x) => x.trim())
    .filter((x): x is ProviderName => x === 'ao' || x === 'ahlsell' || x === 'bd');

  const unique = [...new Set(requested)];
  return unique.length > 0 ? unique : ['ao', 'ahlsell', 'bd'];
}

function getOrderIdFilter(): number | undefined {
  const idx = process.argv.indexOf('--order-id');
  if (idx === -1) return undefined;
  const raw = process.argv[idx + 1];
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function shouldRunWordPressFulfillmentAfterIndex(): boolean {
  return process.env.RUN_WP_FULFILLMENT_AFTER_INDEX === 'true';
}

function shouldRunWordPressFulfillmentBackup(): boolean {
  return process.env.RUN_WP_FULFILLMENT_BACKUP === 'true';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main run function
// ─────────────────────────────────────────────────────────────────────────────

async function run(sendEmail = false): Promise<void> {
  const startedAt = new Date();
  const updatedOrders: UpdatedOrder[] = [];
  const backupOrders: UpdatedOrder[] = [];
  const trackingUpdatedByProvider: Record<ProviderName, ProviderTrackingUpdate[]> = {
    ao: [],
    ahlsell: [],
    bd: [],
  };
  const providerBrowserErrorStreak: Record<ProviderName, number> = {
    ao: 0,
    ahlsell: 0,
    bd: 0,
  };
  const maxBrowserErrorsBeforeRestart = 3;
  const providerLookupTimeoutMs = Math.max(config.bot.pageTimeoutMs * 4, 120_000);
  const useWordPressFulfillment = shouldRunWordPressFulfillmentAfterIndex();
  const useWordPressFulfillmentBackup = shouldRunWordPressFulfillmentBackup();
  const summary: RunSummary = {
    ordersFound:     0,
    trackingUpdated: 0,
    trackingNotReady: 0,
    errors:          0,
    startedAt,
    finishedAt:      startedAt,
  };

  logger.info('═══ Bot-kørsel startet ═══');
  // ── 1. Hent ordrer der mangler tracking ────────────────────────────────
  let orders;
  try {
    orders = await getOrdersMissingTracking();
  } catch {
    logger.error('Kunne ikke hente ordrer fra WordPress – afbryder denne kørsel.');
    return;
  }

  const orderIdFilter = getOrderIdFilter();
  if (orderIdFilter !== undefined) {
    orders = orders.filter((o) => o.order_id === orderIdFilter);
    if (orders.length === 0) {
      logger.warn(
        `--order-id ${orderIdFilter} blev angivet, men ordren findes ikke i /orders-missing-tracking.`
      );
      logger.warn('Mulige årsager: ordren har allerede tracking, mangler korrekt status, eller er over max checks.');
      return;
    }
    logger.info(`Test-filter aktivt: behandler kun ordre #${orderIdFilter}.`);
  }


  // Begræns antal ordrer hvis TEST_ORDER_LIMIT er sat
  if (config.bot.testOrderLimit && config.bot.testOrderLimit > 0) {
    orders = orders.slice(0, config.bot.testOrderLimit);
    logger.info(`TEST_ORDER_LIMIT=${config.bot.testOrderLimit}: behandler kun ${orders.length} ordre(r).`);
  }

  summary.ordersFound = orders.length;

  if (orders.length === 0) {
    logger.info('Ingen ordrer mangler tracking. Kørsel afsluttet.');
    return;
  }

  // Log hvilke felter der mangler på hver ordre
  for (const o of orders) {
    const missing = [];
    if (!o.ao_reference) missing.push('ao_reference');
    if (o.check_count === undefined) missing.push('check_count');
    if (missing.length > 0) {
      logger.warn(`Ordre #${o.order_id} mangler: ${missing.join(', ')}`);
    }
  }

  logger.info(`${orders.length} ordre(r) mangler tracking. Starter browser(e)…`);

  const providerSequence = getProviderSequence();
  const activeProviders: TrackingProvider[] = [];

  // ── 2. Start browser og log ind for hver provider (én ad gangen) ───────
  for (const providerName of providerSequence) {
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
      logger.info(`Provider klar: ${provider.name}`);
    } catch (err: unknown) {
      logger.error(`Provider ${provider.name} kunne ikke starte/login:`, err);
    }
  }

  if (activeProviders.length === 0) {
    logger.error('Ingen tracking providers er klar – afbryder denne kørsel.');
    summary.errors = orders.length;
    logSummary(summary);
    return;
  }

  // ── 3. Behandl ALLE ordrer ───────────────────────────────────────────
  for (const order of orders) {
    // Brug order_id som ao_reference (de er ens i dette system)
    const aoRef = order.ao_reference || String(order.order_id);
    logger.info(
      `Behandler ordre #${order.order_id} (AO ref: ${aoRef}, ` +
      `tjekket ${order.check_count} gang(e) før)`
    );

    try {
      let finalResult: ScrapeResult | null = null;
      let finalProviderName: ProviderName | null = null;
      let sawNotReady = false;
      let sawNotFound = false;
      let lastErrorMessage: string | undefined;

      for (const provider of activeProviders) {
        logger.info(`Opslag via ${provider.name} for ordre #${order.order_id}`);
        let result = await withTimeout(
          provider.getTrackingForOrder(aoRef),
          providerLookupTimeoutMs,
          `${provider.name} opslag for ordre #${order.order_id}`,
        );

        // Genstart kun provider-browseren efter flere browser-fejl i traek.
        if (!result.success && result.reason === 'error' && isBrowserRelatedError(result.message)) {
          providerBrowserErrorStreak[provider.name]++;
          logger.warn(
            'Browser-relateret fejl hos ' + provider.name + ' ' +
            '(' + providerBrowserErrorStreak[provider.name] + '/' + maxBrowserErrorsBeforeRestart + '): ' +
            (result.message ?? 'ukendt fejl')
          );

          if (providerBrowserErrorStreak[provider.name] >= maxBrowserErrorsBeforeRestart) {
            logger.warn(provider.name + ' har haft ' + maxBrowserErrorsBeforeRestart + ' browser-fejl i traek - genstarter browser/session nu.');
            try {
              await provider.closeBrowser().catch(() => {});
              await provider.launchAndLogin();
              providerBrowserErrorStreak[provider.name] = 0;
              result = await withTimeout(
                provider.getTrackingForOrder(aoRef),
                providerLookupTimeoutMs,
                `${provider.name} opslag for ordre #${order.order_id} efter genstart`,
              );
            } catch (restartErr) {
              logger.error('Kunne ikke genstarte ' + provider.name + ':', restartErr);
              lastErrorMessage = String(restartErr);
              continue;
            }
          }
        } else if (result.success || result.reason !== 'error') {
          providerBrowserErrorStreak[provider.name] = 0;
        }

        if (result.success) {
          finalResult = result;
          finalProviderName = provider.name;
          logger.info(`Tracking fundet via ${provider.name} for ordre #${order.order_id}`);
          break;
        }

        if (result.reason === 'not_ready') sawNotReady = true;
        if (result.reason === 'not_found') sawNotFound = true;
        if (result.reason === 'error') lastErrorMessage = result.message;
      }

      if (!finalResult) {
        if (sawNotReady) {
          logger.info(
            `Tracking ikke klar til ordre #${order.order_id}. ` +
            `(${order.check_count + 1}/${config.bot.maxRetriesPerOrder} forsøg)`
          );
          await markOrderChecked(order.order_id);
          summary.trackingNotReady++;

          if (order.check_count + 1 >= config.bot.maxRetriesPerOrder) {
            logger.warn(
              `Ordre #${order.order_id} har nået max ${config.bot.maxRetriesPerOrder} forsøg ` +
              `uden tracking – botten vil ikke tjekke den igen.`
            );
          }
          continue;
        }

        if (sawNotFound) {
          logger.warn(
            `Reference ${aoRef} ikke fundet hos nogen provider. ` +
            `Tjek at referencenummeret er korrekt på ordre #${order.order_id}.`
          );
          await markOrderChecked(order.order_id);
          summary.errors++;
          continue;
        }

        logger.error(
          `Fejl ved opslag af ordre #${order.order_id}: ${lastErrorMessage ?? 'ukendt fejl'}`
        );
        summary.errors++;
        continue;
      }

      // Post kun unikke forsendelser til WooCommerce (undgår dubletter)
      const uniqueTrackingItems = dedupeTrackingItems(finalResult.trackingItems);
      const validTrackingItems = uniqueTrackingItems.filter((item) => hasTrackingNumberLetterPrefix(item.trackingNumber));

      if (validTrackingItems.length === 0) {
        logger.warn(
          `Ordre #${order.order_id}: fandt kun ugyldige trackingnumre uden 2 bogstaver foran: ` +
          uniqueTrackingItems.map((t) => `${t.carrier}/${t.trackingNumber}`).join(', ')
        );
        await markOrderChecked(order.order_id);
        summary.trackingNotReady++;
        continue;
      }

      if (!useWordPressFulfillment) {
      for (const item of validTrackingItems) {
        logger.info(
          `Opdaterer tracking for ordre #${order.order_id}: carrier='${item.carrier}', tracking='${item.trackingNumber}'`
        );
        try {
            const response = await postTracking({
              order_id:        order.order_id,
              tracking_number: item.trackingNumber,
              carrier:         item.carrier,
              status_shipped:  1,
            });
          if (response && response.success) {
            logger.info(`Tracking opdateret for ordre #${order.order_id}: ${item.carrier}/${item.trackingNumber}`);
          } else if (response && response.error && response.error.code === 'duplicate_tracking') {
            logger.warn(`Tracking-nummer allerede brugt på en anden ordre: ${item.trackingNumber}`);
          } else {
            logger.warn(`Uventet svar fra API ved opdatering af tracking: ${JSON.stringify(response)}`);
            if (useWordPressFulfillmentBackup) {
              backupOrders.push({ orderId: order.order_id, carrier: item.carrier, trackingNumber: item.trackingNumber });
            }
          }
        } catch (err) {
          logger.error(`Fejl ved opdatering af tracking for ordre #${order.order_id}: ${String(err)}`);
          if (useWordPressFulfillmentBackup) {
            backupOrders.push({ orderId: order.order_id, carrier: item.carrier, trackingNumber: item.trackingNumber });
          }
        }
      }
      } else {
        logger.info(
          `Gemmer ${validTrackingItems.length} trackingnummer/-numre til browser-opdatering for ordre #${order.order_id}.`
        );
      }
      logger.info(
        `${validTrackingItems.length} forsendelse(r) forsøgt gemt på ordre #${order.order_id}: ` +
        validTrackingItems.map(t => `${t.carrier}/${t.trackingNumber}`).join(', ')
      );
      summary.trackingUpdated++;
      for (const item of validTrackingItems) {
        updatedOrders.push({ orderId: order.order_id, carrier: item.carrier, trackingNumber: item.trackingNumber });
        if (finalProviderName) {
          trackingUpdatedByProvider[finalProviderName].push({
            orderId: order.order_id,
            carrier: item.carrier,
            trackingNumber: item.trackingNumber,
          });
        }
      }

    } catch (err: unknown) {
      logger.error(`Uventet fejl for ordre #${order.order_id}:`, err);
      summary.errors++;
    }
  }

  // ── 4. Luk browser(e) ──────────────────────────────────────────────────
  for (const provider of activeProviders) {
    await provider.closeBrowser().catch((err) => {
      logger.warn(`Kunne ikke lukke browser for ${provider.name}: ${String(err)}`);
    });
  }

  // ── 5. Log sammendrag ──────────────────────────────────────────────────
  summary.finishedAt = new Date();
  logSummary(summary, trackingUpdatedByProvider);

  // ── 6. Send email-rapport (kun ved morgenkørsel) ───────────────────────
  if (sendEmail) {
    await sendMorningReport(summary, updatedOrders);
  }

  if (useWordPressFulfillment) {
    if (updatedOrders.length === 0) {
      logger.info('Ingen fundne trackingnumre at sende til WordPress fulfillment-browserflow.');
    } else {
      const fulfillmentRows: ManualTrackingRow[] = updatedOrders.map((order) => ({
        orderId: order.orderId,
        carrier: order.carrier,
        trackingNumber: order.trackingNumber,
      }));
      logger.info(`Starter WordPress fulfillment-browserflow med ${fulfillmentRows.length} trackingnummer/-numre fra index.ts.`);
      await runWordPressFulfillment(fulfillmentRows);
    }
  } else if (useWordPressFulfillmentBackup) {
    if (backupOrders.length === 0) {
      logger.info('Ingen fejlede API-opdateringer at sende til WordPress fulfillment-backup.');
    } else {
      const fulfillmentRows: ManualTrackingRow[] = backupOrders.map((order) => ({
        orderId: order.orderId,
        carrier: order.carrier,
        trackingNumber: order.trackingNumber,
      }));
      logger.info(`Starter WordPress fulfillment-backup med ${fulfillmentRows.length} trackingnummer/-numre.`);
      await runWordPressFulfillment(fulfillmentRows);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logging helpers
// ─────────────────────────────────────────────────────────────────────────────

function logSummary(
  summary: RunSummary,
  trackingUpdatedByProvider?: Record<ProviderName, ProviderTrackingUpdate[]>,
): void {
  const durationMs = summary.finishedAt.getTime() - summary.startedAt.getTime();
  logger.info('═══ Kørsel afsluttet ═══');
  logger.info(`  Ordrer fundet:      ${summary.ordersFound}`);
  logger.info(`  Tracking opdateret: ${summary.trackingUpdated}`);
  logger.info(`  Tracking ikke klar: ${summary.trackingNotReady}`);
  logger.info(`  Fejl:               ${summary.errors}`);
  logProviderTrackingUpdates(trackingUpdatedByProvider);
  logger.info(`  Varighed:           ${(durationMs / 1000).toFixed(1)}s`);
}

function logProviderTrackingUpdates(
  trackingUpdatedByProvider?: Record<ProviderName, ProviderTrackingUpdate[]>,
): void {
  if (!trackingUpdatedByProvider) return;

  const labels: Record<ProviderName, string> = {
    ao: 'AO',
    ahlsell: 'Ahlsell',
    bd: 'BD',
  };

  logger.info('  Opdateret pr. leverandor:');
  for (const providerName of getProviderSequence()) {
    const updates = trackingUpdatedByProvider[providerName];
    logger.info(`    ${labels[providerName]} opdateret: ${updates.length}`);
    for (const update of updates) {
      logger.info(`      #${update.orderId}: ${update.carrier}/${update.trackingNumber}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

const runOnce = process.argv.includes('--once');

if (runOnce) {
  // Kør én gang og afslut (nyttigt til manuelt test / debugging)
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Fatal fejl:', err);
      process.exit(1);
    });
} else {
  // ── Kør med det samme ved opstart (hvis konfigureret) ──────────────────
  if (config.bot.runOnStartup) {
    logger.info('Kører bot én gang med det samme ved opstart…');
    run().catch((err) => logger.error('Fejl ved opstartsrun:', err));
  }

  // ── Planlæg ét dagligt cron-job ───────────────────────────────────────
  logger.info(
    `Planlægger cron-job: "${config.bot.cronSchedule}" (timezone: ${config.bot.cronTimezone}) – sender email`
  );
  cron.schedule(config.bot.cronSchedule, () => {
    run(true).catch((err) => logger.error('Uventet cron-fejl:', err));
  }, { timezone: config.bot.cronTimezone });

  logger.info('Bot er aktiv og venter på næste kørsel…');
}
