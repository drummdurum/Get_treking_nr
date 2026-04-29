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
  launchAndLogin,
  getTrackingForOrder,
  closeBrowser,
} from './ao-scraper';
import type { RunSummary } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Main run function
// ─────────────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const startedAt = new Date();
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

  summary.ordersFound = orders.length;

  if (orders.length === 0) {
    logger.info('Ingen ordrer mangler tracking. Kørsel afsluttet.');
    return;
  }

  logger.info(`${orders.length} ordre(r) mangler tracking. Starter browser…`);

  // ── 2. Start browser og log ind ────────────────────────────────────────
  try {
    await launchAndLogin();
  } catch (err: unknown) {
    logger.error('Browser/login fejlede – afbryder:', err);
    summary.errors = orders.length;
    logSummary(summary);
    return;
  }

  // ── 3. Behandl kun første ordre ───────────────────────────────────────
  const order = orders[0];
  if (order) {
    logger.info(
      `Behandler ordre #${order.order_id} (AO ref: ${order.ao_reference}, ` +
      `tjekket ${order.check_count} gang(e) før)`
    );

    try {
      const result = await getTrackingForOrder(order.ao_reference);

      if (result.success) {
        // Post ALLE forsendelser til WooCommerce (kan være flere fragtbreve på én ordre)
        for (const item of result.trackingItems) {
          await postTracking({
            order_id:        order.order_id,
            tracking_number: item.trackingNumber,
            carrier:         item.carrier,
          });
        }
        logger.info(
          `${result.trackingItems.length} forsendelse(r) gemt på ordre #${order.order_id}: ` +
          result.trackingItems.map(t => `${t.carrier}/${t.trackingNumber}`).join(', ')
        );
        summary.trackingUpdated++;

      } else if (result.reason === 'not_ready') {
        // Tracking ikke klar endnu → inkrementer check-tæller
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

      } else if (result.reason === 'not_found') {
        logger.warn(
          `AO reference ${order.ao_reference} ikke fundet på AO-portalen. ` +
          `Tjek at referencenummeret er korrekt på ordre #${order.order_id}.`
        );
        await markOrderChecked(order.order_id);
        summary.errors++;

      } else {
        logger.error(
          `Fejl ved opslag af ordre #${order.order_id}: ${result.message ?? result.reason}`
        );
        summary.errors++;
      }

    } catch (err: unknown) {
      logger.error(`Uventet fejl for ordre #${order.order_id}:`, err);
      summary.errors++;
    }
  }

  // ── 4. Luk browser ─────────────────────────────────────────────────────
  await closeBrowser();

  // ── 5. Log sammendrag ──────────────────────────────────────────────────
  summary.finishedAt = new Date();
  logSummary(summary);
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

  // ── Planlæg cron-job ───────────────────────────────────────────────────
  logger.info(`Planlægger cron-job: "${config.bot.cronSchedule}"`);

  cron.schedule(config.bot.cronSchedule, () => {
    run().catch((err) => logger.error('Uventet cron-fejl:', err));
  });

  logger.info('Bot er aktiv og venter på næste kørsel…');
}
