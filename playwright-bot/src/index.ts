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
import { sendMorningReport } from './mailer';
import type { RunSummary, ScrapeResult, UpdatedOrder } from './types';

type ProviderName = 'ao' | 'ahlsell';

interface TrackingProvider {
  name: ProviderName;
  launchAndLogin: () => Promise<void>;
  getTrackingForOrder: (reference: string) => Promise<ScrapeResult>;
  closeBrowser: () => Promise<void>;
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
};

function isBrowserRelatedError(message?: string): boolean {
  const m = (message ?? '').toLowerCase();
  return m.includes('browser') || m.includes('lukket');
}

function getProviderSequence(): ProviderName[] {
  const raw = (process.env.SCRAPER_PROVIDERS ?? 'ao,ahlsell').toLowerCase();
  const requested = raw
    .split(',')
    .map((x) => x.trim())
    .filter((x): x is ProviderName => x === 'ao' || x === 'ahlsell');

  const unique = [...new Set(requested)];
  return unique.length > 0 ? unique : ['ao', 'ahlsell'];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main run function
// ─────────────────────────────────────────────────────────────────────────────

async function run(sendEmail = false): Promise<void> {
  const startedAt = new Date();
  const updatedOrders: UpdatedOrder[] = [];
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
      let sawNotReady = false;
      let sawNotFound = false;
      let lastErrorMessage: string | undefined;

      for (const provider of activeProviders) {
        logger.info(`Opslag via ${provider.name} for ordre #${order.order_id}`);
        let result = await provider.getTrackingForOrder(aoRef);

        // Browser crashede for denne provider – forsøg genstart én gang
        if (!result.success && result.reason === 'error' && isBrowserRelatedError(result.message)) {
          logger.warn(`Browser lukket uventet hos ${provider.name} – forsøger genstart…`);
          try {
            await provider.closeBrowser().catch(() => {});
            await provider.launchAndLogin();
            result = await provider.getTrackingForOrder(aoRef);
          } catch (restartErr) {
            logger.error(`Kunne ikke genstarte ${provider.name}:`, restartErr);
            lastErrorMessage = String(restartErr);
            continue;
          }
        }

        if (result.success) {
          finalResult = result;
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
            `Reference ${order.ao_reference} ikke fundet hos nogen provider. ` +
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

      // Post ALLE forsendelser til WooCommerce (kan være flere fragtbreve på én ordre)
      for (const item of finalResult.trackingItems) {
        await postTracking({
          order_id:        order.order_id,
          tracking_number: item.trackingNumber,
          carrier:         item.carrier,
        });
      }
      logger.info(
        `${finalResult.trackingItems.length} forsendelse(r) gemt på ordre #${order.order_id}: ` +
        finalResult.trackingItems.map(t => `${t.carrier}/${t.trackingNumber}`).join(', ')
      );
      summary.trackingUpdated++;
      for (const item of finalResult.trackingItems) {
        updatedOrders.push({ orderId: order.order_id, carrier: item.carrier, trackingNumber: item.trackingNumber });
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
  logSummary(summary);

  // ── 6. Send email-rapport (kun ved morgenkørsel) ───────────────────────
  if (sendEmail) {
    await sendMorningReport(summary, updatedOrders);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logging helpers
// ─────────────────────────────────────────────────────────────────────────────

function logSummary(summary: RunSummary): void {
  const durationMs = summary.finishedAt.getTime() - summary.startedAt.getTime();
  logger.info('═══ Kørsel afsluttet ═══');
  logger.info(`  Ordrer fundet:      ${summary.ordersFound}`);
  logger.info(`  Tracking opdateret: ${summary.trackingUpdated}`);
  logger.info(`  Tracking ikke klar: ${summary.trackingNotReady}`);
  logger.info(`  Fejl:               ${summary.errors}`);
  logger.info(`  Varighed:           ${(durationMs / 1000).toFixed(1)}s`);
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

  // ── Planlæg cron-jobs ──────────────────────────────────────────────────
  // Kl. 07:00 (morgen – sender email), 10:00 og 18:45
  const schedules: Array<{ cron: string; sendEmail: boolean }> = [
    { cron: '0 7 * * *',  sendEmail: true  },
    { cron: '0 10 * * *', sendEmail: false },
    { cron: '45 18 * * *', sendEmail: false },
  ];
  for (const { cron: schedule, sendEmail } of schedules) {
    logger.info(`Planlægger cron-job: "${schedule}" (timezone: ${config.bot.cronTimezone})${sendEmail ? ' – sender email' : ''}`);
    cron.schedule(schedule, () => {
      run(sendEmail).catch((err) => logger.error('Uventet cron-fejl:', err));
    }, { timezone: config.bot.cronTimezone });
  }

  logger.info('Bot er aktiv og venter på næste kørsel…');
}
