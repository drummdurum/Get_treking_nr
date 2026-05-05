/**
 * test-tracking.ts – tester AO ordresøgning + Track & Trace opslag.
 *
 * Kørsel (fra playwright-bot/):
 *   npx ts-node src/test-tracking.ts
 *
 * Ændre AO_ORDER_REF og EXPECTED_TRACKING nedenfor til det ordre du vil teste.
 */

import dotenv from 'dotenv';
dotenv.config();

import { launchAndLogin, getTrackingForOrder, closeBrowser } from './ao-scraper'; // ao-scraper er i samme mappe

const AO_ORDER_REF     = '33772';
const EXPECTED_TRACKING = '';

async function main() {
  console.log('\n══════════════════════════════════════════');
  console.log(' AO Tracking test');
  console.log('══════════════════════════════════════════');
  console.log(` Ordrenummer:      ${AO_ORDER_REF}`);
  console.log(` Forventet T&T:    ${EXPECTED_TRACKING}`);
  console.log('══════════════════════════════════════════\n');

  try {
    console.log('▶ Logger ind på AO…');
    await launchAndLogin();
    console.log('✓ Login OK\n');

    console.log(`▶ Slår op: ${AO_ORDER_REF}…`);
    const result = await getTrackingForOrder(AO_ORDER_REF);

    console.log('\n── Resultat ──────────────────────────────');
    console.log(JSON.stringify(result, null, 2));
    console.log('──────────────────────────────────────────');

    if (result.success) {
      const match = result.trackingNumber === EXPECTED_TRACKING;
      console.log(`\n✓ Tracking fundet:  ${result.trackingNumber}  (${result.carrier})`);
      console.log(match
        ? `✓ MATCH – tracker stemmer overens med forventet ${EXPECTED_TRACKING}`
        : `✗ MISMATCH – forventede ${EXPECTED_TRACKING}, fik ${result.trackingNumber}`
      );
    } else {
      console.error(`\n✗ Ingen tracking: [${result.reason}] ${result.message}`);
    }
  } catch (err) {
    console.error('\n✗ FEJL:', err);
  } finally {
    await closeBrowser();
  }
}

main();
